/**
 * 最近一次取字幕的结果。
 *
 * 两个用途：
 *  - popup 里显示状态（✓ 双语字幕 / ⚠ 无字幕轨 / ✕ 出错）
 *  - 集成测试从扩展页面读取，验证 content script 真的跑通了
 *    （content script 在 isolated world，测试脚本没法直接读它的变量）
 */

import type { SubtitleTrack } from '../subtitle/types.ts';

const KEY = 'lastTrack';

export interface TrackDiagnostics {
  videoId: string | null;
  found: boolean;
  trackId?: string;
  kind?: SubtitleTrack['kind'];
  source?: SubtitleTrack['source'];
  lineCount?: number;
  tokenCount?: number;
  /** 第一段文本，用来一眼看出内容对不对。 */
  firstLine?: string;
  at: number;
}

export async function recordTrack(
  videoId: string | null,
  track: SubtitleTrack | null,
): Promise<void> {
  const diag: TrackDiagnostics = track
    ? {
        videoId,
        found: true,
        trackId: track.trackId,
        kind: track.kind,
        source: track.source,
        lineCount: track.lines.length,
        tokenCount: track.tokens?.length,
        firstLine: track.lines[0]?.text.slice(0, 120),
        at: Date.now(),
      }
    : { videoId, found: false, at: Date.now() };

  await chrome.storage.local.set({ [KEY]: diag });
}

export async function readTrackDiagnostics(): Promise<TrackDiagnostics | null> {
  const raw = await chrome.storage.local.get(KEY);
  return (raw[KEY] as TrackDiagnostics) ?? null;
}
