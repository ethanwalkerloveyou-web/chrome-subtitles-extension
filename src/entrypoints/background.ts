import Anthropic from '@anthropic-ai/sdk';
import type { Request, TestConnectionResult } from '../messaging.ts';
import { activeCredentials, type LlmSettings } from '../store/settings.ts';

/**
 * 用一次极短的真实请求验证「Key 有效 + 模型可用 + 网络可达」。
 *
 * 只做连通性验证，不看返回内容质量，所以 max_tokens 给得很小。
 */
async function testAnthropic(llm: LlmSettings): Promise<TestConnectionResult> {
  const { apiKey, model } = activeCredentials(llm);
  if (!apiKey) return { ok: false, detail: '还没有填 API Key' };

  const client = new Anthropic({
    apiKey,
    // service worker 里没有 window，SDK 需要显式放行非 Node 环境
    dangerouslyAllowBrowser: true,
  });

  const started = performance.now();
  const message = await client.messages.create({
    model,
    max_tokens: 256,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: '请只回复两个字：正常' }],
  });

  const text = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  return {
    ok: true,
    detail: text || `模型 ${message.model} 已响应`,
    latencyMs: Math.round(performance.now() - started),
  };
}

async function testOpenAiCompatible(
  llm: LlmSettings,
): Promise<TestConnectionResult> {
  const { apiKey, model, baseUrl } = activeCredentials(llm);
  if (!baseUrl) return { ok: false, detail: '还没有填 Base URL' };
  if (!apiKey) return { ok: false, detail: '还没有填 API Key' };

  const started = performance.now();
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 32,
      messages: [{ role: 'user', content: '请只回复两个字：正常' }],
    }),
  });

  if (!res.ok) {
    return { ok: false, detail: describeHttpError(res.status, await res.text()) };
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return {
    ok: true,
    detail: data.choices?.[0]?.message?.content?.trim() || '已响应',
    latencyMs: Math.round(performance.now() - started),
  };
}

async function handle(req: Request): Promise<TestConnectionResult> {
  if (req.type !== 'TEST_CONNECTION') {
    return { ok: false, detail: `未知消息类型：${(req as Request).type}` };
  }
  try {
    return req.llm.provider === 'anthropic'
      ? await testAnthropic(req.llm)
      : await testOpenAiCompatible(req.llm);
  } catch (err) {
    return { ok: false, detail: describeError(err) };
  }
}

/**
 * 把 OpenAI 兼容供应商的错误响应翻成人话。
 *
 * 各家的错误体结构不一样，但基本都能在 error.message 或 message 里找到
 * 实际原因。直接把整个 JSON 甩给用户，看不出问题出在哪。
 */
function describeHttpError(status: number, body: string): string {
  let message = body.slice(0, 300);
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string };
      message?: string;
    };
    message = parsed.error?.message ?? parsed.message ?? message;
  } catch {
    // 不是 JSON 就原样显示
  }

  const hint =
    status === 401
      ? 'Key 无效，或复制时带了空格/换行，或与 Base URL 不匹配'
      : status === 403
        ? '这个 Key 没有该模型的权限'
        : status === 404
          ? 'Base URL 或模型 ID 不对'
          : status === 429
            ? '触发限流或余额不足'
            : '';

  return hint ? `HTTP ${status}（${hint}）：${message}` : `HTTP ${status}：${message}`;
}

/** 把各种异常翻成用户能看懂的中文。 */
function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'API Key 无效或已被撤销';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'API Key 没有访问该模型的权限';
  }
  if (err instanceof Anthropic.NotFoundError) {
    return '模型 ID 不存在，检查拼写';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return '触发限流，稍后再试';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return '网络不通 —— 检查代理，或确认扩展有该域名的访问权限';
  }
  if (err instanceof Anthropic.APIError) {
    return `API 错误 ${err.status ?? ''}：${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((req: Request, _sender, sendResponse) => {
    handle(req).then(sendResponse);
    // 返回 true 表示会异步回复，Chrome 会保持消息通道打开
    return true;
  });
});
