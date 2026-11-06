// 主动开口（urge）的自检。零依赖，用 node 内置 test runner：
//
//   node --test
//
// 钉死的几条约定：
//   · 平静的时候她自己不会开口（不然就是骚扰）
//   · 开口是「一阵」，不是一句。一句话说完还有下一句，越说越硬
//   · 主人一回应，这一阵立刻散场，剩下的不补
//   · 浓度是个旋钮，情绪在后面再加一次权
//   · 全局间隔、每日上限、静默时段三个闸门都能兜住
//   · 投递没成功不该扣掉她一次机会

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createState, ingest, resolve } from '../lib/mood/engine.js';
import { DEFAULT_PROFILE } from '../lib/mood/profile.js';
import { fromIdle } from '../lib/mood/signals.js';
import { decide, mark, interrupt, inQuietHours, summarizeUrge, stepsOf } from '../lib/mood/urge.js';
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
function judge(s, t, profile = P) {
  return decide(resolve(s, profile, t), s, profile, t);
}

/** 说一句就把这一笔记进账本，返回新账本。 */
function say(s, t, profile = P) {
  const d = judge(s, t, profile);
  return { d, s: d.speak ? mark(s, d, t) : s };
}

test('平静时她自己不开口', () => {
  const d = judge(createState(P, T0), T0 + hour(5));
  assert.equal(d.speak, false);
  assert.equal(d.why, 'none');
});

test('不痛快够久会自己开口，而且是两句话一阵', () => {
  const t = T0 + min(50);
  const d = judge(moodAt('upset', t), t);
  assert.equal(d.speak, true);
  assert.equal(d.window, 'sulky-nudge');
  assert.equal(d.tier, 'sulky');
  assert.equal(d.step, 0);
  assert.equal(d.steps, 2, '第一档就该是两句，不是一句');
  assert.ok(d.nextStepAt > t, '说完这句要排下一句');
  assert.ok(d.hint.includes('不痛快'), '要带上为什么开口，不然模型不知道该用什么口气');
  assert.ok(d.idleMin >= 45);
});

test('一阵里的第二句要等够 afterMs，不能连珠炮', () => {
  const t = T0 + min(50);
  const first = say(moodAt('upset', t), t);
  assert.equal(first.s.burst.window, 'sulky-nudge');
  assert.equal(first.s.burst.step, 1);

  const early = judge(first.s, t + 1000);
  assert.equal(early.speak, false);
  assert.equal(early.why, 'burst-wait');
  assert.ok(early.nextInMs > 0);

  const onTime = judge(first.s, first.d.nextStepAt);
  assert.equal(onTime.speak, true);
  assert.equal(onTime.why, 'burst');
  assert.equal(onTime.step, 1);
  assert.equal(onTime.hint, P.urge.windows[0].burst.steps[1].hint, '第二句要用第二句的说法');
  assert.equal(onTime.nextStepAt, 0, '最后一句后面没有下一句');
});

test('一阵说完就散，两阵之间要等 gapMs', () => {
  const t = T0 + min(50);
  const a = say(moodAt('upset', t), t);
  const b = say(a.s, a.d.nextStepAt);
  assert.equal(b.s.burst, null, '两句说完这一阵就结束');

  const early = judge(b.s, a.d.nextStepAt + min(30));
  assert.equal(early.speak, false, '刚说完一阵不该马上又来');

  // 三小时后还没人理：委屈照旧在攒（桥每半小时会补记一次），这时候该再来一阵
  const later = a.d.nextStepAt + hour(3);
  const hot = ingest(b.s, fromIdle(180, later, 3), P, later);
  assert.equal(judge(hot, later).speak, true);
});

test('主人一回应，这一阵立刻散场', () => {
  const t = T0 + min(50);
  const a = say(moodAt('upset', t), t);
  assert.ok(a.s.burst, '先说了一句，正等着接着说第二句');
  const stopped = interrupt(a.s);
  assert.equal(stopped.burst, null);
  const next = judge(stopped, a.d.nextStepAt);
  assert.notEqual(next.why, 'burst-wait', '被打断之后不该接着往下怼');
});

test('软的不吃就来硬的，最后一句是哭', () => {
  const t = T0 + min(160);
  let s = moodAt('upset', t);
  s = mark(s, { window: 'sulky-nudge' }, t - min(130));
  s = mark(s, { window: 'sulky-nudge' }, t - min(70));

  const d = judge(s, t);
  assert.equal(d.speak, true);
  assert.equal(d.window, 'sulky-sharp', '戳过两句没人理，语气要硬');
  assert.equal(d.steps, 3);

  const steps = stepsOf(P.urge.windows[1]);
  assert.ok(steps[2].hint.includes('哭'), '最后一句不是继续凶，是委屈');
});

test('冷战期还在开口，只是很少很冷', () => {
  const t = T0 + min(200);
  const d = judge(moodAt('cold', t), t);
  assert.equal(d.speak, true);
  assert.equal(d.window, 'cold-drift');
  assert.equal(d.steps, 2);
  assert.ok(d.hint.includes('冷'), '冷战要说短话，不是不说话');
});

test('心情好会连着说两句，不是等定时器蹦一句', () => {
  const t = T0 + min(30);
  const base = createState(P, T0);
  const happy = { ...base, emotions: { ...base.emotions, joy: { value: 0.7, at: t } } };
  const d = judge(happy, t);
  assert.equal(d.speak, true);
  assert.equal(d.window, 'joy-share');
  assert.equal(d.steps, 2);
});

test('全天句数有上限，几档加起来也不许刷屏', () => {
  const t = T0 + hour(4);
  let s = moodAt('cold', t);
  for (let i = 0; i < 8; i++) s = mark(s, { window: 'fake-' + i }, t - hour(3) - min(i * 5));
  const d = judge(s, t);
  assert.equal(d.speak, false);
  assert.equal(d.why, 'day-cap');
});

test('浓度旋钮：chatty 比 normal 说得更密', () => {
  const t = T0 + min(50);
  const s = moodAt('upset', t);
  const normal = judge(s, t);
  const chatty = judge(s, t, { ...P, urge: { ...P.urge, intensity: 'chatty' } });
  const quiet = judge(s, t, { ...P, urge: { ...P.urge, intensity: 'quiet' } });

  assert.equal(normal.preset, 'normal');
  assert.equal(chatty.preset, 'chatty');
  assert.ok(chatty.nextStepAt - t < normal.nextStepAt - t, 'chatty 第二句来得更快');
  assert.ok(quiet.nextStepAt - t > normal.nextStepAt - t, 'quiet 更慢');
});

test('情绪自己再加一次权：越开心越急', () => {
  const t = T0 + min(30);
  const base = createState(P, T0);
  const mild = { ...base, emotions: { ...base.emotions, joy: { value: 0.6, at: t } } };
  const very = { ...base, emotions: { ...base.emotions, joy: { value: 0.85, at: t } } };

  const a = judge(mild, t);
  const b = judge(very, t);
  assert.equal(a.window, 'joy-share');
  assert.equal(b.window, 'joy-share');
  assert.ok(b.heat < a.heat, '开心到一定程度节奏要变急');
  assert.ok(b.nextStepAt - t < a.nextStepAt - t, '第二句来得更快');
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

test('一次都没碰过时不会立刻就抱怨', () => {
  const s = createState(P, T0);          // lastInteractionAt 还是 0
  const d = judge(s, T0 + min(5));
  assert.equal(resolve(s, P, T0 + min(5)).idleMinutes, null, '没互动过就没有空闲时长');
  assert.equal(d.speak, false);
  assert.equal(d.idleMin, 5, '应该拿 createdAt 兜底');
});

test('老状态文件里没有 urges / burst 也不炸', () => {
  const legacy = { ...createState(P, T0), urges: undefined, burst: undefined };
  const d = judge(legacy, T0 + min(50));
  assert.equal(d.speak, false, '平静时本来就不该开口');
  assert.equal(interrupt(legacy), legacy, '没有一阵的时候打断是空操作');
});

test('静默时段是一点到七点，七点一过就能把昨晚的话说了', () => {
  // 这条是实跑一夜之后改的：原来 0~8，一整夜的委屈憋到八点才开口，
  // 那时人刚睁眼，说出来像隔天翻旧账。
  const morning = new Date(2026, 10, 7, 7, 10, 0).getTime();
  const d = judge(moodAt('upset', morning, morning - hour(7)), morning);
  assert.equal(d.speak, true, '七点之后该开口了');
  assert.equal(d.why, 'speak');

  const dawn = new Date(2026, 10, 7, 6, 50, 0).getTime();
  const early = judge(moodAt('upset', dawn, dawn - hour(7)), dawn);
  assert.equal(early.speak, false);
  assert.equal(early.why, 'quiet', '六点多还是静默');

  const lateNight = new Date(2026, 10, 7, 1, 30, 0).getTime();
  assert.equal(judge(moodAt('upset', lateNight, lateNight - hour(7)), lateNight).why, 'quiet', '一点半别吵');
  // 0 点到 1 点是放行的：那会儿主人多半还醒着，跟窥屏的静默起点 1 点对齐
  const midnight = new Date(2026, 10, 7, 0, 30, 0).getTime();
  assert.equal(judge(moodAt('upset', midnight, midnight - hour(7)), midnight).speak, true);
});

test('mark 只加不改，也留得下最近四十句', () => {
  let s = createState(P, T0);
  for (let i = 0; i < 45; i++) s = mark(s, { window: 'w' }, T0 + i);
  assert.equal(s.urges.w.length, 40);
  assert.equal(s.urges.w[39], T0 + 44);
  assert.equal(createState(P, T0).urges.w, undefined, '不改入参');
});

test('profile 里关掉 urge 就彻底不开口', () => {
  const off = { ...P, urge: { ...P.urge, enabled: false } };
  const t = T0 + min(300);
  const s = moodAt('cold', t);
  const d = judge(s, t, off);
  assert.equal(d.speak, false);
  assert.equal(d.why, 'off');
});

test('外置配置能改参数，也能加一档新理由', () => {
  const custom = {
    ...P,
    urge: {
      ...P.urge,
      windows: [
        {
          id: 'only-mine',
          requires: { path: 'tier', eq: 'calm' },
          minIdleMin: 0, gapMs: 1000, maxPerDay: 9,
          burst: { steps: [{ hint: 'x' }, { hint: 'y', afterMs: 60000 }] },
        },
      ],
    },
  };
  const t = T0 + min(1);
  const s = createState(P, T0);
  const d = judge(s, t, custom);
  assert.equal(d.speak, true);
  assert.equal(d.window, 'only-mine');
  assert.equal(d.steps, 2);
});

test('门面：urge 可读、markUrge 会落账、摘要不漏提示词', () => {
  const m = createMood({ file: '', now: () => T0 });
  m.touch({ zone: 'head' }, T0);
  const d = m.urge(T0 + min(1));
  assert.equal(typeof d.speak, 'boolean');

  m.markUrge({ window: 'sulky-nudge', step: 0, nextStepAt: T0 + min(10) }, T0 + min(2));
  const st = m.state(T0 + min(3));
  assert.equal(st.urge.windows['sulky-nudge'].total, 1);
  assert.equal(st.urge.enabled, true);
  assert.equal(st.urge.burst.window, 'sulky-nudge', '一阵没说完，状态里要看得出来');

  // 一摸就散场
  m.touch({ zone: 'head' }, T0 + min(4));
  assert.equal(m.state(T0 + min(5)).urge.burst, null);

  assert.ok(!('hint' in st.urge.windows['sulky-nudge']), '摘要不该把提示词漏给前端');
  assert.ok(!JSON.stringify(st.urge).includes('不痛快'));
});

test('门面：浓度能靠配置盖掉', () => {
  const m = createMood({ file: '', urgeIntensity: 'clingy', now: () => T0 });
  assert.equal(m.state(T0).urge.intensity, 'clingy');

  const bad = createMood({ file: '', urgeIntensity: 'nope', now: () => T0 });
  assert.equal(bad.state(T0).urge.intensity, 'normal', '写错了就退回默认，别把桥搞崩');
});

test('摘要按二十四小时窗口数次数', () => {
  let s = createState(P, T0);
  s = mark(s, { window: 'cold-drift' }, T0 - hour(30));   // 昨天
  s = mark(s, { window: 'cold-drift' }, T0 - hour(2));    // 今天
  const u = summarizeUrge(s, P, T0);
  assert.equal(u.windows['cold-drift'].total, 2);
  assert.equal(u.windows['cold-drift'].today, 1);
  assert.equal(u.today, 1);
  assert.equal(u.intensity, 'normal');
});
