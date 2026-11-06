// urge.js —— 「她自己想开口」的冲动层。纯函数，不碰文件、不读时钟、不发网络。
//
// 跟 peek 的分工，一句话：
//   peek 看屏幕，决定「说什么」
//   urge 看情绪，决定「现在该不该开口」
// 两者互相不认识，都只是调桥里的 deliver()。所以哪一条坏了，另一条照常跑。
//
// 为什么要独立一层，而不是塞进 peek：
//   1. 生气不该等屏幕变化。屏幕没变、全屏、开着静默，人都会生气。
//   2. 加一种「主动」只该加一条 window，不该改调度器。
//   3. peek 是「外部世界」，urge 是「她自己」。混在一起以后谁都改不动。
//
// ── window 字段 ─────────────────────────────────────────────────────────
//   id          唯一名字，也是记账的 key。改名等于从头算
//   requires    什么时候算数，走 engine 的条件 DSL（path 支持 tier / mood.* / signal.*）
//   minIdleMin  至少多久没人理才允许开口。防止她一直黏着说话
//   gapMs       同一个 window 两次之间最少隔多久
//   maxPerDay   这个 window 24 小时内最多开口几次
//   after       { window, times } 先开口过多少次才轮到这一档，用来做「先软后硬」的升级
//   hint        给模型看的一句话，说清「你为什么要开口」。不带情绪卡，情绪卡另有一条
//   note        日志和 /mood 里给人看的短说明
//
// 顺序即优先级：从上往下第一条满足的就用，后面的不再看。
// 所以负面档位要排在正面前面——同时又想发火又想分享时，先发火。

import { evalCond } from './engine.js';

const DAY_MS = 24 * 3600 * 1000;
const KEEP = 20;              // 每个 window 只留最近 20 次，够算 24 小时上限了

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

/** 24 小时内开口的总次数：全局上限，防止两三个 window 轮流把主人吵死。 */
function countSince(state, since, id) {
  let n = 0;
  const ids = id ? [id] : Object.keys((state && state.urges) || {});
  for (const key of ids) {
    for (const t of marksOf(state, key)) if (Number(t) >= since) n++;
  }
  return n;
}

/**
 * 决定现在要不要开口。
 *
 * @param {object} snapshot  engine.resolve 的结果
 * @param {object} state     账本，只用 urges 和 createdAt
 * @param {object} profile   情绪表，读 profile.urge
 * @param {number} now
 * @returns {{speak:boolean, why:string, window?:string, note?:string, hint?:string,
 *            tier:string, idleMin:number, attempt:number}}
 */
export function decide(snapshot, state, profile, now = Date.now()) {
  const cfg = (profile && profile.urge) || {};
  const tier = (snapshot && snapshot.tier) || 'calm';
  const windows = Array.isArray(cfg.windows) ? cfg.windows : [];

  // 没人理了多久。刚装上、一次都没被碰过的时候 idleMinutes 是 null，
  // 拿 createdAt 兜底，不然第一次见面就要听她抱怨。
  const created = Number(state && state.createdAt) || 0;
  const idleMin = (snapshot && Number.isFinite(snapshot.idleMinutes))
    ? snapshot.idleMinutes
    : (created ? Math.floor((now - created) / 60000) : 0);

  const base = { speak: false, why: 'none', tier, idleMin, attempt: 0 };
  if (cfg.enabled === false || !windows.length) return { ...base, why: 'off' };

  const hour = new Date(now).getHours();
  if (inQuietHours(hour, cfg.quietFrom, cfg.quietTo)) return { ...base, why: 'quiet' };

  const last = lastUrgeAt(state);
  const minGap = Number(cfg.minGapMs) || 0;
  if (last && now - last < minGap) return { ...base, why: 'gap' };

  const dayCap = Number(cfg.maxPerDay) || Infinity;
  if (countSince(state, now - DAY_MS) >= dayCap) return { ...base, why: 'day-cap' };

  const bag = {
    mood: (snapshot && snapshot.values) || {},
    tier,
    signal: { kind: 'urge', idleMinutes: idleMin, hour, at: now },
  };

  for (const w of windows) {
    if (!w || !w.id) continue;
    if (w.requires && !evalCond(w.requires, bag, profile)) continue;
    if (idleMin < (Number(w.minIdleMin) || 0)) continue;

    if (w.after && w.after.window) {
      const done = countSince(state, 0, w.after.window);
      if (done < (Number(w.after.times) || 1)) continue;
    }

    const marks = marksOf(state, w.id);
    const mine = marks.length ? Math.max(...marks) : 0;
    if (mine && now - mine < (Number(w.gapMs) || minGap || 0)) continue;
    if (countSince(state, now - DAY_MS, w.id) >= (Number(w.maxPerDay) || Infinity)) continue;

    return {
      speak: true,
      why: 'speak',
      window: w.id,
      note: w.note || w.id,
      hint: w.hint || '',
      tier,
      idleMin,
      // 今天已经自己开口过几次。给提示词用「这是第几次」，让她自己知道是不是在重复
      attempt: countSince(state, now - DAY_MS),
    };
  }

  return base;
}

/**
 * 记一次开口。返回新账本，不改入参。
 *
 * 刻意跟 decide 分开：决定是纯读，记账是显式写入。桥在真正投递成功前后各调一次，
 * 万一投递炸了也不会把「已经说过」写进账本，下一轮还能重来。
 */
export function mark(state, id, now = Date.now(), keep = KEEP) {
  if (!id) return state;
  const all = { ...((state && state.urges) || {}) };
  const list = marksOf(state, id);
  all[id] = [...list, now].slice(-keep);
  return { ...state, urges: all };
}

/** 给 /mood 和托盘看的摘要：什么时候开口过、开了几次。不含 hint，别把提示词漏给前端。 */
export function summarizeUrge(state, profile, now = Date.now()) {
  const cfg = (profile && profile.urge) || {};
  const windows = {};
  for (const w of cfg.windows || []) {
    if (!w || !w.id) continue;
    const marks = marksOf(state, w.id);
    windows[w.id] = {
      total: marks.length,
      today: marks.filter((t) => Number(t) >= now - DAY_MS).length,
      lastAt: marks.length ? new Date(Math.max(...marks)).toISOString() : '',
    };
  }
  return {
    enabled: cfg.enabled !== false,
    quietFrom: cfg.quietFrom ?? null,
    quietTo: cfg.quietTo ?? null,
    maxPerDay: cfg.maxPerDay ?? null,
    today: countSince(state, now - DAY_MS),
    windows,
  };
}

export default { decide, mark, inQuietHours, summarizeUrge };
