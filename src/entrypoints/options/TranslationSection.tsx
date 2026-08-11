import {
  LINE_LENGTH_PRESETS,
  type LineLength,
  type TargetLang,
  type TranslationSettings,
} from '../../store/settings.ts';
import { DEFAULT_SYSTEM_PROMPT } from '../../translate/prompt.ts';
import { Field, Section, Select, TextArea, TextInput } from './controls.tsx';

const LANGS: { value: TargetLang; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
];

const LINE_LENGTHS = (Object.keys(LINE_LENGTH_PRESETS) as LineLength[]).map(
  (value) => ({ value, label: LINE_LENGTH_PRESETS[value].label }),
);

/**
 * 术语表在 UI 上是一个每行 `English = 中文` 的文本框。
 * 比一行一个输入框好用得多 —— 可以整段粘贴。
 */
function parseGlossary(text: string) {
  return text
    .split('\n')
    .map((line) => line.split('='))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({
      en: parts[0]!.trim(),
      zh: parts.slice(1).join('=').trim(),
    }))
    .filter((e) => e.en && e.zh);
}

function formatGlossary(entries: TranslationSettings['glossary']) {
  return entries.map((e) => `${e.en} = ${e.zh}`).join('\n');
}

export default function TranslationSection({
  translation,
  patch,
}: {
  translation: TranslationSettings;
  patch: (p: Partial<TranslationSettings>) => void;
}) {
  // 留空表示用默认模板；文本框里始终把默认模板显示出来，方便直接看和改
  const isCustomPrompt = translation.systemPrompt.trim().length > 0;
  const promptValue = translation.systemPrompt || DEFAULT_SYSTEM_PROMPT;

  return (
    <Section
      title="翻译"
      description="这些内容会拼进发给模型的提示词，直接影响译文风格。"
    >
      <Field label="目标语言">
        <Select
          value={translation.targetLang}
          onChange={(targetLang) => patch({ targetLang })}
          options={LANGS}
        />
      </Field>

      <Field
        label="每条字幕长度"
        hint="每条字幕最多放多少内容。觉得一条太长、铺满屏幕就调「短」；长句会自动拆成多条依次显示。改这个会重新翻译当前视频"
      >
        <Select
          value={translation.lineLength}
          onChange={(lineLength) => patch({ lineLength })}
          options={LINE_LENGTHS}
        />
      </Field>

      <Field
        label="领域提示"
        hint="告诉模型这是什么内容，术语和语气会准很多"
      >
        <TextInput
          value={translation.domain}
          onChange={(domain) => patch({ domain })}
          placeholder="例如：机器学习技术分享 / 历史纪录片 / 脱口秀"
        />
      </Field>

      <Field
        label="术语表"
        hint="一行一条，格式 English = 中文。人名、专有名词写在这里就不会翻乱"
      >
        <textarea
          className="textarea is-mono"
          rows={6}
          spellCheck={false}
          defaultValue={formatGlossary(translation.glossary)}
          placeholder={'attention = 注意力\ntransformer = Transformer\nAndrej = 安德烈'}
          onBlur={(e) => patch({ glossary: parseGlossary(e.target.value) })}
        />
      </Field>
      <p className="field-footnote">
        术语表在失焦时保存，当前 {translation.glossary.length} 条。
      </p>

      <Field
        label="翻译提示词"
        hint="发给模型的系统提示词。想翻成中文以外的语言、或改翻译风格，直接改这段即可。{lang} 会替换成上面选的目标语言，{domain} 替换成领域提示。输出格式、断句、难词等硬规则由程序自动追加，无需在此编写"
      >
        <TextArea
          value={promptValue}
          onChange={(systemPrompt) => patch({ systemPrompt })}
          rows={12}
          monospace
        />
        <div className="prompt-actions">
          <span className="combo-hint">
            {isCustomPrompt ? '● 已自定义' : '当前为默认模板'}
          </span>
          <button
            type="button"
            className="btn is-ghost"
            disabled={!isCustomPrompt}
            onClick={() => patch({ systemPrompt: '' })}
          >
            恢复默认
          </button>
        </div>
      </Field>
    </Section>
  );
}
