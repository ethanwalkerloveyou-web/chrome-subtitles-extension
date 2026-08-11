/** 翻译管线的输入输出类型。 */

import type { SourceLine, TrackKind } from '../subtitle/types.ts';

/** 最终渲染到播放器上的一行。 */
export interface RenderLine {
  startMs: number;
  endMs: number;
  en: string;
  zh: string;
  /** 中文译文的拼音，在 service worker 里生成。 */
  pinyin?: string;
  /** 模型标出的难词，用于高亮和生词本。 */
  hard: string[];
}

/** 模型返回的一条。 */
export interface ModelLine {
  /** 人工字幕走 id 对齐；自动字幕由模型重新断句，没有 id。 */
  id?: number;
  en: string;
  zh: string;
  hard: string[];
}

export interface BatchRequest {
  /** 人工字幕：多条已断好的句子。自动字幕：一段未断句的文本。 */
  lines: SourceLine[];
  kind: TrackKind;
  /** 上文，只读不翻，帮助模型理解代词和主语。 */
  context: string;
  targetLang: string;
  domain: string;
  glossary: { en: string; zh: string }[];
}

export interface TranslationProvider {
  readonly id: string;
  translateBatch(
    req: BatchRequest,
    signal: AbortSignal,
  ): Promise<ModelLine[]>;
}

/** 翻译进度，用于播放器上的状态徽标。 */
export interface Progress {
  done: number;
  total: number;
  status: 'idle' | 'running' | 'complete' | 'error';
  error?: string;
}
