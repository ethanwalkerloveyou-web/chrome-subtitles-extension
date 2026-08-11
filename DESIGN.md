# YouTube 双语字幕学习插件 — 技术方案

> 状态：设计阶段，尚未开始编码
> 定位：个人自用的 Chrome 扩展（不上架），英文视频 → 中文双语字幕 + 中文学习辅助

---

## 1. 目标与范围

**做什么**

- 在 YouTube 播放页叠加一层「英文原文 + 中文译文」双语字幕
- 译文由大模型生成，模型 / API Key / 目标语言可在设置页配置
- 面向中文学习者：难词高亮、生词本、单句重播

**v0 明确不做**

- 不做语音识别（ASR）—— YouTube 绝大多数视频有人工字幕或自动字幕，够用
- 不做 YouTube 以外的网站 —— 但架构上留好 Site Adapter 接口
- 不做账号、云同步、上架审核相关的一切

---

## 2. 实现效果

### 2.1 播放器画面

字幕层覆盖在播放器底部，位于进度条上方：

```
┌────────────────────────────────────────────────────────┐
│                                                        │
│                    [ 视频画面 ]                         │
│                                                        │
│                                                        │
│      So the key insight here is that attention         │  ← 英文原文（小号、半透明）
│      所以这里的关键在于，注意力机制                       │  ← 中文译文（大号、白色）
│                                                        │
│  ▶  ━━━━━━━━━●───────────────────  12:34 / 45:01      │
└────────────────────────────────────────────────────────┘
```

- 两层布局可在设置里切换：仅中文 / 仅英文 / 双语
- 字号、透明度、垂直位置可调；字幕层可鼠标拖动
- 鼠标悬停在中文词上 → 高亮；单击 → 弹出释义小卡片，可「加入生词本」
- 全屏、剧场模式、迷你播放器下都正常跟随

### 2.2 首次打开一个视频的时序

```
0.0s   进入 watch 页，扩展检测到 videoId
0.3s   拿到英文字幕轨（约 800 条 cue）
0.4s   查缓存 → 未命中，开始翻译
0.4s   并发发出 3 个请求，优先翻译「当前播放位置附近」的批次
2~4s   第一批返回 → 字幕开始显示（此时可以正常看了）
       后台继续按顺序补齐剩余批次
~25s   全片翻译完成，写入 IndexedDB
```

**第二次打开同一个视频：命中缓存，0 延迟，0 成本。**

### 2.3 状态提示

播放器右上角一个小徽标：

- `⏳ 翻译中 3/12` — 正在处理
- `✓ 双语字幕` — 就绪
- `⚠ 无字幕轨` — 这个视频没有任何字幕，无能为力
- `✕ API 错误` — 点开看详情（Key 错误 / 余额 / 限流）

---

## 3. 技术方案

### 3.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│ Content Script (ISOLATED world)                         │
│  ├─ SiteAdapter (YouTube)  找 video / 播放器容器          │
│  ├─ SubtitleOverlay        Shadow DOM 渲染 + rAF 同步     │
│  └─ 与 SW 之间用 chrome.runtime port 长连接               │
└───────────┬─────────────────────────────────────────────┘
            │ postMessage
┌───────────▼─────────────────────────────────────────────┐
│ Injected Script (MAIN world)                            │
│  ├─ 读 window.ytInitialPlayerResponse                    │
│  └─ hook window.fetch，截获 /api/timedtext 请求           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Service Worker (background)                             │
│  ├─ TranslationPipeline   分批 / 并发 / 重试 / 顺序回填    │
│  ├─ ProviderRegistry      Anthropic / OpenAI 兼容 / …    │
│  └─ CacheStore            IndexedDB 读写                 │
└─────────────────────────────────────────────────────────┘

┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ Options Page │  │  Side Panel  │  │   Popup      │
│ 模型/Key/术语 │  │ 全文对照+生词 │  │ 当前页开关   │
└──────────────┘  └──────────────┘  └──────────────┘
```

**为什么需要 MAIN world 脚本**：Content Script 跑在 isolated world，读不到页面的 `window.ytInitialPlayerResponse`。MV3 支持在 manifest 里声明 `world: "MAIN"` 的 content script，或者动态注入一个 `<script>`。

**Service Worker 会被回收**：空闲约 30 秒就休眠。用 Content Script 主动建立的 `chrome.runtime.connect` 长连接保活；同时把翻译进度写进 IndexedDB，被杀掉后能从断点恢复。

---

### 3.2 字幕获取（YouTube，三级降级）

按可靠性从高到低尝试：

**① 截获播放器自己的请求（最稳）**

在 MAIN world 里 hook `window.fetch` 和 `XMLHttpRequest.prototype.open`，捕获播放器发往 `/api/timedtext?...` 的 URL。拿到后直接重放这个 URL（追加 `&fmt=json3`）。

优点：完全不用自己构造签名参数，YouTube 改协议也不受影响。
缺点：需要用户至少打开过一次 CC；可以用代码模拟点击一次 CC 按钮再关掉。

**② 读 `ytInitialPlayerResponse`（主路径）**

```js
const tracks = window.ytInitialPlayerResponse
  ?.captions
  ?.playerCaptionsTracklistRenderer
  ?.captionTracks;
// tracks[i] = { baseUrl, languageCode: "en", kind: "asr" | undefined, name: {...} }
```

选轨优先级：`languageCode === "en" && !kind`（人工字幕）> `languageCode === "en" && kind === "asr"`（自动字幕）> 任意英文轨。

`fetch(baseUrl + "&fmt=json3")` 拿到 JSON：

```json
{ "events": [
  { "tStartMs": 1200, "dDurationMs": 2400, "segs": [{ "utf8": "so the key" }] }
]}
```

**③ 读 `video.textTracks`（兜底）**

```js
[...video.textTracks].find(t => t.mode !== "disabled")?.cues
```

YouTube 通常自己渲染字幕、不挂原生 track，所以这条基本不会命中，留作其他站点的通用兜底。

**都失败** → 显示 `⚠ 无字幕轨`，不做 ASR（v3 再说）。

---

### 3.3 字幕预处理（关键，决定翻译质量）

YouTube 自动字幕（`kind: "asr"`）的原始数据有三个问题：

1. **滚动重复** —— 相邻 cue 会重复前一条的尾部词
2. **无标点、无大小写** —— `so the key insight here is that attention`
3. **切分点随机** —— 一句话被切在任意词中间

处理流程：

```
原始 events
  → 去重（丢弃 aAppend 事件 / 检测尾部重叠）
  → 合并成连续 token 流，每个 token 带精确时间戳
  → 按停顿 + 长度启发式切成「段」（约 20~40 秒一段）
  → 交给 LLM：断句 + 加标点 + 翻译（一次调用完成三件事）
  → 模型返回带 id 的句子数组
  → 按 token 时间戳把每句映射回时间区间
```

**这一步是整个项目里最容易做错的地方。** 让模型同时完成「断句 + 标点还原 + 翻译」，比先用规则断句再翻译效果好得多，因为模型能利用语义决定句子边界。

人工字幕（无 `kind` 字段）本身有标点，跳过断句，直接按句号合并成句即可。

---

### 3.4 翻译管线

**分批策略**

- 每批 15~25 个句子，或约 1200 tokens，取先到者
- 每批附带前一批最后 2 句作为上下文（只读，不要求翻译）
- 并发度 3；**优先翻译当前播放位置所在的批次**，然后向后预取，最后回填前面的

**输出格式（结构化输出，强约束）**

用 `output_config.format` 的 JSON Schema 约束返回，不靠提示词祈祷：

```json
{
  "type": "object",
  "properties": {
    "lines": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id":  { "type": "integer" },
          "en":  { "type": "string" },
          "zh":  { "type": "string" },
          "hard": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["id", "en", "zh", "hard"],
        "additionalProperties": false
      }
    }
  },
  "required": ["lines"],
  "additionalProperties": false
}
```

- `en` 是断句加标点后的英文原句（自动字幕场景下模型重新生成）
- `zh` 是中文译文
- `hard` 是模型标出的这句里较难的中文词 → 直接用于高亮和生词本，几乎不增加成本

**容错**

- 返回条数与预期不符 → 把这批拆成两半重试
- JSON 解析失败 → 重试一次；再失败标记该批为 `failed`，字幕降级为仅显示英文
- 429 / 5xx → 指数退避重试 3 次

**提示词要点**

```
你在翻译一段视频的英文字幕，供中文学习者阅读。

- 译成自然的中文口语，不要翻译腔。宁可意译，不要逐字对应。
- 每行译文不超过 25 个汉字；太长就在语义边界处拆成两条。
- 保留说话人的语气（犹豫、强调、玩笑）。
- 遇到术语表中的词，必须使用指定译法。
- hard 字段列出这句译文里 HSK 5 级以上或专业性较强的词。

领域：{domain}
术语表：{glossary}
上文（仅供参考，不要翻译）：{context}
```

---

### 3.5 渲染与时间同步

**渲染层**

- 容器挂到 `#movie_player` 内部，**不是 `document.body`** —— 这样全屏时自动跟随，不用监听 `fullscreenchange` 做特殊处理
- 内部用 Shadow DOM (`mode: "closed"`)，隔绝 YouTube 的 CSS
- 定位 `position: absolute; bottom: 60px; left: 50%; transform: translateX(-50%)`
- 检测 YouTube 控制栏的显隐（`.ytp-autohide` class），控制栏出现时字幕上移

**同步**

用 `requestAnimationFrame` 循环读 `video.currentTime`，**不要用 `timeupdate` 事件**（触发频率只有约 4Hz，字幕会一顿一顿的）：

```js
const loop = () => {
  const t = video.currentTime;
  const i = binarySearch(cues, t);          // 缓存上次索引，通常 O(1)
  if (i !== lastIndex) { render(cues[i]); lastIndex = i; }
  rafId = requestAnimationFrame(loop);
};
```

**SPA 导航**

YouTube 是单页应用，切换视频不会重新加载页面。监听 `yt-navigate-finish` 事件（YouTube 自己派发的），同时用 `MutationObserver` 兜底监测 URL 变化。每次导航要：销毁旧的 rAF 循环、清空覆盖层、重新走一遍字幕获取流程。

**关掉 YouTube 自带字幕**，避免和我们的覆盖层重叠。

---

### 3.6 存储

| 数据 | 位置 | 说明 |
|---|---|---|
| 翻译结果 | IndexedDB | key = `${videoId}:${trackId}:${targetLang}:${modelId}:${promptVersion}:${promptHash}` |
| 生词本 | IndexedDB | 词 / 例句 / 来源视频 + 时间戳 / 添加时间 |
| 配置、API Key | `chrome.storage.local` | |
| 用量统计 | `chrome.storage.local` | 按月累计 token 数和估算金额 |

一小时视频的翻译结果约 200~400 KB。加 `unlimitedStorage` 权限。

缓存 key 里带 `promptVersion` 和 `promptHash` —— 前者在改内置默认提示词时手动加一，后者是用户在设置页自定义提示词内容的短哈希。改了提示词（无论改默认还是自己填的）旧缓存都自动失效，不会拿旧结果糊弄自己。

---

### 3.7 LLM Provider 抽象

```ts
interface TranslationProvider {
  readonly id: string;
  translate(req: {
    lines: SourceLine[];
    context: string;
    glossary: Record<string, string>;
    signal: AbortSignal;
  }): Promise<TranslatedLine[]>;
}
```

**内置两类实现**

1. **Anthropic**（默认）—— 用官方 SDK `@anthropic-ai/sdk`，配 `dangerouslyAllowBrowser: true`。MV3 的 service worker 里带上 `host_permissions` 就能跨域请求，不受页面 CORS 限制。
2. **OpenAI 兼容** —— 一个 `baseURL + apiKey + model` 的通用实现，覆盖 OpenAI、DeepSeek、Qwen、Groq、本地 Ollama、各种中转。

**思考模式开关做成一段自由 JSON**（`LlmSettings.extraBody`，按供应商各存一份）。各家关/开思考的字段完全不一样，硬做成一个统一的布尔开关只会覆盖不全：Qwen3 用 `enable_thinking: false`，智谱 GLM / 火山豆包用 `thinking: {type: "disabled"}`，Anthropic 又是另一套。所以留一段 JSON 让用户自己填，请求时原样并进请求体（OpenAI 兼容并进 `/chat/completions` body，Anthropic 并进 `messages.create` 参数，用户填的键覆盖默认值）。OpenAI 兼容路径把它放进「可选参数」里，供应商若对某字段报 400 会自动去掉重试一次；设置页对这段做实时 JSON 校验，非法时给红字提示、请求侧当作空对象跳过。

Anthropic 请求的关键参数：

```js
{
  model: "claude-opus-5",
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  output_config: {
    effort: "low",                  // 翻译不需要深度推理，low 省钱省延迟
    format: { type: "json_schema", schema: LINES_SCHEMA }
  },
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: batchPayload }]
}
```

几个注意点：

- **不要设 `thinking: {type: "disabled"}`**。Opus 5 上禁用思考有已知副作用（`<thinking>` 标签可能泄漏到可见输出里），用 `adaptive` + `effort: "low"` 更稳，成本也已经很低。
- **不要设 `temperature`** —— Opus 5 / Sonnet 5 已移除采样参数，传了直接 400。
- **提示词缓存基本用不上**：我们的系统提示词大约 500~800 tokens，Opus 5 的最低缓存门槛是 512 tokens（Sonnet 5 是 1024、Haiku 4.5 是 4096）。只有系统提示词 + 术语表足够长时才值得开，且要留意最少两次请求才回本。术语表大的话可以开。

---

## 4. 核心数据结构

```ts
type SourceLine = { id: number; text: string; start: number; end: number };

type TranslatedLine = SourceLine & {
  zh: string;
  hard: string[];
};

type VideoSubtitles = {
  videoId: string;
  trackId: string;          // "en" | "en.asr"
  lines: TranslatedLine[];
  status: "partial" | "complete" | "failed";
  meta: { model: string; promptVersion: number; translatedAt: number };
};
```

---

## 5. 项目结构

技术栈：**WXT + TypeScript + React**（设置页和侧边栏用 React，字幕覆盖层用原生 DOM，减少开销）

```
src/
  entrypoints/
    content.ts            # ISOLATED world
    main-world.ts         # MAIN world，读 ytInitialPlayerResponse + hook fetch
    background.ts         # service worker
    options/              # 设置页
    sidepanel/            # 双语全文 + 生词本
    popup/                # 当前页开关
  adapters/
    types.ts              # SiteAdapter 接口
    youtube.ts
  subtitle/
    fetch.ts              # 三级降级获取
    normalize.ts          # 自动字幕去重、合并、切段
    align.ts              # 句子 → 时间轴映射
  translate/
    pipeline.ts           # 分批、并发、优先级、重试
    prompt.ts
    schema.ts
    providers/
      anthropic.ts
      openai-compatible.ts
      index.ts            # ProviderRegistry
  render/
    overlay.ts            # Shadow DOM 覆盖层
    sync.ts               # rAF 同步循环
    styles.css
  learn/
    vocab.ts              # 生词本
    export.ts             # 导出 Anki / CSV
  store/
    cache.ts              # IndexedDB
    settings.ts           # chrome.storage
```

**权限**（自用，从宽）：

```json
{
  "permissions": ["storage", "unlimitedStorage", "sidePanel", "scripting"],
  "host_permissions": [
    "https://www.youtube.com/*",
    "https://*.googlevideo.com/*",
    "https://api.anthropic.com/*",
    "https://api.openai.com/*"
  ]
}
```

自用可以直接写 `<all_urls>` 省事，但列清楚更好调试。

---

## 6. 成本

一小时英文演讲约 9,000 词。按我们的批次和提示词开销估算：**输入约 20K tokens，输出约 15K tokens**。

| 模型 | 价格（输入/输出，每百万 tokens） | 每小时视频 |
|---|---|---|
| Claude Opus 5 (`claude-opus-5`) | $5 / $25 | **≈ $0.48** |
| Claude Sonnet 5 (`claude-sonnet-5`) | $3 / $15（$2 / $10 优惠价至 2026-08-31） | ≈ $0.19 |
| Claude Haiku 4.5 (`claude-haiku-4-5`) | $1 / $5 | ≈ $0.10 |

建议：**默认配置用 `claude-opus-5`**，译文质量最好，一天看 2 小时也就一美元；如果量大或者只是刷着玩，在设置页切到 Sonnet 5 或 Haiku 4.5。这是设置项，随时可改。

加上缓存（同一视频第二次免费）和用量统计面板，实际花销可控。

**Batch API 不适用** —— 便宜 50%，但延迟最多 24 小时，看视频等不了。不过 v2 可以做「稍后观看列表夜间批量预翻译」，那个场景用 Batch API 正好。

---

## 7. 使用方法

### 安装

```bash
pnpm install
pnpm dev            # 开发模式，带 HMR
# 或
pnpm build          # 产出 .output/chrome-mv3/
```

Chrome → `chrome://extensions` → 打开右上角「开发者模式」→「加载已解压的扩展程序」→ 选 `.output/chrome-mv3/`

### 首次配置

点扩展图标 →「设置」，填三项：

1. **Provider**：Anthropic（默认）
2. **API Key**：`sk-ant-...`
3. **模型**：`claude-opus-5`（默认）

其余都有合理默认值。可选项：

- 目标语言：简体中文（默认）/ 繁体中文
- 显示模式：双语（默认）/ 仅中文 / 仅英文
- 术语表：一行一条 `English term = 中文译法`
- 领域提示：比如「机器学习技术分享」，会拼进提示词

### 日常使用

打开任意 YouTube 视频，扩展自动检测。首次约 3 秒后字幕出现，之后即时。

### 快捷键

| 键 | 作用 |
|---|---|
| `Alt + S` | 开 / 关双语字幕 |
| `Alt + X` | 循环切换显示模式（双语 / 仅中 / 仅英 / 关） |
| `Alt + R` | **重播当前这句**（跳回本句开头）—— 跟读练习的核心 |
| `Alt + ↑ / ↓` | 字号 +/− |
| `Alt + W` | 把当前句加入生词本 |
| 拖动字幕层 | 调整位置 |

### 侧边栏

点扩展图标 →「打开侧边栏」：

- 全片双语对照文本，点任意一句 → 视频跳到该时间点
- 本视频生词列表
- 「导出 Anki」按钮 → 生成 CSV（正面：中文词 / 背面：释义 + 例句 + 视频链接）

---

## 8. 开发计划

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M1 骨架** | WXT 项目、manifest、SW ↔ CS 通信、设置页 | 能在 YouTube 页面注入并打印出 videoId |
| **M2 取字幕** | MAIN world 注入、三级降级、自动字幕规整 | 控制台能打出结构正确的 `SourceLine[]` |
| **M3 翻译** | Anthropic Provider、分批并发、结构化输出、重试 | 命令行触发能翻译完整一集，JSON 无损 |
| **M4 渲染** | Shadow DOM 覆盖层、rAF 同步、全屏、SPA 导航 | 双语字幕正常显示，切视频不出错 |
| **M5 缓存 + 优先级** | IndexedDB、播放位置优先、进度徽标 | 第二次打开秒开，首次 3 秒内出字幕 |
| **M6 学习功能** | 生词点击、生词本、Anki 导出、快捷键 | 能完整走一遍「看 → 标记 → 导出」 |
| **v1+** | OpenAI 兼容 Provider、Bilibili adapter、用量面板 | |
| **v2** | Batch API 夜间预翻译、tabCapture + ASR | |

**M1~M5 是最小可用版本**，做完就能天天用了。M6 是让它区别于普通翻译插件的部分。

---

## 9. 已知风险

| 风险 | 影响 | 应对 |
|---|---|---|
| YouTube 改字幕接口 | 取不到字幕 | 三级降级；「截获播放器请求」这条路最抗改动 |
| 自动字幕断句质量差 | 译文割裂 | 让模型同时做断句+翻译；预留手动重译按钮 |
| 长视频（3h+）翻译慢、贵 | 体验差 | 按播放位置优先；未播放部分懒加载 |
| API Key 明文存储 | 泄漏风险 | 自用可接受，设置页明确提示；不同步到云端 |
| SW 被回收中断翻译 | 进度丢失 | 进度写 IndexedDB，可断点续传 |
| 模型返回条数不符 | 时间轴错位 | Schema 强约束 + 条数校验 + 拆半重试 |

---

## 10. 下一步

M1 开始动手前需要确认的：

1. 侧边栏用 Side Panel API 还是就做在 popup 里？（Side Panel 体验更好，但要 Chrome 114+）
2. 生词释义从哪来？—— 让翻译时顺带返回（省一次调用），还是点击时单独查？

这两个都不阻塞 M1~M3，可以边做边定。
