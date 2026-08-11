/**
 * 播放器上的字幕覆盖层。
 *
 * 两个关键点：
 *  1. 挂进播放器容器而不是 body —— 全屏时浏览器只把播放器容器提到全屏层，
 *     挂在 body 上的元素会整个消失
 *  2. 用 Shadow DOM 隔离样式 —— 否则会被站点的 CSS 污染
 */

import type { SubtitleSettings } from '../store/settings.ts';
import type { RenderLine } from '../translate/types.ts';
import { containerStyle, hardWordStyle, layerStyle } from './subtitle-style.ts';

export interface OverlayCallbacks {
  /** 点击难词。生词本（M6）会用到。 */
  onWordClick?: (word: string, line: RenderLine) => void;
}

export class SubtitleOverlay {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private box: HTMLElement | null = null;
  private badge: HTMLElement | null = null;
  private current: RenderLine | null = null;
  private settings: SubtitleSettings;

  private readonly callbacks: OverlayCallbacks;

  constructor(settings: SubtitleSettings, callbacks: OverlayCallbacks = {}) {
    this.settings = settings;
    this.callbacks = callbacks;
  }

  /** 挂载到播放器容器。重复调用是安全的。 */
  mount(container: HTMLElement): void {
    if (this.host?.isConnected && this.host.parentElement === container) return;
    this.destroy();

    const host = document.createElement('div');
    host.dataset.ytBilingual = 'overlay';
    // host 本身不吃事件，只有字幕块吃 —— 否则会挡住播放器的点击暂停
    Object.assign(host.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '60',
    });

    // open 而不是 closed：closed 的话 devtools 和自动化测试都读不到内部，
    // 而隔离样式的效果两者是一样的（页面本来就能找到 host 元素）
    const root = host.attachShadow({ mode: 'open' });
    const box = document.createElement('div');
    box.dataset.role = 'lines';
    // 还没有内容时先藏起来，避免空的背景色块闪一下
    box.style.visibility = 'hidden';
    const badge = document.createElement('div');
    badge.dataset.role = 'badge';
    root.append(box, badge);

    // 播放器容器可能是 static 定位，绝对定位的字幕就会跑到页面上去
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    container.appendChild(host);

    this.host = host;
    this.root = root;
    this.box = box;
    this.badge = badge;
    this.applyStyles();
    this.renderLine(this.current);
  }

  updateSettings(settings: SubtitleSettings): void {
    this.settings = settings;
    this.applyStyles();
    // 层的开关或顺序可能变了，重画一次
    this.renderLine(this.current, true);
  }

  /** 显示某一行；传 null 表示当前时间点没有字幕。 */
  show(line: RenderLine | null): void {
    if (line === this.current) return;
    this.renderLine(line);
  }

  /** 右上角状态徽标：翻译进度 / 错误。 */
  setStatus(text: string | null): void {
    if (!this.badge) return;
    this.badge.textContent = text ?? '';
    this.badge.style.display = text ? 'block' : 'none';
  }

  destroy(): void {
    this.host?.remove();
    this.host = null;
    this.root = null;
    this.box = null;
    this.badge = null;
  }

  get mounted(): boolean {
    return !!this.host?.isConnected;
  }

  private applyStyles(): void {
    if (!this.box || !this.badge) return;
    Object.assign(this.box.style, containerStyle(this.settings));
    // 字幕块本身要能点（难词），但整体不挡播放器
    this.box.style.pointerEvents = 'auto';

    Object.assign(this.badge.style, {
      position: 'absolute',
      top: '12px',
      right: '12px',
      padding: '4px 10px',
      borderRadius: '4px',
      background: 'rgba(0,0,0,0.6)',
      color: '#fff',
      font: '12px/1.4 -apple-system, BlinkMacSystemFont, sans-serif',
      pointerEvents: 'none',
      display: 'none',
    });
  }

  private renderLine(line: RenderLine | null, force = false): void {
    if (!this.box) return;
    if (line === this.current && !force) return;
    this.current = line;

    this.box.textContent = '';
    if (!line) {
      this.box.style.visibility = 'hidden';
      return;
    }
    this.box.style.visibility = 'visible';

    for (const id of this.settings.order) {
      const layer = this.settings.layers[id];
      if (!layer.enabled) continue;

      const text = id === 'english' ? line.en : line.zh;
      if (!text) continue;

      const p = document.createElement('div');
      p.dataset.layer = id;
      Object.assign(p.style, layerStyle(layer, this.settings));

      if (id === 'chinese' && this.settings.highlightHardWords) {
        this.appendWithHardWords(p, text, line);
      } else {
        p.textContent = text;
      }
      this.box.appendChild(p);
    }
  }

  /** 把难词切出来做成可点击的 span，其余部分是纯文本。 */
  private appendWithHardWords(
    parent: HTMLElement,
    text: string,
    line: RenderLine,
  ): void {
    const words = line.hard.filter((w) => w && text.includes(w));
    if (words.length === 0) {
      parent.textContent = text;
      return;
    }

    // 长的先匹配，避免短词把长词切断
    const sorted = [...words].sort((a, b) => b.length - a.length);
    let rest = text;

    while (rest.length > 0) {
      const hit = sorted
        .map((w) => ({ w, at: rest.indexOf(w) }))
        .filter((h) => h.at >= 0)
        .sort((a, b) => a.at - b.at)[0];

      if (!hit) {
        parent.appendChild(document.createTextNode(rest));
        return;
      }
      if (hit.at > 0) {
        parent.appendChild(document.createTextNode(rest.slice(0, hit.at)));
      }

      const span = document.createElement('span');
      span.textContent = hit.w;
      Object.assign(span.style, hardWordStyle(this.settings));
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onWordClick?.(hit.w, line);
      });
      parent.appendChild(span);

      rest = rest.slice(hit.at + hit.w.length);
    }
  }
}
