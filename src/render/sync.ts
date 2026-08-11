/**
 * 字幕与播放进度的同步。
 *
 * 用 requestAnimationFrame 读 video.currentTime，不用 timeupdate 事件 ——
 * timeupdate 只有约 4Hz，字幕切换会明显一顿一顿的。
 */

import type { RenderLine } from '../translate/types.ts';

/**
 * 把新翻好的一段合并进现有字幕，按时间覆盖。
 *
 * 用途是「流式」显示：一开始先用英文原文把整条时间轴铺好（占位），
 * 每批译文回来后，就用它盖掉自己时间范围内的占位行 —— 于是字幕从第 0 秒起
 * 就跟着人声走，译文翻到哪补到哪，而不是干等整批翻完才「唰」地刷出一大片。
 *
 * incoming 覆盖它 [最早 start, 最晚 end] 这个区间：区间内的旧行（占位或上一版
 * 译文）整体清掉换成 incoming，区间外的旧行原样保留。incoming 为空则不动。
 */
export function mergeRenderLines(
  base: RenderLine[],
  incoming: RenderLine[],
): RenderLine[] {
  if (incoming.length === 0) return [...base].sort(byStart);

  let lo = Infinity;
  let hi = -Infinity;
  for (const l of incoming) {
    if (l.startMs < lo) lo = l.startMs;
    if (l.endMs > hi) hi = l.endMs;
  }

  // 与 [lo, hi) 有重叠的旧行让位给 incoming；其余保留
  const kept = base.filter((l) => l.endMs <= lo || l.startMs >= hi);
  return [...kept, ...incoming].sort(byStart);
}

function byStart(a: RenderLine, b: RenderLine): number {
  return a.startMs - b.startMs;
}

/** 在有序数组里找当前时间对应的那一行。 */
export function findLineAt(
  lines: RenderLine[],
  timeMs: number,
  hint = 0,
): number {
  if (lines.length === 0) return -1;

  // 大多数帧里时间只前进了一点，先看上次的位置和它后面一条，
  // 命中就是 O(1)，避免每帧做二分
  for (const i of [hint, hint + 1]) {
    const line = lines[i];
    if (line && timeMs >= line.startMs && timeMs < line.endMs) return i;
  }

  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = lines[mid]!;
    if (timeMs < line.startMs) hi = mid - 1;
    else if (timeMs >= line.endMs) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export class SubtitleSync {
  private rafId = 0;
  private lines: RenderLine[] = [];

  /**
   * 这两个必须分开。
   *
   * 之前用同一个变量既当查找起点又当"当前显示的是第几行"，而它初始化为 0，
   * 恰好和第一行的索引相同 —— 于是第一行永远被当成"没变化"跳过，一句都不显示。
   */
  private hint = 0;
  /** 当前显示的行；-1 表示什么都没显示。 */
  private shown = -1;

  private readonly video: HTMLVideoElement;
  private readonly onChange: (line: RenderLine | null) => void;

  constructor(
    video: HTMLVideoElement,
    onChange: (line: RenderLine | null) => void,
  ) {
    this.video = video;
    this.onChange = onChange;
  }

  setLines(lines: RenderLine[]): void {
    this.lines = lines;
    this.hint = 0;
    this.shown = -1;
    // 数据变了要立刻反映到画面上，不能等下一次时间推进
    this.tick(true);
  }

  start(): void {
    if (this.rafId) return;
    const loop = () => {
      this.tick();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  get currentTimeMs(): number {
    return this.video.currentTime * 1000;
  }

  private tick(force = false): void {
    const index = findLineAt(this.lines, this.currentTimeMs, this.hint);
    // 命中时把查找起点挪过去；没命中就保留上次的位置继续做局部命中尝试
    if (index >= 0) this.hint = index;

    if (index === this.shown && !force) return;
    this.shown = index;
    this.onChange(index < 0 ? null : (this.lines[index] ?? null));
  }
}
