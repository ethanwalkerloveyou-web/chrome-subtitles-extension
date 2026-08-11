/**
 * 翻译管线：分批 → 并发 → 按播放位置优先 → 失败拆半重试 → 增量回填。
 *
 * 跑在 service worker 里。content script 不能跨域请求（受页面 CORS 约束），
 * 而且 API Key 也不该出现在页面所在的进程里。
 */

import { alignSentencesToTokens } from '../subtitle/normalize.ts';
import type { SourceLine, SubtitleTrack } from '../subtitle/types.ts';
import type { Settings } from '../store/settings.ts';
import type {
  BatchRequest,
  ModelLine,
  Progress,
  RenderLine,
  TranslationProvider,
} from './types.ts';

/** 一批的字符预算。batchSize 是「多少条字幕」，换算成字符更好控制单批大小。 */
const CHARS_PER_LINE = 75;

/** 上文取多少字符。太多会浪费 token，太少代词会翻错。 */
const CONTEXT_CHARS = 300;

interface Batch {
  index: number;
  lines: SourceLine[];
}

/** 按字符预算分批。人工字幕和自动字幕用同一套逻辑。 */
export function planBatches(lines: SourceLine[], batchSize: number): Batch[] {
  const budget = Math.max(300, batchSize * CHARS_PER_LINE);
  const batches: Batch[] = [];
  let current: SourceLine[] = [];
  let chars = 0;

  for (const line of lines) {
    // 单条就超预算时也要自成一批，不能丢
    if (current.length > 0 && chars + line.text.length > budget) {
      batches.push({ index: batches.length, lines: current });
      current = [];
      chars = 0;
    }
    current.push(line);
    chars += line.text.length;
  }
  if (current.length > 0) batches.push({ index: batches.length, lines: current });

  return batches;
}

/**
 * 按「离当前播放位置多远」给批次排序。
 *
 * 这是「3 秒就能开始看」的关键：先翻正在播的那一段，再往后预取，
 * 最后回填前面的。整片翻完的总时间不变，但可用时间从 25 秒降到 3 秒。
 */
export function prioritize(batches: Batch[], currentMs: number): Batch[] {
  return [...batches].sort((a, b) => cost(a) - cost(b));

  function cost(batch: Batch): number {
    const start = batch.lines[0]?.startMs ?? 0;
    const end = batch.lines[batch.lines.length - 1]?.endMs ?? start;
    if (currentMs >= start && currentMs <= end) return 0; // 正在播
    // 后面的比前面的重要：往后是马上要看的，往前是已经看过的
    return currentMs < start
      ? start - currentMs
      : (currentMs - end) * 4 + 1;
  }
}

function buildRequest(
  batch: Batch,
  track: SubtitleTrack,
  settings: Settings,
  allLines: SourceLine[],
): BatchRequest {
  const firstId = batch.lines[0]?.id ?? 0;
  const context = allLines
    .filter((l) => l.id < firstId)
    .slice(-4)
    .map((l) => l.text)
    .join(' ')
    .slice(-CONTEXT_CHARS);

  return {
    lines: batch.lines,
    kind: track.kind,
    context,
    targetLang: settings.translation.targetLang,
    domain: settings.translation.domain,
    glossary: settings.translation.glossary,
  };
}

/**
 * 把模型返回的内容映射回时间轴。
 *
 * 人工字幕按 id 一一对应；自动字幕由模型重新断了句，靠词级时间戳对齐 ——
 * 按字符比例估算在语速不均时会差好几秒。
 */
export function mapToRenderLines(
  batch: Batch,
  modelLines: ModelLine[],
  track: SubtitleTrack,
): RenderLine[] {
  if (track.kind === 'manual') {
    const byId = new Map(batch.lines.map((l) => [l.id, l]));
    return modelLines
      .map((m) => {
        const src = m.id !== undefined ? byId.get(m.id) : undefined;
        if (!src) return null;
        return {
          startMs: src.startMs,
          endMs: src.endMs,
          en: m.en || src.text,
          zh: m.zh,
          hard: m.hard,
        };
      })
      .filter((l): l is RenderLine => l !== null);
  }

  // 自动字幕：模型重新断句，用词级时间戳把每句定位回去
  const tokens = track.tokens ?? [];
  const batchStart = batch.lines[0]?.startMs ?? 0;
  const batchEnd = batch.lines[batch.lines.length - 1]?.endMs ?? batchStart;
  const windowTokens = tokens.filter(
    (t) => t.startMs >= batchStart - 1 && t.endMs <= batchEnd + 1,
  );

  const spans = alignSentencesToTokens(
    modelLines.map((m) => m.en),
    windowTokens.length > 0 ? windowTokens : tokens,
  );

  return modelLines.map((m, i) => ({
    startMs: spans[i]?.startMs ?? batchStart,
    endMs: spans[i]?.endMs ?? batchEnd,
    en: m.en,
    zh: m.zh,
    hard: m.hard,
  }));
}

/** 失败统计。退化成英文原文不能无声无息，要能报告出去。 */
export interface FailureStats {
  failedBatches: number;
  lastError: string;
}

/**
 * 翻一批，失败就拆半重试。
 *
 * 拆半而不是简单重试：失败往往是因为这批太长导致输出被截断，
 * 或者某一条内容让模型返回了不合规的 JSON。拆小之后两种情况都会缓解。
 *
 * 最终仍失败时退化成只显示英文原文（总比整段消失强），但必须记进
 * stats —— 之前这里静默吞掉错误，Key 配错时整片"翻译成功"却全是英文，
 * 用户完全不知道出了什么事，坏结果还会进缓存。
 */
async function translateWithSplit(
  batch: Batch,
  provider: TranslationProvider,
  track: SubtitleTrack,
  settings: Settings,
  allLines: SourceLine[],
  signal: AbortSignal,
  stats: FailureStats,
  depth = 0,
): Promise<RenderLine[]> {
  try {
    const req = buildRequest(batch, track, settings, allLines);
    const modelLines = await provider.translateBatch(req, signal);
    if (modelLines.length === 0) throw new Error('模型返回空结果');
    return mapToRenderLines(batch, modelLines, track);
  } catch (err) {
    if (signal.aborted) throw err;
    if (depth >= 2 || batch.lines.length <= 1) {
      stats.failedBatches++;
      stats.lastError = err instanceof Error ? err.message : String(err);
      return batch.lines.map((l) => ({
        startMs: l.startMs,
        endMs: l.endMs,
        en: l.text,
        zh: '',
        hard: [],
      }));
    }

    const mid = Math.ceil(batch.lines.length / 2);
    const halves: Batch[] = [
      { index: batch.index, lines: batch.lines.slice(0, mid) },
      { index: batch.index, lines: batch.lines.slice(mid) },
    ];
    const results = await Promise.all(
      halves.map((h) =>
        translateWithSplit(h, provider, track, settings, allLines, signal, stats, depth + 1),
      ),
    );
    return results.flat();
  }
}

export interface TranslateOptions {
  track: SubtitleTrack;
  settings: Settings;
  provider: TranslationProvider;
  signal: AbortSignal;
  /** 当前播放位置，用于批次优先级。拿不到就当 0。 */
  currentTimeMs: () => number;
  /** 每批完成时回调，让字幕尽快显示出来，不必等全片翻完。 */
  onBatch: (lines: RenderLine[]) => void;
  onProgress: (p: Progress) => void;
}

export interface TranslateResult {
  lines: RenderLine[];
  /** 拆半重试后仍然失败、退化成英文原文的批次数。 */
  failedBatches: number;
  lastError: string;
}

export async function translateTrack(
  opts: TranslateOptions,
): Promise<TranslateResult> {
  const { track, settings, provider, signal } = opts;
  const all = track.lines;
  const batches = planBatches(all, settings.llm.batchSize);
  const stats: FailureStats = { failedBatches: 0, lastError: '' };

  const results: RenderLine[][] = new Array(batches.length).fill(null);
  let done = 0;

  opts.onProgress({ done: 0, total: batches.length, status: 'running' });

  // 每次取任务时重新按当前播放位置排序 —— 用户可能在翻译过程中拖了进度条
  const pending = new Set(batches.map((b) => b.index));
  const byIndex = new Map(batches.map((b) => [b.index, b]));

  function takeNext(): Batch | null {
    if (pending.size === 0) return null;
    const remaining = [...pending].map((i) => byIndex.get(i)!);
    const best = prioritize(remaining, opts.currentTimeMs())[0]!;
    pending.delete(best.index);
    return best;
  }

  async function worker(): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const batch = takeNext();
      if (!batch) return;

      const lines = await translateWithSplit(
        batch,
        provider,
        track,
        settings,
        all,
        signal,
        stats,
      );
      results[batch.index] = lines;
      done++;
      opts.onBatch(lines);
      opts.onProgress({ done, total: batches.length, status: 'running' });
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(settings.llm.concurrency, batches.length)) },
    () => worker(),
  );

  try {
    await Promise.all(workers);
  } catch (err) {
    opts.onProgress({
      done,
      total: batches.length,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  opts.onProgress({ done, total: batches.length, status: 'complete' });

  // 按时间排序：批次是乱序完成的，但渲染需要有序数组做二分查找
  return {
    lines: results
      .filter(Boolean)
      .flat()
      .sort((a, b) => a.startMs - b.startMs),
    failedBatches: stats.failedBatches,
    lastError: stats.lastError,
  };
}
