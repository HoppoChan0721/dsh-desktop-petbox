// 门面层的自检：假时钟 + 内存状态，验证「时间流逝」这条最容易被写错的路。
//
//   node --test test/mood-store.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMood } from '../lib/mood/index.js';

const T0 = new Date(2026, 10, 6, 20, 0, 0).getTime();
const min = (n) => n * 60000;
const hour = (n) => n * 3600000;

function moodAt(clock) {
  return createMood({ file: '', log: () => {}, now: () => clock.t });
}

test('时间推进会自动攒委屈，且不重复记账', () => {
  const clock = { t: T0 };
  const mood = moodAt(clock);

  mood.touch({ zone: 'head' }, clock.t);          // 有互动，计时起点
  clock.t += hour(4);                              // 四小时没人理
  const a = mood.snapshot(clock.t);
  assert.ok(a.values.upset > 0);

  const before = a.values.upset;
  clock.t += min(10);                              // 十分钟内再读，只该衰减，不该再记一笔
  assert.ok(mood.snapshot(clock.t).values.upset <= before);
});

test('一天没人理会到「不痛快」，但还不到冷战', () => {
  const clock = { t: T0 };
  const mood = moodAt(clock);
  mood.touch({ zone: 'head' }, clock.t);

  for (let i = 0; i < 24; i++) {
    clock.t += hour(1);
    mood.tick(clock.t);
  }
  const snap = mood.snapshot(clock.t);
  assert.ok(snap.values.upset > 0.35, `委屈应该攒起来，实际 ${snap.values.upset}`);
  assert.equal(snap.tier, 'sulky');
});

test('窥屏看到在玩只留一条此刻，账本一点不动', () => {
  const clock = { t: T0 };
  const mood = moodAt(clock);
  mood.touch({ zone: 'head' }, clock.t);

  for (let i = 0; i < 20; i++) {
    clock.t += hour(1);
    mood.tick(clock.t);
  }
  const before = mood.snapshot(clock.t);

  mood.peekScene({ proc: 'explorer.exe', title: '下载' }, clock.t);
  assert.equal(mood.snapshot(clock.t).values.anger, before.values.anger, '认不出来的窗口不该记账');
  assert.equal(mood.state(clock.t).moments.count, 0, '认不出来连此刻都不该留');

  mood.peekScene({ proc: 'steam.exe', title: 'Steam' }, clock.t);
  const snap = mood.snapshot(clock.t);
  // 2026-11-07 的口径：观察改此刻，互动改关系。看见在玩不该往账本里写气。
  assert.equal(snap.values.anger, before.values.anger, '看见在玩不该往账本里写气');
  assert.equal(snap.values.upset, before.values.upset, '委屈也不该被窥屏推动');
  const mom = mood.state(clock.t).moments;
  assert.equal(mom.count, 1);
  assert.equal(mom.top.tag, '有点堵', '本来就在委屈，措辞要更重');
});

test('说话能一键清零负面，闸门也随之回到平静', () => {
  const clock = { t: T0 };
  const mood = moodAt(clock);
  mood.touch({ zone: 'head' }, clock.t);
  for (let i = 0; i < 20; i++) {
    clock.t += hour(1);
    mood.tick(clock.t);
  }
  mood.peekScene({ proc: 'steam.exe', title: 'Steam' }, clock.t);
  // 一天没人理，委屈停在「不痛快」这一档。冷战要靠更密集的委屈才能攒到。
  assert.equal(mood.snapshot(clock.t).tier, 'sulky');
  assert.equal(mood.state(clock.t).moments.count, 1, '先留一条此刻，等下说话该把它一并清掉');

  const after = (mood.speech('回来了', clock.t + 1000), mood.snapshot(clock.t + 1000));
  assert.equal(after.tier, 'calm');
  assert.equal(mood.gate('touch', clock.t + 1000).respond, 1);
  assert.equal(mood.state(clock.t + 1000).moments.count, 0, '主人开口了，余温该翻篇');
});

test('reset 之后回到刚认识的样子', () => {
  const clock = { t: T0 };
  const mood = moodAt(clock);
  mood.touch({ zone: 'head' }, clock.t);
  clock.t += hour(6);
  mood.peekScene({ proc: 'steam.exe', title: 'Steam' }, clock.t);
  assert.ok(mood.snapshot(clock.t).values.upset > 0);

  mood.reset(clock.t);
  const snap = mood.snapshot(clock.t);
  assert.equal(snap.tier, 'calm');
  assert.equal(snap.values.upset, 0);
});

test('平静时情绪卡是空串，不白占 token', () => {
  const clock = { t: T0 };
  const mood = moodAt(clock);
  mood.touch({ zone: 'head' }, clock.t);
  assert.equal(mood.cue(clock.t), '');
  assert.ok(mood.state(clock.t).summary);
});
