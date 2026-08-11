import { siteAdapters } from '../adapters/index.ts';
import type { SiteAdapter } from '../adapters/types.ts';
import { listenToMainWorld, pageSnapshot } from '../adapters/youtube.ts';
import { SubtitleOverlay } from '../render/overlay.ts';
import { mergeRenderLines, SubtitleSync } from '../render/sync.ts';
import { recordTrack } from '../store/diagnostics.ts';
import {
  loadSettings,
  watchSettings,
  type Settings,
} from '../store/settings.ts';
import type { SubtitleTrack } from '../subtitle/types.ts';
import { DEBUG_STATE } from '../subtitle/main-world-protocol.ts';
import {
  TRANSLATE_PORT,
  type FromWorker,
  type ToWorker,
} from '../translate/service.ts';
import type { RenderLine } from '../translate/types.ts';

/** 排查用的把手，挂在 window.__ytBilingual 上。 */
interface DebugHandle {
  track: SubtitleTrack | null;
  lines: RenderLine[];
  adapter: string | null;
  snapshot: ReturnType<typeof pageSnapshot>;
  refetch: () => Promise<void>;
}

function log(...args: unknown[]) {
  console.log('%c[双语字幕]', 'color:#6fb3e0;font-weight:bold', ...args);
}

/**
 * 用字幕轨的英文原文铺一条占位时间轴（zh 留空）。
 *
 * 翻译是逐批异步回来的，在译文到达前先把英文按原始时间戳显示出来，
 * 字幕就能从一开始跟着人声走；每批译文回来再逐段盖掉对应的占位行。
 * 英文原文的时间戳是最权威的（直接来自字幕文件），所以占位天然对得上画面。
 */
function seedFromTrack(track: SubtitleTrack): RenderLine[] {
  return track.lines.map((l) => ({
    startMs: l.startMs,
    endMs: l.endMs,
    en: l.text,
    zh: '',
    hard: [],
  }));
}

/**
 * 把调试状态推到页面世界。
 *
 * content script 挂在自己 window 上的属性，devtools 的默认 Console
 * 上下文（页面世界）是看不到的 —— 排查时得先切上下文，很不直观。
 * 推过去之后 __ytBilingual 就是直接可用的。
 */
function publishDebugState(session: Session) {
  window.postMessage(
    {
      type: DEBUG_STATE,
      state: {
        adapter: session.adapterId,
        track: session.track,
        lines: session.lines,
        snapshot: pageSnapshot(),
      },
    },
    location.origin,
  );
}

/**
 * 取不到字幕时打出足够定位问题的信息。
 *
 * 只说"没有可用字幕轨"是没用的 —— 分不清是这个视频本来就没字幕，
 * 还是我们没读到 playerResponse（那才是需要改代码的情况）。
 */
function reportFailure(adapterId: string) {
  if (adapterId !== 'youtube') {
    log('⚠ 这个视频没有可用的英文字幕轨');
    return;
  }
  const snap = pageSnapshot();

  const reason =
    snap.playerResponseFrom === '未收到'
      ? 'MAIN world 脚本没有回报 —— 注入可能失败了，这是 bug'
      : snap.playerResponseFrom === '未找到'
        ? '页面上找不到 playerResponse —— 字段路径可能变了，这是 bug'
        : snap.trackCount === 0
          ? '这个视频本身没有任何字幕轨（音乐 MV 等常见）'
          : `有 ${snap.trackCount} 条字幕轨但没有英文的`;

  console.groupCollapsed(
    '%c[双语字幕]%c ⚠ 没取到英文字幕 — ' + reason,
    'color:#6fb3e0;font-weight:bold',
    'color:inherit',
  );
  console.log('playerResponse 来源:', snap.playerResponseFrom);
  console.log('字幕轨:', snap.trackCount, snap.trackLanguages);
  console.log('截获的 timedtext 请求:', snap.interceptedCount);
  console.log(
    '提示：先点播放器上的 CC 按钮确认这个视频到底有没有字幕。' +
      '有字幕但这里显示 0 条，就是我们的 bug。',
  );
  console.groupEnd();
}

/** 一支视频的完整生命周期：取字幕 → 翻译 → 渲染。 */
class Session {
  private adapter: SiteAdapter | null = null;
  private abort: AbortController | null = null;
  private port: chrome.runtime.Port | null = null;
  private overlay: SubtitleOverlay | null = null;
  private sync: SubtitleSync | null = null;
  private remountTimer = 0;

  track: SubtitleTrack | null = null;
  lines: RenderLine[] = [];

  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  get adapterId() {
    return this.adapter?.id ?? null;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.overlay?.updateSettings(settings.subtitle);
  }

  async start(): Promise<void> {
    this.stop();
    this.adapter = siteAdapters.find((a) => a.matches(location.href)) ?? null;
    if (!this.adapter) return;
    if (!this.settings.subtitle.enabled) return;

    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.adapter.reset?.();

    const track = await this.retryFetch(signal);
    if (signal.aborted) return;

    this.track = track;
    await recordTrack(this.adapter.videoId(), track);

    if (!track) {
      reportFailure(this.adapter.id);
      publishDebugState(this);
      return;
    }

    log(
      `✓ ${track.kind === 'asr' ? '自动字幕' : '人工字幕'}` +
        ` · ${track.lines.length} 段 · 来源 ${track.source}`,
    );

    // 先用英文原文铺好时间轴，字幕立刻跟着人声走；译文逐批盖上来
    this.lines = seedFromTrack(track);
    this.mountOverlay();
    this.startTranslation(track);
    publishDebugState(this);
  }

  /**
   * 字幕轨不是立刻就绪的：SPA 导航后 playerResponse 要等一会儿，
   * 截获路径还要等播放器真的去请求字幕。所以退避重试几次。
   */
  private async retryFetch(signal: AbortSignal): Promise<SubtitleTrack | null> {
    for (const delay of [0, 400, 800, 1500, 2500]) {
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

  /**
   * 挂载覆盖层，并持续盯着它是否还在。
   *
   * 切换剧场模式 / 全屏时播放器 DOM 会被重建，覆盖层会被连带移除。
   * 定时检查一次比监听一堆不保证存在的事件稳。
   */
  private mountOverlay(): void {
    const adapter = this.adapter!;
    const video = adapter.findVideo();
    const container = adapter.overlayContainer();
    if (!video || !container) {
      log('⚠ 找不到播放器容器，无法显示字幕');
      return;
    }

    adapter.hideNativeSubtitles();

    this.overlay = new SubtitleOverlay(this.settings.subtitle, {
      onWordClick: (word) => log('生词:', word),
    });
    this.overlay.mount(container);

    this.sync = new SubtitleSync(video, (line) => this.overlay?.show(line));
    this.sync.start();
    // 立刻把已有的行（先是英文占位，后续是译文）喂给同步循环
    this.sync.setLines(this.lines);

    this.remountTimer = window.setInterval(() => {
      // 原生字幕的隐藏也要反复补 —— 用户点 CC 按钮 / 播放器重建
      // 都会让 YouTube 自己的字幕重新冒出来，跟我们的叠成两层
      adapter.hideNativeSubtitles();
      if (this.overlay?.mounted) return;
      const c = adapter.overlayContainer();
      if (c) this.overlay?.mount(c);
    }, 1000);
  }

  private expectedDisconnect = false;

  private startTranslation(track: SubtitleTrack): void {
    const port = chrome.runtime.connect({ name: TRANSLATE_PORT });
    this.port = port;
    this.expectedDisconnect = false;
    const post = (msg: ToWorker) => port.postMessage(msg);

    port.onMessage.addListener((msg: FromWorker) => {
      if (msg.type === 'LINES') {
        // replace（缓存命中）时回到英文占位打底，再盖上缓存的译文，
        // 没翻到的段落仍留着英文；增量批次则直接盖在当前结果上
        const base = msg.replace ? seedFromTrack(track) : this.lines;
        this.lines = mergeRenderLines(base, msg.lines);
        this.sync?.setLines(this.lines);
        publishDebugState(this);
      } else if (msg.type === 'PROGRESS') {
        const { done, total, status } = msg.progress;
        this.overlay?.setStatus(
          status === 'complete' ? null : `翻译中 ${done}/${total}`,
        );
        if (status === 'complete') log(`✓ 翻译完成 · ${this.lines.length} 行`);
      } else if (msg.type === 'ERROR') {
        this.overlay?.setStatus(`✕ ${msg.message}`);
        log('翻译失败:', msg.message);
      }
    });

    post({ type: 'START', track, settings: this.settings });

    // 把播放位置报给 SW，让它优先翻正在播的那一段。
    // 自己调 disconnect() 不会触发本侧的 onDisconnect，所以这里也要自检
    const timer = window.setInterval(() => {
      if (this.port !== port) {
        clearInterval(timer);
        return;
      }
      if (this.sync) post({ type: 'TIME', ms: this.sync.currentTimeMs });
    }, 1000);
    port.onDisconnect.addListener(() => {
      clearInterval(timer);
      // 不是我们主动断的就是 SW 崩了 / 扩展被重载了，翻译会停在半路，
      // 明确说出来，比字幕默默不再更新强
      if (!this.expectedDisconnect && this.port === port) {
        log('⚠ 与后台的连接意外断开，翻译中止。刷新页面可恢复');
        this.overlay?.setStatus('✕ 后台连接断开，刷新页面可恢复');
      }
    });
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.expectedDisconnect = true;
    this.adapter?.restoreNativeSubtitles?.();
    this.port?.disconnect();
    this.port = null;
    this.sync?.stop();
    this.sync = null;
    this.overlay?.destroy();
    this.overlay = null;
    if (this.remountTimer) clearInterval(this.remountTimer);
    this.remountTimer = 0;
    this.track = null;
    this.lines = [];
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * 站点是 SPA，切视频不重新加载页面。
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
  matches: [
    'https://www.youtube.com/*',
    'https://x.com/*',
    'https://twitter.com/*',
  ],
  runAt: 'document_start',

  async main() {
    const settings = await loadSettings();
    listenToMainWorld();

    // MAIN world 脚本负责读 playerResponse 和 hook fetch，
    // content script 在 isolated world 里两件事都做不了
    await injectScript('/main-world.js', { keepInDom: true });

    const session = new Session(settings);
    let enabled = settings.subtitle.enabled;
    // 模型 / 翻译相关配置一变就整体重来，让「关思考模式」「换模型」
    // 这类改动立刻生效，不用刷新页面
    let llmKey = JSON.stringify([settings.llm, settings.translation]);

    // 设置页是边改边存的（填 Key 时每敲一个字都会触发一次变更），
    // 重启要防抖，等改完稳定一秒再动手
    let restartTimer = 0;
    const scheduleRestart = () => {
      clearTimeout(restartTimer);
      restartTimer = window.setTimeout(() => void session.start(), 1000);
    };

    watchSettings((next) => {
      session.updateSettings(next);
      const nextLlmKey = JSON.stringify([next.llm, next.translation]);
      // 总开关翻转时要整体重来（关掉要拆覆盖层，打开要重新取字幕）
      if (next.subtitle.enabled !== enabled || nextLlmKey !== llmKey) {
        enabled = next.subtitle.enabled;
        llmKey = nextLlmKey;
        scheduleRestart();
      }
    });

    // isolated world 里也留一份，带 refetch()（跨世界传不了函数）
    const debug: DebugHandle = {
      get track() {
        return session.track;
      },
      get lines() {
        return session.lines;
      },
      get adapter() {
        return session.adapterId;
      },
      get snapshot() {
        return pageSnapshot();
      },
      refetch: () => session.start(),
    };
    Object.defineProperty(window, '__ytBilingual', { value: debug });

    await session.start();
    watchNavigation(() => void session.start());
  },
});
