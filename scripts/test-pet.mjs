// whale-pet-shell 自检：node scripts/test-pet.mjs（npm test）
// 钉两件「本地复现不出来、别人一用就出事」的东西：
//   1. 口型帧表必须满足舞台的硬约束（帧 time 落在 0.15..duration-0.15、duration ≤ 20），越界舞台直接 400；
//   2. Alt 拖动跨屏时必须保住物理尺寸、位移不多不少。
import { mouthFrames } from '../src/mouth.js';
import { createDragState, dragFrame } from '../src/drag.js';

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
};
const near = (a, b, eps = 0.011) => Math.abs(a - b) <= eps;

// ---- 1. 口型帧表 ----
console.log('口型帧表（舞台硬约束：0.15 ≤ time ≤ duration-0.15，0.2 ≤ duration ≤ 20）');
for (const ms of [400, 485, 1200, 3333, 4120, 8000, 19500, 60000]) {
  const env = Array.from({ length: Math.max(4, Math.min(58, Math.round(ms / 125))) }, (_, i) => 0.05 + ((i * 7) % 90) / 100);
  const { dur, frames, lead, aud } = mouthFrames(ms, env);
  const lo = 0.15, hi = +(dur - 0.15).toFixed(2);
  const bad = frames.filter((f) => f.time < lo || f.time > hi + 1e-9);
  ok(frames.length >= 2, `ms=${ms} 至少两帧`, 'frames=' + frames.length);
  ok(bad.length === 0, `ms=${ms} 帧都在 ${lo}..${hi}`, '越界 ' + bad.length + ' 帧，最后一帧 ' + (frames.at(-1) || {}).time);
  ok(dur >= 0.2 && dur <= 20, `ms=${ms} duration=${dur.toFixed(2)} 在 0.2..20`);
  ok(frames.every((f, i) => i === 0 || f.time >= frames[i - 1].time), `ms=${ms} 帧时间单调不减`);
  ok(frames.every((f) => f.values.ParamMouthOpenY >= 0.05 && f.values.ParamMouthOpenY <= 1), `ms=${ms} 口型值在 0.05..1`);
  ok(near(lead, 0.15), `ms=${ms} 声音起点 ${lead}`);
  ok(aud <= 19.5 + 1e-9, `ms=${ms} 声音时长被夹到 19.5 内（${aud.toFixed(2)}）`);
}
{
  const { frames } = mouthFrames(3000, null);
  ok(frames.length >= 10, '没包络时也有兜底帧', 'frames=' + frames.length);
  ok(frames.every((f) => f.values.ParamMouthOpenY === 0.95 || f.values.ParamMouthOpenY === 0.1), '兜底帧是开合两档');
}

// ---- 2. Alt 拖动 ----
console.log('');
console.log('Alt 拖动（物理尺寸不变、位移一比一）');
{
  // 单屏 100%：拖多少走多少
  const st = createDragState({ x: 1000, y: 500, width: 736, height: 1320 }, { x: 1300, y: 700 }, 1);
  const scaleAt = () => 1;
  const boxes = [];
  for (let i = 1; i <= 10; i++) boxes.push(dragFrame(st, { x: 1300 - i * 30, y: 700 - i * 5 }, scaleAt));
  const last = boxes.at(-1);
  ok(last.x === 700 && last.y === 450, '同屏 100%：位移一比一', JSON.stringify(last));
  ok(last.width === 736 && last.height === 1320, '同屏 100%：尺寸不变', JSON.stringify(last));
  ok(boxes.slice(0, -1).every((b) => b.width === 736 && b.height === 1320), '同屏 100%：中途也不改尺寸（不改尺寸=不重排=不闪）');
  ok(dragFrame(st, { x: 1000, y: 650 }, scaleAt) === null, '光标没动的那一帧返回 null（不空转 setBounds）');
}
{
  // 跨屏：100% → 150%，物理尺寸必须保住，屏幕上看不出变大
  let scale = 1;
  const st = createDragState({ x: 2000, y: 300, width: 736, height: 1320 }, { x: 2300, y: 600 }, 1);
  const scaleAt = () => scale;
  const first = dragFrame(st, { x: 2200, y: 600 }, scaleAt);
  ok(first.width === 736 && first.height === 1320, '还在 100% 屏上：尺寸不变', JSON.stringify(first));
  ok(first.x === 1900 && first.y === 300, '同屏位移一比一（-100）', JSON.stringify(first));
  scale = 1.5;   // 拖到 150% 的屏
  const second = dragFrame(st, { x: 2100, y: 600 }, scaleAt);
  ok(second.width === 491 || second.width === 490, '跨到 150%：DIP 宽按物理尺寸缩到 ~490', JSON.stringify(second));
  ok(second.height === 880, '跨到 150%：DIP 高按物理尺寸缩到 880', JSON.stringify(second));
  ok(Math.abs(Math.round(second.width * 1.5) - 736) <= 1, '跨到 150%：物理宽度仍是 736 左右', String(second.width * 1.5));
  ok(second.x === 1800 && second.y === 300, '跨屏位移照样一比一（-100，不多走一截）', JSON.stringify(second));
  scale = 1;     // 再拖回去
  const third = dragFrame(st, { x: 2000, y: 600 }, scaleAt);
  ok(third.width === 736 && third.height === 1320, '拖回 100%：尺寸复原，没有累积变大', JSON.stringify(third));
  ok(third.x === 1700 && third.y === 300, '拖回 100%：位置继续一比一', JSON.stringify(third));
}
{
  // 极端缩放别把窗口撑爆/缩没
  const st = createDragState({ x: 0, y: 0, width: 1600, height: 2000 }, { x: 100, y: 100 }, 1);
  const box = dragFrame(st, { x: 200, y: 100 }, () => 4);
  ok(box.width <= 1600 && box.width >= 240 && box.height <= 2000 && box.height >= 360, '400% 屏上尺寸仍在 240..1600 / 360..2000', JSON.stringify(box));
}

console.log('');
console.log(`${pass} 条通过，${fail} 条失败`);
process.exit(fail ? 1 : 0);
