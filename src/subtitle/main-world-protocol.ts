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
    };

/** content script 请求 MAIN world 重新读一次 playerResponse。 */
export const REQUEST_PLAYER_RESPONSE = 'REQUEST_PLAYER_RESPONSE';
