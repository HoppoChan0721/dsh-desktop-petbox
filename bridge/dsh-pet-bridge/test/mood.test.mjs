// 情绪引擎的自检。零依赖，直接用 node 内置的 test runner：
//
//   node --test test/
//
// 重点不是覆盖率，是把「委屈攒够才转成气」「冷战里被摸更委屈」「说话能哄好」
// 这几条业务约定钉死。以后改 profile 参数，跑一遍就知道有没有改坏。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createState, ingest, tick, resolve, gate, evalCond } from '../lib/mood/engine.js';
import { DEFAULT_PROFILE } from '../lib/mood/profile.js';
import { fromIdle, fromTouch, fromSpeech, fromScene, classifyScene, isNight } from '../lib/mood/signals.js';
import { render, summarize } from '../lib/mood/cue.js';

const P = DEFAULT_PROFILE;
const T0 = 1700000000000;
const min = (n) => n * 60000;
const hour = (n) => n * 3600000;

/** 反复记同一笔，用来把某个情绪推上去。 */
function pump(state, makeSignal, times, stepMs = 1000) {
  let s = state;
  for (let i = 0; i < times; i++) s = ingest(s, makeSignal(), P, T0 + i * stepMs);
  return s;
}

test('空账本是平静的，也不占字数', () => {
  const s = createState(P, T0);
  const snap = resolve(s, P, T0);
  assert.equal(snap.tier, 'calm');
  assert.equal(snap.axes.valence, 0);
  assert.equal(render(snap, P), '');
});

test('没互动会攒委屈，但前两小时不算', () => {
  const s0 = createState(P, T0);
  const s1 = ingest(s0, fromIdle(60), P, T0);
  assert.equal(resolve(s1, P, T0).values.upset, 0);

  const s2 = ingest(s0, fromIdle(6 * 60), P, T0);
  assert.ok(resolve(s2, P, T0).values.upset > 0.1);
});

test('委屈不到线时，看见在玩也不会生气', () => {
  const s = ingest(createState(P, T0), fromIdle(6 * 60), P, T0);   // 委屈 0.12
  const after = ingest(s, fromScene({ category: 'leisure', label: 'Steam' }), P, T0 + 1000);
  assert.equal(resolve(after, P, T0 + 1000).values.anger, 0);
});

test('委屈攒够了，看见没干正事才转成气', () => {
  let s = pump(createState(P, T0), () => fromIdle(6 * 60), 5);
  const before = resolve(s, P, T0 + 6000);
  assert.ok(before.values.upset > 0.4);

  const after = ingest(s, fromScene({ category: 'leisure', label: 'Steam' }), P, T0 + 10000);
  const snap = resolve(after, P, T0 + 10000);
  assert.ok(snap.values.anger > 0.4);
  assert.equal(snap.tier, 'cold');
  assert.match(render(snap, P), /生气/);
});

test('冷战里被摸是「现在才来」，不是甜', () => {
  let s = pump(createState(P, T0), () => fromIdle(6 * 60), 5);
  s = ingest(s, fromScene({ category: 'leisure', label: 'Steam' }), P, T0 + 10000);
  const upsetBefore = resolve(s, P, T0 + 10000).values.upset;
  const joyBefore = resolve(s, P, T0 + 10000).values.joy;

  const after = ingest(s, fromTouch({ zone: 'head' }), P, T0 + 11000);
  const snap = resolve(after, P, T0 + 11000);
  assert.ok(snap.values.upset > upsetBefore);
  assert.equal(snap.values.joy, joyBefore);
});

test('说句话能把她哄好', () => {
  let s = pump(createState(P, T0), () => fromIdle(6 * 60), 5);
  s = ingest(s, fromScene({ category: 'leisure', label: 'Steam' }), P, T0 + 10000);
  assert.ok(resolve(s, P, T0 + 10000).values.anger > 0.4);

  const after = ingest(s, fromSpeech('我回来啦'), P, T0 + 12000);
  const snap = resolve(after, P, T0 + 12000);
  assert.equal(snap.values.anger, 0);
  assert.equal(snap.values.upset, 0);
  assert.ok(snap.values.joy > 0.3);
});

test('情绪会自己消，半衰期对得上', () => {
  const s = pump(createState(P, T0), () => fromIdle(6 * 60), 5);
  const start = resolve(s, P, T0 + 6000).values.upset;
  const later = tick(s, P, T0 + 6000 + hour(6));   // upset 的半衰期正是 6 小时
  assert.ok(Math.abs(resolve(later, P, T0 + 6000 + hour(6)).values.upset - start / 2) < 0.02);
});

test('档位有回差，不会在阈值边上抽风', () => {
  let s = pump(createState(P, T0), () => fromIdle(6 * 60), 5);
  s = ingest(s, fromScene({ category: 'leisure', label: 'Steam' }), P, T0 + 10000);
  assert.equal(resolve(s, P, T0 + 10000).tier, 'cold');

  // 掉到 0.6 以下一点还不降，要低于 0.6 * 0.8 = 0.48
  const soft = tick(s, P, T0 + 10000 + hour(1));
  assert.equal(resolve(soft, P, T0 + 10000 + hour(1)).tier, 'cold');
});

test('担心只改语气，不把档位推到冷战', () => {
  const s = pump(createState(P, T0), () => fromScene({ category: 'leisure', label: 'Steam', night: true }), 3, hour(4));
  const snap = resolve(s, P, T0 + hour(8));
  assert.ok(snap.values.worried > 0);
  assert.equal(snap.tier, 'calm');
});

test('同一个窗口一小时内只记一次，防重复', () => {
  let s = pump(createState(P, T0), () => fromIdle(6 * 60), 5);
  const scene = () => fromScene({ category: 'leisure', label: 'Steam' });
  const a = ingest(s, scene(), P, T0 + 10000);
  const b = ingest(a, scene(), P, T0 + 20000);
  assert.ok(Math.abs(resolve(a, P, T0 + 10000).values.anger - resolve(b, P, T0 + 20000).values.anger) < 0.05);
});

test('闸门按档位给不同答案', () => {
  const calm = resolve(createState(P, T0), P, T0);
  assert.equal(gate(calm, P, 'touch').respond, 1);
  assert.equal(gate(calm, P, 'proactive').intervalFactor, 1);

  const cold = { tier: 'cold' };
  assert.ok(gate(cold, P, 'touch').respond < 0.5);
  assert.ok(gate(cold, P, 'proactive').intervalFactor > 1);
  assert.deepEqual(gate(calm, P, 'nope'), {});
});

test('条件求值支持 all / any / not 和比较', () => {
  const bag = { mood: { upset: 0.5 }, signal: { category: 'leisure' }, tier: 'sulky' };
  assert.equal(evalCond({ path: 'mood.upset', gt: 0.4 }, bag, P), true);
  assert.equal(evalCond({ all: [{ path: 'mood.upset', gt: 0.4 }, { path: 'tier', eq: 'calm' }] }, bag, P), false);
  assert.equal(evalCond({ any: [{ path: 'tier', eq: 'calm' }, { path: 'tier', eq: 'sulky' }] }, bag, P), true);
  assert.equal(evalCond({ not: { path: 'mood.upset', gt: 0.4 } }, bag, P), false);
  assert.equal(evalCond(undefined, bag, P), true);
});

test('场景分类认得出正事和摸鱼', () => {
  assert.equal(classifyScene({ proc: 'Code.exe', title: 'main.js - Visual Studio Code' }), 'work');
  assert.equal(classifyScene({ proc: 'chrome.exe', title: '哔哩哔哩 (゜-゜)つロ 干杯~' }), 'leisure');
  assert.equal(classifyScene({ proc: 'steam.exe', title: 'Steam' }), 'leisure');
  assert.equal(classifyScene({ proc: 'explorer.exe', title: '下载' }), 'other');
  assert.equal(classifyScene({}), 'other');
});

test('深夜判定', () => {
  assert.equal(isNight(new Date(2026, 10, 6, 2, 30)), true);
  assert.equal(isNight(new Date(2026, 10, 6, 15, 0)), false);
});

test('摘要能给人看', () => {
  const s = pump(createState(P, T0), () => fromIdle(6 * 60), 5);
  const text = summarize(resolve(s, P, T0 + 6000), P);
  assert.match(text, /委屈/);
});
