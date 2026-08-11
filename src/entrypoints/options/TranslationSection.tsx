import type { TargetLang, TranslationSettings } from '../../store/settings.ts';
import { Field, Section, Select, TextInput } from './controls.tsx';

const LANGS: { value: TargetLang; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
];

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
    </Section>
  );
}
