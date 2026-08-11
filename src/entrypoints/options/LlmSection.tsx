import { useId, useState } from 'react';
import { sendMessage, type TestConnectionResult } from '../../messaging.ts';
import {
  BASE_URL_PRESETS,
  MODEL_PRESETS,
  type Effort,
  type LlmSettings,
  type ProviderId,
} from '../../store/settings.ts';
import {
  Field,
  ModelCombo,
  Section,
  Select,
  Slider,
  TextInput,
} from './controls.tsx';

const PROVIDERS: { value: ProviderId; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai-compatible', label: 'OpenAI 兼容接口' },
];

const EFFORTS: { value: Effort; label: string }[] = [
  { value: 'low', label: 'low — 字幕翻译推荐' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high — 更慢更贵' },
];

export default function LlmSection({
  llm,
  patch,
}: {
  llm: LlmSettings;
  patch: (p: Partial<LlmSettings>) => void;
}) {
  const baseUrlListId = useId();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestConnectionResult | null>(null);

  const isAnthropic = llm.provider === 'anthropic';

  /**
   * 自定义 Base URL 的域名不在 manifest 的 host_permissions 里，
   * 必须在用户手势（点按钮）中即时申请，否则 fetch 会被扩展策略拦掉。
   */
  async function ensureHostPermission(): Promise<string | null> {
    if (isAnthropic) return null;
    let origin: string;
    try {
      origin = `${new URL(llm.baseUrl).origin}/*`;
    } catch {
      return 'Base URL 格式不对';
    }
    const granted = await chrome.permissions.request({ origins: [origin] });
    return granted ? null : `没有授予 ${origin} 的访问权限`;
  }

  async function runTest() {
    setTesting(true);
    setResult(null);
    try {
      const permissionError = await ensureHostPermission();
      if (permissionError) {
        setResult({ ok: false, detail: permissionError });
        return;
      }
      setResult(await sendMessage<TestConnectionResult>({
        type: 'TEST_CONNECTION',
        llm,
      }));
    } catch (err) {
      setResult({
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <Section
      title="大模型"
      description="翻译由这里配置的模型生成。API Key 只保存在本机，不会上传到任何地方。"
    >
      <Field label="供应商">
        <Select
          value={llm.provider}
          onChange={(provider) => patch({ provider })}
          options={PROVIDERS}
        />
      </Field>

      {!isAnthropic && (
        <Field
          label="Base URL"
          hint="选一个预设，或手填。Key 只在对应家的地址上有效"
        >
          <div className="model-combo">
            <input
              className="text-input is-mono"
              list={baseUrlListId}
              value={llm.baseUrl}
              spellCheck={false}
              autoComplete="off"
              placeholder="https://api.deepseek.com/v1"
              // trim：从文档里复制地址常带空格，供应商会直接 404 / 401
              onChange={(e) => patch({ baseUrl: e.target.value.trim() })}
            />
            <datalist id={baseUrlListId}>
              {BASE_URL_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </datalist>
          </div>
        </Field>
      )}

      <Field label="API Key" hint="按供应商分别保存，切换回来不用重填">
        <TextInput
          value={llm.apiKeys[llm.provider]}
          // trim：复制 Key 时带上的空格或换行会让供应商报「Key 格式不正确」，
          // 那个报错完全看不出是空格的问题，所以在入口就清掉
          onChange={(key) =>
            patch({ apiKeys: { ...llm.apiKeys, [llm.provider]: key.trim() } })
          }
          placeholder={isAnthropic ? 'sk-ant-...' : 'sk-...'}
          password
          monospace
        />
      </Field>

      <Field label="模型">
        <ModelCombo
          value={llm.models[llm.provider]}
          onChange={(model) =>
            patch({ models: { ...llm.models, [llm.provider]: model } })
          }
          presets={MODEL_PRESETS[llm.provider]}
        />
      </Field>

      {isAnthropic && (
        <Field
          label="推理强度 (effort)"
          hint="字幕翻译不需要深度推理，low 又快又省"
        >
          <Select
            value={llm.effort}
            onChange={(effort) => patch({ effort })}
            options={EFFORTS}
          />
        </Field>
      )}

      <Field
        label="每批句数"
        hint="太小则上下文不足译文割裂，太大则单批延迟高"
      >
        <Slider
          value={llm.batchSize}
          onChange={(batchSize) => patch({ batchSize })}
          min={5}
          max={50}
          unit=" 句"
        />
      </Field>

      <Field label="并发请求数" hint="调高出字幕更快，但容易触发供应商限流">
        <Slider
          value={llm.concurrency}
          onChange={(concurrency) => patch({ concurrency })}
          min={1}
          max={8}
        />
      </Field>

      <div className="test-row">
        <button
          type="button"
          className="btn"
          onClick={runTest}
          disabled={testing}
        >
          {testing ? '测试中…' : '测试连接'}
        </button>
        {result && (
          <span className={`test-result ${result.ok ? 'is-ok' : 'is-err'}`}>
            {result.ok ? '✓' : '✕'} {result.detail}
            {result.latencyMs !== undefined && ` (${result.latencyMs}ms)`}
          </span>
        )}
      </div>
    </Section>
  );
}
