/** 翻译管线、WebVTT、HLS 字幕轨的单元测试。 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  parseSegmentUris,
  parseSubtitleTracks,
  pickEnglishSubtitleTrack,
  resolveUri,
} from '../src/subtitle/hls.ts';
import { mergeVttCues, parseTimestamp, parseVtt } from '../src/subtitle/vtt.ts';
import {
  mapToRenderLines,
  planBatches,
  prioritize,
  translateTrack,
} from '../src/translate/pipeline.ts';
import { parseModelLines } from '../src/translate/providers.ts';
import {
  buildSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
} from '../src/translate/prompt.ts';
import type { BatchRequest, TranslationProvider } from '../src/translate/types.ts';
import { DEFAULT_SETTINGS, parseExtraBody } from '../src/store/settings.ts';
import { hashString } from '../src/store/cache.ts';
import type { SourceLine, SubtitleTrack } from '../src/subtitle/types.ts';
import { findLineAt, mergeRenderLines } from '../src/render/sync.ts';
import type { RenderLine } from '../src/translate/types.ts';

// ---------------------------------------------------------------- WebVTT

describe('parseTimestamp', () => {
  it('支持 时:分:秒.毫秒', () => {
    assert.equal(parseTimestamp('00:01:02.500'), 62_500);
  });
  it('支持省略小时', () => {
    assert.equal(parseTimestamp('01:02.500'), 62_500);
  });
  it('支持逗号做小数点', () => {
    assert.equal(parseTimestamp('00:00:01,250'), 1250);
  });
  it('非法输入返回 null', () => {
    assert.equal(parseTimestamp('abc'), null);
  });
});

describe('parseVtt', () => {
  const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000 position:50%
So the key insight

00:00:03.000 --> 00:00:05.500
<v Speaker>is that <c.highlight>attention</c> matters.</v>

00:00:06.000 --> 00:00:07.000
   `;

  const cues = parseVtt(VTT);

  it('解析出 cue 并跳过空内容', () => {
    assert.equal(cues.length, 2);
  });

  it('时间正确', () => {
    assert.equal(cues[0]!.startMs, 1000);
    assert.equal(cues[0]!.endMs, 3000);
  });

  it('忽略 cue 标识符行和时间行后面的设置', () => {
    assert.equal(cues[0]!.text, 'So the key insight');
  });

  it('去掉内联标签', () => {
    assert.equal(cues[1]!.text, 'is that attention matters.');
  });

  it('支持 offset', () => {
    assert.equal(parseVtt(VTT, 10_000)[0]!.startMs, 11_000);
  });

  it('CRLF 也能解析', () => {
    const crlf = 'WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nhello\r\n';
    assert.equal(parseVtt(crlf).length, 1);
  });
});

describe('mergeVttCues', () => {
  it('去掉分片边界上重复的 cue', () => {
    const a = [{ text: 'one', startMs: 0, endMs: 1000 }];
    const b = [
      { text: 'one', startMs: 0, endMs: 1000 },
      { text: 'two', startMs: 1000, endMs: 2000 },
    ];
    const merged = mergeVttCues([a, b]);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map((c) => c.text), ['one', 'two']);
  });
});

// ---------------------------------------------------------------- HLS

describe('parseSubtitleTracks', () => {
  const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",URI="audio.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English, Auto",LANGUAGE="en",AUTOSELECT=YES,URI="/subs/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Japanese",LANGUAGE="ja",URI="/subs/ja.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=832000,SUBTITLES="subs"
720p.m3u8`;

  it('只取 SUBTITLES 类型', () => {
    const tracks = parseSubtitleTracks(MASTER);
    assert.equal(tracks.length, 2);
  });

  it('属性值里含逗号也能正确解析', () => {
    // NAME="English, Auto" 里的逗号不能把属性切开
    assert.equal(parseSubtitleTracks(MASTER)[0]!.name, 'English, Auto');
  });

  it('识别 AUTOSELECT/DEFAULT', () => {
    assert.equal(parseSubtitleTracks(MASTER)[0]!.isDefault, true);
    assert.equal(parseSubtitleTracks(MASTER)[1]!.isDefault, false);
  });

  it('没有字幕轨时返回空数组', () => {
    assert.deepEqual(parseSubtitleTracks('#EXTM3U\n720p.m3u8'), []);
  });

  it('优先选英文轨', () => {
    const picked = pickEnglishSubtitleTrack(parseSubtitleTracks(MASTER));
    assert.equal(picked!.language, 'en');
  });
});

describe('parseSegmentUris', () => {
  it('过滤掉注释行和空行', () => {
    const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:10

#EXTINF:10.0,
seg1.vtt
#EXTINF:10.0,
seg2.vtt
#EXT-X-ENDLIST`;
    assert.deepEqual(parseSegmentUris(playlist), ['seg1.vtt', 'seg2.vtt']);
  });
});

describe('resolveUri', () => {
  it('相对路径按 playlist 地址解析', () => {
    assert.equal(
      resolveUri('seg1.vtt', 'https://video.twimg.com/a/b/en.m3u8'),
      'https://video.twimg.com/a/b/seg1.vtt',
    );
  });
  it('绝对路径原样保留', () => {
    assert.equal(
      resolveUri('/x/seg.vtt', 'https://video.twimg.com/a/b/en.m3u8'),
      'https://video.twimg.com/x/seg.vtt',
    );
  });
});

// ---------------------------------------------------------------- 分批

const lines = (n: number, len = 50): SourceLine[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i,
    text: 'x'.repeat(len),
    startMs: i * 3000,
    endMs: i * 3000 + 2500,
  }));

describe('planBatches', () => {
  it('按字符预算分批', () => {
    // batchSize 20 → 预算 1500 字符 → 每批 30 条 50 字符的
    const batches = planBatches(lines(90), 20);
    assert.equal(batches.length, 3);
    assert.equal(batches[0]!.lines.length, 30);
  });

  it('单条超预算时也自成一批而不是被丢掉', () => {
    const batches = planBatches(lines(3, 5000), 5);
    assert.equal(batches.length, 3);
    assert.equal(batches.flatMap((b) => b.lines).length, 3);
  });

  it('批次编号连续，不丢行', () => {
    const batches = planBatches(lines(50), 10);
    batches.forEach((b, i) => assert.equal(b.index, i));
    assert.equal(batches.flatMap((b) => b.lines).length, 50);
  });

  it('空输入返回空', () => {
    assert.deepEqual(planBatches([], 20), []);
  });
});

describe('prioritize', () => {
  const batches = planBatches(lines(90), 20); // 3 批，各 90 秒

  it('正在播的那批排第一', () => {
    // 第二批覆盖 90s~180s
    const ordered = prioritize(batches, 120_000);
    assert.equal(ordered[0]!.index, 1);
  });

  it('后面的批次优先于已经播过的', () => {
    const ordered = prioritize(batches, 120_000);
    assert.equal(ordered[1]!.index, 2, '未播的应排在已播的前面');
    assert.equal(ordered[2]!.index, 0);
  });

  it('从头开始播时按自然顺序', () => {
    const ordered = prioritize(batches, 0);
    assert.deepEqual(ordered.map((b) => b.index), [0, 1, 2]);
  });
});

// ---------------------------------------------------------------- 回填

describe('mapToRenderLines', () => {
  const manualTrack = {
    kind: 'manual',
    lines: [],
  } as unknown as SubtitleTrack;

  it('人工字幕按 id 对齐到原时间轴', () => {
    const batch = { index: 0, lines: lines(3) };
    const out = mapToRenderLines(
      batch,
      [
        { id: 0, en: 'a', zh: '甲', hard: [] },
        { id: 2, en: 'c', zh: '丙', hard: ['丙'] },
      ],
      manualTrack,
    );
    assert.equal(out.length, 2);
    assert.equal(out[0]!.startMs, 0);
    assert.equal(out[1]!.startMs, 6000);
    assert.deepEqual(out[1]!.hard, ['丙']);
  });

  it('模型返回不存在的 id 时跳过而不是崩', () => {
    const batch = { index: 0, lines: lines(2) };
    const out = mapToRenderLines(
      batch,
      [{ id: 99, en: 'x', zh: '未知', hard: [] }],
      manualTrack,
    );
    assert.equal(out.length, 0);
  });

  it('自动字幕用词级时间戳定位重新断好的句子', () => {
    const tokens = [
      { text: 'so ', startMs: 1000, endMs: 1300 },
      { text: 'the ', startMs: 1300, endMs: 1600 },
      { text: 'key ', startMs: 1600, endMs: 2000 },
      { text: 'insight ', startMs: 2000, endMs: 2600 },
    ];
    const track = {
      kind: 'asr',
      tokens,
      lines: [],
    } as unknown as SubtitleTrack;
    const batch = {
      index: 0,
      lines: [{ id: 0, text: 'so the key insight', startMs: 1000, endMs: 2600 }],
    };

    const out = mapToRenderLines(
      batch,
      [
        { en: 'So the key.', zh: '所以关键。', hard: [] },
        { en: 'Insight.', zh: '洞见。', hard: [] },
      ],
      track,
    );
    assert.equal(out.length, 2);
    assert.equal(out[0]!.startMs, 1000);
    assert.equal(out[1]!.startMs, 2000);
  });
});

// ---------------------------------------------------------------- 模型输出

describe('parseModelLines', () => {
  it('解析正常 JSON', () => {
    const out = parseModelLines(
      '{"lines":[{"id":0,"en":"a","zh":"甲","hard":["甲"]}]}',
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.zh, '甲');
  });

  it('容忍 ```json 围栏', () => {
    const out = parseModelLines(
      '```json\n{"lines":[{"id":0,"en":"a","zh":"甲","hard":[]}]}\n```',
    );
    assert.equal(out.length, 1);
  });

  it('丢掉缺字段的条目而不是整批失败', () => {
    const out = parseModelLines(
      '{"lines":[{"id":0,"en":"a","zh":"甲","hard":[]},{"id":1,"en":"b"}]}',
    );
    assert.equal(out.length, 1);
  });

  it('hard 不是数组时退化为空数组', () => {
    const out = parseModelLines('{"lines":[{"id":0,"en":"a","zh":"甲","hard":"x"}]}');
    assert.deepEqual(out[0]!.hard, []);
  });

  it('hard 最多保留 3 个', () => {
    const out = parseModelLines(
      '{"lines":[{"id":0,"en":"a","zh":"甲","hard":["1","2","3","4","5"]}]}',
    );
    assert.equal(out[0]!.hard.length, 3);
  });

  it('完全不是 JSON 时抛错，交给上层拆半重试', () => {
    assert.throws(() => parseModelLines('抱歉，我无法翻译这段内容'));
  });

  it('字段里的换行被压掉（英文换空格，中文直接删）', () => {
    const out = parseModelLines(
      '{"lines":[{"id":0,"en":"line one\\nline two","zh":"第一行\\n第二行","hard":[]}]}',
    );
    assert.equal(out[0]!.en, 'line one line two');
    assert.equal(out[0]!.zh, '第一行第二行');
  });
});

// ---------------------------------------------------------------- 额外请求体

describe('parseExtraBody', () => {
  it('空串 / 纯空白当作空对象', () => {
    assert.deepEqual(parseExtraBody(''), { ok: true, value: {} });
    assert.deepEqual(parseExtraBody('   \n '), { ok: true, value: {} });
  });

  it('解析合法的 JSON 对象', () => {
    const r = parseExtraBody('{ "enable_thinking": false }');
    assert.ok(r.ok);
    assert.deepEqual(r.value, { enable_thinking: false });
  });

  it('支持嵌套对象（GLM/豆包的 thinking.type）', () => {
    const r = parseExtraBody('{"thinking":{"type":"disabled"}}');
    assert.ok(r.ok);
    assert.deepEqual(r.value, { thinking: { type: 'disabled' } });
  });

  it('非法 JSON 报错而不是抛异常', () => {
    const r = parseExtraBody('{enable_thinking: false}');
    assert.equal(r.ok, false);
  });

  it('顶层是数组 / 字符串 / 数字都判非法（没法并进请求体）', () => {
    assert.equal(parseExtraBody('[1,2,3]').ok, false);
    assert.equal(parseExtraBody('"x"').ok, false);
    assert.equal(parseExtraBody('42').ok, false);
    assert.equal(parseExtraBody('null').ok, false);
  });

  it('默认配置里的 openai-compatible 额外体是合法 JSON', () => {
    const r = parseExtraBody(
      DEFAULT_SETTINGS.llm.extraBody['openai-compatible'],
    );
    assert.ok(r.ok);
    assert.deepEqual(r.value, { enable_thinking: false });
  });
});

// ---------------------------------------------------------------- 失败统计

describe('translateTrack 失败统计', () => {
  const track = {
    videoId: 'v',
    trackId: 'en',
    languageCode: 'en',
    kind: 'manual',
    lines: lines(6),
    source: 'intercepted',
  } as SubtitleTrack;

  const baseOpts = () => ({
    track,
    settings: DEFAULT_SETTINGS,
    signal: new AbortController().signal,
    currentTimeMs: () => 0,
    onBatch: () => {},
    onProgress: () => {},
  });

  it('供应商一直失败时退化为英文原文，并如实上报失败批次', async () => {
    const provider: TranslationProvider = {
      id: 'openai-compatible',
      translateBatch: () => Promise.reject(new Error('HTTP 401: bad key')),
    };
    const result = await translateTrack({ ...baseOpts(), provider });

    // 退化路径：行数不丢，但 zh 是空的
    assert.equal(result.lines.length, 6);
    assert.ok(result.lines.every((l) => l.zh === ''));
    // 关键：失败不能静默 —— 之前这里吞掉错误，坏结果还会被存成 complete
    assert.ok(result.failedBatches > 0);
    assert.match(result.lastError, /401/);
  });

  it('翻译成功时失败数为 0', async () => {
    const provider: TranslationProvider = {
      id: 'openai-compatible',
      translateBatch: (req) =>
        Promise.resolve(
          req.lines.map((l) => ({ id: l.id, en: l.text, zh: '译文', hard: [] })),
        ),
    };
    const result = await translateTrack({ ...baseOpts(), provider });

    assert.equal(result.failedBatches, 0);
    assert.equal(result.lastError, '');
    assert.equal(result.lines.length, 6);
    assert.ok(result.lines.every((l) => l.zh === '译文'));
  });
});

// ---------------------------------------------------------------- 同步

// ---------------------------------------------------------------- 提示词

describe('buildSystemPrompt', () => {
  const req = (over: Partial<BatchRequest> = {}): BatchRequest => ({
    lines: [],
    kind: 'manual',
    context: '',
    targetLang: 'zh-CN',
    domain: '',
    glossary: [],
    ...over,
  });

  it('默认模板：替换 {lang}，不残留占位符，附带 hard 规则', () => {
    const p = buildSystemPrompt(req());
    assert.ok(p.includes('简体中文'));
    assert.ok(!p.includes('{lang}'));
    assert.ok(!p.includes('{domain}'));
    assert.ok(p.includes('hard 字段'));
    assert.ok(p.includes('换行符'));
  });

  it('{domain} 有领域提示时展开，没有时留空', () => {
    assert.ok(buildSystemPrompt(req({ domain: '机器学习' })).includes('机器学习'));
    assert.ok(!buildSystemPrompt(req()).includes('视频内容领域'));
  });

  it('自定义模板生效，并仍追加格式硬规则', () => {
    const p = buildSystemPrompt(
      req({ systemPrompt: '把字幕翻成地道的日语，读者是日语学习者。' }),
    );
    assert.ok(p.includes('日语'));
    // 用户模板里没写这些，但程序仍会追加
    assert.ok(p.includes('hard 字段'));
    assert.ok(p.includes('换行符'));
    // 不该再带默认模板的中文框架
    assert.ok(!p.includes('正在学简体中文的英文母语者'));
  });

  it('自定义模板里的 {lang} 占位符也会被替换', () => {
    const p = buildSystemPrompt(
      req({ targetLang: 'zh-TW', systemPrompt: '译成{lang}。' }),
    );
    assert.ok(p.includes('繁體中文'));
    assert.ok(!p.includes('{lang}'));
  });

  it('空白自定义模板退回默认', () => {
    assert.equal(buildSystemPrompt(req({ systemPrompt: '   ' })), buildSystemPrompt(req()));
  });

  it('自动字幕断句长度跟随 maxChars / maxWords', () => {
    const p = buildSystemPrompt(req({ kind: 'asr', maxWords: 8, maxChars: 15 }));
    assert.ok(p.includes('8 个英文词'), '英文词数上限应写进提示词');
    assert.ok(p.includes('15 个字'), '译文字数上限应写进提示词');
  });

  it('默认模板导出的常量本身带占位符', () => {
    assert.ok(DEFAULT_SYSTEM_PROMPT.includes('{lang}'));
  });
});

describe('hashString', () => {
  it('相同输入相同输出，不同输入不同输出', () => {
    assert.equal(hashString('abc'), hashString('abc'));
    assert.notEqual(hashString('abc'), hashString('abd'));
  });
  it('空串给空哈希（默认模板不额外占用缓存桶）', () => {
    assert.equal(hashString(''), '');
  });
});

describe('mergeRenderLines', () => {
  const rl = (startMs: number, endMs: number, zh = ''): RenderLine => ({
    startMs,
    endMs,
    en: 'en',
    zh,
    hard: [],
  });

  it('译文盖掉自己时间范围内的英文占位', () => {
    const seed = [rl(0, 1000), rl(1000, 2000), rl(2000, 3000)];
    const merged = mergeRenderLines(seed, [rl(1000, 2000, '译文')]);
    // 中间那条被替换，首尾占位保留
    assert.equal(merged.length, 3);
    assert.equal(merged[1]!.zh, '译文');
    assert.equal(merged[0]!.zh, '');
    assert.equal(merged[2]!.zh, '');
  });

  it('区间外的占位一条不丢', () => {
    const seed = [rl(0, 1000), rl(5000, 6000)];
    const merged = mergeRenderLines(seed, [rl(2000, 3000, '译文')]);
    assert.deepEqual(
      merged.map((l) => [l.startMs, l.endMs]),
      [[0, 1000], [2000, 3000], [5000, 6000]],
    );
  });

  it('一段占位被拆成多条译文（自动字幕重新断句）', () => {
    const seed = [rl(0, 9000)]; // 一整段粗切
    const fine = [rl(0, 3000, 'a'), rl(3000, 6000, 'b'), rl(6000, 9000, 'c')];
    const merged = mergeRenderLines(seed, fine);
    assert.equal(merged.length, 3);
    assert.deepEqual(merged.map((l) => l.zh), ['a', 'b', 'c']);
  });

  it('结果始终按时间排序', () => {
    const merged = mergeRenderLines(
      [rl(4000, 5000), rl(0, 1000)],
      [rl(2000, 3000)],
    );
    const starts = merged.map((l) => l.startMs);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  });

  it('incoming 为空时原样返回（排序后）', () => {
    const merged = mergeRenderLines([rl(1000, 2000), rl(0, 1000)], []);
    assert.deepEqual(merged.map((l) => l.startMs), [0, 1000]);
  });

  it('边界相接不算重叠（endMs === 下一条 startMs）', () => {
    const seed = [rl(0, 1000), rl(1000, 2000)];
    // incoming 正好占 [1000,2000)，只应替换第二条
    const merged = mergeRenderLines(seed, [rl(1000, 2000, 'x')]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0]!.zh, '');
    assert.equal(merged[1]!.zh, 'x');
  });
});

describe('findLineAt', () => {
  const rendered = [
    { startMs: 0, endMs: 1000, en: 'a', zh: '甲', hard: [] },
    { startMs: 1000, endMs: 2000, en: 'b', zh: '乙', hard: [] },
    { startMs: 5000, endMs: 6000, en: 'c', zh: '丙', hard: [] },
  ];

  it('命中区间', () => {
    assert.equal(findLineAt(rendered, 1500), 1);
  });

  it('区间之间的空隙返回 -1', () => {
    assert.equal(findLineAt(rendered, 3000), -1);
  });

  it('边界：起点算在内，终点不算', () => {
    assert.equal(findLineAt(rendered, 1000), 1);
    assert.equal(findLineAt(rendered, 2000), -1);
  });

  it('hint 命中时结果与二分一致', () => {
    assert.equal(findLineAt(rendered, 5500, 2), 2);
    assert.equal(findLineAt(rendered, 5500, 0), 2);
  });

  it('空数组返回 -1', () => {
    assert.equal(findLineAt([], 100), -1);
  });
});
