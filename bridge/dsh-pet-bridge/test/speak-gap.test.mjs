import test from 'node:test';
import assert from 'node:assert/strict';

import { speakGapOk, countSpeak, speakCapOf } from '../lib/index.js';

// 2026-11-07：窥屏看见就投，5 分钟档三个小时把一天的额度烧光，之后一整天哑巴。
// 额度管的是「一天几句」，节奏得另外管——这个函数就是那道闸。

const T0 = 1_800_000_000_000;   // 随便一个基准时刻，纯算术不依赖真实时间
const MIN = 60 * 1000;

test('没说过话就放行', () => {
  assert.equal(speakGapOk(0, 25 * MIN, T0), true);
  assert.equal(speakGapOk(null, 25 * MIN, T0), true);
});

test('刚说完一句，下一分钟不许再说', () => {
  assert.equal(speakGapOk(T0, 25 * MIN, T0 + 1 * MIN), false);
  assert.equal(speakGapOk(T0, 25 * MIN, T0 + 24 * MIN), false);
});

test('满一个间隔就放行', () => {
  assert.equal(speakGapOk(T0, 25 * MIN, T0 + 25 * MIN), true);
  assert.equal(speakGapOk(T0, 25 * MIN, T0 + 26 * MIN), true);
});

test('间隔配 0 等于不限：主人要的就是「随便她说」', () => {
  assert.equal(speakGapOk(T0, 0, T0), true);
  assert.equal(speakGapOk(T0, null, T0), true);
  assert.equal(speakGapOk(T0, undefined, T0), true);
});

test('间隔是负数或者乱写的，当成不限，别把人锁死', () => {
  assert.equal(speakGapOk(T0, -5 * MIN, T0), true);
  assert.equal(speakGapOk(T0, 'abc', T0), true);
});

test('25 分钟的闸配上 40 句的日额度：一天铺得开，不会三小时烧完', () => {
  const gap = 25 * MIN;
  // 模拟一个白天：从 0 点开始，每次想说就隔 25 分钟，看 16 小时能说几句
  let last = 0;
  let n = 0;
  for (let t = T0; t < T0 + 16 * 60 * MIN; t += gap) {
    if (speakGapOk(last, gap, t)) { last = t; n++; }
  }
  const cap = speakCapOf({ clingy: { dayCap: 40 } }, 'clingy');
  assert.equal(n, 39, '16 小时每个间隔说一句，正好 39 句');
  assert.ok(n <= cap, '节奏算下来不该撞到 40 句的日额度，撞到就说明间隔太密');
});

test('额度和节奏是两件事：额度满了一样要过节奏闸', () => {
  const cap = speakCapOf({ quiet: { dayCap: 4 } }, 'quiet');
  const log = [T0, T0 + MIN, T0 + 2 * MIN, T0 + 3 * MIN];
  assert.equal(countSpeak(log, T0 + 4 * MIN), 4);
  assert.ok(countSpeak(log, T0 + 4 * MIN) >= cap, '额度确实满了');
  assert.equal(speakGapOk(T0 + 3 * MIN, 25 * MIN, T0 + 4 * MIN), false, '节奏闸照样拦得住');
});
