'use strict';
// 外壳那套 plan → 舞台能执行的指令。
//
// DSH 侧的桥在「只有动作没台词」时，会往舞台砸一个 plan：{ title, actions:[{kind,...}] }。
// 外壳那边能跑 trajectory（参数级帧序列），舞台这层只做得到三类，剩下的**如实跳过**——
// 装作执行了比不执行更坏，排查时看不出到底是没做还是做了没效果。
//
// 纯函数：只算指令，不发指令。node 里能直接测。
const GESTURE_MOTION = {
  hand_on_chest: 'HandRaise',
  point: 'FingerShow',
  grass: 'GrassOn',
};

// 一步动作 → 一条舞台指令。认不出来的返回 null。
function commandOf(a) {
  if (!a || !a.kind) return null;
  if (a.kind === 'expression') {
    const name = String(a.name || '');
    if (!name) return null;
    return { type: 'emotion', name, ms: Math.round((Number(a.duration) || 2.6) * 1000) };
  }
  if (a.kind === 'motion') {
    const name = String(a.name || '');
    if (!name) return null;
    return { type: 'motion', name, hold: !!a.hold };
  }
  if (a.kind === 'gesture') {
    const g = GESTURE_MOTION[String(a.name || '')];
    if (g) return { type: 'motion', name: g };
    if (a.name === 'nod') return { type: 'nod' };
    if (a.name === 'shake') return { type: 'shake' };
    return null;
  }
  // 下面这些是「语义动作」：没有动作文件，舞台用参数冲量演（点头、歪头、看一眼）
  if (a.kind === 'nod') return { type: 'nod', count: Number(a.count) || 2 };
  if (a.kind === 'shake_head' || a.kind === 'shake') return { type: 'shake', count: Number(a.count) || 2 };
  if (a.kind === 'tilt') return { type: 'tilt', direction: a.direction === 'left' ? 'left' : 'right', ms: Math.round((Number(a.duration) || 1.8) * 1000) };
  if (a.kind === 'look') {
    const d = String(a.direction || 'center');
    return { type: 'look', direction: ['left', 'right', 'up', 'down'].includes(d) ? d : 'center', ms: Math.round((Number(a.duration) || 1.2) * 1000) };
  }
  if (a.kind === 'blink') return { type: 'blink', side: String(a.side || 'both'), count: Number(a.count) || 1 };
  if (a.kind === 'smile') return { type: 'smile', ms: Math.round((Number(a.duration) || 1.8) * 1000) };
  if (a.kind === 'talk') return { type: 'talk', ms: Math.round((Number(a.duration) || 2.4) * 1000) };
  // pose 是参数级帧序列，舞台这层做不了，如实跳过（桥那边也只在外壳里用）
  return null;
}

function toCommands(plan) {
  const actions = Array.isArray(plan && plan.actions) ? plan.actions : [];
  const commands = [];
  const applied = [];
  const skipped = [];
  for (const a of actions) {
    const cmd = commandOf(a);
    if (cmd) {
      commands.push(cmd);
      applied.push(a.kind === 'gesture' ? 'gesture:' + a.name : a.kind + ':' + cmd.name);
    } else if (a && a.kind) {
      skipped.push(a.kind + ':' + (a.name || ''));
    }
  }
  return { commands, applied, skipped, title: (plan && plan.title) || '' };
}

module.exports = { GESTURE_MOTION, commandOf, toCommands };
