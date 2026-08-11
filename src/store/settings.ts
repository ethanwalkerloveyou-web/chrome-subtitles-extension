/**
 * 全局配置的数据模型、默认值与读写。
 *
 * 所有配置存在 chrome.storage.local 的单个 key 下（`settings`），整体读写。
 * 配置体积很小（几 KB），整体读写换来的是「不会出现半新半旧的状态」。
 */

// ---------------------------------------------------------------- 大模型

export type ProviderId = 'anthropic' | 'openai-compatible';

/** effort 只影响 Anthropic；字幕翻译不需要深度推理，默认 low。 */
export type Effort = 'low' | 'medium' | 'high';

export interface LlmSettings {
  provider: ProviderId;
  /** 各供应商的 key 分开存，切换供应商时不用重填。 */
  apiKeys: Record<ProviderId, string>;
  /** 各供应商各自记住上次选的模型。 */
  models: Record<ProviderId, string>;
  /** 仅 openai-compatible 使用，例如 https://api.deepseek.com/v1 */
  baseUrl: string;
  effort: Effort;
  /**
   * 各供应商额外注入请求体的一段 JSON，按供应商分开存，原样合并进请求体。
   *
   * 「思考模式」的开关字段各家都不一样，做不成一个统一的布尔开关：
   *   - 阿里云百炼 Qwen3：{"enable_thinking": false}
   *   - 智谱 GLM / 火山豆包：{"thinking": {"type": "disabled"}}
   *   - Anthropic：{"thinking": {"type": "disabled"}}（一般不建议，见下）
   * 所以这里留成一段自由 JSON 让用户自己填。留空表示不额外注入。
   *
   * OpenAI 兼容供应商：合并进 /chat/completions 请求体；若供应商对某个
   * 字段报 400，会自动去掉这段重试一次（宁可退化也别整批失败）。
   * Anthropic：合并进 messages.create 参数，用户填的键覆盖默认值。
   */
  extraBody: Record<ProviderId, string>;
  /** 每批送给模型的字幕句数。太小则上下文不足，太大则单次延迟高。 */
  batchSize: number;
  /** 并发请求数。太高容易触发供应商限流。 */
  concurrency: number;
}

// ---------------------------------------------------------------- 翻译

export type TargetLang = 'zh-CN' | 'zh-TW';

export interface GlossaryEntry {
  en: string;
  zh: string;
}

export interface TranslationSettings {
  targetLang: TargetLang;
  /** 领域提示，拼进系统提示词，例如「机器学习技术分享」。 */
  domain: string;
  glossary: GlossaryEntry[];
  /**
   * 自定义的系统提示词模板（设置页可编辑）。留空表示用内置默认模板。
   * 想翻成中文以外的语言，改这里最直接。输出格式等硬约束由程序固定追加。
   */
  systemPrompt: string;
}

// ---------------------------------------------------------------- 字幕

/** 字幕的两层内容，数组顺序即从上到下的显示顺序。 */
export type LayerId = 'english' | 'chinese';

export const LAYER_LABELS: Record<LayerId, string> = {
  english: '英文原文',
  chinese: '中文译文',
};

export interface LayerStyle {
  /** 这一层的总开关。 */
  enabled: boolean;
  fontSize: number;
  color: string;
  /** 0~1，独立于颜色，方便把原文压暗而不用改颜色。 */
  opacity: number;
  bold: boolean;
}

export type BackgroundMode = 'none' | 'solid';

export interface SubtitleSettings {
  /** 字幕总开关（也可以用 Alt+S 在页面上切）。 */
  enabled: boolean;
  /** 从上到下的层顺序。 */
  order: LayerId[];
  layers: Record<LayerId, LayerStyle>;

  background: {
    mode: BackgroundMode;
    color: string;
    opacity: number;
    paddingX: number;
    paddingY: number;
    radius: number;
  };

  /** 文字描边。关掉背景时靠它保证在亮画面上也看得清。 */
  outline: {
    enabled: boolean;
    color: string;
    width: number;
  };

  /** 距播放器底部的距离（px），以及字幕块最大宽度（占播放器宽度的百分比）。 */
  position: {
    bottomOffset: number;
    maxWidth: number;
  };

  /** 层与层之间的行距（px）。 */
  lineGap: number;
  fontFamily: string;

  /** 高亮模型标出的难词（hard 字段）。 */
  highlightHardWords: boolean;
  hardWordColor: string;
}

// ---------------------------------------------------------------- 汇总

export interface Settings {
  /** 用于将来做配置迁移。 */
  version: number;
  llm: LlmSettings;
  translation: TranslationSettings;
  subtitle: SubtitleSettings;
}

export const SETTINGS_VERSION = 1;

export const FONT_FAMILY_PRESETS = [
  {
    label: '系统默认',
    value:
      '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  { label: '思源黑体 / Noto Sans SC', value: '"Noto Sans SC", sans-serif' },
  { label: '楷体', value: '"Kaiti SC", KaiTi, STKaiti, serif' },
  { label: '宋体 / 衬线', value: '"Songti SC", SimSun, serif' },
] as const;

/**
 * 常见 OpenAI 兼容供应商的接口地址。
 *
 * 填错 Base URL 会得到 401「Key 格式不正确」这种看不出所以然的报错 ——
 * 每家的 Key 只在自家地址上有效，所以直接给出正确地址比让人去翻文档强。
 */
export const BASE_URL_PRESETS = [
  {
    label: '阿里云百炼 / DashScope',
    value: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  { label: 'DeepSeek', value: 'https://api.deepseek.com/v1' },
  { label: 'OpenAI', value: 'https://api.openai.com/v1' },
  { label: '月之暗面 Moonshot', value: 'https://api.moonshot.cn/v1' },
  { label: '硅基流动 SiliconFlow', value: 'https://api.siliconflow.cn/v1' },
  { label: '智谱 GLM', value: 'https://open.bigmodel.cn/api/paas/v4' },
  { label: '本地 Ollama', value: 'http://localhost:11434/v1' },
] as const;

/** 各供应商的推荐模型。用户也可以直接手填任意 model id。 */
export const MODEL_PRESETS: Record<
  ProviderId,
  { value: string; label: string; hint: string }[]
> = {
  anthropic: [
    {
      value: 'claude-opus-5',
      label: 'Claude Opus 5',
      hint: '译文质量最好 · 约 $0.48 / 小时视频',
    },
    {
      value: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      hint: '质量与成本均衡 · 约 $0.19 / 小时视频',
    },
    {
      value: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      hint: '最便宜最快 · 约 $0.10 / 小时视频',
    },
  ],
  'openai-compatible': [
    { value: 'deepseek-chat', label: 'deepseek-chat', hint: 'DeepSeek' },
    { value: 'qwen-plus', label: 'qwen-plus', hint: '阿里云百炼' },
    { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini', hint: 'OpenAI' },
  ],
};

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  llm: {
    provider: 'anthropic',
    apiKeys: { anthropic: '', 'openai-compatible': '' },
    models: {
      anthropic: 'claude-opus-5',
      'openai-compatible': 'deepseek-chat',
    },
    baseUrl: '',
    effort: 'low',
    extraBody: {
      // Anthropic 的思考由 SDK 的 adaptive + effort 处理，禁用它在 Opus 5 上
      // 有已知副作用（见 DESIGN.md），所以默认不注入，留给用户按需覆盖
      anthropic: '',
      // Qwen3 / DeepSeek-R1 这类模型默认先思考几千 token 再回答，字幕翻译
      // 用不上，默认关掉；换成别家（如 GLM）时改成对应字段即可
      'openai-compatible': '{ "enable_thinking": false }',
    },
    batchSize: 20,
    concurrency: 3,
  },
  translation: {
    targetLang: 'zh-CN',
    domain: '',
    glossary: [],
    systemPrompt: '',
  },
  subtitle: {
    enabled: true,
    order: ['english', 'chinese'],
    layers: {
      english: {
        enabled: true,
        fontSize: 18,
        color: '#d8dee9',
        opacity: 0.75,
        bold: false,
      },
      chinese: {
        enabled: true,
        fontSize: 26,
        color: '#ffffff',
        opacity: 1,
        bold: true,
      },
    },
    background: {
      mode: 'solid',
      color: '#000000',
      opacity: 0.45,
      paddingX: 16,
      paddingY: 8,
      radius: 6,
    },
    outline: {
      enabled: true,
      color: '#000000',
      width: 2,
    },
    position: {
      bottomOffset: 72,
      maxWidth: 82,
    },
    lineGap: 4,
    fontFamily: FONT_FAMILY_PRESETS[0].value,
    highlightHardWords: true,
    hardWordColor: '#ebcb8b',
  },
};

// ---------------------------------------------------------------- 读写

const STORAGE_KEY = 'settings';

/**
 * 与默认值做深合并。
 *
 * 这一步不是形式主义：升级插件后新增的配置项在旧的存储里不存在，
 * 不合并的话读出来是 undefined，UI 会崩。
 */
function merge<T>(fallback: T, stored: unknown): T {
  if (stored === null || stored === undefined) return fallback;

  // 数组整体替换 —— glossary / order 这类数组按元素合并没有意义
  if (Array.isArray(fallback)) {
    return (Array.isArray(stored) ? stored : fallback) as T;
  }

  if (typeof fallback === 'object' && typeof stored === 'object') {
    const out = { ...(fallback as object) } as Record<string, unknown>;
    for (const key of Object.keys(fallback as object)) {
      out[key] = merge(
        (fallback as Record<string, unknown>)[key],
        (stored as Record<string, unknown>)[key],
      );
    }
    return out as T;
  }

  return typeof stored === typeof fallback ? (stored as T) : fallback;
}

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  return merge(DEFAULT_SETTINGS, raw[STORAGE_KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

export async function resetSettings(): Promise<Settings> {
  await saveSettings(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

/** 订阅配置变化，用于让内容脚本里的字幕层实时跟随设置页的改动。 */
export function watchSettings(cb: (settings: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ) => {
    if (area !== 'local' || !(STORAGE_KEY in changes)) return;
    cb(merge(DEFAULT_SETTINGS, changes[STORAGE_KEY]?.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ---------------------------------------------------------------- 派生

/**
 * 当前生效的 API Key / 模型，供翻译管线使用。
 *
 * 统一 trim：从网页或文档里复制 Key 极容易带上首尾空格或换行，
 * 供应商那边会直接判成「Key 格式不正确」，报错还看不出是空格的问题。
 */
export function activeCredentials(llm: LlmSettings) {
  return {
    provider: llm.provider,
    apiKey: (llm.apiKeys[llm.provider] ?? '').trim(),
    model: (llm.models[llm.provider] ?? '').trim(),
    baseUrl: llm.baseUrl.trim(),
  };
}

/** 至少要有一层是开的，否则字幕层等于关掉了。 */
export function hasVisibleLayer(subtitle: SubtitleSettings): boolean {
  return subtitle.order.some((id) => subtitle.layers[id].enabled);
}

/**
 * 校验用户填的额外请求体 JSON。
 *
 * 返回 `ok: false` 时不动它 —— UI 据此给出红字提示，请求侧则当作空对象跳过，
 * 绝不把一段解析不了的文本硬塞进请求体把整批翻译搞崩。
 *
 * 只接受「JSON 对象」：数组、字符串、数字这些没法合并进请求体，一律判非法。
 */
export function parseExtraBody(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: {} };

  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: '不是合法的 JSON' };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, error: '需要是一个 JSON 对象，例如 {"enable_thinking": false}' };
  }
  return { ok: true, value: doc as Record<string, unknown> };
}
