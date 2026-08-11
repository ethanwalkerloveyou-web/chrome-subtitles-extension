/**
 * 运行在 MAIN world（页面自己的 JS 环境）。
 *
 * 存在的唯一理由：content script 跑在 isolated world，读不到页面的
 * window.ytInitialPlayerResponse，也 hook 不了页面的 fetch。
 *
 * 这里只做两件事，然后通过 postMessage 把结果交给 content script：
 *  1. 截获播放器自己发出的 /api/timedtext 请求（最可靠的字幕来源）
 *  2. 读 ytInitialPlayerResponse 里的 captionTracks
 *
 * 注意：这个脚本在页面环境里，页面的代码能看到它。不要在这里碰 API Key
 * 或任何敏感数据 —— 它只负责搬运公开的字幕地址。
 */

import type { TrackCandidate } from '../subtitle/types.ts';
import {
  DEBUG_STATE,
  MAIN_WORLD_SOURCE,
  REQUEST_PLAYER_RESPONSE,
  type DebugState,
  type MainWorldMessage,
} from '../subtitle/main-world-protocol.ts';

function post(msg: MainWorldMessage) {
  window.postMessage(msg, location.origin);
}

/** 我们关心的字幕相关请求：YouTube 的 timedtext，以及 X 的 HLS 清单。 */
function isInteresting(url: string): boolean {
  return url.includes('/api/timedtext') || /\.m3u8(\?|$)/.test(url);
}

/**
 * Hook fetch 和 XHR，捕获播放器请求字幕的真实 URL。
 *
 * 为什么值得做：这个 URL 上带着签名 / pot 之类的参数，自己构造很容易失效，
 * 而播放器自己发的一定是对的。YouTube 改协议也不影响这条路。
 */
function interceptTimedText() {
  const origFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (isInteresting(url)) post({ source: MAIN_WORLD_SOURCE, type: 'TIMEDTEXT_URL', url });
    } catch {
      // 绝不能因为我们的探针让页面的 fetch 挂掉
    }
    return origFetch.call(this, input as RequestInfo, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    try {
      const s = typeof url === 'string' ? url : url.toString();
      if (isInteresting(s)) post({ source: MAIN_WORLD_SOURCE, type: 'TIMEDTEXT_URL', url: s });
    } catch {
      /* 同上 */
    }
    // @ts-expect-error 透传原始参数
    return origOpen.call(this, method, url, ...rest);
  };
}

interface PlayerResponse {
  videoDetails?: { videoId?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: {
        baseUrl?: string;
        languageCode?: string;
        kind?: string;
        name?: { simpleText?: string; runs?: { text?: string }[] };
      }[];
    };
  };
}

/**
 * 按可靠性依次尝试几个 playerResponse 的来源。
 *
 * `#movie_player.getPlayerResponse()` 排第一：它是播放器实例的当前状态，
 * SPA 切视频后一定是新的。而 window.ytInitialPlayerResponse 是首屏 HTML
 * 里那份，导航后不保证被更新 —— 只靠它会读到上一支视频的数据，或者读不到。
 */
function readPlayerResponse(): {
  pr: PlayerResponse | null;
  from: string;
} {
  const w = window as unknown as {
    ytInitialPlayerResponse?: PlayerResponse;
    ytplayer?: { config?: { args?: { player_response?: string } } };
  };

  const player = document.getElementById('movie_player') as unknown as {
    getPlayerResponse?: () => PlayerResponse;
  } | null;

  try {
    const pr = player?.getPlayerResponse?.();
    if (pr?.captions) return { pr, from: 'movie_player.getPlayerResponse' };
  } catch {
    // 播放器还没初始化完，往下试
  }

  if (w.ytInitialPlayerResponse?.captions) {
    return { pr: w.ytInitialPlayerResponse, from: 'ytInitialPlayerResponse' };
  }

  // 老版本播放器把 playerResponse 塞在这里，且是 JSON 字符串
  const legacy = w.ytplayer?.config?.args?.player_response;
  if (legacy) {
    try {
      return { pr: JSON.parse(legacy) as PlayerResponse, from: 'ytplayer.config' };
    } catch {
      // 解析失败就当没有
    }
  }

  // 都没有 captions 字段时，退回任何一个能拿到的，至少 videoId 是有的
  const fallback =
    (() => {
      try {
        return player?.getPlayerResponse?.() ?? null;
      } catch {
        return null;
      }
    })() ??
    w.ytInitialPlayerResponse ??
    null;

  return { pr: fallback, from: fallback ? 'fallback(无 captions 字段)' : '未找到' };
}

function extractTracks(pr: PlayerResponse | null): TrackCandidate[] {
  const raw =
    pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return raw
    .filter((t): t is typeof t & { baseUrl: string } => Boolean(t.baseUrl))
    .map((t) => ({
      baseUrl: t.baseUrl,
      languageCode: t.languageCode ?? '',
      kind: t.kind,
      name: t.name?.simpleText ?? t.name?.runs?.[0]?.text,
    }));
}

function publishPlayerResponse() {
  const { pr, from } = readPlayerResponse();
  post({
    source: MAIN_WORLD_SOURCE,
    type: 'PLAYER_RESPONSE',
    videoId: pr?.videoDetails?.videoId ?? null,
    tracks: extractTracks(pr),
    // 排查用：取不到字幕时要能分清是"没读到 playerResponse"
    // 还是"读到了但这个视频确实没有字幕轨"
    from,
  });
}

/**
 * SPA 导航后 ytInitialPlayerResponse 会被换掉，但没有可靠的事件说明
 * "新的已经就位了"。轮询几次比赌某个事件稳。
 */
function publishWithRetries() {
  let tries = 0;
  const timer = setInterval(() => {
    publishPlayerResponse();
    // 拿到带 captions 的响应才算就位；播放器初始化需要一点时间
    if (++tries >= 12 || readPlayerResponse().pr?.captions) clearInterval(timer);
  }, 250);
}

export default defineUnlistedScript(() => {
  interceptTimedText();
  publishPlayerResponse();

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;

    // content script 在导航后要求重新读一次
    if (e.data?.type === REQUEST_PLAYER_RESPONSE) publishWithRetries();

    // 把调试快照挂到页面世界的 window 上，这样在 devtools 的默认
    // Console 上下文里直接敲 __ytBilingual 就能看到
    if (e.data?.type === DEBUG_STATE) {
      (window as unknown as { __ytBilingual?: DebugState }).__ytBilingual =
        e.data.state as DebugState;
    }
  });

  // YouTube 自己派发的导航完成事件
  window.addEventListener('yt-navigate-finish', publishWithRetries);
});
