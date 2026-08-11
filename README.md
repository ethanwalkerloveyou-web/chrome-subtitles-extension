# YouTube 双语字幕

英文视频的中英双语字幕，大模型驱动，面向中文学习者。自用的 Chrome 扩展，不上架。

完整技术方案见 [DESIGN.md](./DESIGN.md)。

## 当前进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 项目骨架 + 设置页 | ✅ |
| M2 | 取字幕（三级降级 + 自动字幕规整） | ✅ |
| M3 | 翻译管线 | 未开始 |
| M4 | 字幕渲染与同步 | 未开始 |
| M5 | 缓存 + 播放位置优先 | 未开始 |
| M6 | 拼音、生词本、Anki 导出 | 未开始 |

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
npm run build && npm run smoke         # 冒烟测试：设置页渲染与配置落盘
```

集成测试用 Playwright 拦截把 `https://www.youtube.com/watch` 换成 mock 页面，所以
content script 的 matches 规则是真的生效的，测的是完整链路。**它不覆盖
「YouTube 真实页面结构是否与假设一致」** —— 那个只能在真机上验，见下。

需要指定浏览器时：`CHROME_PATH=/path/to/chrome npm run integration`

## 真机验证（M2 必做一次）

自动化测试跑的是 mock 页面。YouTube 真实页面的结构（`ytInitialPlayerResponse`
的路径、`/api/timedtext` 的参数）是根据公开资料写的，需要在真实环境确认一次：

1. 装载扩展，打开一个**有人工英文字幕**的 YouTube 视频
2. F12 → Console，应该看到：
   ```
   [双语字幕] ✓ 人工字幕 · 42 段 · 来源 player-response
   ```
3. 在 Console 里执行 `__ytBilingual.track`，检查：
   - `lines[0].text` 是完整的英文句子（不是半句）
   - `startMs` / `endMs` 与视频里那句话的实际时间对得上
4. 换一个**只有自动字幕**的视频（CC 菜单里显示"英语(自动生成)"），重复上面两步，
   这次应该看到 `自动字幕` 和 `来源 player-response`，并且：
   - `track.tokens` 有词级时间戳
   - `lines[0].text` 里**没有重复的词**（滚动字幕的重复已被去掉）
5. 不离开页面，从推荐里点进另一个视频，确认日志重新打印了一次（SPA 导航生效）

如果第 2 步没有任何日志，或者显示 `⚠ 这个视频没有可用的英文字幕轨`，把
`__ytBilingual` 和 Console 里的报错发我，多半是选择器或字段路径需要调整。

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
