/**
 * X / Twitter 适配器。
 *
 * 和 YouTube 差别很大：
 *  - 没有 playerResponse 这种全局对象，字幕只能从 HLS 播放列表里找
 *  - 一个时间线上可能同时有好几个 video，要挑「正在播的那个」
 *  - 大部分用户发的视频根本没有字幕轨 —— 那是事实，不是 bug
 *
 * 这里只处理「有字幕轨」的情况，不做语音识别。
 */

import {
  parseSegmentUris,
  parseSubtitleTracks,
  pickEnglishSubtitleTrack,
  resolveUri,
} from '../subtitle/hls.ts';
import { mergeManualCues } from '../subtitle/normalize.ts';
import type { SubtitleTrack } from '../subtitle/types.ts';
import { mergeVttCues, parseVtt } from '../subtitle/vtt.ts';
import type { SiteAdapter } from './types.ts';

/** MAIN world 截获到的 m3u8 地址，按出现顺序。 */
const state = { playlists: [] as string[] };

/** X 的视频清单地址长这样：video.twimg.com/.../xxx.m3u8 */
export function isVideoPlaylist(url: string): boolean {
  return /\.m3u8(\?|$)/.test(url) && /twimg\.com|video\.twitter\.com/.test(url);
}

export function noteInterceptedUrl(url: string): void {
  if (isVideoPlaylist(url) && !state.playlists.includes(url)) {
    state.playlists.push(url);
  }
}

export function xPageSnapshot() {
  return { playlistCount: state.playlists.length };
}

/** 从推文 URL 里取状态 ID，用作缓存 key。 */
export function statusIdFromUrl(href: string): string | null {
  return /\/status\/(\d+)/.exec(new URL(href).pathname)?.[1] ?? null;
}

/**
 * 挑「正在播的那个」video。
 *
 * X 的时间线上可能有多个视频元素，只有一个在播；都没在播就取
 * 面积最大的那个（通常是用户点开的那条推文）。
 */
function pickActiveVideo(): HTMLVideoElement | null {
  const videos = [...document.querySelectorAll('video')];
  if (videos.length === 0) return null;

  const playing = videos.find((v) => !v.paused && !v.ended && v.readyState > 2);
  if (playing) return playing;

  return videos
    .map((v) => ({ v, area: v.clientWidth * v.clientHeight }))
    .sort((a, b) => b.area - a.area)[0]!.v;
}

/** 视频所在的播放器容器，字幕层挂这里。 */
function playerContainer(video: HTMLVideoElement | null): HTMLElement | null {
  if (!video) return null;
  return (
    video.closest<HTMLElement>('[data-testid="videoPlayer"]') ??
    video.closest<HTMLElement>('[data-testid="videoComponent"]') ??
    video.parentElement
  );
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 从一个 master playlist 出发，把字幕拉全。
 *
 * 三跳：master → 字幕 m3u8 → 一串 .vtt 分片。
 */
async function fetchFromPlaylist(
  masterUrl: string,
  signal?: AbortSignal,
): Promise<{ cues: ReturnType<typeof parseVtt>; language: string } | null> {
  const master = await fetchText(masterUrl, signal);
  const track = pickEnglishSubtitleTrack(parseSubtitleTracks(master));
  if (!track) return null;

  const playlistUrl = resolveUri(track.uri, masterUrl);
  const playlist = await fetchText(playlistUrl, signal);
  const segments = parseSegmentUris(playlist).map((u) =>
    resolveUri(u, playlistUrl),
  );
  if (segments.length === 0) return null;

  // 分片不多（一支几分钟的视频通常个位数），并发拉完
  const texts = await Promise.all(
    segments.map((u) => fetchText(u, signal).catch(() => '')),
  );
  const cues = mergeVttCues(texts.filter(Boolean).map((t) => parseVtt(t)));

  return cues.length > 0 ? { cues, language: track.language || 'en' } : null;
}

/** 兜底：播放器如果挂了原生 track，直接读。 */
function readNativeTrack(video: HTMLVideoElement | null) {
  if (!video) return [];
  const track = [...video.textTracks].find((t) => t.cues && t.cues.length > 0);
  if (!track?.cues) return [];
  return [...track.cues]
    .filter((c): c is VTTCue => 'text' in c)
    .map((c) => ({
      text: c.text.replace(/\s+/g, ' ').trim(),
      startMs: Math.round(c.startTime * 1000),
      endMs: Math.round(c.endTime * 1000),
    }))
    .filter((c) => c.text);
}

export const xAdapter: SiteAdapter = {
  id: 'x',

  matches(url) {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // 只在单条推文页生效；时间线上多个视频同时在滚，字幕跟谁都不对
    return (
      (host === 'x.com' || host === 'twitter.com') &&
      /\/status\/\d+/.test(u.pathname)
    );
  },

  videoId() {
    return statusIdFromUrl(location.href);
  },

  findVideo: pickActiveVideo,

  overlayContainer() {
    return playerContainer(pickActiveVideo());
  },

  hideNativeSubtitles() {
    for (const video of document.querySelectorAll('video')) {
      for (const track of video.textTracks) {
        if (track.mode === 'showing') track.mode = 'hidden';
      }
    }
  },

  reset() {
    state.playlists = [];
  },

  async fetchSubtitles(signal, opts) {
    const videoId = this.videoId();
    if (!videoId) return null;

    // 后截获的更可能对应当前这条推文
    for (const url of [...state.playlists].reverse()) {
      try {
        const found = await fetchFromPlaylist(url, signal);
        if (!found) continue;
        return {
          videoId,
          trackId: found.language,
          languageCode: found.language,
          kind: 'manual',
          lines: mergeManualCues(found.cues, opts?.manualCaps),
          source: 'intercepted',
        } satisfies SubtitleTrack;
      } catch {
        // 换下一个候选
      }
    }

    const native = readNativeTrack(pickActiveVideo());
    if (native.length > 0) {
      return {
        videoId,
        trackId: 'en',
        languageCode: 'en',
        kind: 'manual',
        lines: mergeManualCues(native, opts?.manualCaps),
        source: 'text-tracks',
      } satisfies SubtitleTrack;
    }

    return null;
  },
};
