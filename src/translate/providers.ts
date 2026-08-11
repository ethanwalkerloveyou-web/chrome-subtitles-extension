/**
 * 各供应商的翻译实现。
 *
 * 两条路：Anthropic 走官方 SDK 的结构化输出；其余走 OpenAI 兼容接口，
 * 用 JSON mode + 手工校验（各家对 json_schema 的支持程度不一）。
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  activeCredentials,
  parseExtraBody,
  type LlmSettings,
} from '../store/settings.ts';
import { buildSystemPrompt, buildUserPrompt, LINES_SCHEMA } from './prompt.ts';
import type { BatchRequest, ModelLine, TranslationProvider } from './types.ts';

/** 模型返回的 JSON 不一定合规，逐条校验，坏的直接丢。 */
export function parseModelLines(raw: string): ModelLine[] {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    // 有些模型会在 JSON 外面包一层 ```json 围栏
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
    if (!fenced) throw new Error('返回的不是 JSON');
    doc = JSON.parse(fenced[1]!);
  }

  const lines = (doc as { lines?: unknown }).lines;
  if (!Array.isArray(lines)) throw new Error('返回里没有 lines 数组');

  return lines
    .filter(
      (l): l is ModelLine =>
        !!l &&
        typeof (l as ModelLine).zh === 'string' &&
        typeof (l as ModelLine).en === 'string',
    )
    .map((l) => ({
      id: typeof l.id === 'number' ? l.id : undefined,
      // 提示词禁止了换行，但模型偶尔还是会给 —— 渲染层一行一层，
      // 字段里的换行会把版式撑乱，这里兜底压掉
      en: l.en.replace(/\s*\n+\s*/g, ' ').trim(),
      zh: l.zh.replace(/\s*\n+\s*/g, '').trim(),
      hard: Array.isArray(l.hard)
        ? l.hard.filter((h): h is string => typeof h === 'string').slice(0, 3)
        : [],
    }));
}

function firstText(content: { type: string; text?: string }[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/** 解析用户填的额外请求体；解析不了就当没填，绝不因一个字段拖垮整批翻译。 */
function extraBodyOf(raw: string): Record<string, unknown> {
  const parsed = parseExtraBody(raw);
  return parsed.ok ? parsed.value : {};
}

class AnthropicProvider implements TranslationProvider {
  readonly id = 'anthropic';
  private readonly llm: LlmSettings;

  constructor(llm: LlmSettings) {
    this.llm = llm;
  }

  async translateBatch(
    req: BatchRequest,
    signal: AbortSignal,
  ): Promise<ModelLine[]> {
    const { apiKey, model } = activeCredentials(this.llm);
    const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

    const message = await client.messages.create(
      {
        model,
        max_tokens: 16000,
        // 翻译不需要深度推理；adaptive + low 比关掉思考更稳，
        // 关掉思考在 Opus 5 上有已知副作用（内部标签可能漏进输出）
        thinking: { type: 'adaptive' },
        output_config: {
          effort: this.llm.effort,
          format: { type: 'json_schema', schema: LINES_SCHEMA },
        },
        system: buildSystemPrompt(req),
        messages: [{ role: 'user', content: buildUserPrompt(req) }],
        // 用户填的额外参数覆盖在最后：想改 thinking 之类就用它。
        // SDK 是强类型的，这里必须 as 才能塞进未知键
        ...extraBodyOf(this.llm.extraBody.anthropic),
      } as Anthropic.MessageCreateParamsNonStreaming,
      { signal },
    );

    if (message.stop_reason === 'refusal') {
      throw new Error('模型拒绝了这段内容');
    }
    return parseModelLines(firstText(message.content));
  }
}

class OpenAiCompatibleProvider implements TranslationProvider {
  readonly id = 'openai-compatible';
  private readonly llm: LlmSettings;

  constructor(llm: LlmSettings) {
    this.llm = llm;
  }

  async translateBatch(
    req: BatchRequest,
    signal: AbortSignal,
  ): Promise<ModelLine[]> {
    const { apiKey, model, baseUrl } = activeCredentials(this.llm);
    const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const base = {
      model,
      max_tokens: 8000,
      messages: [
        {
          role: 'system',
          content: `${buildSystemPrompt(req)}

只输出 JSON，格式为：{"lines":[{"id":0,"en":"...","zh":"...","hard":[]}]}`,
        },
        { role: 'user', content: buildUserPrompt(req) },
      ],
    };

    // 可选参数单独放：有的供应商会对不认识的参数直接报 400，
    // 那种情况下去掉它们重试一次（宁可退化也别整批失败）
    const optional: Record<string, unknown> = {
      // 各家对 json_schema 的支持不一致，json_object 是最大公约数，
      // 配合提示词里的格式说明 + 返回后的校验
      response_format: { type: 'json_object' },
      // 用户填的额外参数（各家关思考的字段不同：Qwen 用 enable_thinking，
      // GLM/豆包用 thinking.type 等）。解析不了就当没填（UI 会提示）。
      // 放进 optional：供应商若认不得会 400，届时去掉这些重试一次
      ...extraBodyOf(this.llm.extraBody['openai-compatible']),
    };

    const call = (body: Record<string, unknown>) =>
      fetch(endpoint, {
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

    let res = await call({ ...base, ...optional });
    if (res.status === 400 && Object.keys(optional).length > 0) {
      res = await call(base);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return parseModelLines(data.choices?.[0]?.message?.content ?? '');
  }
}

export function createProvider(llm: LlmSettings): TranslationProvider {
  return llm.provider === 'anthropic'
    ? new AnthropicProvider(llm)
    : new OpenAiCompatibleProvider(llm);
}
