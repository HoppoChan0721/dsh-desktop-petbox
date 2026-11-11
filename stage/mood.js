'use strict';
// 心情 → 舞台反应。
//
// 情绪来源是 `persona\mood.ps1` 那台状态机，只有七种：恬静 / 开心 / 害羞 / 撒娇 / 担心 / 认真 / 困。
// 这里的活儿是把「她现在什么心情」翻成三样东西：
//   1. 表情（模型自带的那几个）
//   2. 一个小动作（点头 / 摇头）
//   3. 待机摆动的偏置（幅度倍数 + 重心前倾 + 歪头），持续几秒以后自然收回去
//
// 全是纯函数，node 里能直接测。数值不是瞎挑的：
// 认真/困 会更稳更安静（0.7 倍），撒娇/开心 会更晃（1.2 倍）——
// 待机摆动本来就是「有没有活着」的唯一信号，心情一变它还得看得出来变了。
const MOODS = {
  恬静: { expression: null, gesture: null, sway: 1.0, lean: 0, tilt: 0, holdMs: 6000 },
  开心: { expression: '爱心眼', gesture: 'nod', sway: 1.18, lean: 3, tilt: 3, holdMs: 6000 },
  害羞: { expression: '脸红', gesture: null, sway: 0.88, lean: 7, tilt: 2, holdMs: 6000 },
  撒娇: { expression: '＞＜', gesture: 'shake', sway: 1.25, lean: 6, tilt: 4, holdMs: 5000 },
  担心: { expression: '流冷汗', gesture: 'shake', sway: 0.8, lean: -3, tilt: -2, holdMs: 6000 },
  认真: { expression: '眯眼', gesture: 'nod', sway: 0.7, lean: 5, tilt: 0, holdMs: 8000 },
  困: { expression: '眯眼', gesture: null, sway: 0.65, lean: -2, tilt: -3, holdMs: 12000 },
};

const FALLBACK = '恬静';
const DEFAULT_INTENSITY = 0.6;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 强度只放大「偏离中性多少」，不改变方向：强度 0 就是恬静的样子
function plan(mood, intensity) {
  const name = MOODS[mood] ? mood : FALLBACK;
  const m = MOODS[name];
  const k = clamp01(intensity === undefined || intensity === null ? DEFAULT_INTENSITY : Number(intensity));
  return {
    name,
    known: !!MOODS[mood],
    expression: m.expression,
    expressionMs: Math.round(1800 + 2600 * k),
    gesture: m.gesture,
    // 以下三样交给 engine.setMood，进来 0.8 秒淡入、末尾 1.5 秒淡出
    sway: 1 + (m.sway - 1) * k,
    lean: m.lean * k,
    tilt: m.tilt * k,
    holdMs: Math.round(m.holdMs * (0.6 + 0.4 * k)),
  };
}

function names() {
  return Object.keys(MOODS);
}

module.exports = { MOODS, FALLBACK, DEFAULT_INTENSITY, plan, names };
