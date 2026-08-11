import {
  listenToMainWorld,
  resetPageState,
  youtubeAdapter,
} from '../adapters/youtube.ts';
import type { SiteAdapter } from '../adapters/types.ts';
import type { SubtitleTrack } from '../subtitle/types.ts';
import { recordTrack } from '../store/diagnostics.ts';

const ADAPTERS: SiteAdapter[] = [youtubeAdapter];

/** 拿到字幕后暴露给 devtools，方便排查：window.__ytBilingual */
interface DebugHandle {
  track: SubtitleTrack | null;
  adapter: string | null;
  refetch: () => Promise<SubtitleTrack | null>;
}

function log(...args: unknown[]) {
  console.log('%c[双语字幕]', 'color:#6fb3e0;font-weight:bold', ...args);
}

class Session {
  private adapter: SiteAdapter | null = null;
  private abort: AbortController | null = null;
  track: SubtitleTrack | null = null;

  async start(): Promise<SubtitleTrack | null> {
    this.stop();
    this.adapter = ADAPTERS.find((a) => a.matches(location.href)) ?? null;
    if (!this.adapter) return null;

    resetPageState();
    this.abort = new AbortController();

    // 播放器要一点时间把 ytInitialPlayerResponse 换成新视频的
    const track = await this.retryFetch(this.abort.signal);
    this.track = track;
    await recordTrack(this.adapter.videoId(), track);

    if (track) {
      log(
        `✓ ${track.kind === 'asr' ? '自动字幕' : '人工字幕'}` +
          ` · ${track.lines.length} 段 · 来源 ${track.source}`,
        track,
      );
    } else {
      log('⚠ 这个视频没有可用的英文字幕轨');
    }
    return track;
  }

  /**
   * 字幕轨不是立刻就绪的：SPA 导航后 ytInitialPlayerResponse 要等一会儿，
   * 截获路径还要等播放器真的去请求字幕。所以退避重试几次。
   */
  private async retryFetch(signal: AbortSignal): Promise<SubtitleTrack | null> {
    const delays = [0, 400, 800, 1500, 2500];
    for (const delay of delays) {
      if (signal.aborted) return null;
      if (delay > 0) await sleep(delay, signal);
      try {
        const track = await this.adapter!.fetchSubtitles(signal);
        if (track) return track;
      } catch (err) {
        if (signal.aborted) return null;
        log('取字幕出错，重试中', err);
      }
    }
    return null;
  }

  stop() {
    this.abort?.abort();
    this.abort = null;
    this.track = null;
  }

  get adapterId() {
    return this.adapter?.id ?? null;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * YouTube 是 SPA，切视频不重新加载页面。
 * yt-navigate-finish 是 YouTube 自己派发的；再用 URL 轮询兜底，
 * 因为这个事件名不是公开 API，哪天改了不至于整个失效。
 */
function watchNavigation(onChange: () => void) {
  let lastUrl = location.href;

  const check = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    onChange();
  };

  window.addEventListener('yt-navigate-finish', check);
  setInterval(check, 700);
}

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_start',

  async main() {
    listenToMainWorld();

    // 注入 MAIN world 脚本。必须在页面自己的环境里跑，
    // 否则读不到 ytInitialPlayerResponse，也 hook 不了页面的 fetch。
    await injectScript('/main-world.js', { keepInDom: true });

    const session = new Session();

    const debug: DebugHandle = {
      get track() {
        return session.track;
      },
      get adapter() {
        return session.adapterId;
      },
      refetch: () => session.start(),
    };
    Object.defineProperty(window, '__ytBilingual', { value: debug });

    await session.start();
    watchNavigation(() => {
      void session.start();
    });
  },
});
