import test from 'node:test';
import assert from 'node:assert/strict';

import { billsBudget, countSpeak, speakCapOf } from '../lib/index.js';

// 2026-11-07：一天 40 句的额度是「主动说话」那根轴上配的。
// 窥屏多久说一句由窥屏档位管，不该吃这份额度——混在一起会三小时烧光，之后整天哑巴。
// 主人原话：「我记得没有让你在窥屏这部分加额度」。

test('主动开口要记额度', () => {
  assert.equal(billsBudget({ proactive: true }), true);
});

test('窥屏传 budget:false，不记也不查', () => {
  assert.equal(billsBudget({ proactive: true, budget: false }), false);
});

test('点触回复本来就不算主动，怎么传都不记账', () => {
  assert.equal(billsBudget({}), false);
  assert.equal(billsBudget({ budget: false }), false);
  assert.equal(billsBudget(), false);
  assert.equal(billsBudget(null), false);
});

test('窥屏跑一整天也不该把主动说话的额度撑满', () => {
  // 模拟：窥屏每 5 分钟投一条，投一整个白天，但它不该进 speakLog
  const peekOpts = { proactive: true, budget: false };
  const urgeOpts = { proactive: true };
  const log = [];
  const T0 = 1_800_000_000_000;
  for (let i = 0; i < 100; i++) {
    if (billsBudget(peekOpts)) log.push(T0 + i * 5 * 60 * 1000);
  }
  assert.equal(log.length, 0, '一百次窥屏都没进额度账本');
  if (billsBudget(urgeOpts)) log.push(T0);
  assert.equal(countSpeak(log, T0 + 1000), 1, '真正的主动开口才记一条');
});

test('额度只看自己这一轴：窥屏再多也碰不到 cap', () => {
  const cap = speakCapOf({ clingy: { dayCap: 40 } }, 'clingy');
  const log = [];
  assert.ok(countSpeak(log, 1_800_000_000_000) < cap, '窥屏跑完额度还是空的');
});
