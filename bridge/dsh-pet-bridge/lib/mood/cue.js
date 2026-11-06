// 情绪卡 —— 把快照说给模型听的那一小段话。
//
// 单独一个文件的理由：这是最会被人按自己口味改的部分。engine 决定「有多气」，
// 这里决定「气成什么样」。改文案不该碰任何逻辑。
//
// 三条自我约束：
//   1. 只说「因为什么」和「怎么说」，不写情绪描写。一描写就变成琼瑶剧。
//   2. 平静且没什么事的时候返回空串 —— 没情绪就别占 token。
//   3. 最多一百来字。这段每轮都跟着消息走，写长了比热记忆还贵。

/** 默认语气模板。可以在 profile.cue.tones 里整段替换。 */
export const DEFAULT_TONES = {
  sulky: '说话短一点，可以带点刺，但不主动翻旧账',
  cold: '只回极短的一句，不主动示好，被追问也冷着，别解释为什么生气',
  warm: '语气软一点，愿意多说两句',
  worried: '语气软，关心一下，催他早点休息',
  jealous: '有点酸，别直接承认',
};

const TIER_ORDER = { cold: 3, sulky: 2, calm: 1 };

/**
 * @param {object} snapshot  engine.resolve() 的产物
 * @param {object} profile
 * @param {{ prefix?: string }} [opts]
 * @returns {string} 可直接拼进投递文本的一段话，可能是空串
 */
export function render(snapshot, profile, opts = {}) {
  if (!snapshot) return '';
  const tones = { ...DEFAULT_TONES, ...((profile && profile.cue && profile.cue.tones) || {}) };
  const reasons = (snapshot.reasons || []).filter(Boolean).slice(0, 3);
  const because = reasons.length ? `因为${reasons.join('、')}` : '说不上来为什么，就是不想说话';

  const tier = snapshot.tier || 'calm';
  const values = snapshot.values || {};

  // 冷战优先，其次不痛快，其次正面，最后才是担心
  if (tier === 'cold') {
    return wrap(`你现在是真的在生气，${because}。${tones.cold}`, opts);
  }
  if (tier === 'sulky') {
    return wrap(`你现在有点不痛快，${because}。${tones.sulky}`, opts);
  }
  if ((values.worried || 0) > 0.3) {
    return wrap(`你在担心他，${because}。${tones.worried}`, opts);
  }
  if ((values.jealous || 0) > 0.3) {
    return wrap(`你有点吃醋，${because}。${tones.jealous}`, opts);
  }
  // 心疼优先于单纯的高兴：看见对方在忙，该是软下来的那种心情，不是雀跃
  if ((values.moved || 0) > 0.3 && (values.moved || 0) >= (values.joy || 0)) {
    return wrap(`你有点心疼他，${because}。${tones.warm}`, opts);
  }
  if ((values.joy || 0) > 0.3) {
    return wrap(`你现在心情不错，${because}。${tones.warm}`, opts);
  }
  // 平静且没事：不占字数
  return '';
}

function wrap(body, opts) {
  const prefix = (opts && opts.prefix) || '';
  return `（${prefix}${body}。）`;
}

/** 给托盘和 /mood 看的人话摘要，不给模型。 */
export function summarize(snapshot, profile) {
  if (!snapshot) return '未知';
  const label = (name) => (profile && profile.emotions && profile.emotions[name] && profile.emotions[name].label) || name;
  const tierName = { calm: '平静', sulky: '不痛快', cold: '冷战' }[snapshot.tier] || snapshot.tier;
  const dom = snapshot.dominant ? label(snapshot.dominant) : '无';
  const pct = Math.round((snapshot.axes && snapshot.axes.valence ? snapshot.axes.valence : 0) * 100);
  return `${tierName}·主情绪${dom}·心情${pct >= 0 ? '+' : ''}${pct}`;
}

export { TIER_ORDER };
