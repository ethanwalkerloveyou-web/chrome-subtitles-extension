/**
 * 把字幕配置翻译成 CSS。
 *
 * 设置页的实时预览和播放器里的真实字幕层都调用这里，
 * 保证「预览看到的」就是「播放时看到的」。
 */

import type { LayerStyle, SubtitleSettings } from '../store/settings.ts';

/** #rrggbb + alpha → rgba()。输入非法时退回不透明黑，不抛异常。 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const a = Math.min(1, Math.max(0, alpha));
  if (!m) return `rgba(0, 0, 0, ${a})`;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/**
 * 用四向 text-shadow 模拟描边。
 *
 * 不用 -webkit-text-stroke：它是内描边，会把字形本身削细，
 * 中文笔画多，细了就糊。
 */
function outlineShadow(color: string, width: number): string {
  if (width <= 0) return 'none';
  const w = width;
  return [
    `${w}px 0 ${w}px ${color}`,
    `-${w}px 0 ${w}px ${color}`,
    `0 ${w}px ${w}px ${color}`,
    `0 -${w}px ${w}px ${color}`,
  ].join(', ');
}

/** 字幕外层容器：定位、宽度、背景。 */
export function containerStyle(s: SubtitleSettings): Record<string, string> {
  const bg =
    s.background.mode === 'solid'
      ? withAlpha(s.background.color, s.background.opacity)
      : 'transparent';

  return {
    position: 'absolute',
    left: '50%',
    bottom: `${s.position.bottomOffset}px`,
    transform: 'translateX(-50%)',
    maxWidth: `${s.position.maxWidth}%`,
    boxSizing: 'border-box',
    padding: `${s.background.paddingY}px ${s.background.paddingX}px`,
    background: bg,
    borderRadius: `${s.background.radius}px`,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: `${s.lineGap}px`,
    fontFamily: s.fontFamily,
    textAlign: 'center',
    lineHeight: '1.35',
    pointerEvents: 'auto',
    userSelect: 'none',
    // 播放器控制栏 z-index 在 30 上下，这里压过它
    zIndex: '60',
  };
}

/** 单层文本（英文 / 拼音 / 中文）。 */
export function layerStyle(
  layer: LayerStyle,
  s: SubtitleSettings,
): Record<string, string> {
  return {
    margin: '0',
    fontSize: `${layer.fontSize}px`,
    fontWeight: layer.bold ? '700' : '400',
    color: withAlpha(layer.color, layer.opacity),
    textShadow: s.outline.enabled
      ? outlineShadow(withAlpha(s.outline.color, 1), s.outline.width)
      : 'none',
    whiteSpace: 'pre-wrap',
    wordBreak: 'normal',
  };
}

/** 难词高亮。 */
export function hardWordStyle(s: SubtitleSettings): Record<string, string> {
  return {
    color: s.hardWordColor,
    cursor: 'pointer',
    borderBottom: `1px dotted ${withAlpha(s.hardWordColor, 0.6)}`,
  };
}

/** 供 React 使用的 CSSProperties（键名已经是 camelCase，直接断言即可）。 */
export function asReactStyle(
  style: Record<string, string>,
): React.CSSProperties {
  return style as unknown as React.CSSProperties;
}
