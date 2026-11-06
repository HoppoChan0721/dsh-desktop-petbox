// 主动开口（urge）的自检。零依赖，用 node 内置 test runner：
//
//   node --test
//
// 钉死的几条约定：
//   · 平静的时候她自己不会开口（不然就是骚扰）
//   · 不痛快够久会先软后硬，戳两次没人理才换硬的
//   · 冷战也在开口，只是很少很冷 —— 真不出声，主人反而感觉不到她在生气
//   · 全局间隔、每日上限、静默时段三个闸门都能兜住
//   · 投递没成功不该扣掉她一次机会

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createState, ingest, resolve } from '../lib/mood/engine.js';
import { DEFAULT_PROFILE } from '../lib/mood/profile.js';
import { fromIdle, fromTouch } from '../lib/mood/signals.js';
import { decide, mark, inQuietHours, summarizeUrge } from '../lib/mood/urge.js';
import { createMood } from '../lib/mood/index.js';

const P = DEFAULT_PROFILE;
const T0 = new Date(2026, 10, 6, 14, 0, 0).getTime();   // 下午两点，避开静默时段
const min = (n) => n * 60000;
const hour = (n) => n * 3600000;

/** 在 at 时刻造一份刚好是这个档位的账本。createdAt 留在 T0，好让「多久没人理」有得算。 */
function moodAt(level, at = T0, created = T0) {
  const s = createState(P, created);
  if (level === 'upset') return ingest(s, fromIdle(600, at, 6), P, at);     // ≈0.30 sulky
  if (level === 'cold') return ingest(s, fromIdle(900, at, 14), P, at);     // ≈0.70 cold
  return s;
}

/** 造完就当场判断，别让衰减把档位偷偷改掉。 */
function judge(s, t) {
  return decide(resolve(s, P, t), s, P, t);
}

test('平静时她自己不开口', () => {
  const s = createState(P, T0);
  const d = judge(s, T0 + hour(5));
  assert.equal(d.speak, false);
  assert.equal(d.why, 'none');
});

test('不痛快够久会自己开口，理由是试探', () => {
  const t = T0 + min(50);
  const d = judge(moodAt('upset', t), t);
  assert.equal(d.speak, true);
  assert.equal(d.window, 'sulky-nudge');
  assert.equal(d.tier, 'sulky');
  assert.ok(d.idleMin >= 45);
  assert.ok(d.hint.includes('不痛快'), '要带上为什么开口，不然模型不知道该用什么口气');
});

test('刚冷落几分钟还不到时候', () => {
  const t = T0 + min(10);
  const d = judge(moodAt('upset', t), t);
  assert.equal(d.speak, false, '十分钟就开口是撒娇，不是不高兴');
});

test('开口过一次之后要等够间隔', () => {
  const t = T0 + min(50);
  let s = moodAt('upset', t);
  s = mark(s, 'sulky-nudge', t);

  const early = judge(s, t + min(20));
  assert.equal(early.speak, false);
  assert.equal(early.why, 'gap');

  const later = judge(s, t + min(70));
  assert.equal(later.speak, true, '隔了一个小时该可以再戳一次');
});

test('软的不吃两次才换硬的', () => {
  const t = T0 + min(160);
  let s = moodAt('upset', t);
  assert.equal(judge(s, t).window, 'sulky-nudge', '第一次肯定是轻的');

  // 戳满两次（这个档位每天就两次），再判断就该换硬的了
  s = mark(mark(s, 'sulky-nudge', t - min(130)), 'sulky-nudge', t - min(70));
  const d = judge(s, t);
  assert.equal(d.speak, true);
  assert.equal(d.window, 'sulky-sharp', '戳过两次没人理，语气要硬');
  assert.equal(d.attempt, 2);
});

test('冷战期还在开口，只是很少', () => {
  const t = T0 + min(200);
  const d = judge(moodAt('cold', t), t);
  assert.equal(d.speak, true);
  assert.equal(d.window, 'cold-drift');
  assert.ok(d.hint.includes('冷'), '冷战要说短话，不是不说话');
});

test('全天次数有上限，几档加起来也不许刷屏', () => {
  const t = T0 + hour(4);
  let s = moodAt('cold', t);
  for (let i = 0; i < 6; i++) s = mark(s, 'fake-' + i, t - hour(3) - min(i * 5));
  const d = judge(s, t);
  assert.equal(d.speak, false);
  assert.equal(d.why, 'day-cap');
});

test('静默时段只记账不开口', () => {
  const night = new Date(2026, 10, 7, 3, 0, 0).getTime();
  const d = judge(moodAt('cold', night, night - hour(4)), night);
  assert.equal(d.speak, false);
  assert.equal(d.why, 'quiet');
});

test('静默时段判定，跨零点也要对', () => {
  assert.equal(inQuietHours(3, 0, 8), true);
  assert.equal(inQuietHours(9, 0, 8), false);
  assert.equal(inQuietHours(23, 22, 7), true);
  assert.equal(inQuietHours(6, 22, 7), true);
  assert.equal(inQuietHours(12, 22, 7), false);
  assert.equal(inQuietHours(3, 5, 5), false, '起止相同视为没有静默时段');
});

test('心情好也会主动说话', () => {
  const t = T0 + min(30);
  const s = ingest(createState(P, T0), fromTouch({ zone: 'head' }), P, T0);
  // 摸一下只涨 0.04，够不到 0.55；直接改账本把开心推上去，测的是 urge 不是记账
  const happy = { ...s, emotions: { ...s.emotions, joy: { value: 0.7, at: t } } };
  const d = judge(happy, t);
  assert.equal(d.speak, true);
  assert.equal(d.window, 'joy-share');
});

test('一次都没碰过时不会立刻就抱怨', () => {
  const s = createState(P, T0);          // lastInteractionAt 还是 0
  const d = judge(s, T0 + min(5));
  assert.equal(resolve(s, P, T0 + min(5)).idleMinutes, null, '没互动过就没有空闲时长');
  assert.equal(d.speak, false);
  assert.equal(d.idleMin, 5, '应该拿 createdAt 兜底');
});

test('老状态文件里没有 urges 也不炸', () => {
  const legacy = { ...createState(P, T0), urges: undefined };
  const d = judge(legacy, T0 + min(50));
  assert.equal(d.speak, false, '平静时本来就不该开口');
});

test('mark 只加不改，也留得下最近二十次', () => {
  let s = createState(P, T0);
  for (let i = 0; i < 25; i++) s = mark(s, 'w', T0 + i);
  assert.equal(s.urges.w.length, 20);
  assert.equal(s.urges.w[19], T0 + 24);
  assert.equal(createState(P, T0).urges.w, undefined, '不改入参');
});

test('profile 里关掉 urge 就彻底不开口', () => {
  const off = { ...P, urge: { ...P.urge, enabled: false } };
  const t = T0 + min(300);
  const s = moodAt('cold', t);
  const d = decide(resolve(s, off, t), s, off, t);
  assert.equal(d.speak, false);
  assert.equal(d.why, 'off');
});

test('外置配置能改参数，也能加一档新理由', () => {
  const custom = {
    ...P,
    urge: {
      ...P.urge,
      windows: [
        { id: 'only-mine', requires: { path: 'tier', eq: 'calm' }, minIdleMin: 0, gapMs: 1000, maxPerDay: 9, hint: 'x' },
      ],
    },
  };
  const t = T0 + min(1);
  const s = createState(P, T0);
  const d = decide(resolve(s, custom, t), s, custom, t);
  assert.equal(d.speak, true);
  assert.equal(d.window, 'only-mine');
});

test('门面：urge 可读、markUrge 会落账、摘要不漏提示词', () => {
  const m = createMood({ file: '', now: () => T0 });
  m.touch({ zone: 'head' }, T0);
  const d = m.urge(T0 + min(1));
  assert.equal(typeof d.speak, 'boolean');

  m.markUrge('sulky-nudge', T0 + min(2));
  const st = m.state(T0 + min(3));
  assert.equal(st.urge.windows['sulky-nudge'].total, 1);
  assert.equal(st.urge.enabled, true);
  assert.ok(!('hint' in st.urge.windows['sulky-nudge']), '摘要不该把提示词漏给前端');
  assert.ok(!JSON.stringify(st.urge).includes('不痛快'));
});

test('摘要按二十四小时窗口数次数', () => {
  let s = createState(P, T0);
  s = mark(s, 'cold-drift', T0 - hour(30));   // 昨天
  s = mark(s, 'cold-drift', T0 - hour(2));    // 今天
  const u = summarizeUrge(s, P, T0);
  assert.equal(u.windows['cold-drift'].total, 2);
  assert.equal(u.windows['cold-drift'].today, 1);
  assert.equal(u.today, 1);
});
