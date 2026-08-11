/**
 * 解析 YouTube 的 timedtext json3 格式。
 *
 * 人工字幕和自动字幕在同一个格式里，但结构差别很大：
 *
 * 人工字幕 —— 一个 event 就是一条完整字幕，segs 里是整句：
 *   { tStartMs: 1200, dDurationMs: 2400, segs: [{ utf8: "So the key insight..." }] }
 *
 * 自动字幕 —— 词级时间戳，且带滚动重复：
 *   { tStartMs: 1000, dDurationMs: 2000, segs: [
 *       { utf8: "so",  tOffsetMs: 0 },
 *       { utf8: " the", tOffsetMs: 220 },
 *   ]}
 *   { tStartMs: 1500, aAppend: 1, segs: [{ utf8: "\n" }] }   ← 这条是滚动窗口的产物
 */

import type { Token } from './types.ts';

export interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
  acAsrConf?: number;
}

export interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Seg[];
  /** aAppend: 1 表示"追加到上一个窗口"，是滚动字幕的产物，不是新内容。 */
  aAppend?: number;
  wWinId?: number;
}

export interface Json3Doc {
  events?: Json3Event[];
}

/**
 * 给 timedtext 的 baseUrl 加上 fmt=json3。
 *
 * base 参数只在 baseUrl 是相对路径时才用得上，默认取当前页面 origin；
 * 显式传入是为了让这个函数在浏览器之外也能测。
 */
export function toJson3Url(
  baseUrl: string,
  base: string = typeof location !== 'undefined'
    ? location.origin
    : 'https://www.youtube.com',
): string {
  const url = new URL(baseUrl, base);
  url.searchParams.set('fmt', 'json3');
  return url.toString();
}

function isBlank(s: string | undefined): boolean {
  return !s || s.trim().length === 0;
}

/**
 * 自动字幕 → 词级 token 流。
 *
 * 三步去噪：
 *  1. 丢掉 aAppend 事件（滚动窗口的重复内容）
 *  2. 丢掉纯空白 / 换行的 seg（窗口排版用的）
 *  3. 按 (绝对起始时间, 文本) 去重 —— 同一个词在滚动过程中会被重复下发
 */
export function parseAsrTokens(doc: Json3Doc): Token[] {
  const tokens: Token[] = [];
  const seen = new Set<string>();

  for (const event of doc.events ?? []) {
    if (event.aAppend === 1) continue;
    const base = event.tStartMs ?? 0;

    for (const seg of event.segs ?? []) {
      if (isBlank(seg.utf8)) continue;
      const startMs = base + (seg.tOffsetMs ?? 0);
      const text = seg.utf8!;

      const key = `${startMs} ${text}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // endMs 先占位，下一轮用后继 token 的起点回填
      tokens.push({ text, startMs, endMs: startMs });
    }
  }

  tokens.sort((a, b) => a.startMs - b.startMs);

  // 每个 token 的结束时间 = 下一个 token 的开始时间；最后一个给个合理的兜底
  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i]!;
    const next = tokens[i + 1];
    cur.endMs = next ? Math.max(cur.startMs, next.startMs) : cur.startMs + 600;
  }

  return tokens;
}

/** 人工字幕 → 每个 event 一条，文本是 segs 拼接。 */
export function parseManualCues(doc: Json3Doc): Token[] {
  const cues: Token[] = [];

  for (const event of doc.events ?? []) {
    const text = (event.segs ?? [])
      .map((s) => s.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;

    const startMs = event.tStartMs ?? 0;
    cues.push({
      text,
      startMs,
      endMs: startMs + (event.dDurationMs ?? 2000),
    });
  }

  cues.sort((a, b) => a.startMs - b.startMs);
  return cues;
}
