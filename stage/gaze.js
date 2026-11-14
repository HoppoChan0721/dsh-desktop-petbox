// 舞台的指针追踪策略层（主进程）。
//
// 指针追踪 / 绕圈判定 / 三节反应：这套是从早期外壳里长出来的，现在独立维护
// （2026-10-31 ~ 11-01 一点点调出来的手感），但换个分工：
//   这里只回答两个问题——
//     1. 这一帧要不要告诉她指针在哪（离开本屏 / 鼠标停太久 → 不说，她自己回正）
//     2. 主人是不是在绕着她的头转圈（转够 → 一节：发晕 → 嫌弃 → 生气 → 冷却，冷却期间不看鼠标）
//   画面和台词由 main.js 决定，这里只给节号。
//
// 纯数学部分（createSpinState / spinSample）刻意不 require('electron')，npm test 能直接测。
'use strict';

const DEG = Math.PI * 2;

const TUNE = {
  // 指针采样间隔。老外壳（鲸语）是 33ms = 30Hz，页面 60Hz 渲染时手一快就是台阶；
  // 2026-11-13 主人说「俯身追鼠标卡卡的」，压到 16ms（约 60Hz）跟手明显更顺。
  // 一次采样就是 getCursorScreenPoint + 两次 getDisplayNearestPoint，很便宜。
  pollMs: 16,
  // 鼠标静止超过这么久就当它离开了：视线和身体收回正前方，别一直偏着头朝着同一个方向。
  // 一动就立刻恢复追踪（位置一变就刷新 lastMoveAt）。
  idleMs: 10000,
  // 正中间这么小的一圈归零：手停在窗口正中时不左右抖
  deadZone: 0.04,
  // 位置没变也每这么久重发一次，页面重挂驱动时不至于一直收不到
  resendMs: 400,

  // 绕圈判定（在外壳那套数值上放宽过一轮：2026-11-10 主人实测「一直转都没触发」）：
  // 以**头部**为圆心，在调戏区里转过有向角度就累计；手停住、明确反向都清零重来。
  zoneR: 0.45,        // 调戏区半径 = 窗口高 × 0.45（至少 160px）；0.27 时绕着整个身子转会被判出区
  zoneExit: 1.3,      // 出区要出到 1.3 倍半径才算真离开，手在边上抖一下不扔进度
  headFallback: { x: 0.503, y: 0.22 },   // 剪影还没标定出来时的兜底（外壳当年就是这两个数）
  headCenter: 0.21,   // 头心 = 剪影顶 + 剪影高 × 0.21；剪影顶由 interact.js 报上来
  turnsPerStage: 4,   // 一节要转几圈（2~20）：主人 2026-11-10 深夜定 4 圈，6 圈嫌多
  gapMs: 700,         // 手停这么久就作废，别把几段零碎的转合成一节
  stageGap: 900,      // 两节之间至少隔这么久
  jump: 1.6,          // 一帧转角超过这么多弧度（≈92°）就是瞬移，不是手转的
  suspendMs: { 1: 3600, 2: 4000, 3: 26000 },   // 各节「这段时间不看鼠标」
  cooldownMs: 26000,  // 第三节之后整段冷却，结束才恢复跟手
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- 纯状态机：绕圈判定 ------------------------------------------------------
function createSpinState(opts) {
  const o = opts || {};
  const turns = Number(o.turnsPerStage);
  return {
    turnsPerStage: turns >= 2 && turns <= 20 ? turns : TUNE.turnsPerStage,
    accum: 0,          // 这一节已经累计的有向转角（弧度，带正负）
    dir: 0,            // 当前转的方向：1 顺时针 / -1 逆时针 / 0 还没定
    lastA: null,       // 上一帧的角度
    accumAt: 0,        // 上一次真的有转角的时间（用来判断「手停了」）
    stage: 0,          // 0 还没被绕 / 1 发晕 / 2 嫌弃 / 3 生气
    lastStageAt: 0,
    suspendedUntil: 0,
    cooldownUntil: 0,
  };
}

function spinClear(s) {
  s.accum = 0;
  s.dir = 0;
  s.lastA = null;
}

function spinAdvance(s, now) {
  if (now < s.cooldownUntil || now - s.lastStageAt < TUNE.stageGap) return 0;
  s.lastStageAt = now;
  s.stage = Math.min(3, s.stage + 1);
  spinClear(s);
  s.suspendedUntil = now + (TUNE.suspendMs[s.stage] || 0);
  if (s.stage === 3) s.cooldownUntil = now + TUNE.cooldownMs;
  return s.stage;
}

// 喂一帧指针相对头心的像素偏移，返回这一帧有没有跨到新的一节（0 = 没有）。
function spinSample(s, now, dx, dy, geom) {
  const g = geom || {};
  const zoneR = Number.isFinite(g.zoneR) ? g.zoneR : Infinity;
  const exitR = zoneR * (Number.isFinite(g.zoneExit) ? g.zoneExit : TUNE.zoneExit);

  if (s.stage >= 3 && now >= s.cooldownUntil) { s.stage = 0; spinClear(s); }
  if (now < s.cooldownUntil || now < s.suspendedUntil) { spinClear(s); return 0; }

  const dist = Math.hypot(dx, dy);
  if (dist > exitR) { spinClear(s); return 0; }   // 真离开调戏区

  // 别看半径小就不算：手绕的圈再小，只要圈住头心，转一圈就是一整圈。
  // 以前贴太近（<55px）直接 spinClear，而且贴着的那几帧转角最猛（越靠圆心角速度越快），
  // 一次就丢掉大半圈——主人 11-10 晚上「一直转没触发」就是这两条叠出来的。
  // 现在只要求在调戏区里（zoneR 以内），半径不设下限。

  // 手停了：断档超过 gapMs 就作废，别让好几段零碎的转合成一节
  if (now - s.accumAt > TUNE.gapMs) { s.accum = 0; s.dir = 0; s.lastA = null; }

  const a = Math.atan2(dy, dx);
  if (s.lastA === null) { s.lastA = a; s.accumAt = now; return 0; }

  let d = a - s.lastA;
  while (d > Math.PI) d -= DEG;
  while (d < -Math.PI) d += DEG;
  s.lastA = a;
  if (Math.abs(d) < 0.002) return 0;   // 抖动不算转角，也不刷新断档计时

  // 一帧跨了 1.6 弧度以上（≈92°）说明指针是「跳」过来的，不是手转出来的：
  // 跨屏瞬移、程序挪鼠标、从她身上划到旁边都会这样。跳变不算转角，也不翻方向，
  // 否则鼠标来回跳两下就能凭空凑出一圈「发晕」。
  if (Math.abs(d) > TUNE.jump) { s.accumAt = now; return 0; }

  s.accumAt = now;
  const dir = d > 0 ? 1 : -1;
  if (s.dir === 0) { s.dir = dir; s.accum = 0; }
  else if (dir !== s.dir && Math.abs(d) > 0.35) { s.dir = dir; s.accum = 0; }   // 明确反手：重新数
  s.accum += d;

  // 一节 = turnsPerStage 圈。到了就进下一节，并把累计清零（下一节从零开始转）
  if (Math.abs(s.accum) < DEG * s.turnsPerStage) return 0;
  return spinAdvance(s, now);
}

// ---- 跟 Electron 打交道的部分 -------------------------------------------------
// opts: { getWindow(), onCursor(payload|null), onSpin(stage) }
function createStageGaze(opts) {
  const o = opts || {};
  const spin = createSpinState({ turnsPerStage: Number(process.env.WHALE_SPIN_TURNS) });
  const { screen } = require('electron');
  let timer = null;
  let track = true;
  let head = null;              // 剪影报上来的 { x, top, span }，全是窗口比例
  let lastKey = '';
  let lastSentAt = 0;
  let lastPayload = null;
  let lastMoveAt = 0;
  let lastX = null;
  let lastY = null;
  let lastError = '';
  let lastDist = null;      // 指针到头的距离（px）：排查「为什么不触发」用
  let lastZoneR = null;

  function send(payload) {
    lastPayload = payload;
    try { if (o.onCursor) o.onCursor(payload); } catch (e) { lastError = e.message; }
  }

  function poll() {
    const win = o.getWindow && o.getWindow();
    if (!win || win.isDestroyed() || !win.isVisible() || !track) return;
    let p;
    try { p = screen.getCursorScreenPoint(); } catch (e) { return; }
    const [wx, wy] = win.getPosition();
    const [ww, wh] = win.getSize();
    const now = Date.now();

    let display = null;
    let petDisplay = null;
    try {
      display = screen.getDisplayNearestPoint(p);
      petDisplay = screen.getDisplayNearestPoint({ x: wx + Math.round(ww / 2), y: wy + Math.round(wh / 2) });
    } catch (e) { return; }

    let payload = null;
    let idleDrop = false;   // 这次的 null 是「鼠标静止太久」，不是离开屏幕

    if (display.id === petDisplay.id) {
      const cx = (p.x - wx) / Math.max(1, ww);
      const cy = (p.y - wy) / Math.max(1, wh);
      let x = clamp(cx * 2 - 1, -1, 1);
      let y = clamp(1 - cy * 2, -1, 1);
      if (Math.abs(x) < TUNE.deadZone && Math.abs(y) < TUNE.deadZone) { x = 0; y = 0; }
      payload = { x: +x.toFixed(3), y: +y.toFixed(3), inside: cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1 };

      // 绕圈判定：圆心是头，不是窗口中心（头在窗口上方，用窗口中心算会差半截）。
      // 只要指针在**她这扇窗里**就算（不设半径上限）：绕着整个身子转、绕着身子转半圈带着头，
      // 都该算数。真正「离开」由下面的 inside / 换屏判断，那才是清零的时候。
      const h = head || null;
      const hx = wx + ww * (h ? h.x : TUNE.headFallback.x);
      const hy = wy + wh * (h ? h.top + h.span * TUNE.headCenter : TUNE.headFallback.y);
      lastDist = Math.round(Math.hypot(p.x - hx, p.y - hy));
      lastZoneR = Math.round(Math.max(160, wh * TUNE.zoneR));
      let stage = 0;
      if (payload.inside) {
        stage = spinSample(spin, now, p.x - hx, p.y - hy, { zoneR: Infinity });
        if (stage && o.onSpin) { try { o.onSpin(stage); } catch (e) { lastError = e.message; } }
      } else {
        spinClear(spin);   // 指针挪出窗口：进度作废，别拿屏幕另一头的动作凑数
      }

      if (now < spin.suspendedUntil) payload = null;   // 发晕 / 生气期间不看鼠标

      if (payload) {
        if (payload.x !== lastX || payload.y !== lastY) {
          lastX = payload.x;
          lastY = payload.y;
          lastMoveAt = now;
        } else if (now - lastMoveAt > TUNE.idleMs) {
          payload = null;
          idleDrop = true;   // 鼠标长时间不动，当它已经离开
        }
      }
    }

    // 离开本屏 / 暂停追踪：记成「刚刚动过」，回到屏幕时立刻恢复跟手
    if (!payload && !idleDrop) lastMoveAt = now;

    const key = payload ? payload.x + ',' + payload.y : 'null';
    if (key !== lastKey || now - lastSentAt > TUNE.resendMs) {
      lastKey = key;
      lastSentAt = now;
      send(payload);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(poll, TUNE.pollMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    setTrack(on) {
      track = !!on;
      lastKey = '';
      if (!track) send(null);
      return track;
    },
    // 一节要转几圈：托盘/面板里能改，改完立即生效
    setSpinTurns(n) {
      const v = Math.round(Number(n));
      if (Number.isFinite(v) && v >= 2 && v <= 20) spin.turnsPerStage = v;
      return spin.turnsPerStage;
    },
    // 剪影标定完由页面报上来：{ x, top, span }，都是相对窗口的比例
    setHead(h) {
      if (!h || !Number.isFinite(h.x) || !Number.isFinite(h.top) || !Number.isFinite(h.span)) return false;
      head = { x: clamp(h.x, 0, 1), top: clamp(h.top, 0, 1), span: clamp(h.span, 0.01, 1) };
      return true;
    },
    // 手动挂起：比如以后托盘里「别看我」那种开关
    suspend(ms) {
      const until = Date.now() + Math.max(0, Number(ms) || 0);
      if (until > spin.suspendedUntil) spin.suspendedUntil = until;
      send(null);
      return Math.round(spin.suspendedUntil - Date.now());
    },
    // 演示 / 自检用：在内部按 16ms 一步走一圈假指针，把「判定 → 节号 → 反应」整条链路跑一遍。
    // 不碰真实鼠标（主人在用电脑的时候不能抢），判定和画面都是真的——只有输入是假的。
    simulateCircle(turns, opts) {
      const win = o.getWindow && o.getWindow();
      if (!win || win.isDestroyed()) return { error: 'no window' };
      const [ww, wh] = win.getSize();
      const radius = Number(opts && opts.r) > 0 ? Number(opts.r) : 160;
      const steps = Number(opts && opts.steps) > 0 ? Number(opts.steps) : 48;
      const zoneR = Math.max(160, wh * TUNE.zoneR);
      let now = Date.now();
      const fired = [];
      const n = Math.max(0.1, Number(turns) || 1);
      const total = Math.round(steps * n);
      for (let i = 0; i <= total + 1; i++) {
        const a = DEG * (i / steps);
        now += 16;
        const st = spinSample(spin, now, Math.cos(a) * radius, Math.sin(a) * radius, { zoneR });
        if (st) { fired.push(st); if (o.onSpin) { try { o.onSpin(st); } catch (e) { lastError = e.message; } } }
      }
      // 模拟是一口气跑完的，时间轴跑到真实时间前面去了；把三个截止点拉回真实时间，
      // 否则「发晕 3.6 秒」会变成「5 秒多」，跟真绕出来的手感对不上。
      const ahead = now - Date.now();
      spin.suspendedUntil -= ahead;
      spin.cooldownUntil -= ahead;
      spin.lastStageAt -= ahead;
      return { turns: n, fired };
    },
    state() {
      const now = Date.now();
      return {
        track,
        pointer: lastPayload ? { x: lastPayload.x, y: lastPayload.y, inside: lastPayload.inside } : null,
        head: head || null,
        dist: lastDist,
        zoneR: lastZoneR,
        idleMs: lastMoveAt ? Math.max(0, Math.round(now - lastMoveAt)) : null,
        spin: {
          stage: spin.stage,
          turns: +(Math.abs(spin.accum) / DEG).toFixed(2),
          need: spin.turnsPerStage,
          dir: spin.dir,
          suspendedMs: Math.max(0, Math.round(spin.suspendedUntil - now)),
          cooldownMs: Math.max(0, Math.round(spin.cooldownUntil - now)),
        },
        lastError: lastError || null,
      };
    },
  };
}

module.exports = { TUNE, createSpinState, spinSample, spinClear, createStageGaze };
