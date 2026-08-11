/**
 * 站点适配器。
 *
 * 整个项目里只有这一层知道"我在哪个网站上"。翻译、渲染、缓存都不认站点，
 * 所以加一个新网站等于加一个这个接口的实现。
 */

import type { SubtitleTrack } from '../subtitle/types.ts';

export interface SiteAdapter {
  readonly id: string;

  /** 当前 URL 是不是这个站点的播放页。 */
  matches(url: string): boolean;

  /** 当前页面的视频 ID，用作缓存 key。拿不到返回 null。 */
  videoId(): string | null;

  /** 页面上的 <video> 元素。 */
  findVideo(): HTMLVideoElement | null;

  /**
   * 字幕层要挂到哪个元素里。
   *
   * 必须选播放器容器而不是 body —— 全屏时浏览器只把这个容器提到全屏层，
   * 挂在 body 上的字幕会整个消失。
   */
  overlayContainer(): HTMLElement | null;

  /** 取英文字幕轨。没有可用字幕时返回 null。 */
  fetchSubtitles(signal?: AbortSignal): Promise<SubtitleTrack | null>;

  /** 关掉站点自带的字幕，避免和我们的覆盖层重叠。 */
  hideNativeSubtitles(): void;

  /** SPA 导航到新视频时清空上一支的残留状态。 */
  reset?(): void;
}
