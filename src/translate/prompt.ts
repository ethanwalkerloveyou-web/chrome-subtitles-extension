/**
 * 提示词与输出格式。
 *
 * 改动这里的任何内容都要同步把 PROMPT_VERSION 加一 —— 它是缓存 key 的一部分，
 * 不加的话调完提示词还会读到旧译文，会误以为改动没生效。
 */

import type { BatchRequest } from './types.ts';

// 2: 作废 v1 —— 修复静默失败前，Key 配错跑出的「全英文」结果被当成
//    complete 存了缓存，必须整体作废
// 3: 提示词模板可在设置页自定义，且默认模板的措辞有调整，旧缓存整体作废
export const PROMPT_VERSION = 3;

/**
 * 默认的翻译提示词模板（设置页可编辑的那一段）。
 *
 * 只放「翻译风格 / 目标语言」这类用户可能想改的内容 —— 想翻成中文以外的语言，
 * 直接在设置页把这段文字改掉即可。输出格式、断句规则、hard 字段这些关乎
 * 程序正确解析的硬约束不放在这里，由 buildSystemPrompt 固定追加，改不坏。
 *
 * 两个占位符：
 *   {lang}   —— 目标语言名称（取自「目标语言」下拉），如「简体中文」
 *   {domain} —— 领域提示行；没填时自动留空
 */
export const DEFAULT_SYSTEM_PROMPT = `你在翻译视频字幕，读者是正在学{lang}的英文母语者。{domain}

翻译要求：
- 译成自然的{lang}口语，不要翻译腔。宁可意译，不要逐字对应。
- 译文精炼紧凑，适合作为单行字幕阅读。
- 保留说话人的语气：犹豫、强调、玩笑、反问都要体现出来。
- 专有名词、人名、产品名保持原文或用通用译名。`;

/** 模型输出的 JSON Schema。用结构化输出强约束，不靠提示词祈祷。 */
export const LINES_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          en: { type: 'string' },
          zh: { type: 'string' },
          hard: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'en', 'zh', 'hard'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
} as const;

const LANG_LABEL: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
};

function glossaryBlock(glossary: BatchRequest['glossary']): string {
  if (glossary.length === 0) return '';
  const lines = glossary.map((g) => `  ${g.en} → ${g.zh}`).join('\n');
  return `\n<术语表>\n这些词必须按指定译法翻译：\n${lines}\n</术语表>`;
}

export function buildSystemPrompt(req: BatchRequest): string {
  const lang = LANG_LABEL[req.targetLang] ?? '简体中文';
  const domainLine = req.domain ? `\n视频内容领域：${req.domain}` : '';

  // 用户可在设置页改这段；留空则用默认模板。占位符在这里替换。
  const style = (req.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT)
    .replace(/\{lang\}/g, lang)
    .replace(/\{domain\}/g, domainLine);

  const asrExtra =
    req.kind === 'asr'
      ? `
这段文字来自自动语音识别，没有标点、没有大小写、断句随意。你要同时完成三件事：
1. 按语义重新断句成适合字幕显示的短句（每句大约 8~15 个英文词），
   加上正确的标点和大小写，写进 en 字段；长句拆成多条
2. 把每句译成${lang}，写进 zh 字段，每条不超过 25 个字
3. en 字段必须只用原文里出现过的词，顺序不变 —— 不要增删词，否则时间轴会对不上
每条的 id 从 0 开始递增。`
      : `
每条输入都是一个完整句子。逐条翻译，输出的 id 必须与输入的 id 一一对应，
条数必须完全相同。en 字段原样回填输入的英文。`;

  // 下面这些是保证程序能正确解析的硬约束，固定追加，不受用户模板影响。
  return `${style}
- en 和 zh 字段里绝不要出现换行符。
${asrExtra}${glossaryBlock(req.glossary)}

hard 字段：列出这条译文里对学习者较难的词（高级词汇或专业术语），必须是 zh 字段里原样出现的连续子串，最多 3 个，没有就给空数组。`;
}

export function buildUserPrompt(req: BatchRequest): string {
  const context = req.context
    ? `<上文 仅供理解，不要翻译>\n${req.context}\n</上文>\n\n`
    : '';

  if (req.kind === 'asr') {
    const text = req.lines.map((l) => l.text).join(' ');
    return `${context}<待处理>\n${text}\n</待处理>`;
  }

  const numbered = req.lines
    .map((l) => `${l.id}\t${l.text}`)
    .join('\n');
  return `${context}<待翻译 每行格式为 id + 制表符 + 英文>\n${numbered}\n</待翻译>`;
}
