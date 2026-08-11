/**
 * service worker 侧的翻译服务。
 *
 * content script 建立一条长连接，SW 在上面回传增量结果和进度。
 * 用 port 而不是一次性消息有两个原因：
 *  1. 长连接能让 SW 不被 30 秒空闲回收掉，翻到一半不会断
 *  2. 每翻完一批就推回去，字幕能尽快显示，不必等全片翻完
 */

import { cacheKey, hashString, readCache, writeCache } from '../store/cache.ts';
import { activeCredentials, type Settings } from '../store/settings.ts';
import type { SubtitleTrack } from '../subtitle/types.ts';
import { translateTrack } from './pipeline.ts';
import { PROMPT_VERSION } from './prompt.ts';
import { createProvider } from './providers.ts';
import type { Progress, RenderLine } from './types.ts';

export const TRANSLATE_PORT = 'translate';

export type ToWorker =
  | { type: 'START'; track: SubtitleTrack; settings: Settings }
  | { type: 'TIME'; ms: number }
  | { type: 'STOP' };

export type FromWorker =
  | { type: 'LINES'; lines: RenderLine[]; replace?: boolean }
  | { type: 'PROGRESS'; progress: Progress }
  | { type: 'ERROR'; message: string };

function keyFor(track: SubtitleTrack, settings: Settings): string {
  return cacheKey({
    videoId: track.videoId,
    trackId: track.trackId,
    targetLang: settings.translation.targetLang,
    model: activeCredentials(settings.llm).model,
    promptVersion: PROMPT_VERSION,
    // 自定义提示词也算提示词变化，改了就不复用旧译文
    promptHash: hashString(settings.translation.systemPrompt.trim()),
    lineLength: settings.translation.lineLength,
  });
}

export function handleTranslatePort(port: chrome.runtime.Port): void {
  const abort = new AbortController();
  let currentTimeMs = 0;

  const send = (msg: FromWorker) => {
    try {
      port.postMessage(msg);
    } catch {
      // 页面已经关了，忽略
    }
  };

  port.onDisconnect.addListener(() => abort.abort());

  port.onMessage.addListener((msg: ToWorker) => {
    if (msg.type === 'TIME') {
      currentTimeMs = msg.ms;
      return;
    }
    if (msg.type === 'STOP') {
      abort.abort();
      return;
    }
    if (msg.type === 'START') {
      void run(msg.track, msg.settings);
    }
  });

  async function run(track: SubtitleTrack, settings: Settings): Promise<void> {
    const key = keyFor(track, settings);

    const cached = await readCache(key);
    if (cached && cached.status === 'complete') {
      send({ type: 'LINES', lines: cached.lines, replace: true });
      send({
        type: 'PROGRESS',
        progress: { done: 1, total: 1, status: 'complete' },
      });
      return;
    }

    const { apiKey } = activeCredentials(settings.llm);
    if (!apiKey) {
      send({ type: 'ERROR', message: '还没有配置 API Key，去设置页填一下' });
      return;
    }

    // 有部分缓存就先显示出来，剩下的继续翻
    if (cached && cached.lines.length > 0) {
      send({ type: 'LINES', lines: cached.lines, replace: true });
    }

    const collected: RenderLine[] = [];

    try {
      const result = await translateTrack({
        track,
        settings,
        provider: createProvider(settings.llm),
        signal: abort.signal,
        currentTimeMs: () => currentTimeMs,
        onBatch: (lines) => {
          collected.push(...lines);
          send({ type: 'LINES', lines });
        },
        onProgress: (progress) => send({ type: 'PROGRESS', progress }),
      });

      await writeCache({
        key,
        videoId: track.videoId,
        lines: result.lines,
        // 有失败批次就只算 partial —— 之前失败也存成 complete，
        // Key 配错的那次「全英文」结果会永久霸占缓存，修好 Key 也没用
        status: result.failedBatches === 0 ? 'complete' : 'partial',
        model: activeCredentials(settings.llm).model,
        promptVersion: PROMPT_VERSION,
        updatedAt: Date.now(),
      });

      if (result.failedBatches > 0) {
        send({
          type: 'ERROR',
          message:
            `${result.failedBatches} 批翻译失败（已用英文原文顶替）：` +
            result.lastError,
        });
      }
    } catch (err) {
      if (abort.signal.aborted) return;

      // 翻到一半失败也把已完成的部分存下来，下次接着翻
      if (collected.length > 0) {
        await writeCache({
          key,
          videoId: track.videoId,
          lines: collected.sort((a, b) => a.startMs - b.startMs),
          status: 'partial',
          model: activeCredentials(settings.llm).model,
          promptVersion: PROMPT_VERSION,
          updatedAt: Date.now(),
        });
      }
      send({
        type: 'ERROR',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
