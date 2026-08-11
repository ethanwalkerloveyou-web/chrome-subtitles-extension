/**
 * 冒烟测试：真正把扩展加载进 Chromium，打开设置页，检查渲染、
 * 控制台报错、配置落盘、以及「测试连接」是否走通。
 *
 *   pnpm build && pnpm smoke
 *
 * CHROME_PATH 可指定 Chrome/Chromium 可执行文件，默认用 Playwright 自带的。
 */
import { chromium } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, '.output/chrome-mv3');
const userDataDir = mkdtempSync(join(tmpdir(), 'ext-'));

const ctx = await chromium.launchPersistentContext(userDataDir, {
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-sandbox',
  ],
});

const errors = [];
ctx.on('weberror', (e) => errors.push(`page: ${e.error().message}`));

// 等 service worker 起来，拿扩展 ID
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
console.log('扩展已加载, id =', extId);

const page = await ctx.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`chrome-extension://${extId}/options.html`);
await page.waitForSelector('.app', { timeout: 10000 });

// 1. 三个分区都渲染出来了吗
const headings = await page.$$eval('.section-head h2', (els) =>
  els.map((e) => e.textContent),
);
console.log('分区:', headings.join(' / '));

// 2. 预览里应该有三层文本
const layers = await page.$$eval('.preview-stage p', (els) =>
  els.map((e) => e.textContent.slice(0, 18)),
);
console.log('预览层数:', layers.length, '→', JSON.stringify(layers));

// 3. 改一个设置，确认写进了 chrome.storage.local
//    用 Playwright 原生交互，绕过 React 的受控组件 value 追踪
await page
  .locator('.layer-card')
  .first()
  .locator('input[type=range]')
  .first()
  .fill('30');
await page.getByPlaceholder('例如：机器学习技术分享 / 历史纪录片 / 脱口秀').fill('机器学习讲座');
await page.waitForTimeout(1000);

const saved = await page.evaluate(
  () => new Promise((r) => chrome.storage.local.get('settings', (v) => r(v.settings))),
);
console.log('落盘的英文层字号:', saved?.subtitle?.layers?.english?.fontSize);
console.log('落盘的领域提示:', saved?.translation?.domain);
console.log('落盘的模型:', saved?.llm?.models?.anthropic);

// 预览是否跟着变
const previewSize = await page.$eval('.preview-stage p', (e) => e.style.fontSize);
console.log('预览英文层字号:', previewSize);

// 4. 关掉英文层，预览应当只剩中文一行
await page.locator('.layer-card').first().locator('.layer-head .toggle').click();
await page.waitForTimeout(200);
const after = await page.$$eval('.preview-stage p', (e) => e.length);
console.log('关掉英文层后预览层数:', after);

// 5. 只剩最后一层（中文）时，它的开关应当被锁住（防止字幕整个消失）
const lastDisabled = await page
  .locator('.layer-card')
  .nth(1)
  .locator('.layer-head .toggle input')
  .isDisabled();
console.log('最后一层开关被锁住:', lastDisabled);

// 6. 走真实路径点「测试连接」，验证 Anthropic SDK 在 service worker 里能构造并发请求
//    （SDK 有 node:fs / node:path 被 externalize，这一步就是在确认它不会炸）
await page.getByPlaceholder('sk-ant-...').fill('sk-ant-invalid-key-for-smoke-test');
await page.getByRole('button', { name: '测试连接' }).click();
await page.waitForSelector('.test-result', { timeout: 30000 });
const testText = await page.$eval('.test-result', (e) => e.textContent.trim());
console.log('测试连接结果:', testText);

console.log('\n错误数:', errors.length);
errors.forEach((e) => console.log('  !', e));

await ctx.close();
process.exit(errors.length === 0 ? 0 : 1);
