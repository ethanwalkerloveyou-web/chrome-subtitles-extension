/** 字幕数据的核心类型。M2 产出这些，M3 翻译管线消费它们。 */

/** 一个词（自动字幕）或一小段文本，带精确时间。 */
export interface Token {
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * 送给模型的一行/一段源文本。
 *
 * - 人工字幕：已经是完整句子，start/end 可信
 * - 自动字幕：是按停顿粗切的段，等 M3 让模型断句后再细分
 */
export interface SourceLine {
  id: number;
  text: string;
  startMs: number;
  endMs: number;
}

export type TrackKind = 'manual' | 'asr';

export interface SubtitleTrack {
  videoId: string;
  /** 例如 "en" 或 "en.asr"，进缓存 key。 */
  trackId: string;
  languageCode: string;
  kind: TrackKind;
  lines: SourceLine[];
  /**
   * 仅自动字幕有。M3 拿模型断好的句子回填时间轴时要用到词级时间戳，
   * 没有它就只能按字符比例估算，误差会很明显。
   */
  tokens?: Token[];
  /** 走了哪条获取路径，排查问题时很有用。 */
  source: 'intercepted' | 'player-response' | 'text-tracks';
}

/** 页面上可选的一条字幕轨。 */
export interface TrackCandidate {
  baseUrl: string;
  languageCode: string;
  /** YouTube 用 kind: "asr" 标记自动生成的字幕轨。 */
  kind?: string;
  name?: string;
}
