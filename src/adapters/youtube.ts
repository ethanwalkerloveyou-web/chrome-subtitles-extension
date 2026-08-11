import {
  MAIN_WORLD_SOURCE,
  REQUEST_PLAYER_RESPONSE,
  type MainWorldMessage,
} from '../subtitle/main-world-protocol.ts';
import {
  parseAsrTokens,
  parseManualCues,
  toJson3Url,
  type Json3Doc,
} from '../subtitle/timedtext.ts';
import {
  chunkAsrTokens,
  mergeManualCues,
  type ManualCaps,
} from '../subtitle/normalize.ts';
import type {
  SubtitleTrack,
  TrackCandidate,
  TrackKind,
} from '../subtitle/types.ts';
import type { FetchOptions, SiteAdapter } from './types.ts';
import { noteInterceptedUrl } from './x.ts';

/** MAIN world 报上来的信息，随导航更新。 */
interface PageState {
  videoId: string | null;
  tracks: TrackCandidate[];
  /** 截获到的播放器 timedtext 请求，按出现顺序。 */
  interceptedUrls: string[];
  /** playerResponse 的来源，取不到字幕时用来定位问题。 */
  from: string;
}

const state: PageState = {
  videoId: null,
  tracks: [],
  interceptedUrls: [],
  from: '未收到',
};

/** 当前页面状态的只读快照，供诊断输出。 */
export function pageSnapshot() {
  return {
    videoId: state.videoId,
    playerResponseFrom: state.from,
    trackCount: state.tracks.length,
    trackLanguages: state.tracks.map(
      (t) => `${t.languageCode}${t.kind === 'asr' ? '(自动)' : ''}`,
    ),
    interceptedCount: state.interceptedUrls.length,
  };
}

/** 开始监听 MAIN world 的消息。在 content script 启动时调用一次。 */
export function listenToMainWorld(): void {
  window.addEventListener('message', (e: MessageEvent<MainWorldMessage>) => {
    if (e.source !== window) return;
    const msg = e.data;
    if (msg?.source !== MAIN_WORLD_SOURCE) return;

    if (msg.type === 'PLAYER_RESPONSE') {
      state.videoId = msg.videoId;
      state.from = msg.from;
      if (msg.tracks.length > 0) state.tracks = msg.tracks;
    } else if (msg.type === 'TIMEDTEXT_URL') {
      // m3u8 是 X 的字幕来源，转给它的 adapter
      noteInterceptedUrl(msg.url);
      if (
        msg.url.includes('/api/timedtext') &&
        !state.interceptedUrls.includes(msg.url)
      ) {
        state.interceptedUrls.push(msg.url);
      }
    }
  });
}

/** 导航到新视频后清空上一支视频的残留。 */
function resetPageState(): void {
  state.videoId = null;
  state.tracks = [];
  state.interceptedUrls = [];
  state.from = '未收到';
  window.postMessage({ type: REQUEST_PLAYER_RESPONSE }, location.origin);
}

function videoIdFromUrl(): string | null {
  return new URL(location.href).searchParams.get('v');
}

async function fetchJson3(url: string, signal?: AbortSignal): Promise<Json3Doc> {
  // 同源请求，带上 cookie —— timedtext 对未登录会话有时会拒绝
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw new Error(`timedtext HTTP ${res.status}`);
  return (await res.json()) as Json3Doc;
}

function buildTrack(
  doc: Json3Doc,
  meta: {
    videoId: string;
    languageCode: string;
    kind: TrackKind;
    source: SubtitleTrack['source'];
  },
  manualCaps?: ManualCaps,
): SubtitleTrack | null {
  if (meta.kind === 'asr') {
    const tokens = parseAsrTokens(doc);
    if (tokens.length === 0) return null;
    return {
      videoId: meta.videoId,
      trackId: `${meta.languageCode}.asr`,
      languageCode: meta.languageCode,
      kind: 'asr',
      lines: chunkAsrTokens(tokens),
      tokens,
      source: meta.source,
    };
  }

  const cues = parseManualCues(doc);
  if (cues.length === 0) return null;
  return {
    videoId: meta.videoId,
    trackId: meta.languageCode,
    languageCode: meta.languageCode,
    kind: 'manual',
    lines: mergeManualCues(cues, manualCaps),
    source: meta.source,
  };
}

/** 从截获的 URL 上判断它是不是自动字幕轨、什么语言。 */
function describeInterceptedUrl(url: string): {
  languageCode: string;
  kind: TrackKind;
} {
  const base =
    typeof location !== 'undefined'
      ? location.origin
      : 'https://www.youtube.com';
  const params = new URL(url, base).searchParams;
  return {
    languageCode: params.get('lang') ?? 'en',
    kind: params.get('kind') === 'asr' ? 'asr' : 'manual',
  };
}

export const youtubeAdapter: SiteAdapter = {
  id: 'youtube',

  matches(url) {
    const u = new URL(url);
    return u.hostname.endsWith('youtube.com') && u.pathname === '/watch';
  },

  videoId() {
    return state.videoId ?? videoIdFromUrl();
  },

  findVideo() {
    return document.querySelector<HTMLVideoElement>(
      '#movie_player video, video.html5-main-video',
    );
  },

  overlayContainer() {
    return document.querySelector<HTMLElement>('#movie_player');
  },

  hideNativeSubtitles() {
    // 用样式表而不是改元素的 style：字幕容器会被播放器反复重建，
    // 改在元素上的样式跟着元素一起没了，原生字幕就会再冒出来
    // 和我们的叠成两层。样式表挂在 head 上，重建多少次都压得住。
    const STYLE_ID = 'yt-bilingual-hide-native';
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.ytp-caption-window-container { display: none !important; }';
    document.head.appendChild(style);
  },

  restoreNativeSubtitles() {
    document.getElementById('yt-bilingual-hide-native')?.remove();
  },

  reset: resetPageState,

  async fetchSubtitles(signal, opts) {
    const videoId = this.videoId();
    if (!videoId) return null;

    // 截获路径和 playerResponse 路径的候选放在一起排序，而不是
    // 简单地"截获优先"。播放器可能正好请求的是自动字幕，
    // 而页面上其实有人工字幕 —— 那种情况下应该用人工的。
    for (const c of rankCandidates(state)) {
      try {
        const doc = await fetchJson3(toJson3Url(c.url), signal);
        const track = buildTrack(
          doc,
          {
            videoId,
            languageCode: c.languageCode,
            kind: c.kind,
            source: c.source,
          },
          opts?.manualCaps,
        );
        if (track) return track;
      } catch {
        // 换下一个候选，不中断整条链
      }
    }

    // 最后兜底：原生 textTracks。YouTube 通常自己渲染字幕不挂 track，
    // 这条基本不会命中，留给以后的其他站点复用。
    return readNativeTextTrack(videoId, this.findVideo());
  },
};

interface RankedCandidate {
  url: string;
  languageCode: string;
  kind: TrackKind;
  source: 'intercepted' | 'player-response';
}

/**
 * 候选排序：
 *  1. 人工字幕优先于自动字幕 —— 有标点、断句正确，翻译质量差一个档次
 *  2. 同类型里截获的优先 —— URL 参数一定有效，不受 YouTube 改协议影响
 */
export function rankCandidates(page: {
  tracks: TrackCandidate[];
  interceptedUrls: string[];
}): RankedCandidate[] {
  const out: RankedCandidate[] = [];

  // 后截获的更可能对应当前视频，所以倒序
  for (const url of [...page.interceptedUrls].reverse()) {
    out.push({ url, ...describeInterceptedUrl(url), source: 'intercepted' });
  }

  for (const t of page.tracks) {
    if (!t.languageCode.startsWith('en')) continue;
    out.push({
      url: t.baseUrl,
      languageCode: t.languageCode || 'en',
      kind: t.kind === 'asr' ? 'asr' : 'manual',
      source: 'player-response',
    });
  }

  const score = (c: RankedCandidate) =>
    (c.kind === 'manual' ? 0 : 10) + (c.source === 'intercepted' ? 0 : 1);

  return out
    .filter((c) => c.languageCode.startsWith('en'))
    .sort((a, b) => score(a) - score(b));
}

function readNativeTextTrack(
  videoId: string,
  video: HTMLVideoElement | null,
): SubtitleTrack | null {
  if (!video) return null;
  const textTrack = [...video.textTracks].find(
    (t) => t.cues && t.cues.length > 0,
  );
  if (!textTrack?.cues) return null;

  const cues = [...textTrack.cues]
    .filter((c): c is VTTCue => 'text' in c)
    .map((c) => ({
      text: c.text.replace(/\s+/g, ' ').trim(),
      startMs: Math.round(c.startTime * 1000),
      endMs: Math.round(c.endTime * 1000),
    }))
    .filter((c) => c.text);

  if (cues.length === 0) return null;

  return {
    videoId,
    trackId: textTrack.language || 'en',
    languageCode: textTrack.language || 'en',
    kind: 'manual',
    lines: mergeManualCues(cues),
    source: 'text-tracks',
  };
}
