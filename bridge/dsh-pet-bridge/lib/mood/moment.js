// moment.js —— 「此刻」短时层。
//
// 存在的理由：窥屏是观察，不是互动。
//
// 看见主人在玩、在忙、凌晨还没睡，这些是「瞄到一眼」的余温，
// 该影响她这会儿说话的味道，不该被记成几小时的委屈。
// 跟情绪账本混在一起的话，只要开着窥屏，看一眼屏幕就能给她攒出半天情绪——
// 那不是陪伴，是被监控。
//
// 所以划一条线：
//   情绪账本 emotions —— 只由主人自己的行为驱动：被摸、说话、长时间没人理。会累积、会衰减、推档位。
//   moment 列表        —— 只由观察驱动：看到的场景。带 TTL，到期消失，不累积、不衰减、不结转。
//
// ── 三条硬规矩 ───────────────────────────────────────────────────────────
//   1. 带 TTL，到期自己消失。不补偿、不回填，错过就错过。
//   2. 同一个 id 在有效期内只占一条。重复触发只刷新时间、把次数加一。
//   3. 永远不进 emotions，不参与档位、不参与 PAD 轴、不参与 valence。
//
// 这一层就是「调味品撒下去当场尝到」，不是「改菜的配方」。

const MAX_MOMENTS = 6;               // 同时最多记几条，多出来的挤掉最旧的
const MIN_TTL = 60 * 1000;           // 再短就没意义了，刚记完就过期
const MAX_TTL = 2 * 3600 * 1000;     // 再长就不叫「此刻」了
const DEFAULT_TTL = 10 * 60 * 1000;

/** 空列表。给 createState 和兜底用。 */
export function createMoments() {
  return [];
}

/**
 * 清掉过期的。纯粹按时间算，不改入参。
 * @param {Array} list
 * @param {number} now
 */
export function pruneMoments(list, now = Date.now()) {
  if (!Array.isArray(list) || !list.length) return [];
  return list.filter((m) => {
    if (!m || typeof m !== 'object') return false;
    const at = Number(m.at);
    const ttl = Number(m.ttlMs);
    if (!Number.isFinite(at) || !Number.isFinite(ttl) || ttl <= 0) return false;
    return now - at < ttl;
  });
}

/**
 * 记一条。「同 id 只占一条」是这里的核心：连着三次看见主人在玩，
 * 不该变成三条「在玩」，而是一条「看见了三次」。
 *
 * @param {Array} list      现有列表，可以是 undefined
 * @param {object} spec     { id, tag, why, ttlMs }
 * @param {number} now
 * @returns {Array} 新列表
 */
export function pushMoment(list, spec, now = Date.now()) {
  if (!spec) return pruneMoments(list, now);
  const id = String(spec.id || spec.tag || 'moment');
  const ttlMs = Math.min(MAX_TTL, Math.max(MIN_TTL, Number(spec.ttlMs) || DEFAULT_TTL));

  const alive = pruneMoments(list, now);
  const prev = alive.find((m) => m && m.id === id);
  // 同一时刻被两条规则命中，算「看见了这一回」，不算两回。
  // 只有真的隔了一轮再看见，次数才往上加。
  const sameTurn = !!prev && Number(prev.at) === Number(now);
  const n = sameTurn ? (Number(prev.n) || 1) : ((Number(prev && prev.n) || 0) + 1);

  const kept = alive.filter((m) => m && m.id !== id);
  kept.push({
    id,
    at: now,
    ttlMs,
    tag: String(spec.tag || ''),
    why: String(spec.why || ''),
    n,
  });
  // 超出上限时丢最旧的。moments 只是余温，不值得为它排序做花活。
  return kept.slice(-MAX_MOMENTS);
}

/** 全部清掉。主人真的开口了，之前「瞄到一眼」的余温就该翻篇。 */
export function clearMoments() {
  return [];
}

/** 还剩多少毫秒过期。已经过期返回 0。 */
export function remainingMs(m, now = Date.now()) {
  if (!m) return 0;
  return Math.max(0, Number(m.at) + Number(m.ttlMs) - now);
}

/**
 * 取「这会儿最响的那条」。次数多的优先，次数一样取新的。
 * cue 和托盘都只认这一条，不做加权求和——好几条余温搅在一起，文案会变得没法写。
 */
export function topMoment(list, now = Date.now()) {
  const alive = pruneMoments(list, now);
  if (!alive.length) return null;
  let best = alive[0];
  for (const m of alive) {
    const bn = Number(best.n) || 1;
    const mn = Number(m.n) || 1;
    if (mn > bn || (mn === bn && Number(m.at) >= Number(best.at))) best = m;
  }
  return best;
}

/**
 * 给托盘 / /mood 的摘要。没东西时返回空对象，调用方不用判断。
 * @returns {{ top: object|null, tags: string[], count: number }}
 */
export function summarizeMoments(list, now = Date.now()) {
  const alive = pruneMoments(list, now);
  const top = topMoment(alive, now);
  return {
    top,
    tags: alive.map((m) => m.tag).filter(Boolean),
    count: alive.length,
  };
}
