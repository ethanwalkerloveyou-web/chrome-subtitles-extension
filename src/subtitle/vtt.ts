/**
 * WebVTT 解析。
 *
 * X / Twitter 的字幕走 HLS 的 subtitle track，最终是一串 .vtt 分片，
 * 和 YouTube 的 json3 完全是两套格式。
 */

import type { Token } from './types.ts';

/** `00:01:02.500` 或 `01:02.500` → 毫秒。 */
export function parseTimestamp(s: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(s.trim());
  if (!m) return null;
  const [, h, min, sec, frac] = m;
  return (
    Number(h ?? 0) * 3600_000 +
    Number(min) * 60_000 +
    Number(sec) * 1000 +
    Number((frac ?? '0').padEnd(3, '0'))
  );
}

/** 去掉 <v Speaker>、<c.classname>、<00:00:01.000> 这类内联标签。 */
function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析一个 .vtt 文件的所有 cue。
 *
 * HLS 分片里每个 .vtt 都可能带 X-TIMESTAMP-MAP 做时间偏移，
 * offsetMs 由调用方按分片顺序传进来。
 */
export function parseVtt(text: string, offsetMs = 0): Token[] {
  const cues: Token[] = [];
  // \r\n 和 \n 混用很常见
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    // 时间行可能是第一行，也可能第一行是 cue 标识符
    const timeIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeIndex < 0) continue;

    const [rawStart, rawRest] = lines[timeIndex]!.split('-->');
    if (!rawStart || !rawRest) continue;
    // 时间行后面可能跟着 position/align 之类的设置
    const rawEnd = rawRest.trim().split(/\s+/)[0]!;

    const startMs = parseTimestamp(rawStart);
    const endMs = parseTimestamp(rawEnd);
    if (startMs === null || endMs === null) continue;

    const text = stripTags(lines.slice(timeIndex + 1).join(' '));
    if (!text) continue;

    cues.push({
      text,
      startMs: startMs + offsetMs,
      endMs: endMs + offsetMs,
    });
  }

  return cues;
}

/**
 * 合并多个分片的 cue 并去重。
 *
 * HLS 的相邻分片会重复边界上的 cue，不去重会看到同一句显示两遍。
 */
export function mergeVttCues(groups: Token[][]): Token[] {
  const seen = new Set<string>();
  const out: Token[] = [];

  for (const cues of groups) {
    for (const cue of cues) {
      const key = `${cue.startMs}|${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cue);
    }
  }

  return out.sort((a, b) => a.startMs - b.startMs);
}
