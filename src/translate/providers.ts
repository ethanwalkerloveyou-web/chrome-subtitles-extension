/**
 * 各供应商的翻译实现。
 *
 * 两条路：Anthropic 走官方 SDK 的结构化输出；其余走 OpenAI 兼容接口，
 * 用 JSON mode + 手工校验（各家对 json_schema 的支持程度不一）。
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  activeCredentials,
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
      en: l.en,
      zh: l.zh,
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
      },
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

    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        // 各家对 json_schema 的支持不一致，json_object 是最大公约数，
        // 配合提示词里的格式说明 + 返回后的校验
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `${buildSystemPrompt(req)}

只输出 JSON，格式为：{"lines":[{"id":0,"en":"...","zh":"...","hard":[]}]}`,
          },
          { role: 'user', content: buildUserPrompt(req) },
        ],
      }),
    });

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
