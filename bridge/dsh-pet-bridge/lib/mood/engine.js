// 情绪引擎 —— 纯函数，不碰文件、不读时钟、不发网络。
//
// 四个导出就是全部对外契约：
//   createState(profile, now)                     造一份空账本
//   ingest(state, signal, profile, now)           记一笔，返回新账本
//   tick(state, profile, now)                     只结算衰减，返回新账本
//   resolve(state, profile, now)                  结算成只读快照，消费方只认这个
//   gate(snapshot, profile, name)                 问「现在能不能做某事」
//
// 时间永远由调用方传进来，随机数也不需要 —— 这样它能在任何环境里跑，也能被测。
// state 是普通 JSON，可以直接落盘、直接 diff、直接在日志里看。
//
// ── 状态形状 ─────────────────────────────────────────────────────────────
//   {
//     schemaVersion: 1,
//     emotions: { joy: { value: 0.3, at: 1730000000000 }, ... },
//     tier: 'calm',                       上一次结算出的档位，用来做回差
//     cooldowns: { 'ruleId:key': at },
//     log: [ { at, emotion, delta, reason } ],   最近若干条，渲染情绪卡用
//     lastInteractionAt, lastSignalAt,
//     createdAt,                                  建账本的时间
//     urges: { [windowId]: [at, ...] }            主动开口过的时刻，给 urge 算间隔和上限
//   }

import { SCHEMA_VERSION } from './profile.js';

const CAP = 1;          // 单种情绪上限
const FLOOR = 0.001;    // 低于这个数直接归零，免得浮点尾巴永远不消失
const LOG_MAX = 12;     // 账本里留多少条历史

/** 造一份空账本。 */
export function createState(profile, now = Date.now()) {
  const emotions = {};
  for (const name of Object.keys(profile.emotions)) {
    emotions[name] = { value: 0, at: now };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    emotions,
    tier: profile.tiers[0] ? profile.tiers[0].name : 'calm',
    cooldowns: {},
    log: [],
    lastInteractionAt: 0,
    lastSignalAt: 0,
    // 什么时候第一次建的。一次都没被碰过的时候，「多久没人理」靠它算，
    // 不然刚装上就要听她抱怨被冷落。
    createdAt: now,
    // 主动开口的记账表：{ [windowId]: [时间戳] }。老状态文件里没有这个键，读的时候兜空。
    urges: {},
  };
}

/** 把某个情绪从它自己的 at 衰减到 now。返回新对象，不改入参。 */
function decayOne(entry, halfLife, now) {
  const at = Number(entry && entry.at) || now;
  const value = Number(entry && entry.value) || 0;
  if (!value) return { value: 0, at: now };
  const hours = Math.max(0, (now - at) / 3600000);
  if (!hours) return { value, at: now };
  const next = value * Math.pow(0.5, hours / Math.max(0.01, halfLife));
  return { value: next < FLOOR ? 0 : next, at: now };
}

/** 结算整份账本的衰减，返回新 state。档位也在这里一并更新，回差才有依据。 */
export function tick(state, profile, now = Date.now()) {
  const emotions = {};
  for (const [name, def] of Object.entries(profile.emotions)) {
    emotions[name] = decayOne(state.emotions[name], def.halfLife, now);
  }
  // 冷却表顺手清掉过期的，别让它无限长
  const cooldowns = {};
  for (const [key, at] of Object.entries(state.cooldowns || {})) {
    if (now - Number(at) < 24 * 3600000) cooldowns[key] = at;
  }
  const view = {};
  for (const [name, entry] of Object.entries(emotions)) view[name] = Number(entry.value) || 0;
  const tier = tierOf(profile, negForTier(profile, view), state.tier);
  return { ...state, emotions, cooldowns, tier };
}

function readMood(state, name) {
  const e = state.emotions && state.emotions[name];
  return e ? Number(e.value) || 0 : 0;
}

/** 从 path 取值。mood / axes / signal / tier 四个命名空间。 */
function readPath(path, bag) {
  const parts = String(path || '').split('.');
  let cur = bag;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

const OPS = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
};

/** 求值一个条件对象。没有条件视为通过。 */
export function evalCond(cond, bag, profile) {
  if (!cond) return true;
  if (typeof cond === 'function') return !!cond(bag.mood, bag.signal, bag.tier);
  if (Array.isArray(cond.all)) return cond.all.every((c) => evalCond(c, bag, profile));
  if (Array.isArray(cond.any)) return cond.any.some((c) => evalCond(c, bag, profile));
  if (cond.not) return !evalCond(cond.not, bag, profile);
  if (cond.fn && profile && profile.allowFnConditions !== false) {
    return !!cond.fn(bag.mood, bag.signal, bag.tier);
  }
  if (!cond.path) return true;
  const value = readPath(cond.path, bag);
  for (const [op, fn] of Object.entries(OPS)) {
    if (op in cond) return fn(value, cond[op]);
  }
  return value !== undefined && value !== null && value !== false;
}

/** 当前情绪值的扁平视图，条件求值和渲染都用它。 */
function moodView(state) {
  const out = {};
  for (const [name, entry] of Object.entries(state.emotions || {})) {
    out[name] = Number(entry && entry.value) || 0;
  }
  return out;
}

/** 记一笔。signal 形状见 signals.js；weight 默认 1，适配器用它表达「几小时」「几下」。 */
export function ingest(state, signal, profile, now = Date.now()) {
  if (!signal || !signal.kind) return state;
  const sig = { ...signal, weight: Number.isFinite(signal.weight) ? signal.weight : 1 };
  let next = tick(state, profile, now);

  const bag = {
    mood: moodView(next),
    signal: sig,
    tier: next.tier,
  };

  const fired = [];
  for (const rule of profile.rules || []) {
    if (rule.on !== sig.kind) continue;

    // 去重：同一个 key 在冷却期内只算一次
    const key = `${rule.id}:${sig[rule.key || 'label'] ?? ''}`;
    if (rule.cooldown && next.cooldowns[key] && now - next.cooldowns[key] < rule.cooldown) {
      continue;
    }

    const emotionDef = profile.emotions[rule.add];
    if (!emotionDef) continue;
    // 前提没到就跳过：委屈不够，气就生不起来
    if (emotionDef.requires && !evalCond(emotionDef.requires, bag, profile)) continue;
    if (rule.when && !evalCond(rule.when, bag, profile)) continue;

    const amount = (Number(rule.delta) || 0) * sig.weight;
    if (!amount) continue;

    const prev = next.emotions[rule.add] || { value: 0, at: now };
    const value = Math.min(CAP, Math.max(0, (Number(prev.value) || 0) + amount));
    next.emotions[rule.add] = { value, at: now };

    // 顺手清零，用来表达「被哄好了」
    for (const name of rule.clear || []) {
      if (next.emotions[name]) next.emotions[name] = { value: 0, at: now };
    }

    if (rule.cooldown) next.cooldowns[key] = now;

    const reason = typeof rule.reason === 'function' ? rule.reason(sig, value) : rule.reason;
    if (reason) {
      next.log = [...(next.log || []), { at: now, emotion: rule.add, delta: amount, reason }].slice(-LOG_MAX);
    }
    fired.push({ rule: rule.id, emotion: rule.add, amount });
    bag.mood = moodView(next);
  }

  next.lastSignalAt = now;
  if ((profile.interactiveKinds || ['touch', 'speech']).includes(sig.kind)) {
    next.lastInteractionAt = now;
  }
  if (fired.length) next.lastFired = fired;
  return next;
}

/** 只有 drives 里带 tier 的负面情绪才进档位结算：担心和吃醋只改语气，不该把人推进冷战。 */
function negForTier(profile, view) {
  let sum = 0;
  for (const [name, def] of Object.entries(profile.emotions || {})) {
    if (!(def.drives || []).includes('tier')) continue;
    if (def.polarity >= 0) continue;
    sum += view[name] || 0;
  }
  return sum;
}

/**
 * 档位带 0.8 回差：升档立即生效，降档要低于目标档阈值乘以回差。
 * 没有回差的话，情绪在阈值边上会来回跳，看着像抽风而不是像脾气。
 */
function tierOf(profile, neg, current) {
  const tiers = profile.tiers || [{ name: 'calm' }];
  const hysteresis = Number(profile.hysteresis) || 0.8;

  let raw = tiers[tiers.length - 1].name;
  for (const t of tiers) {
    if (Number.isFinite(t.below) && neg < t.below) {
      raw = t.name;
      break;
    }
  }

  const ci = tiers.findIndex((t) => t.name === current);
  const ri = tiers.findIndex((t) => t.name === raw);
  if (!current || ci < 0 || ri < 0) return raw;
  if (ri >= ci) return raw;                       // 变严重：立刻
  const threshold = tiers[ri].below;              // 变平静：得掉到阈值以下才降
  return Number.isFinite(threshold) && neg < threshold * hysteresis ? raw : current;
}

/** 结算成只读快照。消费方只该吃这个，不要直接读 state。 */
export function resolve(state, profile, now = Date.now()) {
  const fresh = tick(state, profile, now);
  const view = moodView(fresh);

  let pos = 0;
  let bond = 0;
  let dominant = null;
  let peak = 0;
  let tierPeak = 0;

  for (const [name, def] of Object.entries(profile.emotions)) {
    const v = view[name] || 0;
    if (def.axis === 'bond') {
      bond = Math.max(bond, v);
      continue;
    }
    if (def.polarity > 0) pos += v;
    if (v > peak) {
      peak = v;
      dominant = name;
    }
    // 能推档位的负面情绪优先当主情绪：生气和委屈一样大时，该说自己是在生气。
    // 必须带 v > 0：光靠 >= 的话全零账本也会命中（0 >= 0），平静时主情绪会被写成
    // 最后一个负面情绪，托盘上看着像「明明没事却在生气」。
    if (v > 0 && v >= tierPeak && (def.drives || []).includes('tier') && def.polarity < 0) {
      tierPeak = v;
      dominant = name;
    }
  }

  const clamped = (n) => Math.max(0, Math.min(1, n));
  const neg = negForTier(profile, view);

  const recent = (fresh.log || []).slice(-12);
  const maxReasons = (profile.cue && profile.cue.maxReasons) || 3;
  const reasons = [];
  for (let i = recent.length - 1; i >= 0 && reasons.length < maxReasons; i--) {
    const r = recent[i].reason;
    if (r && !reasons.includes(r) && (view[recent[i].emotion] || 0) > 0.02) reasons.push(r);
  }

  return {
    schemaVersion: fresh.schemaVersion,
    at: now,
    tier: fresh.tier,
    dominant,
    axes: {
      closeness: clamped(bond),
      valence: Math.max(-1, Math.min(1, pos - neg)),
      expression: clamped(pos * (1 - neg * 0.5) - neg * 0.3),
    },
    values: view,
    reasons,
    idleMinutes: fresh.lastInteractionAt ? Math.floor((now - fresh.lastInteractionAt) / 60000) : null,
  };
}

/** 问闸门。闸门名不存在就当没限制，返回空对象。 */
export function gate(snapshot, profile, name) {
  const table = (profile.gates || {})[name];
  if (!table) return {};
  return table[snapshot.tier] || {};
}
