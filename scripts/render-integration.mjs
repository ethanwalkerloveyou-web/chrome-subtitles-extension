/**
 * 端到端：取字幕 → 翻译 → 渲染到播放器上。
 *
 *   npm run build && npm run render
 *
 * 用 Playwright 的 route 拦截同时伪造两件事：
 *  - https://www.youtube.com/watch 的页面和字幕
 *  - 大模型接口（配成 OpenAI 兼容供应商指向一个假域名）
 *
 * 这样整条链路都是真的在跑 —— content script、service worker、
 * 长连接、翻译管线、Shadow DOM 覆盖层、rAF 同步 —— 只有外部依赖是假的。
 */
import { chromium } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, '.output/chrome-mv3');
const TT = 'https://www.youtube.com/api/timedtext';
const LLM = 'https://mock-llm.test/v1';

const CAPTIONS = {
  events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'So the key insight' }] },
    {
      tStartMs: 3000,
      dDurationMs: 2500,
      segs: [{ utf8: 'is that attention is all you need.' }],
    },
    { tStartMs: 8000, dDurationMs: 2000, segs: [{ utf8: 'Does that make sense?' }] },
  ],
};

/** 假模型：把收到的每一条都翻成固定的中文，id 原样返回。 */
function mockCompletion(body) {
  const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
  const ids = [...user.matchAll(/^(\d+)\t(.+)$/gm)].map((m) => ({
    id: Number(m[1]),
    en: m[2],
  }));

  const zhFor = (en) =>
    en.includes('key insight')
      ? '所以这里的关键在于，注意力机制就够了。'
      : '这样说得通吗？';

  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            lines: ids.map(({ id, en }) => ({
              id,
              en,
              zh: zhFor(en),
              hard: en.includes('key insight') ? ['注意力机制'] : [],
            })),
          }),
        },
      },
    ],
  };
}

/**
 * 一段静音 WAV，用作 mock 播放器的真实媒体源。
 *
 * 不能用 Object.defineProperty 伪造 currentTime：那是在页面世界改的，
 * 而 content script 跑在 isolated world —— 两个世界对同一个 DOM 节点
 * 各有一份 JS 包装对象，content script 读到的仍然是原生属性，永远为 0。
 * 只有给一个真实媒体源，currentTime 和 seek 才对两边都成立。
 */
function silentWav(seconds = 20, rate = 4000) {
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); // fmt chunk 长度
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate, 28); // 字节率
  buf.writeUInt16LE(1, 32); // 块对齐
  buf.writeUInt16LE(8, 34); // 位深
  buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  buf.fill(128, 44); // 8 位 PCM 的静音是 128
  return buf;
}

const MEDIA_DATA_URL = `data:audio/wav;base64,${silentWav().toString('base64')}`;

function mockPage(videoId) {
  return `<!doctype html><html><head><title>${videoId}</title></head><body>
<div id="movie_player" style="position:relative;width:640px;height:360px;background:#222">
  <video src="${MEDIA_DATA_URL}" preload="auto"></video>
</div>
<script>
  window.ytInitialPlayerResponse = {
    videoDetails: { videoId: ${JSON.stringify(videoId)} },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [
      { baseUrl: '${TT}?v=${videoId}&lang=en', languageCode: 'en' }
    ] } }
  };
</script></body></html>`;
}

/** 真的 seek 过去，并等 seeked 事件 —— 否则读到的还是旧时间。 */
async function seekTo(page, seconds) {
  const landed = await page.evaluate(async (t) => {
    const v = document.querySelector('video');
    if (Math.abs(v.currentTime - t) >= 0.01) {
      v.currentTime = t;
      // 与超时赛跑：媒体不可 seek 时 seeked 永远不来，不能让测试挂死
      await Promise.race([
        new Promise((r) => v.addEventListener('seeked', r, { once: true })),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
    return v.currentTime;
  }, seconds);
  if (Math.abs(landed - seconds) > 0.5) {
    console.log(`  [seek] 想到 ${seconds}s，实际停在 ${landed}s —— 媒体不可 seek？`);
  }
}

// ---------------------------------------------------------------- 断言

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✕ ${name}${detail ? '\n      ' + detail : ''}`);
  }
}

// ---------------------------------------------------------------- 跑

const ctx = await chromium.launchPersistentContext(
  mkdtempSync(join(tmpdir(), 'yt-render-')),
  {
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    headless: true,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--no-sandbox',
    ],
  },
);

const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const extId = new URL(sw.url()).host;

// 模型接口和字幕接口都要拦；SW 发出的请求也走 context 级的 route
let llmCalls = 0;
await ctx.route('**://mock-llm.test/**', async (route) => {
  llmCalls++;
  const body = route.request().postDataJSON();
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(mockCompletion(body)),
  });
});

// 先把配置写好，content script 启动时就能读到
const reader = await ctx.newPage();
await reader.goto(`chrome-extension://${extId}/options.html`);
// 设置页挂载后 350ms 会把自己的内存态自动保存一次；
// 等它保存完再写，否则我们的写入会被它覆盖掉
await reader.waitForSelector('.app');
await reader.waitForTimeout(800);
// storage 用 Promise 式 API：回调式写法里回调内一旦抛异常，
// 外层 Promise 永远悬着，最终被 GC —— Playwright 会报
// "Resulting promise was garbage collected"，完全看不出真实原因
await reader.evaluate(
  async ({ llm }) => {
    const v = await chrome.storage.local.get('settings');
    const s = v.settings ?? {};
    await chrome.storage.local.set({
      settings: { ...s, llm: { ...(s.llm ?? {}), ...llm } },
    });
  },
  {
    llm: {
      provider: 'openai-compatible',
      apiKeys: { anthropic: '', 'openai-compatible': 'test-key' },
      models: { anthropic: 'claude-opus-5', 'openai-compatible': 'mock-model' },
      baseUrl: LLM,
      effort: 'low',
      batchSize: 20,
      concurrency: 2,
    },
  },
);

const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.route('**://www.youtube.com/**', async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === '/watch') {
    return route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: mockPage('RENDER01'),
    });
  }
  if (url.pathname === '/api/timedtext') {
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(CAPTIONS),
    });
  }
  return route.fulfill({ status: 204, body: '' });
});

await page.goto('https://www.youtube.com/watch?v=RENDER01');
// requestAnimationFrame 在非前台标签页会被暂停，字幕同步就不会推进。
// 真实使用时用户本来就在看这个页面，测试里要显式把它提到前台。
await page.bringToFront();
// 等媒体就绪，否则 seek 会被忽略
await page.waitForFunction(
  () => (document.querySelector('video')?.readyState ?? 0) >= 1,
);

/** 读覆盖层当前显示的各层文本。Shadow DOM 是 open 的，所以能穿进去。 */
const readOverlay = () =>
  page.evaluate(() => {
    const host = document.querySelector('[data-yt-bilingual="overlay"]');
    if (!host?.shadowRoot) return null;
    const box = host.shadowRoot.querySelector('[data-role="lines"]');
    const badge = host.shadowRoot.querySelector('[data-role="badge"]');
    return {
      visible: box?.style.visibility !== 'hidden',
      layers: Object.fromEntries(
        [...(box?.querySelectorAll('[data-layer]') ?? [])].map((e) => [
          e.dataset.layer,
          e.textContent,
        ]),
      ),
      badge: badge?.textContent ?? '',
    };
  });

async function waitFor(fn, timeoutMs = 20000) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

// 1. 覆盖层挂载
const mounted = await waitFor(async () => (await readOverlay()) !== null);
check('覆盖层挂进了播放器容器', mounted);

// 2. 翻译跑起来并回填
const translated = await waitFor(async () => {
  const lines = await page.evaluate(() => window.__ytBilingual?.lines?.length ?? 0);
  return lines >= 2 ? lines : null;
});
check('翻译结果回填到 content script', translated >= 2, `实际 ${translated} 行`);
check('确实调用了模型接口', llmCalls > 0, `调用次数 ${llmCalls}`);

// 3. 把播放头移到第一句，看渲染
await seekTo(page, 2.0);
const shown = await waitFor(async () => {
  const o = await readOverlay();
  return o?.layers?.chinese ? o : null;
});
if (!shown) {
  console.log('  [probe]', JSON.stringify(await page.evaluate(async () => {
    // rAF 活性：100ms 内能不能等到一帧
    const rafAlive = await Promise.race([
      new Promise((r) => requestAnimationFrame(() => r(true))),
      new Promise((r) => setTimeout(() => r(false), 100)),
    ]);
    const v = document.querySelector('video');
    const host = document.querySelector('[data-yt-bilingual="overlay"]');
    const box = host?.shadowRoot?.querySelector('[data-role="lines"]');
    return {
      rafAlive,
      visibility: document.visibilityState,
      videoTime: v?.currentTime,
      readyState: v?.readyState,
      lines: (window.__ytBilingual?.lines ?? []).map((l) => [l.startMs, l.endMs, (l.zh ?? '').slice(0, 8)]),
      boxHTML: box?.outerHTML?.slice(0, 160),
    };
  })));
}
check('中文译文渲染出来了', !!shown?.layers?.chinese, JSON.stringify(shown));
check(
  '英文原文同时显示',
  shown?.layers?.english?.includes('key insight'),
  JSON.stringify(shown?.layers),
);

// 4. 空隙处不显示字幕
await seekTo(page, 6.5);
const gap = await waitFor(async () => {
  const o = await readOverlay();
  return o && !o.visible ? o : null;
}, 5000);
check('字幕空隙处隐藏', !!gap);

// 5. 后一句
await seekTo(page, 8.5);
const second = await waitFor(async () => {
  const o = await readOverlay();
  return o?.layers?.chinese?.includes('说得通') ? o : null;
});
check('时间推进后切到下一句', !!second, JSON.stringify(second?.layers));

// 6. 缓存：重新加载同一个视频不应再调模型
const callsBefore = llmCalls;
await page.reload();
await page.waitForFunction(
  () => (document.querySelector('video')?.readyState ?? 0) >= 1,
);
await waitFor(async () => {
  const lines = await page.evaluate(() => window.__ytBilingual?.lines?.length ?? 0);
  return lines >= 2;
});
check(
  '第二次打开命中缓存，不再调用模型',
  llmCalls === callsBefore,
  `重载后又调了 ${llmCalls - callsBefore} 次`,
);

// 7. 设置实时生效
// 改设置走 service worker，不再经过设置页 —— 设置页一挂载就会把
// 自己的内存态自动保存一次，和我们的写入抢；SW 没有这个问题，
// 且被翻译长连接保活，句柄一直有效
await sw.evaluate(async () => {
  const v = await chrome.storage.local.get('settings');
  const s = v.settings ?? {};
  // 存储层的契约是「可以只存改过的部分，读取时与默认值深合并」，
  // 所以这里做部分写入，不假设 storage 里是完整结构
  s.subtitle = {
    ...(s.subtitle ?? {}),
    layers: {
      ...(s.subtitle?.layers ?? {}),
      english: { ...(s.subtitle?.layers?.english ?? {}), enabled: false },
    },
  };
  await chrome.storage.local.set({ settings: s });
});
await page.bringToFront();
await seekTo(page, 2.0);
const afterToggle = await waitFor(async () => {
  const o = await readOverlay();
  return o && o.layers.english === undefined && o.layers.chinese ? o : null;
}, 6000);
check('关掉英文层后立刻生效，无需刷新', !!afterToggle);

check('页面无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
await ctx.close();
process.exit(failures === 0 ? 0 : 1);
