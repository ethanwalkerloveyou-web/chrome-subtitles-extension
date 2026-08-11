import { useEffect, useRef, useState } from 'react';
import {
  asReactStyle,
  containerStyle,
  hardWordStyle,
  layerStyle,
} from '../../render/subtitle-style.ts';
import type { LayerId, SubtitleSettings } from '../../store/settings.ts';

/** 两个背景差别很大的示例画面，用来检查描边和背景够不够。 */
const BACKDROPS = [
  {
    id: 'dark',
    label: '暗画面',
    css: 'linear-gradient(160deg, #10131a 0%, #1c2530 55%, #2b3a4a 100%)',
  },
  {
    id: 'bright',
    label: '亮画面',
    css: 'linear-gradient(160deg, #fdf6e3 0%, #e8d9a8 45%, #cfe3f7 100%)',
  },
] as const;

const SAMPLE = {
  english: 'So the key insight here is that attention is all you need.',
  pinyin: 'suǒ yǐ zhè lǐ de guān jiàn zài yú, zhù yì lì jī zhì jiù gòu le',
  chinese: '所以这里的关键在于，注意力机制就够了。',
};

/** 中文示例句里被标为难词的片段，用于演示高亮效果。 */
const HARD_WORDS = ['关键', '注意力机制'];

/**
 * 预览按「真实播放器尺寸」渲染，再整体缩放到侧栏宽度。
 *
 * 不这么做的话，26px 的字在 430px 宽的预览框里看着巨大，
 * 在 1280px 宽的播放器里却正常 —— 用户会照着预览把字号调错。
 */
const STAGE_WIDTH = 1280;
const STAGE_HEIGHT = 720;

function useStageScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setScale(width / STAGE_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, scale };
}

/** 把难词从中文句子里切出来，其余部分原样返回。 */
function splitHardWords(text: string, words: string[]) {
  if (words.length === 0) return [{ text, hard: false }];
  const pattern = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'g');
  return text
    .split(pattern)
    .filter(Boolean)
    .map((part) => ({ text: part, hard: words.includes(part) }));
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default function Preview({ subtitle }: { subtitle: SubtitleSettings }) {
  const [backdrop, setBackdrop] = useState<(typeof BACKDROPS)[number]['id']>(
    'dark',
  );
  const active = BACKDROPS.find((b) => b.id === backdrop)!;
  const { ref, scale } = useStageScale();

  function renderLayer(id: LayerId) {
    const layer = subtitle.layers[id];
    if (!layer.enabled) return null;
    const style = asReactStyle(layerStyle(layer, subtitle));

    if (id === 'chinese' && subtitle.highlightHardWords) {
      return (
        <p key={id} style={style}>
          {splitHardWords(SAMPLE.chinese, HARD_WORDS).map((part, i) =>
            part.hard ? (
              <span key={i} style={asReactStyle(hardWordStyle(subtitle))}>
                {part.text}
              </span>
            ) : (
              <span key={i}>{part.text}</span>
            ),
          )}
        </p>
      );
    }

    return (
      <p key={id} style={style}>
        {SAMPLE[id]}
      </p>
    );
  }

  return (
    <div className="preview">
      <div className="preview-head">
        <h2>实时预览</h2>
        <div className="backdrop-switch">
          {BACKDROPS.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`chip${backdrop === b.id ? ' is-active' : ''}`}
              onClick={() => setBackdrop(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      {/* 外框负责裁切和 16:9；内层按 1280×720 渲染后整体缩放 */}
      <div className="preview-frame" ref={ref}>
        <div
          className="preview-stage"
          style={{
            background: active.css,
            width: STAGE_WIDTH,
            height: STAGE_HEIGHT,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        >
          <div style={asReactStyle(containerStyle(subtitle))}>
            {subtitle.order.map(renderLayer)}
          </div>
          {/* 模拟 YouTube 进度条，用来检查字幕会不会被挡 */}
          <div className="fake-controls">
            <span className="fake-play">▶</span>
            <span className="fake-bar">
              <span className="fake-progress" />
            </span>
            <span className="fake-time">12:34 / 45:01</span>
          </div>
        </div>
      </div>

      <p className="preview-note">
        按 1280×720 播放器等比缩放，字号所见即所得。与播放器用的是同一份样式代码。
      </p>
    </div>
  );
}
