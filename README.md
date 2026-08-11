# 双语视频字幕

YouTube / X 英文视频的中英双语字幕，大模型驱动，面向中文学习者。自用的 Chrome 扩展，不上架。

完整技术方案见 [DESIGN.md](./DESIGN.md)。

## 当前进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 项目骨架 + 设置页 | ✅ |
| M2 | 取字幕（三级降级 + 自动字幕规整） | ✅ |
| M3 | 翻译管线（分批 / 并发 / 结构化输出 / 拆半重试） | ✅ |
| M4 | 字幕渲染与同步（Shadow DOM + rAF） | ✅ |
| M5 | 缓存 + 播放位置优先 | ✅（与 M3 一起做了） |
| X  | X / Twitter 适配器（HLS 字幕轨） | ✅ 待真机验证 |
| M6 | 生词本、Anki 导出、快捷键（拼音层已就位） | 未开始 |

## 开发

```bash
npm install
npm run dev          # 开发模式，带热重载
npm run build        # 产出 .output/chrome-mv3/
```

装载：`chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选 `.output/chrome-mv3/`

## 测试

```bash
npm run compile      # 类型检查
npm test             # 单元测试：字幕解析与整理
npm run build && npm run integration   # 集成测试：真实 Chromium 里跑完整取字幕链路
npm run build && npm run render        # 端到端：取字幕 → 翻译(mock 模型) → 渲染到播放器
npm run build && npm run smoke         # 冒烟测试：设置页渲染与配置落盘
```

集成测试用 Playwright 拦截把 `https://www.youtube.com/watch` 换成 mock 页面，所以
content script 的 matches 规则是真的生效的，测的是完整链路。**它不覆盖
「YouTube 真实页面结构是否与假设一致」** —— 那个只能在真机上验，见下。

需要指定浏览器时：`CHROME_PATH=/path/to/chrome npm run integration`

## 真机验证

自动化测试用 mock 页面覆盖了完整链路，但「真实网站的页面结构是否与假设一致」
只能在真机确认：

**YouTube（主路径）**

1. 设置页填好 API Key，打开一个有英文字幕的 YouTube 视频
2. 几秒内应该看到播放器右上角出现「翻译中 n/m」徽标，随后双语字幕出现
3. 首次打开一个视频约 3 秒出第一批字幕；再次打开同一视频秒出（缓存）
4. 全屏 / 剧场模式下字幕应该跟随；切到别的视频应该重新走一遍流程

**X / Twitter（尽力而为）**

1. 打开一条**带字幕视频**的推文详情页（点进单条推文，不是时间线）
2. 判断视频有没有字幕：X 播放器设置菜单里有没有字幕选项
3. 有字幕轨 → 应该和 YouTube 一样出双语字幕；没有 → Console 里明确说明
4. **注意**：X 上大部分用户上传的视频没有字幕轨（很多是烧在画面里的），
   那种情况显示不了是预期行为，不是 bug

**排查**：F12 → Console 输入 `__ytBilingual`（页面世界直接可用），
`snapshot` 字段会说明取字幕走到了哪一步、失败在哪。把它整个发出来即可定位。

**翻译很慢？** 用 Qwen3 / DeepSeek-R1 这类思考型模型时，模型会先思考几千
token 再回答。关思考的字段各家不一样，所以设置页「思考模式 / 额外参数」是一段
可自己填的 JSON，会原样并进请求体，OpenAI 兼容供应商默认已填
`{ "enable_thinking": false }`。换别家时改成对应字段即可：智谱 GLM / 火山豆包
用 `{ "thinking": { "type": "disabled" } }`。填错（供应商认不得该字段）会自动去掉
这段重试一次，不至于整批失败。再不行就换非思考型模型（qwen-plus / deepseek-chat），
或调高「并发请求数」。改完设置无需刷新页面，当前视频会自动重新翻译。

## 目录结构

```
src/
  adapters/       站点适配器（只有这一层知道"我在哪个网站"）
  subtitle/       字幕解析（timedtext）与整理（normalize）
  render/         字幕样式，设置页预览与播放器覆盖层共用
  store/          配置、诊断信息
  entrypoints/    background / content / main-world / options
test/             单元测试
scripts/          集成测试与冒烟测试
```
