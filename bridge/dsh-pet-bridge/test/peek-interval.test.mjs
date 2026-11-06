// 窥屏间隔的自检。零依赖，用 node 内置 test runner：
//
//   node --test
//
// 钉住三件事：
//   · 基准间隔能运行时改，不用重启，改完自动重排下一次
//   · 越界的数字夹到一分钟到一天，脏数据退回默认三十分钟
//   · 情绪倍率只乘在生效值上，不污染主人拨的那个基准

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPeek } from '../lib/peek.js';

const noop = () => {};
const base = { peek: false, peekIntervalMs: undefined, peekQuietFrom: 1, peekQuietTo: 8, peekTmpDir: join(import.meta.dirname, '.tmp-peek'), peekTimeoutMs: 1000 };

function mk(over = {}, factor = () => 1) {
  const p = createPeek({ cfg: { ...base, ...over }, log: noop, deliver: async () => {}, intervalFactor: factor });
  return p;
}

test('默认三十分钟', () => {
  const p = mk();
  assert.equal(p.state().baseMs, 30 * 60 * 1000);
  assert.equal(p.state().intervalMs, 30 * 60 * 1000);
});

test('能改，改完立刻生效', () => {
  const p = mk();
  assert.equal(p.setIntervalMs(15 * 60 * 1000), 900000);
  assert.equal(p.state().baseMs, 900000);
});

test('越界夹住，脏数据退回默认', () => {
  const p = mk();
  assert.equal(p.setIntervalMs(1000), 60 * 1000, '再短就是拿探针刷自己的盘');
  assert.equal(p.setIntervalMs(50 * 3600 * 1000), 24 * 3600 * 1000, '再长等于关了');
  assert.equal(p.setIntervalMs('abc'), 30 * 60 * 1000, '写错了退回默认，别把窥屏弄没');
  assert.equal(p.setIntervalMs(0), 30 * 60 * 1000);
});

test('情绪倍率只乘生效值，不动基准', () => {
  const p = mk({}, () => 0.5);
  p.setIntervalMs(30 * 60 * 1000);
  assert.equal(p.state().baseMs, 1800000, '基准还是主人拨的那个');
  assert.equal(p.state().intervalMs, 900000, '生效值被情绪缩短了一半');
  assert.equal(p.state().factor, 0.5);
});

test('倍率回调炸了也当 1', () => {
  const p = mk({}, () => { throw new Error('boom'); });
  assert.equal(p.state().factor, 1);
  assert.equal(p.state().intervalMs, 30 * 60 * 1000);
});

test('开着的时候改间隔会重排下一次', () => {
  const p = mk({ peek: true });
  p.setIntervalMs(60 * 60 * 1000);
  const left = p.state().nextInSec;
  // 一小时 ±20%，允许到 48 分钟起步
  assert.ok(left > 2800, `下一次应该被推到一小时后，实际 ${left}s`);
  p.stop();
});
