/**
 * 字幕解析与整理的单元测试。
 *
 *   npm test
 *
 * 这些 fixture 复刻了 YouTube json3 的真实结构，重点是自动字幕的三个坑：
 * 滚动重复、纯换行 seg、词级 tOffsetMs。
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  parseAsrTokens,
  parseManualCues,
  toJson3Url,
  type Json3Doc,
} from '../src/subtitle/timedtext.ts';
import {
  alignSentencesToTokens,
  chunkAsrTokens,
  mergeManualCues,
} from '../src/subtitle/normalize.ts';
import { rankCandidates } from '../src/adapters/youtube.ts';

// ---------------------------------------------------------------- fixtures

/**
 * 自动字幕：滚动窗口。
 * "so the key" 这三个词在第二个事件里被重发了一次（滚动效果的来源），
 * 并且夹着 aAppend 事件和纯换行 seg。
 */
const ASR_DOC: Json3Doc = {
  events: [
    {
      tStartMs: 1000,
      dDurationMs: 2000,
      segs: [
        { utf8: 'so', tOffsetMs: 0 },
        { utf8: ' the', tOffsetMs: 300 },
        { utf8: ' key', tOffsetMs: 600 },
      ],
    },
    { tStartMs: 1900, aAppend: 1, segs: [{ utf8: '\n' }] },
    {
      // 滚动窗口重发前三个词，再加两个新词
      tStartMs: 1000,
      dDurationMs: 3000,
      segs: [
        { utf8: 'so', tOffsetMs: 0 },
        { utf8: ' the', tOffsetMs: 300 },
        { utf8: ' key', tOffsetMs: 600 },
        { utf8: ' insight', tOffsetMs: 1000 },
        { utf8: ' here', tOffsetMs: 1400 },
      ],
    },
    { tStartMs: 3000, dDurationMs: 500, segs: [{ utf8: ' ' }] },
    {
      tStartMs: 5000,
      dDurationMs: 1500,
      segs: [
        { utf8: ' is', tOffsetMs: 0 },
        { utf8: ' attention', tOffsetMs: 400 },
      ],
    },
  ],
};

/** 人工字幕：有标点，但一句话被切成两条 cue。 */
const MANUAL_DOC: Json3Doc = {
  events: [
    { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'So the key insight' }] },
    {
      tStartMs: 3000,
      dDurationMs: 2500,
      segs: [{ utf8: 'here is that attention is all you need.' }],
    },
    { tStartMs: 6000, dDurationMs: 2000, segs: [{ utf8: 'Does that make sense?' }] },
    { tStartMs: 8500, dDurationMs: 1000, segs: [{ utf8: '   ' }] },
  ],
};

// ---------------------------------------------------------------- 解析

describe('parseAsrTokens', () => {
  const tokens = parseAsrTokens(ASR_DOC);

  it('去掉滚动重复，每个词只留一次', () => {
    const words = tokens.map((t) => t.text.trim());
    assert.deepEqual(words, [
      'so',
      'the',
      'key',
      'insight',
      'here',
      'is',
      'attention',
    ]);
  });

  it('丢弃 aAppend 事件和纯空白 seg', () => {
    assert.ok(tokens.every((t) => t.text.trim().length > 0));
  });

  it('用 tStartMs + tOffsetMs 算出绝对时间', () => {
    assert.equal(tokens[0]!.startMs, 1000); // 1000 + 0
    assert.equal(tokens[3]!.startMs, 2000); // 1000 + 1000
    assert.equal(tokens[6]!.startMs, 5400); // 5000 + 400
  });

  it('token 时间递增，结束时间接到下一个开始', () => {
    for (let i = 1; i < tokens.length; i++) {
      assert.ok(tokens[i]!.startMs >= tokens[i - 1]!.startMs);
      assert.equal(tokens[i - 1]!.endMs, tokens[i]!.startMs);
    }
  });
});

describe('parseManualCues', () => {
  const cues = parseManualCues(MANUAL_DOC);

  it('跳过空白 cue', () => {
    assert.equal(cues.length, 3);
  });

  it('结束时间用 dDurationMs 算', () => {
    assert.equal(cues[0]!.startMs, 1000);
    assert.equal(cues[0]!.endMs, 3000);
  });
});

// ---------------------------------------------------------------- 整理

describe('mergeManualCues', () => {
  const lines = mergeManualCues(parseManualCues(MANUAL_DOC));

  it('把被切开的半句合成完整句子', () => {
    assert.equal(
      lines[0]!.text,
      'So the key insight here is that attention is all you need.',
    );
  });

  it('句尾标点是切分点', () => {
    assert.equal(lines.length, 2);
    assert.equal(lines[1]!.text, 'Does that make sense?');
  });

  it('合并后的时间跨度覆盖所有来源 cue', () => {
    assert.equal(lines[0]!.startMs, 1000);
    assert.equal(lines[0]!.endMs, 5500);
  });

  it('id 连续', () => {
    lines.forEach((l, i) => assert.equal(l.id, i));
  });
});

describe('chunkAsrTokens', () => {
  it('短内容不切碎', () => {
    const lines = chunkAsrTokens(parseAsrTokens(ASR_DOC));
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.text, 'so the key insight here is attention');
  });

  it('在长停顿处切分，且每段不短于下限', () => {
    // 造一段 60 秒的词流，第 20 秒处有 1.5 秒停顿
    const tokens = [];
    for (let i = 0; i < 60; i++) {
      const startMs = i * 1000 + (i >= 20 ? 1500 : 0);
      tokens.push({ text: `w${i} `, startMs, endMs: startMs + 900 });
    }
    const lines = chunkAsrTokens(tokens);

    assert.ok(lines.length >= 2, '应该被切成多段');
    // 第一段应该正好在停顿处结束（第 19 个词之后）
    assert.equal(lines[0]!.text.trim().split(/\s+/).pop(), 'w19');
    for (const line of lines.slice(0, -1)) {
      assert.ok(
        line.endMs - line.startMs >= 12_000,
        `段落 "${line.text.slice(0, 20)}…" 太短`,
      );
    }
  });

  it('没有停顿时也会按上限强制切分', () => {
    const tokens = Array.from({ length: 120 }, (_, i) => ({
      text: `w${i} `,
      startMs: i * 1000,
      endMs: i * 1000 + 1000,
    }));
    const lines = chunkAsrTokens(tokens);
    for (const line of lines) {
      assert.ok(
        line.endMs - line.startMs <= 31_000,
        `段落超过上限：${line.endMs - line.startMs}ms`,
      );
    }
  });

  it('空输入不炸', () => {
    assert.deepEqual(chunkAsrTokens([]), []);
  });
});

describe('alignSentencesToTokens', () => {
  const tokens = parseAsrTokens(ASR_DOC);

  it('把模型断好的句子映射回真实时间戳', () => {
    // 模型会加标点、改大小写，对齐必须容忍这些
    const spans = alignSentencesToTokens(
      ['So the key insight here', 'is attention.'],
      tokens,
    );
    assert.equal(spans.length, 2);
    assert.equal(spans[0]!.startMs, 1000); // "so"
    assert.equal(spans[1]!.endMs, 6000); // "attention" 的结束
  });

  it('句子对不上时不抛异常，退化为按顺序推进', () => {
    const spans = alignSentencesToTokens(['完全对不上的内容'], tokens);
    assert.equal(spans.length, 1);
    assert.ok(Number.isFinite(spans[0]!.startMs));
  });
});

// ---------------------------------------------------------------- URL

describe('toJson3Url', () => {
  it('加上 fmt=json3', () => {
    const url = toJson3Url(
      'https://www.youtube.com/api/timedtext?v=abc&lang=en',
    );
    assert.ok(url.includes('fmt=json3'));
    assert.ok(url.includes('lang=en'));
  });

  it('已有 fmt 参数时覆盖掉', () => {
    const url = toJson3Url(
      'https://www.youtube.com/api/timedtext?v=abc&fmt=srv3',
    );
    assert.ok(url.includes('fmt=json3'));
    assert.ok(!url.includes('srv3'));
  });

  it('相对路径按 base 解析', () => {
    const url = toJson3Url('/api/timedtext?v=abc', 'https://www.youtube.com');
    assert.ok(url.startsWith('https://www.youtube.com/api/timedtext'));
  });
});

// ---------------------------------------------------------------- 选轨排序

describe('rankCandidates', () => {
  const manualTrack = {
    baseUrl: 'https://www.youtube.com/api/timedtext?lang=en',
    languageCode: 'en',
  };
  const asrTrack = {
    baseUrl: 'https://www.youtube.com/api/timedtext?lang=en&kind=asr',
    languageCode: 'en',
    kind: 'asr',
  };

  it('人工字幕排在自动字幕前面，即使自动字幕是截获来的', () => {
    // 播放器可能正好在请求自动字幕，但页面上有人工字幕轨
    const ranked = rankCandidates({
      tracks: [manualTrack],
      interceptedUrls: ['https://www.youtube.com/api/timedtext?lang=en&kind=asr'],
    });
    assert.equal(ranked[0]!.kind, 'manual');
    assert.equal(ranked[0]!.source, 'player-response');
  });

  it('同为人工字幕时，截获的排前面', () => {
    const ranked = rankCandidates({
      tracks: [manualTrack],
      interceptedUrls: ['https://www.youtube.com/api/timedtext?lang=en'],
    });
    assert.equal(ranked[0]!.source, 'intercepted');
  });

  it('过滤掉非英文轨', () => {
    const ranked = rankCandidates({
      tracks: [
        { baseUrl: 'https://x/1', languageCode: 'ja' },
        { baseUrl: 'https://x/2', languageCode: 'en' },
      ],
      interceptedUrls: [],
    });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]!.languageCode, 'en');
  });

  it('只有自动字幕时也能返回', () => {
    const ranked = rankCandidates({ tracks: [asrTrack], interceptedUrls: [] });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]!.kind, 'asr');
  });
});
