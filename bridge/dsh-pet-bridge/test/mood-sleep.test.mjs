// 睡觉不算冷落。
//
// 2026-11-08 修的：idle 结算原来只认墙钟，睡八小时等于八小时没人理，一觉醒来
// 一次性补一笔大的（实测 +0.699，正好十四小时）。现在用系统输入空闲把「人不在」
// 摘出去，账本只记「人坐在前面却没理她」。
//
// 这里用一个假的探针替掉真的 PowerShell 子进程，好让判定本身能被单测。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMood } from '../lib/mood/index.js';

const T0 = 1700000000000;
const hour = (n) => n * 3600000;
const STEP = 90 * 1000;

/** 跑一段时间，每次 tick 前喂一个新的采样点。 */
function run(m, { from, to, idleAt, onSample }) {
  let clock = from;
  for (let t = from + STEP; t <= to; t += STEP) {
    clock = t;
    onSample({ idleMs: idleAt(t), sampledAt: t });
    m.tick();
  }
  return clock;
}

test('睡了一整夜，醒来不记委屈', () => {
  let idleMs = 0;
  let sampledAt = T0;
  const probe = { start() {}, current: () => ({ idleMs, sampledAt }) };
  let clock = T0;
  const m = createMood({ file: '', probe, log: () => {}, now: () => clock });

  m.touch({ zone: 'hair' }); // 睡前摸一下，建立「上次互动」

  clock = run(m, {
    from: T0,
    to: T0 + hour(8),
    idleAt: (t) => t - T0, // 从睡前那一刻起键鼠就没动过
    onSample: (s) => {
      idleMs = s.idleMs;
      sampledAt = s.sampledAt;
    },
  });

  const snap = m.state(clock).snapshot;
  assert.equal(snap.values.upset, 0, '睡了一整夜不该攒委屈');
  assert.equal(snap.tier, 'calm');
});

test('人在前面却不理她，照样攒委屈', () => {
  let idleMs = 0;
  let sampledAt = T0;
  const probe = { start() {}, current: () => ({ idleMs, sampledAt }) };
  let clock = T0;
  const m = createMood({ file: '', probe, log: () => {}, now: () => clock });

  m.touch({ zone: 'hair' });

  clock = run(m, {
    from: T0,
    to: T0 + hour(8),
    idleAt: () => 10 * 1000, // 一直有小动作，只是没碰她
    onSample: (s) => {
      idleMs = s.idleMs;
      sampledAt = s.sampledAt;
    },
  });

  const snap = m.state(clock).snapshot;
  assert.ok(snap.values.upset > 0.05, '坐着不理她就该有委屈，现在是 ' + snap.values.upset);
});

test('醒来之后再坐四小时，只按这四小时记', () => {
  let idleMs = 0;
  let sampledAt = T0;
  const probe = { start() {}, current: () => ({ idleMs, sampledAt }) };
  let clock = T0;
  const m = createMood({ file: '', probe, log: () => {}, now: () => clock });

  m.touch({ zone: 'hair' });

  // 先睡八小时
  clock = run(m, {
    from: T0,
    to: T0 + hour(8),
    idleAt: (t) => t - T0,
    onSample: (s) => {
      idleMs = s.idleMs;
      sampledAt = s.sampledAt;
    },
  });

  // 醒来敲了一下，人来了，账重开
  m.touch({ zone: 'hair' });

  // 再坐五小时没理她，这次键鼠一直有小动作
  clock = run(m, {
    from: clock,
    to: clock + hour(5),
    idleAt: () => 10 * 1000,
    onSample: (s) => {
      idleMs = s.idleMs;
      sampledAt = s.sampledAt;
    },
  });

  const snap = m.state(clock).snapshot;
  assert.ok(snap.values.upset > 0.05, '醒着的这五小时该记账，现在是 ' + snap.values.upset);
  assert.ok(snap.values.upset < 0.45, '不该把夜里那八小时一起补上，现在是 ' + snap.values.upset);
});
