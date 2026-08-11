/**
 * MAIN world 脚本 ↔ content script 的消息协议。
 *
 * 单独一个模块，是为了让 adapter 不必 import entrypoint —— entrypoint 里有
 * defineUnlistedScript 这类只有 WXT 注入时才存在的全局，被别处 import 会炸。
 */

import type { TrackCandidate } from './types.ts';

export const MAIN_WORLD_SOURCE = 'yt-bilingual/main';

export type MainWorldMessage =
  | { source: typeof MAIN_WORLD_SOURCE; type: 'TIMEDTEXT_URL'; url: string }
  | {
      source: typeof MAIN_WORLD_SOURCE;
      type: 'PLAYER_RESPONSE';
      videoId: string | null;
      tracks: TrackCandidate[];
      /** playerResponse 是从哪个来源读到的，排查时用。 */
      from: string;
    };

/** content script 请求 MAIN world 重新读一次 playerResponse。 */
export const REQUEST_PLAYER_RESPONSE = 'REQUEST_PLAYER_RESPONSE';

/**
 * content script 往页面世界推的调试快照。
 *
 * content script 跑在 isolated world，它挂在 window 上的东西在 devtools
 * 的默认 Console 上下文里是看不到的 —— 排查时几乎必踩这个坑。
 * 所以把状态搬到页面世界，让 __ytBilingual 直接可用。
 */
export const DEBUG_STATE = 'YT_BILINGUAL_DEBUG_STATE';

export interface DebugState {
  adapter: string | null;
  track: unknown;
  lines: unknown[];
  snapshot: unknown;
}
