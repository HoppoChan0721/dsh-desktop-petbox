// 「此刻」短时层的自检。
//
// 这一层存在的意义是把「观察」和「关系」分开，所以测试的重点不是算得准不准，
// 而是钉死三条：不进账本、会自己过期、主人一开口就翻篇。
//
//   node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pushMoment, pruneMoments, summarizeMoments } from '../lib/mood/moment.js';
import { createState, ingest, resolve } from '../lib/mood/engine.js';
import { DEFAULT_PROFILE as P } from '../lib/mood/profile.js';
import { fromScene } from '../lib/mood/signals.js';
import { render } from '../lib/mood/cue.js';
import { createMood } from '../lib/mood/index.js';

const T0 = 1700000000000;
const min = (n) => n * 60000;

test('此刻带 TTL，时间一到自己消失', () => {
  const list = pushMoment([], { id: 'saw-play', tag: '有点在意', ttlMs: min(10) }, T0);
  assert.equal(list.length, 1);
  assert.equal(pruneMoments(list, T0 + min(9)).length, 1);
  assert.equal(pruneMoments(list, T0 + min(11)).length, 0);
  assert.equal(summarizeMoments(list, T0 + min(11)).count, 0);
});

test('同一条此刻只占一个位置，隔一轮才加次数', () => {
  let list = pushMoment([], { id: 'saw-play', tag: '有点在意' }, T0);
  // 同一时刻被两条规则命中：措辞可以变得更重要，但不算「看了两回」
  list = pushMoment(list, { id: 'saw-play', tag: '有点堵' }, T0);
  assert.equal(list.length, 1);
  assert.equal(list[0].n, 1);
  assert.equal(list[0].tag, '有点堵', '后命中的措辞要盖掉前面的');

  // 隔了一轮再看见，这次才真的是第二回
  list = pushMoment(list, { id: 'saw-play', tag: '有点堵' }, T0 + min(5));
  assert.equal(list.length, 1);
  assert.equal(list[0].n, 2);
});

test('不同的 id 各占一条，最多留六条', () => {
  let list = [];
  for (let i = 0; i < 9; i++) list = pushMoment(list, { id: 'm' + i, tag: 't' + i }, T0 + i);
  assert.equal(list.length, 6);
  assert.equal(list[list.length - 1].id, 'm8');
});

test('窥屏只写此刻，账本一个数都不动', () => {
  const s = ingest(createState(P, T0), fromScene({ category: 'work', label: 'Visual Studio Code' }), P, T0 + 1000);
  const snap = resolve(s, P, T0 + 1000);
  assert.equal(snap.values.moved, 0, '看见在忙不该记成感动');
  assert.equal(snap.moments.length, 1);
  assert.equal(snap.moments[0].id, 'saw-work');
  assert.equal(snap.moments[0].tag, '有点心疼');
});

test('账本平静的时候，此刻那段也要说得出来', () => {
  const s = ingest(createState(P, T0), fromScene({ category: 'work', label: 'Visual Studio Code' }), P, T0 + 1000);
  const cue = render(resolve(s, P, T0 + 1000), P);
  assert.match(cue, /瞄到一眼/);
  assert.match(cue, /心疼/);
});

test('什么也没有的时候情绪卡还是空串，不白占 token', () => {
  const s = createState(P, T0);
  assert.equal(render(resolve(s, P, T0), P), '');
});

test('主人真的开口了，此刻该翻篇', () => {
  const clock = { t: T0 };
  const mood = createMood({ file: '', log: () => {}, now: () => clock.t });
  mood.scene({ category: 'work', label: 'Visual Studio Code' }, clock.t);
  assert.equal(mood.state(clock.t).moments.count, 1);

  mood.speech('在忙什么', clock.t + 1000);
  assert.equal(mood.state(clock.t + 1000).moments.count, 0, '他说话了，之前瞄到的余温该翻篇');
});

test('摸一下不清此刻：摸不代表想聊', () => {
  const clock = { t: T0 };
  const mood = createMood({ file: '', log: () => {}, now: () => clock.t });
  mood.scene({ category: 'work', label: 'Visual Studio Code' }, clock.t);
  mood.touch({ zone: 'head' }, clock.t + 500);
  assert.equal(mood.state(clock.t + 500).moments.count, 1);
});
