// 健壮性与版本化：这一份测的不是「情绪对不对」，是「坏掉的时候会不会把桥带崩」。
//
//   node --test test/mood-resilience.test.mjs
//
// 公共插件，别人拉下去会遇到各种状态文件：旧版本、写坏的、手改过的、profile 被改成
// 只剩一种情绪的。这些都不该让 pet-bridge 起不来。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createState, ingest, tick, resolve, evalCond } from '../lib/mood/engine.js';
import { DEFAULT_PROFILE, SCHEMA_VERSION } from '../lib/mood/profile.js';
import { createStore } from '../lib/mood/store.js';
import { createMood } from '../lib/mood/index.js';
import { fromScene, fromTouch, fromIdle } from '../lib/mood/signals.js';

const T0 = 1700000000000;
const hour = (n) => n * 3600000;

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'mood-'));
  return { file: join(dir, 'pet-mood.json'), dir };
}

test('状态文件写坏了就重置，不抛错', () => {
  const { file, dir } = tmpFile();
  try {
    writeFileSync(file, '{ 这不是 json', 'utf8');
    const seen = [];
    const store = createStore({ file, profile: DEFAULT_PROFILE, log: (m) => seen.push(m) });
    const state = store.load(T0);
    assert.equal(state.schemaVersion, SCHEMA_VERSION);
    assert.equal(state.emotions.joy.value, 0);
    assert.ok(seen.some((m) => m.includes('unreadable')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('版本号不认识就重置，并留下日志', () => {
  const { file, dir } = tmpFile();
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 99, emotions: {} }), 'utf8');
    const seen = [];
    const store = createStore({ file, profile: DEFAULT_PROFILE, log: (m) => seen.push(m) });
    const state = store.load(T0);
    assert.equal(state.schemaVersion, SCHEMA_VERSION);
    assert.ok(seen.some((m) => m.includes('unknown schemaVersion')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profile 后来加了新情绪，旧状态文件会自动补上', () => {
  const { file, dir } = tmpFile();
  try {
    // 假装这是上个版本写的：只有 joy 一条
    writeFileSync(file, JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      emotions: { joy: { value: 0.5, at: T0 } },
      tier: 'calm',
      cooldowns: {},
      log: [],
      lastInteractionAt: T0,
      lastSignalAt: T0,
    }), 'utf8');
    const store = createStore({ file, profile: DEFAULT_PROFILE });
    const state = store.load(T0);
    assert.equal(state.emotions.joy.value, 0.5, '老数据要留住');
    assert.equal(state.emotions.upset.value, 0, '新情绪要补零');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('文件不存在就是新账本，不记错误日志', () => {
  const { file, dir } = tmpFile();
  try {
    const seen = [];
    const store = createStore({ file, profile: DEFAULT_PROFILE, log: (m) => seen.push(m) });
    const state = store.load(T0);
    assert.equal(state.emotions.joy.value, 0);
    assert.equal(seen.length, 0, '第一次跑不算错误');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('写盘是原子的，读到的永远是完整 JSON', () => {
  const { file, dir } = tmpFile();
  try {
    const store = createStore({ file, profile: DEFAULT_PROFILE });
    const state = store.load(T0);
    store.save(state);
    const again = store.load(T0);
    assert.equal(again.schemaVersion, SCHEMA_VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profile 被改得很素也不崩：只有一种情绪、一个档位', () => {
  const lean = {
    version: 1,
    emotions: { joy: { halfLife: 2, polarity: 1, label: '开心' } },
    rules: [],
    tiers: [{ name: 'calm' }],
    gates: {},
    cue: {},
  };
  const s = createState(lean, T0);
  const snap = resolve(s, lean, T0);
  assert.equal(snap.tier, 'calm');
  assert.equal(snap.dominant, null);
  assert.equal(evalCond({ path: 'mood.joy', gt: 0.1 }, { mood: {}, signal: {}, tier: 'calm' }, lean), false);
});

test('规则指向不存在的情绪时跳过，不抛错', () => {
  const broken = {
    ...DEFAULT_PROFILE,
    rules: [{ id: 'bad', on: 'touch', add: '其实没这个情绪', delta: 1 }],
  };
  const s = ingest(createState(broken, T0), fromTouch({ zone: 'head' }), broken, T0);
  assert.equal(s.schemaVersion, SCHEMA_VERSION);
});

test('奇怪的 signal 不会把账本弄坏', () => {
  const s0 = createState(DEFAULT_PROFILE, T0);
  assert.equal(ingest(s0, null, DEFAULT_PROFILE, T0), s0);
  assert.equal(ingest(s0, {}, DEFAULT_PROFILE, T0), s0);
  // weight 为负：不该把情绪减成负数
  const s1 = ingest(s0, { kind: 'idle', at: T0, minutes: 999, weight: -5 }, DEFAULT_PROFILE, T0);
  assert.ok(resolve(s1, DEFAULT_PROFILE, T0).values.upset >= 0);
});

test('冷战会自己结束：没人管也会慢慢回到平静', () => {
  let s = createState(DEFAULT_PROFILE, T0);
  s = ingest(s, fromTouch({ zone: 'head' }), DEFAULT_PROFILE, T0);
  // 一小时一小时地喂空闲，weight 就是那一小时。连着一天没人理。
  for (let i = 1; i <= 20; i++) {
    const at = T0 + i * hour(1);
    s = ingest(s, fromIdle((at - T0) / 60000, at, 1), DEFAULT_PROFILE, at);
  }
  const idle = resolve(s, DEFAULT_PROFILE, T0 + hour(20));
  assert.ok(idle.values.upset > 0.3 && idle.values.upset < 0.6, `一天没人理该稳在中段，实际 ${idle.values.upset}`);

  s = ingest(s, fromScene({ category: 'leisure', label: 'Steam' }), DEFAULT_PROFILE, T0 + hour(21));
  assert.equal(resolve(s, DEFAULT_PROFILE, T0 + hour(21)).tier, 'cold', '先说清楚现在是冷战');

  // 之后什么都不发生，只让时间走
  const after3h = resolve(s, DEFAULT_PROFILE, T0 + hour(24));
  const after12h = resolve(s, DEFAULT_PROFILE, T0 + hour(33));
  assert.notEqual(after3h.tier, 'cold', '三小时后该软下来了');
  assert.equal(after12h.tier, 'calm', '半天之后该好了');
});

test('门面在状态文件坏掉时还能起来', () => {
  const { file, dir } = tmpFile();
  try {
    writeFileSync(file, 'null', 'utf8');
    const mood = createMood({ file, log: () => {}, now: () => T0 });
    const snap = mood.snapshot(T0);
    assert.equal(snap.tier, 'calm');
    assert.ok(mood.state(T0).summary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('反复读写不会把状态撑大', () => {
  const { file, dir } = tmpFile();
  try {
    const mood = createMood({ file, log: () => {}, now: () => T0 });
    for (let i = 0; i < 200; i++) {
      mood.touch({ zone: 'head' }, T0 + i * 1000);
      mood.speech('在', T0 + i * 1000);
    }
    const st = mood.state(T0 + 200000);
    assert.ok((st.log || []).length <= 8, '对外只给最近几条');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok((raw.log || []).length <= 12, '落盘的账本也要有上限');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
