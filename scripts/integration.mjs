/**
 * 集成测试：在真实的 Chromium 里加载扩展，用拦截的方式伪造 youtube.com。
 *
 *   npm run build && npm run integration
 *
 * 用 Playwright 的 route 拦截把 https://www.youtube.com/watch 换成 mock 页面，
 * 所以 content script 的 matches 规则是真的生效的 —— 测的是完整链路：
 * content script 注入 → MAIN world 注入 → 读 ytInitialPlayerResponse /
 * hook fetch → 取 timedtext → 解析 → 整理 → 写诊断信息。
 *
 * 唯一没覆盖的是"YouTube 真实页面结构是否与假设一致"，那个只能在真机上验。
 */
import { chromium } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, '.output/chrome-mv3');

// ---------------------------------------------------------------- fixtures

const MANUAL_JSON3 = {
  events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'So the key insight' }] },
    {
      tStartMs: 3000,
      dDurationMs: 2500,
      segs: [{ utf8: 'here is that attention is all you need.' }],
    },
    { tStartMs: 6000, dDurationMs: 2000, segs: [{ utf8: 'Does that make sense?' }] },
  ],
};

const ASR_JSON3 = {
  events: [
    {
      tStartMs: 1000,
      dDurationMs: 2000,
      segs: [
        { utf8: 'so', tOffsetMs: 0 },
        { utf8: ' the', tOffsetMs: 300 },
        { utf8: ' key', tOffsetMs: 600 },
      ],
    },
    { tStartMs: 1900, aAppend: 1, segs: [{ utf8: '\n' }] },
    {
      // 滚动窗口重发，去重后不应出现两遍
      tStartMs: 1000,
      dDurationMs: 3000,
      segs: [
        { utf8: 'so', tOffsetMs: 0 },
        { utf8: ' the', tOffsetMs: 300 },
        { utf8: ' key', tOffsetMs: 600 },
        { utf8: ' insight', tOffsetMs: 1000 },
      ],
    },
  ],
};

const TT = 'https://www.youtube.com/api/timedtext';

/** 造一个 watch 页面。tracks 决定 playerResponse 里有哪些字幕轨。 */
function mockPage({ videoId, tracks, playerFetches }) {
  return `<!doctype html><html><head><title>${videoId} - YouTube</title></head><body>
<div id="movie_player"><video></video></div>
<script>
  window.ytInitialPlayerResponse = {
    videoDetails: { videoId: ${JSON.stringify(videoId)} },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: ${JSON.stringify(tracks)} } }
  };
  // 模拟 YouTube 的 SPA 导航：换 URL、换 playerResponse、派发导航事件
  window.__navigate = (newId) => {
    history.pushState({}, '', '/watch?v=' + newId);
    window.ytInitialPlayerResponse = {
      videoDetails: { videoId: newId },
      captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { baseUrl: '${TT}?v=' + newId + '&lang=en&kind=asr', languageCode: 'en', kind: 'asr' }
      ] } }
    };
    window.dispatchEvent(new Event('yt-navigate-finish'));
  };
  ${
    playerFetches
      ? `// 模拟播放器自己去取字幕，触发我们的 fetch hook
         setTimeout(() => fetch(${JSON.stringify(playerFetches)}), 150);`
      : ''
  }
</script></body></html>`;
}

// ---------------------------------------------------------------- 用例

const CASES = [
  {
    name: '人工字幕：合并成完整句子',
    videoId: 'MANUAL01',
    tracks: [{ baseUrl: `${TT}?v=MANUAL01&lang=en`, languageCode: 'en' }],
    expect: (d) => {
      assert(d.found, '应该找到字幕');
      assertEq(d.kind, 'manual', 'kind');
      assertEq(d.source, 'player-response', 'source');
      assertEq(d.lineCount, 2, '合并后应为 2 句');
      assertEq(
        d.firstLine,
        'So the key insight here is that attention is all you need.',
        '第一句应为完整句子',
      );
    },
  },
  {
    name: '自动字幕：去重 + 词级时间戳',
    videoId: 'ASR00001',
    tracks: [
      { baseUrl: `${TT}?v=ASR00001&lang=en&kind=asr`, languageCode: 'en', kind: 'asr' },
    ],
    expect: (d) => {
      assert(d.found, '应该找到字幕');
      assertEq(d.kind, 'asr', 'kind');
      assertEq(d.tokenCount, 4, '滚动重复应被去掉，只剩 4 个词');
      assertEq(d.firstLine, 'so the key insight', '文本');
    },
  },
  {
    name: '截获路径：hook 到播放器自己的请求',
    videoId: 'INTER001',
    // playerResponse 里没有字幕轨，只能靠截获
    tracks: [],
    playerFetches: `${TT}?v=INTER001&lang=en`,
    expect: (d) => {
      assert(d.found, '应该通过截获拿到字幕');
      assertEq(d.source, 'intercepted', 'source');
      assertEq(d.kind, 'manual', 'kind');
    },
  },
  {
    name: '人工字幕优先于截获到的自动字幕',
    videoId: 'PRIOR001',
    tracks: [{ baseUrl: `${TT}?v=PRIOR001&lang=en`, languageCode: 'en' }],
    playerFetches: `${TT}?v=PRIOR001&lang=en&kind=asr`,
    expect: (d) => {
      assertEq(d.kind, 'manual', '应该选人工字幕而不是截获到的自动字幕');
    },
  },
  {
    name: 'SPA 切视频后重新取字幕',
    videoId: 'NAV00001',
    tracks: [{ baseUrl: `${TT}?v=NAV00001&lang=en`, languageCode: 'en' }],
    // 先等第一支视频就绪，再模拟导航到第二支（自动字幕轨）
    afterReady: async (page) => {
      await page.evaluate(() => window.__navigate('NAV00002'));
    },
    expectAfterNav: (d) => {
      assertEq(d.videoId, 'NAV00002', '应该已经换成第二支视频');
      assertEq(d.kind, 'asr', '第二支是自动字幕轨');
    },
    expect: (d) => {
      assertEq(d.kind, 'manual', '第一支应为人工字幕');
    },
  },
  {
    name: '没有字幕轨时干净地报告失败',
    videoId: 'NOCAP001',
    tracks: [],
    expect: (d) => {
      assertEq(d.found, false, '不应找到字幕');
      assertEq(d.videoId, 'NOCAP001', 'videoId 仍应记录');
    },
  },
];

// ---------------------------------------------------------------- 断言

let failures = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** 轮询诊断信息，直到满足条件或超时。 */
async function waitForDiag(reader, done, tries = 48) {
  for (let i = 0; i < tries; i++) {
    const d = await reader.evaluate(
      () =>
        new Promise((r) =>
          chrome.storage.local.get('lastTrack', (v) => r(v.lastTrack ?? null)),
        ),
    );
    if (done(d)) return d;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// ---------------------------------------------------------------- 跑

const ctx = await chromium.launchPersistentContext(
  mkdtempSync(join(tmpdir(), 'yt-int-')),
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

/** 用来读 chrome.storage —— content script 在 isolated world，测试读不到它的变量。 */
const reader = await ctx.newPage();
await reader.goto(`chrome-extension://${extId}/options.html`);

for (const c of CASES) {
  // 每个用例前清掉上一次的诊断记录，避免读到过期数据
  await reader.evaluate(() => chrome.storage.local.remove('lastTrack'));

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.route('**://www.youtube.com/**', async (route) => {
    const url = new URL(route.request().url());

    if (url.pathname === '/watch') {
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: mockPage(c),
      });
    }
    if (url.pathname === '/api/timedtext') {
      const doc = url.searchParams.get('kind') === 'asr' ? ASR_JSON3 : MANUAL_JSON3;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(doc),
      });
    }
    return route.fulfill({ status: 204, body: '' });
  });

  await page.goto(`https://www.youtube.com/watch?v=${c.videoId}`);

  // content script 有退避重试，最长约 5 秒
  const diag = await waitForDiag(reader, (d) => d?.videoId === c.videoId);

  let problem = null;
  try {
    if (!diag) throw new Error('超时：content script 没有写出诊断信息');
    c.expect(diag);

    if (c.afterReady) {
      await c.afterReady(page);
      const after = await waitForDiag(reader, (d) => d?.videoId !== c.videoId);
      if (!after) throw new Error('导航后没有重新取字幕');
      c.expectAfterNav(after);
    }
  } catch (err) {
    problem = err.message;
  }
  if (!problem && pageErrors.length) problem = `页面报错: ${pageErrors.join(' | ')}`;

  if (problem) {
    failures++;
    console.log(`  ✕ ${c.name}\n      ${problem}`);
    console.log(`      诊断: ${JSON.stringify(diag)}`);
  } else {
    console.log(`  ✓ ${c.name}`);
  }

  await page.close();
}

console.log(`\n${CASES.length - failures}/${CASES.length} 通过`);
await ctx.close();
process.exit(failures === 0 ? 0 : 1);
