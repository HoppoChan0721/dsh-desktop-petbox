// 情绪卡 —— 把快照说给模型听的那一小段话。
//
// 单独一个文件的理由：这是最会被人按自己口味改的部分。engine 决定「有多气」，
// 这里决定「气成什么样」。改文案不该碰任何逻辑。
//
// 三条自我约束：
//   1. 只说「因为什么」和「怎么说」，不写情绪描写。一描写就变成琼瑶剧。
//   2. 平静且没什么事的时候返回空串 —— 没情绪就别占 token。
//   3. 最多一百来字。这段每轮都跟着消息走，写长了比热记忆还贵。

import { topMoment } from './moment.js';

/** 默认语气模板。可以在 profile.cue.tones 里整段替换。 */
export const DEFAULT_TONES = {
  sulky: '说话短一点，可以带点刺，但不主动翻旧账',
  cold: '只回极短的一句，不主动示好，被追问也冷着，别解释为什么生气',
  warm: '语气软一点，愿意多说两句',
  worried: '语气软，关心一下，催他早点休息',
  jealous: '有点酸，别直接承认',
};

// 形态词：同样一句「不痛快」，绷着和蔫着是两回事。
// 来源是 PAD 的两个派生轴，不是又一套人为枚举 —— 阈值只决定「说不说」，
// 说的是哪一种由账面自己算出来。可以在 profile.cue.shapes 里换词。
export const DEFAULT_SHAPES = {
  hot: '绷着',        // A 高且心情差：气是炸出来的
  up: '来劲',         // A 高且心情好：同一条轴，说法完全不同
  flat: '蔫着',       // A 低：气是憋着的
  top: '想占上风',     // D 高：要管人
  low: '气势低',      // D 低：被拿捏住
};

// 阈值是照实跑账本定的，不是拍脑袋：没人理一整天，委屈稳定在 0.44 左右，
// 乘上向量正好是 -0.13 / -0.22。阈值要是卡在 0.14 以上，这种最常见的「蔫」就永远出不来。
// 0.10 / 0.15 能覆盖「不痛快」那一段，又不会让轻微波动也带形态词。
const SHAPE_AT = 0.10;    // 激活轴超过这个值才提一句
const SHAPE_DT = 0.15;    // 支配轴同理

const TIER_ORDER = { cold: 3, sulky: 2, calm: 1 };

/** 从派生轴里挑形态词。最多两个，一个来自激活，一个来自支配。 */
export function shapesOf(snapshot, profile) {
  const t = { ...DEFAULT_SHAPES, ...((profile && profile.cue && profile.cue.shapes) || {}) };
  const axes = (snapshot && snapshot.axes) || {};
  const a = Number(axes.arousal) || 0;
  const d = Number(axes.dominance) || 0;
  const v = Number(axes.valence) || 0;
  const out = [];
  // 同样是「激活」，开心是来劲，不开心是绷着。同一条轴，两种说法。
  if (a > SHAPE_AT) out.push(v > 0.1 ? t.up : t.hot);
  else if (a < -SHAPE_AT) out.push(t.flat);
  if (d > SHAPE_DT) out.push(t.top);
  else if (d < -SHAPE_DT) out.push(t.low);
  return out;
}

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

  // 形态词插在语气模板前面：先说「你现在是绷着还是蔫着」，再说「该怎么说话」
  const shape = shapesOf(snapshot, profile);
  const form = shape.length ? shape.join('、') + '，' : '';

  let body = '';
  if (tier === 'cold') {
    body = `你现在是真的在生气，${because}。${form}${tones.cold}`;
  } else if (tier === 'sulky') {
    body = `你现在有点不痛快，${because}。${form}${tones.sulky}`;
  } else if ((values.worried || 0) > 0.3) {
    body = `你在担心他，${because}。${form}${tones.worried}`;
  } else if ((values.jealous || 0) > 0.3) {
    body = `你有点吃醋，${because}。${form}${tones.jealous}`;
  } else if ((values.moved || 0) > 0.3 && (values.moved || 0) >= (values.joy || 0)) {
    // 心疼优先于单纯的高兴：看见对方在忙，该是软下来的那种心情，不是雀跃
    body = `你有点心疼他，${because}。${form}${tones.warm}`;
  } else if ((values.joy || 0) > 0.3) {
    body = `你现在心情不错，${because}。${form}${tones.warm}`;
  }

  // 「此刻」那一段。账本平静的时候，它是唯一有内容的东西——
  // 窥屏看见什么本来就该在这里起作用，而不是偷偷改账本。
  // 主动开口那条路会传 skipMoment：它自己的提示词里已经带了那条事实，
  // 同一句话里说两遍既费 token，也容易让模型把同一件事复述给主人。
  const mom = (opts && opts.skipMoment) ? '' : momentLine(snapshot);
  if (!body && !mom) return '';
  if (!body) return wrap(`${mom}${tones.warm}`, opts);
  if (mom) return wrap(`${body}${mom}`, opts);
  return wrap(body, opts);
}

/** 把最强的那条 moment 说成一句话。没有就返回空串，不占字数。 */
function momentLine(snapshot) {
  const now = Number(snapshot && snapshot.at) || Date.now();
  const top = topMoment(snapshot && snapshot.moments, now);
  if (!top || !top.tag) return '';
  const again = (Number(top.n) || 1) > 1 ? '又' : '';
  const why = top.why ? `${top.why}，` : '';
  return `刚才${again}瞄到一眼，${why}这会儿${top.tag}。`;
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
  // 形态词也带一个进摘要，托盘上能一眼看出是炸还是蔫
  const shape = shapesOf(snapshot, profile);
  const shapeText = shape.length ? '·' + shape.join('·') : '';
  // 「此刻」的余温不往这里塞：摘要要短，而余温随时会消失。
  // /mood 的 moments 字段单独给，谁想显示谁自己拼。
  return `${tierName}·主情绪${dom}·心情${pct >= 0 ? '+' : ''}${pct}${shapeText}`;
}

export { TIER_ORDER };
