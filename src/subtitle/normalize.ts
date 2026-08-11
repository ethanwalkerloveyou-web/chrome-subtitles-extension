/**
 * 把解析出来的原始字幕整理成可以送给模型的形状。
 *
 * 两条路径差别很大：
 *
 *  - 人工字幕有标点，按句号问号叹号合并成完整句子就行
 *  - 自动字幕没有标点、切分随机，本地不做断句（规则断句效果差），
 *    只按停顿粗切成 15~30 秒的段，断句交给模型在翻译时一起做
 */

import type { SourceLine, Token } from './types.ts';

// 自动字幕分段参数
const PAUSE_GAP_MS = 700; // 超过这个停顿视为可切分点
const MIN_CHUNK_MS = 12_000; // 短于这个不切，避免碎片
const MAX_CHUNK_MS = 30_000; // 超过这个强制切，避免单批太大

/** 句尾标点。中英文都覆盖，字幕里偶尔会混。 */
const SENTENCE_END = /[.!?。！？…]["')\]]?$/;

/** 从句边界（逗号分号等），软上限命中后在这里断，比硬切在词中间强。 */
const CLAUSE_END = /[,;:，；：]["')\]]?$/;

// 单条字幕的显示上限。即兴口语的句号可以隔十几秒才出现一次，
// 只按句号切会垒出一堵 30 秒的文字墙，一次糊满整个播放器。
const SOFT_SPAN_MS = 7_000;
const HARD_SPAN_MS = 12_000;
const SOFT_CHARS = 120;
const HARD_CHARS = 200;

/**
 * 人工字幕：把半句的 cue 合并成适合显示的行。
 *
 * 一条 cue 常常只是半句（"So the key insight" / "here is that attention..."），
 * 逐条翻译会丢主语、代词错乱，所以要合并。但合并必须有显示上限：
 * 句尾标点优先；软上限后遇到从句边界（逗号）就切；硬上限直接切 ——
 * 即兴口语的句号可能十几秒不出现，只等句号会合出一屏糊脸的大块。
 */
export function mergeManualCues(cues: Token[]): SourceLine[] {
  const lines: SourceLine[] = [];
  let buf: Token[] = [];
  let chars = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf
      .map((c) => c.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) {
      lines.push({
        id: lines.length,
        text,
        startMs: buf[0]!.startMs,
        endMs: buf[buf.length - 1]!.endMs,
      });
    }
    buf = [];
    chars = 0;
  };

  for (const cue of cues) {
    buf.push(cue);
    chars += cue.text.length + 1;
    const spanMs = cue.endMs - buf[0]!.startMs;

    const soft = spanMs >= SOFT_SPAN_MS || chars >= SOFT_CHARS;
    const hard = spanMs >= HARD_SPAN_MS || chars >= HARD_CHARS;

    if (
      SENTENCE_END.test(cue.text) ||
      hard ||
      (soft && CLAUSE_END.test(cue.text))
    ) {
      flush();
    }
  }
  flush();

  return lines;
}

/**
 * 自动字幕：按停顿把词流切成段。
 *
 * 切点优先选真实停顿（说话人换气处），这样模型拿到的段落边界
 * 更接近语义边界，断句质量更好。
 */
export function chunkAsrTokens(tokens: Token[]): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;

  const emit = (from: number, to: number) => {
    if (to <= from) return;
    const slice = tokens.slice(from, to);
    const text = slice
      .map((t) => t.text)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return;
    lines.push({
      id: lines.length,
      text,
      startMs: slice[0]!.startMs,
      endMs: slice[slice.length - 1]!.endMs,
    });
  };

  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1]!;
    const cur = tokens[i]!;
    const spanMs = prev.endMs - tokens[start]!.startMs;
    const gapMs = cur.startMs - prev.endMs;

    const atPause = gapMs >= PAUSE_GAP_MS && spanMs >= MIN_CHUNK_MS;
    const tooLong = spanMs >= MAX_CHUNK_MS;

    if (atPause || tooLong) {
      emit(start, i);
      start = i;
    }
  }
  emit(start, tokens.length);

  return lines;
}

/**
 * 把模型断好的句子映射回时间轴。
 *
 * M3 会用到：模型返回的是重新断句后的英文，字符位置和原 token 流对得上，
 * 所以按累计字符长度找到对应的 token，取它的时间戳。
 * 比按比例估算准得多 —— 语速不均匀时按比例会错好几秒。
 */
export function alignSentencesToTokens(
  sentences: string[],
  tokens: Token[],
): { startMs: number; endMs: number }[] {
  // 把 token 流拼成一个规范化字符串，同时记录每个字符属于哪个 token
  const charToToken: number[] = [];
  let flat = '';
  tokens.forEach((token, i) => {
    const normalized = token.text.replace(/\s+/g, '');
    for (let c = 0; c < normalized.length; c++) charToToken.push(i);
    flat += normalized;
  });

  const out: { startMs: number; endMs: number }[] = [];
  let cursor = 0;

  for (const sentence of sentences) {
    const needle = sentence.replace(/\s+/g, '');
    // 优先在游标之后精确匹配；模型可能改了标点，所以退化为按长度推进
    let at = flat.indexOf(needle, cursor);
    if (at < 0) at = cursor;
    const end = Math.min(at + needle.length, charToToken.length);

    const first = tokens[charToToken[at] ?? 0];
    const last = tokens[charToToken[Math.max(at, end - 1)] ?? tokens.length - 1];

    out.push({
      startMs: first?.startMs ?? 0,
      endMs: last?.endMs ?? first?.startMs ?? 0,
    });
    cursor = end;
  }

  return out;
}
