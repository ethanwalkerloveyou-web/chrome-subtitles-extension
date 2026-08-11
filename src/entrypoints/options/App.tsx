import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  resetSettings,
  saveSettings,
  type LlmSettings,
  type Settings,
  type SubtitleSettings,
  type TranslationSettings,
} from '../../store/settings.ts';
import LlmSection from './LlmSection.tsx';
import Preview from './Preview.tsx';
import SubtitleSection from './SubtitleSection.tsx';
import TranslationSection from './TranslationSection.tsx';

type SaveState = 'loading' | 'idle' | 'saving' | 'saved';

const SAVE_DEBOUNCE_MS = 350;

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [saveState, setSaveState] = useState<SaveState>('loading');

  // 首次加载完成前不要触发保存，否则会把默认值覆盖掉用户已有的配置
  const loaded = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      loaded.current = true;
      setSaveState('idle');
    });
  }, []);

  // 自动保存：改动停下来 350ms 后落盘
  useEffect(() => {
    if (!loaded.current) return;
    setSaveState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await saveSettings(settings);
      setSaveState('saved');
      setTimeout(
        () => setSaveState((s) => (s === 'saved' ? 'idle' : s)),
        1600,
      );
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [settings]);

  const patchLlm = useCallback(
    (p: Partial<LlmSettings>) =>
      setSettings((s) => ({ ...s, llm: { ...s.llm, ...p } })),
    [],
  );
  const patchTranslation = useCallback(
    (p: Partial<TranslationSettings>) =>
      setSettings((s) => ({ ...s, translation: { ...s.translation, ...p } })),
    [],
  );
  const patchSubtitle = useCallback(
    (p: Partial<SubtitleSettings>) =>
      setSettings((s) => ({ ...s, subtitle: { ...s.subtitle, ...p } })),
    [],
  );

  async function onReset() {
    if (!confirm('恢复全部默认设置？API Key 也会被清空。')) return;
    setSettings(await resetSettings());
  }

  if (saveState === 'loading') {
    return <div className="loading">加载中…</div>;
  }

  return (
    <div className="app">
      <header className="app-head">
        <div>
          <h1>YouTube 双语字幕</h1>
          <p className="subtitle-note">改动会自动保存，无需手动提交。</p>
        </div>
        <div className="head-actions">
          <span className={`save-state is-${saveState}`}>
            {saveState === 'saving' && '保存中…'}
            {saveState === 'saved' && '✓ 已保存'}
          </span>
          <button type="button" className="btn is-ghost" onClick={onReset}>
            恢复默认
          </button>
        </div>
      </header>

      <main className="app-body">
        <div className="col-settings">
          <LlmSection llm={settings.llm} patch={patchLlm} />
          <TranslationSection
            translation={settings.translation}
            patch={patchTranslation}
          />
          <SubtitleSection
            subtitle={settings.subtitle}
            patch={patchSubtitle}
          />
        </div>

        <aside className="col-preview">
          <Preview subtitle={settings.subtitle} />
        </aside>
      </main>
    </div>
  );
}
