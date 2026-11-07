// 兴趣词的自检。
//
// 这里钉的是「别误报」：一个词命中就开高频窗，误一次就是白盯二十分钟。
// 真探针要起 PowerShell，所以匹配抽成了纯函数。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchInterest } from '../lib/peek.js';
import { DEFAULT_PROFILE as P } from '../lib/mood/profile.js';
import { createMood } from '../lib/mood/index.js';

const T0 = 1700000000000;
const W = P.interest.words;

test('中文词包含就命中', () => {
  assert.equal(matchInterest(W, 'chrome', '【猫猫日常】他以为自己是老大 - 哔哩哔哩').id, 'cat');
  assert.equal(matchInterest(W, 'chrome', '今天做饭翻车了 - 下厨房').id, 'food');
  assert.equal(matchInterest(W, 'msedge', '鲸鱼是怎么呼吸的').id, 'whale');
});

test('英文词按边界匹配，不误伤长单词', () => {
  const only = [{ id: 'cat', words: ['cat'] }];
  assert.equal(matchInterest(only, 'chrome', 'cute cat video').id, 'cat');
  assert.equal(matchInterest(only, 'app', 'category settings'), null);
  assert.equal(matchInterest(only, 'app', 'concatenate strings'), null);
});

test('空输入和坏词表都只是不命中，不抛错', () => {
  assert.equal(matchInterest(null, 'chrome', '猫'), null);
  assert.equal(matchInterest([], 'chrome', '猫'), null);
  assert.equal(matchInterest(W, '', ''), null);
  assert.equal(matchInterest([{ id: '' }, null, { id: 'x', words: [] }], 'chrome', '猫'), null);
});

test('兴趣只留一条此刻，账本一个数都不动', () => {
  const mood = createMood({ file: '', log: () => {}, now: () => T0 });
  mood.scene({ category: 'interest', label: '哔哩哔哩 猫猫', interest: 'cat', interestLabel: '小猫' }, T0);

  const st = mood.state(T0);
  assert.equal(st.moments.count, 1);
  assert.equal(st.moments.top.id, 'curious');
  assert.equal(st.moments.top.tag, '想看看');
  assert.match(st.moments.top.why, /小猫/, '要说清看到了什么');

  const snap = mood.snapshot(T0);
  assert.equal(snap.values.joy, 0);
  assert.equal(snap.values.upset, 0);
});

test('词表里每一条都能用，标签不能是空的', () => {
  assert.ok(Array.isArray(W) && W.length > 0);
  for (const w of W) {
    assert.ok(w.id, '每条都要有 id');
    assert.ok(w.label, `${w.id} 要有给人看的中文名`);
    assert.ok(Array.isArray(w.words) && w.words.length, `${w.id} 要有词`);
  }
});
