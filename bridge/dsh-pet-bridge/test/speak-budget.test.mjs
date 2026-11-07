// 主动说话额度的自检。
//
// 以前两条管道各算各的：窥屏投递不计入主动开口的 today，档位调成「黏人」以后
// 十几分钟就把 8 句吃光，日上限形同虚设。现在合并成一份，额度由窥屏档位给。
//
// 这里钉住：档位给多少额度、24 小时窗口怎么数、没有额度时是不限。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countSpeak, speakCapOf } from '../lib/index.js';
import { DEFAULT_PROFILE } from '../lib/mood/profile.js';

const T0 = 1700000000000;
const hour = (n) => n * 3600000;
// 额度挂在「主动说话浓度」上，不挂在窥屏档位上
const TABLE = DEFAULT_PROFILE.urge.presets;

test('额度跟主动说话的浓度走', () => {
  assert.equal(speakCapOf(TABLE, 'quiet'), 4);
  assert.equal(speakCapOf(TABLE, 'normal'), 20);
  assert.equal(speakCapOf(TABLE, 'clingy'), 40);
  assert.equal(speakCapOf(TABLE, 'chatty'), 60);
});

test('「不拦着」是真的不限：额度是 0，那个闸门不生效', () => {
  assert.equal(speakCapOf(TABLE, 'unbound'), 0);
  // 0 在 deliver 里的含义就是「不检查」，不是「一句都不许说」
  assert.equal(TABLE.unbound.dayCap, 0);
  assert.ok(TABLE.unbound.gapScale < 1, '两阵之间也该比正常更短');
});

test('档位不认识或者表是空的，就当不限', () => {
  assert.equal(speakCapOf(TABLE, 'nope'), 0);
  assert.equal(speakCapOf(TABLE, ''), 0);
  assert.equal(speakCapOf(null, 'gentle'), 0);
  assert.equal(speakCapOf({}, 'gentle'), 0);
});

test('只数最近 24 小时的，过期的自己滑出去', () => {
  const log = [T0 - hour(30), T0 - hour(20), T0 - hour(2), T0 - hour(1)];
  assert.equal(countSpeak(log, T0), 3, '30 小时前那条不算');
  assert.equal(countSpeak([], T0), 0);
  assert.equal(countSpeak(null, T0), 0);
  assert.equal(countSpeak(['x', null], T0), 0, '脏数据不该被当成一句话');
});

test('刚刚到线就不许再说，差一句还能说', () => {
  const cap = 3;
  const log = [T0 - hour(3), T0 - hour(2), T0 - hour(1)];
  assert.equal(countSpeak(log, T0), cap);
  assert.equal(countSpeak(log.slice(0, 2), T0) < cap, true);
});

test('同一份计数按 24 小时窗口数，不按自然日', () => {
  // 三条都在同一个 24 小时窗口里，不管落在哪一天
  const shared = [T0 - hour(5), T0 - hour(4), T0 - hour(1)];
  assert.equal(countSpeak(shared, T0), 3, '三条都在同一个窗口里');
});
