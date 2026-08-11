/**
 * 从 HLS 播放列表里找字幕轨。
 *
 * X / Twitter 的视频走 HLS。master playlist 里如果有字幕，会以
 * `#EXT-X-MEDIA:TYPE=SUBTITLES,...,URI="..."` 的形式声明；
 * 那个 URI 指向另一个 m3u8，里面列着 .vtt 分片。
 *
 * 多数用户发的视频没有这一段 —— 那就是真的没有字幕，不是我们没找到。
 */

export interface HlsSubtitleTrack {
  uri: string;
  language: string;
  name: string;
  /** master playlist 里标了 AUTOSELECT/DEFAULT 的更可能是主字幕。 */
  isDefault: boolean;
}

/** 解析 `KEY=VALUE,KEY="VALUE"` 形式的属性列表。 */
function parseAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // 值可能带引号且内含逗号，不能简单 split(',')
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    attrs[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
  return attrs;
}

/** 从 master playlist 里取出所有字幕轨。 */
export function parseSubtitleTracks(master: string): HlsSubtitleTrack[] {
  const tracks: HlsSubtitleTrack[] = [];

  for (const line of master.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
    if (attrs.TYPE !== 'SUBTITLES' || !attrs.URI) continue;

    tracks.push({
      uri: attrs.URI,
      language: attrs.LANGUAGE ?? '',
      name: attrs.NAME ?? '',
      isDefault: attrs.DEFAULT === 'YES' || attrs.AUTOSELECT === 'YES',
    });
  }

  return tracks;
}

/** 从字幕 m3u8 里取出所有 .vtt 分片的相对路径。 */
export function parseSegmentUris(playlist: string): string[] {
  return playlist
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** 相对路径按 playlist 自身的地址解析成绝对地址。 */
export function resolveUri(uri: string, baseUrl: string): string {
  return new URL(uri, baseUrl).toString();
}

/** 挑一条英文字幕轨；没有英文就退回默认轨。 */
export function pickEnglishSubtitleTrack(
  tracks: HlsSubtitleTrack[],
): HlsSubtitleTrack | null {
  const english = tracks.filter(
    (t) =>
      t.language.toLowerCase().startsWith('en') ||
      /english/i.test(t.name),
  );
  return english[0] ?? tracks.find((t) => t.isDefault) ?? tracks[0] ?? null;
}
