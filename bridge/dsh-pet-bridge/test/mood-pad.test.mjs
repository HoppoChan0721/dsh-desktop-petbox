// PAD 派生轴的自检。零依赖，用 node 内置 test runner：
//
//   node --test
//
// 这两条轴不是新账本，是从现有情绪强度算出来的「形态」：
// 同样是「不痛快」，绷着和蔫着是两回事；同样是「有情绪」，谁占上风也不一样。
// 钉住的约定：
//   · 单种情绪时，形态就是它自己的向量
//   · 多种情绪并存放时不叠加到饱和，取的是方向
//   · 亲近度不参与混合（它是关系，不是此刻）
//   · 平静时一句都不多说

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createState, ingest, resolve } from '../lib/mood/engine.js';
import { DEFAULT_PROFILE } from '../lib/mood/profile.js';
import { fromIdle } from '../lib/mood/signals.js';
import { render, shapesOf, summarize } from '../lib/mood/cue.js';

const P = DEFAULT_PROFILE;
const T0 = new Date(2026, 10, 6, 14, 0, 0).getTime();
const min = (n) => n * 60000;

/** 直接改账本造一份指定情绪组合，测的是派生轴不是记账规则。 */
function withMood(pairs, t = T0) {
  const base = createState(P, T0);
  const emotions = { ...base.emotions };
  for (const [name, v] of Object.entries(pairs)) emotions[name] = { value: v, at: t };
  return resolve({ ...base, emotions }, P, t);
}

test('平静时两条轴都是零，一个字都不多说', () => {
  const snap = resolve(createState(P, T0), P, T0);
  assert.equal(snap.axes.arousal, 0);
  assert.equal(snap.axes.dominance, 0);
  assert.deepEqual(shapesOf(snap, P), []);
  assert.equal(render(snap, P), '');
});

test('单种情绪时形态就是它自己的向量，强度按比例缩', () => {
  const snap = withMood({ anger: 0.6 });
  // 生气向量是 [P -0.7, A 0.6, D 0.5]；强度 0.6 的时候是六成满，不是满格
  assert.ok(Math.abs(snap.axes.arousal - 0.36) < 0.01, '生气该是绷着的');
  assert.ok(Math.abs(snap.axes.dominance - 0.30) < 0.01, '生气想占上风');
  assert.deepEqual(shapesOf(snap, P), ['绷着', '想占上风']);
});

test('委屈是蔫的、气势低，跟生气正好相反', () => {
  const snap = withMood({ upset: 0.5 });
  assert.ok(snap.axes.arousal < 0, '委屈不激动');
  assert.ok(snap.axes.dominance < 0, '委屈是没办法');
  const words = shapesOf(snap, P);
  assert.ok(words.includes('蔫着'), '憋着的气是蔫的');
  assert.ok(words.includes('气势低'));
  assert.ok(!words.includes('绷着'), '不能把委屈说成炸毛');
});

test('同一条激活轴，开心叫来劲，不开心叫绷着', () => {
  const happy = withMood({ joy: 0.9 });
  const cross = withMood({ anger: 0.7 });
  assert.ok(happy.axes.arousal > 0.18);
  assert.ok(cross.axes.arousal > 0.18);
  assert.deepEqual(shapesOf(happy, P).filter((w) => w === '来劲'), ['来劲']);
  assert.deepEqual(shapesOf(cross, P).filter((w) => w === '绷着'), ['绷着']);
});

test('几种情绪并存放不会叠到饱和，取的是方向', () => {
  const snap = withMood({ joy: 0.5, anger: 0.5, worried: 0.5 });
  assert.ok(Math.abs(snap.axes.arousal) <= 1);
  assert.ok(Math.abs(snap.axes.dominance) <= 1);
  // 三股都是高激活，方向一致，应该是个不小的正数
  assert.ok(snap.axes.arousal > 0.3);
});

test('相反的两种情绪会互相抵消回中间，不会凭空放大', () => {
  const snap = withMood({ anger: 0.5, upset: 0.5 });
  // anger A+0.6 与 upset A-0.3，一比一抵完剩 0.15
  assert.ok(Math.abs(snap.axes.arousal - 0.15) < 0.02);
});

test('亲近度不参与混合：亲密度高不代表此刻不生气', () => {
  const only = withMood({ anger: 0.6 });
  const withBond = withMood({ anger: 0.6, bond: 0.9 });
  assert.equal(withBond.axes.arousal, only.axes.arousal);
  assert.equal(withBond.axes.dominance, only.axes.dominance);
});

test('自定义情绪没写 pad 也不炸', () => {
  const custom = {
    ...P,
    emotions: { ...P.emotions, weird: { halfLife: 3, polarity: -1, drives: ['tone'], label: '怪' } },
  };
  const base = createState(custom, T0);
  const state = { ...base, emotions: { ...base.emotions, weird: { value: 0.8, at: T0 } } };
  const snap = resolve(state, custom, T0);
  assert.equal(snap.axes.arousal, 0);
  assert.equal(snap.axes.dominance, 0);
});

test('情绪卡把形态写进正文，位置在语气模板前面', () => {
  const snap = withMood({ anger: 0.7 });
  const text = render(snap, P);
  assert.match(text, /在生气/);
  assert.match(text, /绷着/);
  assert.ok(text.indexOf('绷着') < text.indexOf('极短'), '先说形态，再说怎么说话');
  assert.ok(!text.includes('0.7'), '不把数字丢给模型');
});

test('摘要里带形态，托盘上能一眼看出是炸还是蔫', () => {
  assert.match(summarize(withMood({ anger: 0.7 }), P), /绷着/);
  assert.match(summarize(withMood({ upset: 0.5 }), P), /蔫着/);
  assert.doesNotMatch(summarize(resolve(createState(P, T0), P, T0), P), /绷着|蔫着/);
});

test('形态词能靠 profile 换掉', () => {
  const custom = { ...P, cue: { ...P.cue, shapes: { hot: '炸毛' } } };
  const words = shapesOf(withMood({ anger: 0.7 }), custom);
  assert.deepEqual(words.includes('炸毛'), true);
});

test('晾一整天那种最常见的委屈，要能显出蔫', () => {
  // 实跑账本：没人理一整天，委屈稳定在 0.44 左右。这个强度必须出形态词，
  // 不然「不痛快」这一整段都只剩同一句提示词，等于白加两条轴。
  const snap = withMood({ upset: 0.44 });
  const words = shapesOf(snap, P);
  assert.ok(words.includes('蔫着'), '憋了一整天该是蔫的');
  assert.ok(words.includes('气势低'));
});

test('刚有一点不满的时候不硬套形态词', () => {
  const snap = withMood({ upset: 0.2, joy: 0.1 });
  assert.deepEqual(shapesOf(snap, P), [], '轻微波动别硬说成蔫');
});

test('冷落久了先蔫，攒到一定程度才绷', () => {
  // 三小时没人理：有点委屈，还是蔫的
  const t1 = T0 + min(180);
  const s1 = ingest(createState(P, T0), fromIdle(180, t1, 1), P, t1);
  assert.ok(resolve(s1, P, t1).axes.arousal < 0, '轻度不满是低落的');

  // 攒到冷战期，气出来了，激活度翻正
  const t2 = T0 + min(300);
  const s2 = ingest(createState(P, T0), fromIdle(900, t2, 14), P, t2);
  const snap = resolve(s2, P, t2);
  assert.equal(snap.tier, 'cold');
  assert.ok(snap.axes.dominance < 0, '冷战是被晾着，气势低');
});
