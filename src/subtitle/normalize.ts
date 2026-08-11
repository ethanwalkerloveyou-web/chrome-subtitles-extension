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

/**
 * 一句字幕在最后一个词「开始」之后最多再停留多久。
 *
 * 词级 token 的 endMs 接的是下一个词的开始，一旦这句后面跟着停顿，
 * 直接拿它当结束时间，字幕就会在静音里干挂到下一个词才消失（甚至压到
 * 下一句头上）。用这个上限把结束时间收紧，让字幕说完就走、跟得上音频。
 */
const DISPLAY_TAIL_MS = 1_200;

/** 人工字幕：两条 cue 之间的停顿超过这个值就断开，别把静音也并进一条里。 */
const MANUAL_PAUSE_MS = 1_200;

/** 句尾标点。中英文都覆盖，字幕里偶尔会混。 */
const SENTENCE_END = /[.!?。！？…]["')\]]?$/;

/** 从句边界（逗号分号等），软上限命中后在这里断，比硬切在词中间强。 */
const CLAUSE_END = /[,;:，；：]["')\]]?$/;

/**
 * 单条人工字幕的显示上限。即兴口语的句号可以隔十几秒才出现一次，
 * 只按句号切会垒出一堵文字墙。这几个值可由「每条字幕长度」设置调节。
 */
export interface ManualCaps {
  softChars: number;
  hardChars: number;
  softSpanMs: number;
  hardSpanMs: number;
}

/** 默认上限（对应「适中」档），不传 caps 时用它，保持老行为不变。 */
export const DEFAULT_MANUAL_CAPS: ManualCaps = {
  softChars: 120,
  hardChars: 200,
  softSpanMs: 7_000,
  hardSpanMs: 12_000,
};

/**
 * 人工字幕：把半句的 cue 合并成适合显示的行。
 *
 * 一条 cue 常常只是半句（"So the key insight" / "here is that attention..."），
 * 逐条翻译会丢主语、代词错乱，所以要合并。但合并必须有显示上限：
 * 句尾标点优先；软上限后遇到从句边界（逗号）就切；硬上限直接切 ——
 * 即兴口语的句号可能十几秒不出现，只等句号会合出一屏糊脸的大块。
 * caps 控制上限，让用户能把每条调短或调长。
 */
export function mergeManualCues(
  cues: Token[],
  caps: ManualCaps = DEFAULT_MANUAL_CAPS,
): SourceLine[] {
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
    // 和上一条之间隔了明显的停顿，就先收尾 —— 一句话被切成几条 cue 时它们
    // 是连着的，隔着长静音的多半是下一句了，并进来只会让字幕在静音里干挂
    const prev = buf[buf.length - 1];
    if (prev && cue.startMs - prev.endMs >= MANUAL_PAUSE_MS) flush();

    buf.push(cue);
    chars += cue.text.length + 1;
    const spanMs = cue.endMs - buf[0]!.startMs;

    const soft = spanMs >= caps.softSpanMs || chars >= caps.softChars;
    const hard = spanMs >= caps.hardSpanMs || chars >= caps.hardChars;

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

    const startMs = first?.startMs ?? 0;
    const rawEnd = last?.endMs ?? startMs;
    // 收紧结束时间：最多停到「最后一个词开始 + 余量」，不跟着 token 的
    // endMs 一路挂到下一个词（那样遇到停顿就会在静音里干挂）
    const endMs = Math.min(rawEnd, (last?.startMs ?? rawEnd) + DISPLAY_TAIL_MS);

    out.push({ startMs, endMs });
    cursor = end;
  }

  return out;
}
