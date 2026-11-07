// 窥屏档位的自检。
//
// 拨的不是「几分钟看一眼」，是「她是什么性子」。所以这里钉的是：
//   · 每一档给的是区间，每次排期从里面抽，同样档位每次都不一样
//   · 老配置里的分钟数能自动反推成最接近的一档，升级不用重拨
//   · 写错档位名不崩，给可选名单
//   · 情绪倍率只乘生效值，不改主人拨的性子

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPeek, sampleInterval, personaForMs } from '../lib/peek.js';
import { DEFAULT_PROFILE } from '../lib/mood/profile.js';

const noop = () => {};
const TABLE = DEFAULT_PROFILE.peekPersona;
const min = (n) => n * 60000;

const base = {
  peek: false,
  peekIntervalMs: undefined,
  peekPersonaTable: TABLE,
  peekQuietFrom: 1,
  peekQuietTo: 8,
  peekTmpDir: join(import.meta.dirname, '.tmp-peek'),
  peekTimeoutMs: 1000,
};

function mk(over = {}, factor = () => 1) {
  return createPeek({ cfg: { ...base, ...over }, log: noop, deliver: async () => {}, intervalFactor: factor });
}

test('默认是温和，抽样落在十分钟到半小时之间', () => {
  const s = mk().state();
  assert.equal(s.persona, 'gentle');
  assert.equal(s.personaLabel, '温和');
  assert.ok(s.sampleMs >= min(10) && s.sampleMs <= min(30), `实际 ${s.sampleMs}`);
});

test('同样的档位每次抽到的不一样', () => {
  const p = mk({ peek: true });
  const seen = new Set();
  for (let i = 0; i < 10; i++) {
    p.setPersona('gentle');
    seen.add(p.state().sampleMs);
  }
  p.stop();
  assert.ok(seen.size > 1, '每次都是同一个数，那就是照表打卡，不是有脾气');
});

test('换档位立刻生效', () => {
  const p = mk();
  const r = p.setPersona('cool');
  assert.equal(r.ok, true);
  assert.equal(r.label, '冷淡');
  const s = p.state();
  assert.equal(s.persona, 'cool');
  assert.ok(s.sampleMs >= min(30) && s.sampleMs <= min(90), `实际 ${s.sampleMs}`);
});

test('写错档位名不崩，给可选名单', () => {
  const p = mk();
  const r = p.setPersona('nope');
  assert.equal(r.ok, false);
  assert.equal(p.state().persona, 'gentle', '写错不该把原来的档位顶掉');
  assert.deepEqual(r.options.sort(), ['clingy', 'cool', 'gentle', 'yandere']);
});

test('老配置存的是分钟数，反推成最接近的一档', () => {
  assert.equal(mk({ peekIntervalMs: min(5) }).state().persona, 'clingy');
  assert.equal(mk({ peekIntervalMs: min(30) }).state().persona, 'gentle');
  assert.equal(mk({ peekIntervalMs: min(60) }).state().persona, 'cool');
});

test('直接砸分钟数会切到手动档', () => {
  const p = mk();
  assert.equal(p.setIntervalMs(min(15)), min(15));
  const s = p.state();
  assert.equal(s.persona, 'manual');
  assert.equal(s.sampleMs, min(15));
});

test('没给档位表时退回手动，不装出不存在的档位', () => {
  const p = createPeek({
    cfg: { ...base, peekPersonaTable: null, peekIntervalMs: min(20) },
    log: noop, deliver: async () => {}, intervalFactor: () => 1,
  });
  assert.equal(p.state().persona, 'manual');
  assert.equal(p.state().sampleMs, min(20));
});

test('情绪倍率只乘生效值，不改主人拨的性子', () => {
  const p = mk({}, () => 0.5);
  p.setPersona('gentle');
  const s = p.state();
  assert.ok(s.sampleMs >= min(10) && s.sampleMs <= min(30), '性子自己的区间不变');
  assert.ok(Math.abs(s.intervalMs - s.sampleMs * 0.5) < 1, '生效值被情绪缩短了一半');
  assert.equal(s.factor, 0.5);
});

test('开着的时候换档位会重排下一次', () => {
  const p = mk({ peek: true });
  p.setPersona('cool');
  const left = p.state().nextInSec;
  p.stop();
  assert.ok(left > 1200, `冷淡档下一次该在半小时上下，实际 ${left}s`);
});

test('抽样和反推都是纯函数，边界也稳', () => {
  // 同一个随机源抽到同一头
  assert.equal(sampleInterval({ minMs: min(3), maxMs: min(10) }, () => 0), min(3));
  assert.equal(sampleInterval({ minMs: min(3), maxMs: min(10) }, () => 1), min(10));
  // 脏区间不炸：上下限都空就退回十分钟的默认区间
  assert.equal(sampleInterval({ minMs: 0, maxMs: 0 }, () => 0.5), min(10));
  assert.ok(sampleInterval(null, () => 0.5) > 0);

  // 反推：恰好落在某档中点，就是那一档
  assert.equal(personaForMs(min(6.5), TABLE.presets), 'clingy');
  assert.equal(personaForMs(min(20), TABLE.presets), 'gentle');
  assert.equal(personaForMs(min(60), TABLE.presets), 'cool');
  assert.equal(personaForMs(0, TABLE.presets), '');
  assert.equal(personaForMs(NaN, TABLE.presets), '');
});
