// stage/gaze.js 的纯数学自检：node scripts/test-gaze.mjs
//
// 绕圈判定是纯状态机，不碰 Electron，可以完全脱开窗口测。
// 为什么会走这里：外壳那套绕晕是「围着头转几圈才发晕」调出来的手感，
// 搬进舞台后要是数值抄错一位，主人得用真鼠标转十几圈才发现——那是浪费他的时间。
import gazeModule from '../stage/gaze.js';

const { createSpinState, spinSample, TUNE } = gazeModule;

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   → ' + extra : '')); }
};

const DEG = Math.PI * 2;
const CENTER = { zoneR: 320 };   // 相当于窗口高 1182 时的调戏区（出区线 416）

// 绕着头转一圈，逐格喂给状态机，返回这一圈里触发的节号
// 注意要「多喂一格」：真实鼠标是连续的，转角是逐渐累加的；
// 只在整数圈的那一刻恰好停在阈值上会差最后一点点，那不是状态机的问题。
function spinTurns(s, { now, turns, steps = 48, r = 140, clockwise = true, headY = 0, from = 0 }) {
  const fired = [];
  const sign = clockwise ? 1 : -1;
  for (let i = 0; i <= steps * turns; i++) {
    const a = from + sign * (DEG * i / steps);
    now += 16;
    const st = spinSample(s, now, Math.cos(a) * r, Math.sin(a) * r + headY, CENTER);
    if (st) fired.push(st);
  }
  // 再补一格（约 1 度），保证恰好卡在阈值下限时也能过线
  now += 16;
  const tailA = from + sign * (DEG * turns + 0.02);
  const tail = spinSample(s, now, Math.cos(tailA) * r, Math.sin(tailA) * r + headY, CENTER);
  if (tail) fired.push(tail);
  return { fired, now };
}

// ---- 1. 转够一节才发晕 ----
console.log('绕圈判定（一圈一圈喂进去，看第几圈触发）');
{
  const s = createSpinState({ turnsPerStage: 3 });
  const r = spinTurns(s, { now: 1000, turns: 2 });
  ok(r.fired.length === 0, '转 2 圈（不足 3 圈）不发晕', 'fired=' + JSON.stringify(r.fired));
  ok(s.stage === 0, '没到节数时节号仍是 0');
  ok(Math.abs(s.accum) > DEG * 1.5, '累计转角有在记（转 2 圈 ≈ 2 圈）', (s.accum / DEG).toFixed(2));
}

// ---- 2. 转满一节 → 1，再转满 → 2，再转满 → 3 ----
{
  const s = createSpinState({ turnsPerStage: 2 });
  const stages = [];
  let now = 1000;
  for (let round = 0; round < 3; round++) {
    const r = spinTurns(s, { now, turns: 2 });
    now = r.now + 1200;                    // 隔过节间冷却（stageGap 900ms）
    if (r.fired.length) stages.push(...r.fired);
    // 每一节都会挂起一段时间，演示时这一段指针是拿不到的
    now = Math.max(now, s.suspendedUntil + 50);
  }
  ok(stages.length === 3, '连转三节，一次一节', JSON.stringify(stages));
  ok(stages[0] === 1 && stages[1] === 2 && stages[2] === 3, '节号依次 1→2→3（发晕→嫌弃→生气）', JSON.stringify(stages));
}

// ---- 3. 手停住了（断档超过 gapMs）→ 清零，不算一节 ----
{
  const s = createSpinState({ turnsPerStage: 2 });
  const first = spinTurns(s, { now: 1000, turns: 0.9 });
  const before = s.accum;
  ok(first.fired.length === 0, '转 0.9 圈不发晕');
  ok(Math.abs(before) > 0, '这时累计不为 0', (before / DEG).toFixed(2));
  // 手停 1.5 秒，再接着转，累计要从 0 重新数
  const r = spinTurns(s, { now: first.now + 1500, turns: 1.1 });
  ok(r.fired.length === 0, '停过再转 1.1 圈仍然不发晕（断档作废）', 'fired=' + JSON.stringify(r.fired));
  ok(Math.abs(s.accum) <= DEG * 1.11, '断档后累计从零重新数', (s.accum / DEG).toFixed(2));
}

// ---- 4. 反手 → 重新数 ----
{
  const s = createSpinState({ turnsPerStage: 2 });
  let now = 1000;
  const a = spinTurns(s, { now, turns: 1.5 });
  now = a.now;
  ok(a.fired.length === 0, '顺转 1.5 圈不发晕');
  const dirBefore = s.dir;
  // 明确反手：手挥快了（每帧 0.785 弧度 > 0.35 阈值）逆着转
  const b = spinTurns(s, { now, turns: 1.2, steps: 8, clockwise: false, from: DEG * 1.5 });
  ok(b.fired.length === 0, '反手后不会因为前面的累计而发晕', 'fired=' + JSON.stringify(b.fired));
  ok(dirBefore === 1 && s.dir === -1, '方向翻过来了', dirBefore + ' → ' + s.dir);
  ok(s.accum < 0, '累计跟着反手改成负的', (s.accum / DEG).toFixed(2));
}

// ---- 4b. 指针瞬移（跳变）不算转角 ----
{
  const s = createSpinState({ turnsPerStage: 2 });
  let now = 1000;
  spinSample(s, now, 140, 0, CENTER);        // 先在「右边」定个角度
  const before = s.accum;
  // 一下闪到「左边」：差了 π 弧度，是跳不是手转
  now += 16;
  const jump = spinSample(s, now, -140, 0, CENTER);
  ok(jump === 0 && Math.abs(s.accum - before) < 1e-6, '瞬移不改变累计', (s.accum / DEG).toFixed(3));
}

// ---- 5. 手离开调戏区 → 清零；贴着头心不算但不作废 ----
{
  const s = createSpinState({ turnsPerStage: 2 });
  const r = spinTurns(s, { now: 1000, turns: 1.4 });
  ok(Math.abs(s.accum) > 0, '区内累计有值');
  spinSample(s, r.now + 16, 500, 0, CENTER);   // 超出出区线（zoneR 320 × 1.3 = 416）
  ok(Math.abs(s.accum) === 0, '手真出区，累计清零');
  const before = spinTurns(s, { now: r.now + 32, turns: 1.2 });
  const kept = Math.abs(s.accum);
  // 贴着头心（离圆心 20px）：圈住头心的转动照样算，不再因为「半径太小」被扔掉
  spinSample(s, before.now + 16, 20, 0, CENTER);
  ok(kept > 0 && Math.abs(s.accum) !== kept, '贴着头心也照算转角', kept.toFixed(2));
  // 边缘抖一下（还没到出区线）也不该扔进度
  spinSample(s, before.now + 32, 360, 0, CENTER);
  ok(Math.abs(s.accum) > 0, '在调戏区外沿那一圈不扔进度（1.3 倍才出区）');
}

// ---- 5b. 绕小圈（每圈都从头的近处经过）也能攒满一节 ----
{
  const s = createSpinState({ turnsPerStage: 2 });
  // 圆心偏下 80px、半径 120：每圈都会经过离头心 40px 的地方（旧版到这里就清零了）
  let now = 1000;
  const fired = [];
  for (let i = 0; i <= 48 * 2 + 2; i++) {
    const a = DEG * i / 48;
    now += 16;
    const st = spinSample(s, now, Math.cos(a) * 120, 80 + Math.sin(a) * 120, CENTER);
    if (st) fired.push(st);
  }
  ok(fired[0] === 1, '绕小圈经过头心附近，照样能攒满并触发', 'fired=' + JSON.stringify(fired));
}

// ---- 6. 发晕 / 生气期间不看鼠标 ----
{
  const s = createSpinState({ turnsPerStage: 2 });
  const r = spinTurns(s, { now: 1000, turns: 2 });
  ok(r.fired[0] === 1, '第一节触发');
  ok(s.suspendedUntil > r.now, '第一节挂起了（这段时间不跟指针）', (s.suspendedUntil - r.now) + 'ms');
  const during = spinTurns(s, { now: r.now + 100, turns: 3 });
  ok(during.fired.length === 0, '挂起期间继续转也不会马上进第二节', 'fired=' + JSON.stringify(during.fired));
}

// ---- 7. 生气后 26 秒冷却，冷却结束复原 ----
{
  const s = createSpinState({ turnsPerStage: 2 });
  let now = 1000;
  const stages = [];
  for (let i = 0; i < 3; i++) {
    const r = spinTurns(s, { now: Math.max(now, s.suspendedUntil + 50), turns: 2 });
    now = r.now + TUNE.stageGap + 50;
    if (r.fired.length) stages.push(...r.fired);
  }
  ok(stages[2] === 3, '第三节：生气');
  const cd = s.cooldownUntil - s.suspendedUntil;
  ok(Math.abs(cd) <= 2, '生气的挂起时长 = 冷却时长（都一样是 26 秒）', cd + 'ms');
  ok(TUNE.cooldownMs === 26000, '冷却 26 秒');
  // 冷却中：怎么转都不动
  const mid = spinTurns(s, { now: now + 5000, turns: 3 });
  ok(mid.fired.length === 0, '冷却期间再转也不触发');
  // 冷却结束后：节号归零，可以重新被绕
  const reset = spinSample(s, s.cooldownUntil + 10, 140, 0, CENTER);
  ok(s.stage === 0, '冷却结束后节号归零', String(reset));
}

// ---- 8. 节数与挂起时长对得上 ----
console.log('');
console.log('参数（改了这几个数，手感就变了，别随手动）');
{
  ok(TUNE.turnsPerStage === 4, '默认一节 4 圈（主人 2026-11-10 深夜定，6 圈嫌多）');
  ok(TUNE.gapMs === 700, '手停 700ms 作废');
  ok(TUNE.suspendMs[1] === 3600 && TUNE.suspendMs[2] === 4000, '发晕 3.6s、嫌弃 4s 不看鼠标');
  ok(TUNE.zoneR === 0.45 && TUNE.zoneExit === 1.3, '调戏区 0.45 倍窗高、出区 1.3 倍');
  const s = createSpinState({ turnsPerStage: 99 });
  ok(s.turnsPerStage === 4, '节数越界回落到 4', String(s.turnsPerStage));
  const s2 = createSpinState({ turnsPerStage: 2 });
  ok(s2.turnsPerStage === 2, '演示用的 2 圈可以设');
}

console.log('');
console.log(`${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
