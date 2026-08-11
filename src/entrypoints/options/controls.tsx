import { useId, type ReactNode } from 'react';

/** 一个带标题的配置分区。 */
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <header className="section-head">
        <h2>{title}</h2>
        {description && <p className="section-desc">{description}</p>}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}

/** 一行「标签 + 控件」。hint 用于解释这个选项到底影响什么。 */
export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <div className="field-label">
        <label htmlFor={htmlFor}>{label}</label>
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      <div className="field-control">{children}</div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle${disabled ? ' is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  );
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  unit = '',
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
}) {
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <output>
        {value}
        {unit}
      </output>
    </div>
  );
}

export function ColorPicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="color-picker">
      <input
        type="color"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-label="选择颜色"
      />
      <input
        type="text"
        className="color-hex"
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value.trim();
          // 只在合法的完整 hex 时才写回，允许用户中途输入不完整的值
          if (/^#[0-9a-f]{6}$/i.test(v)) onChange(v);
        }}
      />
    </div>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  id,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  id?: string;
}) {
  return (
    <select
      id={id}
      className="select"
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  password,
  monospace,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  password?: boolean;
  monospace?: boolean;
  id?: string;
}) {
  return (
    <input
      id={id}
      className={`text-input${monospace ? ' is-mono' : ''}`}
      type={password ? 'password' : 'text'}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * 下拉预设 + 自由输入的组合。
 *
 * 模型 ID 变化很快，只给固定下拉的话，新模型发布后就填不进去了。
 */
export function ModelCombo({
  value,
  onChange,
  presets,
}: {
  value: string;
  onChange: (v: string) => void;
  presets: { value: string; label: string; hint: string }[];
}) {
  const listId = useId();
  const matched = presets.find((p) => p.value === value);
  return (
    <div className="model-combo">
      <input
        className="text-input is-mono"
        list={listId}
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder="模型 ID"
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {presets.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label} — {p.hint}
          </option>
        ))}
      </datalist>
      <p className="combo-hint">
        {matched ? matched.hint : '自定义模型 ID —— 确保供应商支持'}
      </p>
    </div>
  );
}
