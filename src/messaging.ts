/** content script / options page ↔ service worker 之间的消息协议。 */

import type { LlmSettings } from './store/settings.ts';

export interface TestConnectionRequest {
  type: 'TEST_CONNECTION';
  llm: LlmSettings;
}

export interface TestConnectionResult {
  ok: boolean;
  /** 成功时是模型的回复片段，失败时是错误说明。 */
  detail: string;
  /** 往返耗时（ms），用于判断供应商是否卡。 */
  latencyMs?: number;
}

export type Request = TestConnectionRequest;

export function sendMessage<T>(req: Request): Promise<T> {
  return chrome.runtime.sendMessage(req) as Promise<T>;
}
