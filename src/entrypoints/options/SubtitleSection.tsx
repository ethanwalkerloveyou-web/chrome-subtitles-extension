import {
  FONT_FAMILY_PRESETS,
  LAYER_LABELS,
  hasVisibleLayer,
  type BackgroundMode,
  type LayerId,
  type LayerStyle,
  type SubtitleSettings,
} from '../../store/settings.ts';
import {
  ColorPicker,
  Field,
  Section,
  Select,
  Slider,
  Toggle,
} from './controls.tsx';

const BG_MODES: { value: BackgroundMode; label: string }[] = [
  { value: 'solid', label: '半透明色块' },
  { value: 'none', label: '无背景（靠描边看清）' },
];

const FONTS = FONT_FAMILY_PRESETS.map((f) => ({
  value: f.value,
  label: f.label,
}));

/** 一层内容（英文 / 中文）的完整样式设置。 */
function LayerCard({
  id,
  layer,
  index,
  total,
  onChange,
  onMove,
  lockedOn,
}: {
  id: LayerId;
  layer: LayerStyle;
  index: number;
  total: number;
  onChange: (patch: Partial<LayerStyle>) => void;
  onMove: (dir: -1 | 1) => void;
  lockedOn: boolean;
}) {
  return (
    <div className={`layer-card${layer.enabled ? '' : ' is-off'}`}>
      <div className="layer-head">
        <Toggle
          checked={layer.enabled}
          disabled={lockedOn}
          onChange={(enabled) => onChange({ enabled })}
          label={LAYER_LABELS[id]}
        />
        <div className="layer-order">
          <button
            type="button"
            className="icon-btn"
            title="上移"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="icon-btn"
            title="下移"
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
        </div>
      </div>

      {layer.enabled && (
        <div className="layer-body">
          <Field label="字号">
            <Slider
              value={layer.fontSize}
              onChange={(fontSize) => onChange({ fontSize })}
              min={10}
              max={56}
              unit="px"
            />
          </Field>
          <Field label="颜色">
            <ColorPicker
              value={layer.color}
              onChange={(color) => onChange({ color })}
            />
          </Field>
          <Field label="不透明度" hint="把原文压暗、突出译文时很有用">
            <Slider
              value={layer.opacity}
              onChange={(opacity) => onChange({ opacity })}
              min={0.2}
              max={1}
              step={0.05}
            />
          </Field>
          <Field label="加粗">
            <Toggle
              checked={layer.bold}
              onChange={(bold) => onChange({ bold })}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

export default function SubtitleSection({
  subtitle,
  patch,
}: {
  subtitle: SubtitleSettings;
  patch: (p: Partial<SubtitleSettings>) => void;
}) {
  const enabledCount = subtitle.order.filter(
    (id) => subtitle.layers[id].enabled,
  ).length;

  function patchLayer(id: LayerId, p: Partial<LayerStyle>) {
    patch({
      layers: { ...subtitle.layers, [id]: { ...subtitle.layers[id], ...p } },
    });
  }

  function move(id: LayerId, dir: -1 | 1) {
    const order = [...subtitle.order];
    const i = order.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    patch({ order });
  }

  return (
    <>
      <Section
        title="展示内容"
        description="英文与中文两层各自独立开关，顺序可调。至少要保留一层。"
      >
        {subtitle.order.map((id, index) => (
          <LayerCard
            key={id}
            id={id}
            index={index}
            total={subtitle.order.length}
            layer={subtitle.layers[id]}
            onChange={(p) => patchLayer(id, p)}
            onMove={(dir) => move(id, dir)}
            // 只剩最后一层开着时禁止关掉，否则字幕整个消失
            lockedOn={enabledCount === 1 && subtitle.layers[id].enabled}
          />
        ))}

        <Field
          label="高亮难词"
          hint="模型会标出译文里较难的词，点击可加入生词本"
        >
          <Toggle
            checked={subtitle.highlightHardWords}
            onChange={(highlightHardWords) => patch({ highlightHardWords })}
          />
        </Field>
        {subtitle.highlightHardWords && (
          <Field label="难词颜色">
            <ColorPicker
              value={subtitle.hardWordColor}
              onChange={(hardWordColor) => patch({ hardWordColor })}
            />
          </Field>
        )}
      </Section>

      <Section title="外观">
        <Field label="字体">
          <Select
            value={subtitle.fontFamily}
            onChange={(fontFamily) => patch({ fontFamily })}
            options={FONTS}
          />
        </Field>

        <Field label="行距">
          <Slider
            value={subtitle.lineGap}
            onChange={(lineGap) => patch({ lineGap })}
            min={0}
            max={20}
            unit="px"
          />
        </Field>

        <Field label="背景">
          <Select
            value={subtitle.background.mode}
            onChange={(mode) =>
              patch({ background: { ...subtitle.background, mode } })
            }
            options={BG_MODES}
          />
        </Field>

        {subtitle.background.mode === 'solid' && (
          <>
            <Field label="背景色">
              <ColorPicker
                value={subtitle.background.color}
                onChange={(color) =>
                  patch({ background: { ...subtitle.background, color } })
                }
              />
            </Field>
            <Field label="背景不透明度">
              <Slider
                value={subtitle.background.opacity}
                onChange={(opacity) =>
                  patch({ background: { ...subtitle.background, opacity } })
                }
                min={0}
                max={1}
                step={0.05}
              />
            </Field>
            <Field label="内边距">
              <div className="dual-slider">
                <Slider
                  value={subtitle.background.paddingX}
                  onChange={(paddingX) =>
                    patch({ background: { ...subtitle.background, paddingX } })
                  }
                  min={0}
                  max={48}
                  unit="px 横"
                />
                <Slider
                  value={subtitle.background.paddingY}
                  onChange={(paddingY) =>
                    patch({ background: { ...subtitle.background, paddingY } })
                  }
                  min={0}
                  max={32}
                  unit="px 竖"
                />
              </div>
            </Field>
            <Field label="圆角">
              <Slider
                value={subtitle.background.radius}
                onChange={(radius) =>
                  patch({ background: { ...subtitle.background, radius } })
                }
                min={0}
                max={24}
                unit="px"
              />
            </Field>
          </>
        )}

        <Field
          label="文字描边"
          hint="关掉背景时必开，否则亮画面上看不清"
        >
          <Toggle
            checked={subtitle.outline.enabled}
            onChange={(enabled) =>
              patch({ outline: { ...subtitle.outline, enabled } })
            }
          />
        </Field>
        {subtitle.outline.enabled && (
          <>
            <Field label="描边颜色">
              <ColorPicker
                value={subtitle.outline.color}
                onChange={(color) =>
                  patch({ outline: { ...subtitle.outline, color } })
                }
              />
            </Field>
            <Field label="描边粗细">
              <Slider
                value={subtitle.outline.width}
                onChange={(width) =>
                  patch({ outline: { ...subtitle.outline, width } })
                }
                min={0}
                max={6}
                unit="px"
              />
            </Field>
          </>
        )}
      </Section>

      <Section title="位置">
        <Field label="距底部距离" hint="留够空间避免被进度条挡住">
          <Slider
            value={subtitle.position.bottomOffset}
            onChange={(bottomOffset) =>
              patch({ position: { ...subtitle.position, bottomOffset } })
            }
            min={0}
            max={240}
            unit="px"
          />
        </Field>
        <Field label="最大宽度" hint="占播放器宽度的百分比，决定何时折行">
          <Slider
            value={subtitle.position.maxWidth}
            onChange={(maxWidth) =>
              patch({ position: { ...subtitle.position, maxWidth } })
            }
            min={40}
            max={100}
            unit="%"
          />
        </Field>
        {!hasVisibleLayer(subtitle) && (
          <p className="warn">所有层都关闭了，字幕不会显示。</p>
        )}
      </Section>
    </>
  );
}
