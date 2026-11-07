// urge.js —— 「她自己想开口」的冲动层。纯函数，不碰文件、不读时钟、不发网络。
//
// 跟 peek 的分工，一句话：
//   peek 看屏幕，决定「说什么」
//   urge 看情绪，决定「现在该不该开口」
// 两者互相不认识，都只是调桥里的 deliver()。所以哪一条坏了，另一条照常跑。
//
// ── 为什么不是「一句话 + 一个间隔」────────────────────────────────────────
// 只发一句话，频率就变成一个平均数：每四十分钟一句，雨露均沾地烦人。
// 真人不是平均数。真生气会连着怼三句，越说越硬，最后不说话了；
// 真开心会连发两条，然后半天不吭声。所以这一层调的是**集中度**：
//
//   一阵 burst = 一串按 afterMs 排好的话，越长越冲（或越说越软）
//   一阵说完不一定结束，隔一阵如果还没人理还会再来一阵
//   情绪越高，间隔越短、桥段越密 —— 不是「更频繁」，是「更集中」
//
// ── window 字段 ─────────────────────────────────────────────────────────
//   id          唯一名字，也是记账的 key。改名等于从头算
//   requires    什么时候算数，走 engine 的条件 DSL（path 支持 tier / mood.* / signal.*）
//   minIdleMin  至少多久没人理才允许开口。防止她一直黏着说话
//   gapMs       两阵之间最少隔多久（从上一阵最后一句算起）
//   maxPerDay   这个 window 24 小时内最多说几句
//   after       { window, times } 先说满多少句才轮到这一档，用来做「先软后硬」的升级
//   burst.steps 这一阵要说的话。steps[0] 立刻说，后面的等上一步的 afterMs
//               { hint, afterMs }  hint 给模型看，说清「你为什么要开口、这一句是什么口气」
//   hint        只有一句时的简写，等价于 burst.steps: [{ hint }]
//   note        日志和 /mood 里给人看的短说明
//
// 顺序即优先级：从上往下第一条满足的就用，后面的不再看。
// 所以负面档位要排在正面前面——同时又想发火又想分享时，先发火。
//
// ── 三个旋钮 ────────────────────────────────────────────────────────────
//   intensity  一个名字换整体浓度（quiet / normal / clingy / chatty）。
//              主攻陪伴的人设成 clingy 就够，不用逐档改参数
//   heat       情绪本身再乘一次：越气越密，越开心越急
//   maxPerDay  兜底，几档一起闹也吵不死人

import { evalCond } from './engine.js';

const DAY_MS = 24 * 3600 * 1000;
const KEEP = 40;              // 每个 window 只留最近 40 句，够算 24 小时上限

/** 现在落在静默时段里吗。from === to 视为没有静默时段。 */
export function inQuietHours(hour, from, to) {
  const f = Number(from);
  const t = Number(to);
  if (!Number.isFinite(f) || !Number.isFinite(t) || f === t) return false;
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  return f < t ? h >= f && h < t : h >= f || h < t;
}

/** 某个 window 最近的开口时间戳数组。老状态文件里没有 urges 也照样能用。 */
function marksOf(state, id) {
  const all = (state && state.urges) || {};
  const list = all[id];
  return Array.isArray(list) ? list.filter((t) => Number.isFinite(Number(t))) : [];
}

/**
 * 把「此刻」列表转成能写条件的对象：{ 'game-over': { tag, why, n, at } }。
 * 条件里写 `{ path: 'moment.game-over' }` 就是「这条余温还在」。
 *
 * 为什么不直接把数组塞进条件：数组查起来要写谓词，配置里没法表达。
 * 转成对象之后，加一档新理由还是只改 profile。
 */
export function momentView(list) {
  const out = {};
  for (const m of Array.isArray(list) ? list : []) {
    if (m && m.id) out[m.id] = m;
  }
  return out;
}

/** 所有 window 里最近的一次开口。用来做全局最小间隔。 */
function lastUrgeAt(state) {
  let last = 0;
  for (const list of Object.values((state && state.urges) || {})) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      const n = Number(t);
      if (Number.isFinite(n) && n > last) last = n;
    }
  }
  return last;
}

/** 24 小时内开口的总次数：全局上限，防止几档轮流把主人吵死。 */
function countSince(state, since, id) {
  let n = 0;
  const ids = id ? [id] : Object.keys((state && state.urges) || {});
  for (const key of ids) {
    for (const t of marksOf(state, key)) if (Number(t) >= since) n++;
  }
  return n;
}

/** 取一档 window。决定和记账两边都要用它，别各写一份。 */
export function windowOf(profile, id) {
  const list = (profile && profile.urge && profile.urge.windows) || [];
  return list.find((w) => w && w.id === id) || null;
}

/** 这一阵要说几句话。`hint` 是「只有一句」的简写。 */
export function stepsOf(w) {
  if (!w) return [];
  const steps = w.burst && Array.isArray(w.burst.steps) ? w.burst.steps.filter((s) => s && s.hint) : [];
  if (steps.length) return steps;
  return w.hint ? [{ hint: w.hint }] : [];
}

/** 浓度 + 情绪热度，算出这一轮的两个倍数。 */
function scalesOf(profile, snapshot, bag) {
  const cfg = (profile && profile.urge) || {};
  const presets = cfg.presets || {};
  const preset = presets[cfg.intensity] || presets.normal || {};

  // 情绪自己再乘一次：气到一个程度就不是「偶尔想起你」，是「非说不可」。
  // 表在 profile.urge.heat 里，第一条命中的生效，纯数据，加规则不用改代码。
  let heat = 1;
  for (const h of cfg.heat || []) {
    if (!h || !Number.isFinite(Number(h.scale))) continue;
    if (evalCond(h.when, bag, profile)) { heat = Number(h.scale); break; }
  }

  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    preset: cfg.intensity || 'normal',
    heat,
    gapScale: num(preset.gapScale, 1) * heat,     // 两阵之间隔多久
    stepScale: num(preset.stepScale, 1) * heat,   // 一阵里面每句隔多久
    dayCap: Math.max(1, Math.round(num(preset.dayCap, num(cfg.maxPerDay, 8)))),
  };
}

/** ±15% 抖动：别像闹钟，也别让这句话在第 180 秒整准时出现。 */
function jitter(ms) {
  const n = Math.max(1000, Number(ms) || 0);
  return Math.round(n * (0.85 + Math.random() * 0.3));
}

/**
 * 决定现在要不要开口。
 *
 * 三种结果：
 *   speak     现在就说，`hint` 是这一句的口气，`nextStepAt` 是下一句的时间
 *   burst-wait  一阵还没说完，但还没到下一句的时间
 *   其它      这次不开口，`why` 说明原因
 *
 * @param {object} snapshot  engine.resolve 的结果
 * @param {object} state     账本，只用 urges / burst / createdAt
 * @param {object} profile   情绪表，读 profile.urge
 * @param {number} now
 */
export function decide(snapshot, state, profile, now = Date.now()) {
  const cfg = (profile && profile.urge) || {};
  const tier = (snapshot && snapshot.tier) || 'calm';
  const windows = Array.isArray(cfg.windows) ? cfg.windows : [];

  const created = Number(state && state.createdAt) || 0;
  const idleMin = (snapshot && Number.isFinite(snapshot.idleMinutes))
    ? snapshot.idleMinutes
    : (created ? Math.floor((now - created) / 60000) : 0);

  const base = { speak: false, why: 'none', tier, idleMin, attempt: 0 };
  if (cfg.enabled === false || !windows.length) return { ...base, why: 'off' };

  const hour = new Date(now).getHours();
  if (inQuietHours(hour, cfg.quietFrom, cfg.quietTo)) return { ...base, why: 'quiet' };

  const bag = {
    mood: (snapshot && snapshot.values) || {},
    tier,
    // 「此刻」也进条件：刚打完一局这种，只有 moment 知道，账本是空的
    moment: momentView(snapshot && snapshot.moments),
    signal: { kind: 'urge', idleMinutes: idleMin, hour, at: now },
  };
  const sc = scalesOf(profile, snapshot, bag);

  // ── 一、正在一阵里：接着往下说 ─────────────────────────────────────────
  // 先看这一阵还算不算数。情绪掉回平静、或者窗口条件不成立了，这一阵就作废，
  // 剩下的几句不再补 —— 已经被哄好了还硬要说第三句，那不是脾气，那是机器人。
  const b = state && state.burst;
  if (b && b.window) {
    const w = windowOf(profile, b.window);
    const steps = stepsOf(w);
    const alive = w && steps.length && evalCond(w.requires, bag, profile);
    if (alive) {
      if (now < Number(b.nextAt || 0)) {
        return {
          speak: false, why: 'burst-wait', tier, idleMin, attempt: 0,
          window: w.id, step: Number(b.step) || 0, steps: steps.length,
          nextInMs: Math.max(0, Number(b.nextAt) - now),
        };
      }
      const step = Math.min(Number(b.step) || 0, steps.length - 1);
      return speakPlan({
        w, steps, step, sc, snapshot, state, now, idleMin, why: 'burst',
      });
    }
    // 作废：不在这里写状态（决定是纯读），下一次记账时会顶掉
  }

  // ── 二、没在一阵里：找一档该开口了 ──────────────────────────────────
  if (countSince(state, now - DAY_MS) >= sc.dayCap) return { ...base, why: 'day-cap' };

  const minGap = Math.max(0, Number(cfg.minGapMs) || 0);
  const last = lastUrgeAt(state);
  // 全局最小间隔不在这里提前 return：带 gapExempt 的窗口要能突破它。
  // 「刚打完一局」这种是事件驱动的一次性反应，等二十五分钟就错过时机了。
  const gapOk = !last || now - last >= minGap;

  for (const w of windows) {
    if (!w || !w.id) continue;
    const steps = stepsOf(w);
    if (!steps.length) continue;
    if (!gapOk && !w.gapExempt) continue;
    if (w.requires && !evalCond(w.requires, bag, profile)) continue;
    if (idleMin < (Number(w.minIdleMin) || 0)) continue;

    if (w.after && w.after.window) {
      const done = countSince(state, 0, w.after.window);
      if (done < (Number(w.after.times) || 1)) continue;
    }

    const marks = marksOf(state, w.id);
    const mine = marks.length ? Math.max(...marks) : 0;
    const gap = (Number(w.gapMs) || 0) * sc.gapScale;
    if (mine && now - mine < gap) continue;
    if (countSince(state, now - DAY_MS, w.id) >= (Number(w.maxPerDay) || Infinity)) continue;

    return speakPlan({ w, steps, step: 0, sc, snapshot, state, now, idleMin, why: 'speak' });
  }

  return gapOk ? base : { ...base, why: 'gap' };
}

/** 拼一份「现在说这句」的结果。decide 的两条路都走这里，免得对不上。 */
function speakPlan({ w, steps, step, sc, snapshot, state, now, idleMin = 0, why }) {
  const cur = steps[step] || steps[0];
  const nextStep = steps[step + 1];
  // 窗口点名了某条此刻，就把那条的理由带上。她说话时能引用「你打了四十分钟游戏」，
  // 靠的就是这个 detail，不是让模型自己猜。
  let detail = '';
  if (w.momentId) {
    const list = (snapshot && Array.isArray(snapshot.moments)) ? snapshot.moments : [];
    const m = list.find((x) => x && x.id === w.momentId);
    if (m && m.why) detail = m.why;
  }
  return {
    speak: true,
    why,
    window: w.id,
    note: w.note || w.id,
    hint: cur.hint || w.hint || '',
    detail,
    tier: (snapshot && snapshot.tier) || 'calm',
    idleMin,
    step,
    steps: steps.length,
    // 下一句什么时候说。一阵最后一句就没有下一句
    nextStepAt: nextStep ? now + jitter((Number(nextStep.afterMs) || 0) * sc.stepScale) : 0,
    attempt: countSince(state, now - DAY_MS),
    preset: sc.preset,
    heat: sc.heat,
  };
}

/**
 * 记一次开口。返回新账本，不改入参。
 *
 * 决定是纯读，记账是显式写入：桥在真正投递成功之后才调这里。
 * 投递炸了就当没说过，下一轮还能重来 —— 她的脾气比一次网络超时重要得多。
 */
export function mark(state, d, now = Date.now()) {
  if (!d || !d.window) return state;
  const all = { ...((state && state.urges) || {}) };
  const list = marksOf(state, d.window);
  all[d.window] = [...list, now].slice(-KEEP);

  const next = Number(d.nextStepAt) || 0;
  const burst = next
    ? { window: d.window, step: (Number(d.step) || 0) + 1, nextAt: next }
    : null;
  return { ...state, urges: all, burst };
}

/** 被打断了就散场。主人来摸她或者跟她说话，一阵话不该继续往下怼。 */
export function interrupt(state) {
  if (!state || !state.burst) return state;
  return { ...state, burst: null };
}

/** 给 /mood 和托盘看的摘要：每一档今天说了几句、这一阵说到第几句。不含 hint。 */
export function summarizeUrge(state, profile, now = Date.now()) {
  const cfg = (profile && profile.urge) || {};
  const presets = cfg.presets || {};
  const preset = presets[cfg.intensity] || presets.normal || {};
  const windows = {};
  for (const w of cfg.windows || []) {
    if (!w || !w.id) continue;
    const marks = marksOf(state, w.id);
    windows[w.id] = {
      total: marks.length,
      today: marks.filter((t) => Number(t) >= now - DAY_MS).length,
      lastAt: marks.length ? new Date(Math.max(...marks)).toISOString() : '',
      steps: stepsOf(w).length,
    };
  }
  const b = state && state.burst;
  return {
    enabled: cfg.enabled !== false,
    intensity: cfg.intensity || 'normal',
    dayCap: Number(preset.dayCap) || Number(cfg.maxPerDay) || null,
    quietFrom: cfg.quietFrom ?? null,
    quietTo: cfg.quietTo ?? null,
    maxPerDay: Number(preset.dayCap) || Number(cfg.maxPerDay) || null,
    today: countSince(state, now - DAY_MS),
    burst: b && b.window
      ? { window: b.window, step: Number(b.step) || 0, nextInSec: Math.max(0, Math.round((Number(b.nextAt) - now) / 1000)) }
      : null,
    windows,
  };
}

export default { decide, mark, interrupt, inQuietHours, summarizeUrge, stepsOf, windowOf };
