#!/usr/bin/env node
// ============================================================================
// 大肥鱼桌宠 · 指挥台（pet.mjs）
//
// 给「我」用的：把鲸语的语义动作语言包装成可以在任何会话里直接调的命令。
// 61942 = 舞台（/api/compile /api/execute /api/stop）
// 61943 = 外壳（/mood /say /sway /status）—— 气泡、语音、口型、待机摇摆
//
// 常用：
//   node pet.mjs state
//   node pet.mjs say "主人回来啦" --voice --emotion happy
//   node pet.mjs expr 脸红 --and look=down --and tilt=right
//   node pet.mjs gesture hand_on_chest
//   node pet.mjs nod 2
//   node pet.mjs sway --phys 0.2 --tilt 0.6 --period 4.0
//   node pet.mjs act '[{"kind":"look","direction":"down","at":0,"duration":1.2}]'
//   node pet.mjs stock
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 端口默认 61942/61943，可用环境变量或 data/config.json 覆盖
function readPorts() {
  let cfg = {};
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    cfg = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {}
  return {
    stage: Number(process.env.WHALE_PET_STAGE_PORT || cfg.stagePort) || 61942,
    mood: Number(process.env.WHALE_PET_MOOD_PORT || cfg.moodPort) || 61943,
  };
}
const PORTS = readPorts();
const STAGE = `http://127.0.0.1:${PORTS.stage}`;
const SHELL = `http://127.0.0.1:${PORTS.mood}`;

const argv = process.argv.slice(2);
const cmd = argv[0];

function parseFlags(list) {
  const out = { _: [], and: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--and') { const v = list[i + 1]; if (v && !v.startsWith('--')) { out.and.push(v); i++; } continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nxt = list[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--')) { out[k] = nxt; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}
const F = parseFlags(argv.slice(1));
const arg = (name) => (F[name] === undefined || F[name] === true ? undefined : String(F[name]));
const num = (name, dflt) => { const v = Number(F[name]); return Number.isFinite(v) ? v : dflt; };

async function jpost(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
async function jget(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return { status: r.status, data: await r.json().catch(() => null) };
}

// ---------------------------------------------------------------- 动作积木
// 所有动作 = {kind, at, duration, ...}；at 是计划内起点秒数。
function A(kind, opt) {
  const o = { kind, at: num('at', 0), duration: num('duration', 2.2), ...opt };
  return o;
}

function buildActions() {
  const acts = [];
  const at0 = num('at', 0);
  // 主命令
  switch (cmd) {
    case 'expr': {
      const name = F._[0];
      if (!name) throw new Error('expr 需要一个表情名（node pet.mjs stock 看列表）');
      acts.push(A('expression', { name, strength: num('strength', 0.9), layer: arg('layer') || 'exclusive' }));
      break;
    }
    case 'gesture': {
      const name = F._[0];
      if (!name) throw new Error('gesture 需要 hand_on_chest / point / grass');
      acts.push(A('gesture', { name, duration: num('duration', 2.6) }));
      break;
    }
    case 'look': acts.push(A('look', { direction: F._[0] || arg('direction') || 'center', duration: num('duration', 1.2) })); break;
    case 'nod': acts.push(A('nod', { count: Math.max(1, Math.min(4, parseInt(F._[0] || '2', 10) || 2)), duration: num('duration', 1.4) })); break;
    case 'shake': case 'shake_head': acts.push(A('shake_head', { count: Math.max(1, Math.min(4, parseInt(F._[0] || '2', 10) || 2)), duration: num('duration', 1.6) })); break;
    case 'tilt': acts.push(A('tilt', { direction: F._[0] === 'left' ? 'left' : 'right', duration: num('duration', 1.8) })); break;
    case 'blink': acts.push(A('blink', { side: arg('side') || 'both', count: Math.max(1, Math.min(4, parseInt(F._[0] || '1', 10) || 1)), duration: num('duration', 0.4) })); break;
    case 'smile': acts.push(A('smile', { duration: num('duration', 1.8) })); break;
    case 'talk': acts.push(A('talk', { duration: num('duration', 2.4) })); break;
    case 'pose': {
      const values = {};
      for (const kv of F._) {
        const [k, v] = kv.split('=');
        const n = Number(v);
        if (k && Number.isFinite(n)) values[k.trim()] = n;
      }
      if (!Object.keys(values).length) throw new Error('pose 需要 k=v，例如 LeanInput=8 AngleZ=6');
      acts.push(A('pose', { values, duration: num('duration', 2.2) }));
      break;
    }
    case 'act': {
      const raw = arg('json') || F._[0];
      if (!raw) throw new Error('act 需要 JSON 数组');
      const parsed = JSON.parse(raw);
      for (const a of Array.isArray(parsed) ? parsed : [parsed]) acts.push(a);
      break;
    }
    default: break;
  }
  // --and 追加：look=down / tilt=right / expr=脸红 / nod=2
  for (const spec of F.and) {
    const [k, v] = spec.split('=');
    const key = (k || '').trim();
    const val = (v || '').trim();
    const at = num('and-at', at0 + 0.3);
    if (key === 'look') acts.push({ kind: 'look', direction: val || 'center', at, duration: num('duration', 1.2) });
    else if (key === 'tilt') acts.push({ kind: 'tilt', direction: val === 'left' ? 'left' : 'right', at, duration: 1.8 });
    else if (key === 'nod') acts.push({ kind: 'nod', count: parseInt(val || '1', 10) || 1, at, duration: 1.4 });
    else if (key === 'shake') acts.push({ kind: 'shake_head', count: parseInt(val || '1', 10) || 1, at, duration: 1.6 });
    else if (key === 'expr') acts.push({ kind: 'expression', name: val, strength: num('strength', 0.9), layer: 'exclusive', at, duration: 2.4 });
    else if (key === 'gesture') acts.push({ kind: 'gesture', name: val, at, duration: 2.6 });
    else if (key === 'pose') { const values = {}; for (const p of val.split(',')) { const [pk, pv] = p.split(':'); if (pk && Number.isFinite(Number(pv))) values[pk.trim()] = Number(pv); } acts.push({ kind: 'pose', values, at, duration: 2.2 }); }
  }
  return acts;
}

function planOf(actions, title) {
  const t = title || `pet · ${actions.map((a) => a.kind).join('+')}`;
  return { version: 1, title: t, intent: t, summary: t, actions };
}

async function execute(plan) {
  const compiled = await jpost(`${STAGE}/api/compile`, { plan });
  if (compiled.status !== 200) return { ok: false, stage: 'compile', ...compiled };
  if (compiled.data && compiled.data.ok === false) return { ok: false, stage: 'compile', ...compiled };
  let r = await jpost(`${STAGE}/api/execute`, { plan, backend: 'web' });
  // 上一段动作还没播完 → 等它收尾再试（引擎比理论时长晚一点点放开）
  for (let i = 0; i < 6 && r.status === 400 && /正在执行/.test(JSON.stringify(r.data || '')); i++) {
    await new Promise((res) => setTimeout(res, 260));
    r = await jpost(`${STAGE}/api/execute`, { plan, backend: 'web' });
  }
  if (r.status === 400 && F.force) {
    await jpost(`${STAGE}/api/stop`, {});
    await new Promise((res) => setTimeout(res, 160));
    r = await jpost(`${STAGE}/api/execute`, { plan, backend: 'web' });
  }
  return { ok: r.status === 200 || r.status === 201, stage: 'execute', ...r };
}

const planSeconds = (actions) => Math.max(0.4, ...actions.map((a) => Number(a.at || 0) + Number(a.duration || 2.2)));

// ---------------------------------------------------------------- 主流程
async function main() {
  if (!cmd || cmd === 'help' || cmd === '-h') return console.log(USAGE.trim());

  if (cmd === 'state') {
    const s = await jget(`${SHELL}/status`);
    const sw = await jget(`${SHELL}/sway`);
    const st = await jget(`${STAGE}/api/state`);
    const jobs = ((st.data && st.data.jobs) || []).slice(-4).map((j) => ({ id: j.id, intent: j.intent, status: j.status, progress: j.progress }));
    const out = {
      ready: !!(st.data && st.data.ready),
      voicing: !!(s.data && s.data.voicing),
      lastSay: s.data && s.data.lastSay ? { text: s.data.lastSay.text, dur: s.data.lastSay.dur, at: new Date(s.data.lastSay.at).toLocaleTimeString() } : null,
      sway: sw.data && { on: sw.data.on, phys: sw.data.phys, tilt: sw.data.tilt, period: sw.data.period },
      jobs,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === 'stock') {
    const caps = (await jget(`${STAGE}/api/capabilities`)).data || {};
    const ex = caps.actions?.expression?.name || [];
    const ge = caps.gestures || {};
    console.log('表情 ' + ex.length + '：' + ex.join(' / '));
    console.log('手势：' + Object.entries(ge).map(([k, v]) => `${k}（${v.label}）`).join(' / '));
    console.log('动作：trajectory / look / nod / shake_head / tilt / smile / blink / expression / gesture / talk / pose');
    return;
  }

  if (cmd === 'dock') {
    // 启动时贴到某个窗口旁边：node pet.mjs dock [left|right|none] [--title "DeepSeek Harness"]
    const a = String(F._[0] || '').toLowerCase();
    const mode = ['left', 'right', 'none'].includes(a) ? a : null;
    if (!mode) {
      console.log(JSON.stringify({ ok: true, dock: (await jget(`${SHELL}/status`)).data?.dock ?? 'none' }, null, 2));
      return;
    }
    const title = arg('title');
    const r = await jpost(`${SHELL}/dock`, { mode, ...(title ? { title } : {}) });
    console.log(JSON.stringify({ status: r.status, ...(r.data || {}) }, null, 2));
    return;
  }

  if (cmd === 'interactive') {
    const a = String(F._[0] || '').toLowerCase();
    if (a === 'on' || a === 'off') {
      const r = await jpost(`${SHELL}/interactive`, { on: a === 'on' });
      console.log(JSON.stringify({ ok: r.status === 200, interactive: (r.data && r.data.interactive) }, null, 2));
    } else {
      const r = await jget(`${SHELL}/interactive`);
      console.log(JSON.stringify({ ok: r.status === 200, interactive: (r.data && r.data.interactive) }, null, 2));
    }
    return;
  }

  if (cmd === 'bridge') {
    // 模型桥接：点触要不要叫醒 DSH 会话。node pet.mjs bridge on|off
    const a = String(F._[0] || '').toLowerCase();
    const r = (a === 'on' || a === 'off')
      ? await jpost(`${SHELL}/bridge`, { on: a === 'on' })
      : await jget(`${SHELL}/bridge`);
    console.log(JSON.stringify({ ok: r.status === 200, ...(r.data || {}) }, null, 2));
    return;
  }

  if (cmd === 'peek') {
    // 窥屏：她自己隔一阵瞄一眼屏幕再主动开口。node pet.mjs peek on|off|now|（空=读状态）
    // 走桥插件（61944），不是桌宠壳——定时器活在 DSH 那边，壳子关了也不影响判断。
    // peek interval <分钟> 换基准间隔：热改，不用重启，落 pet-bridge.json。
    const BRIDGE = process.env.WHALE_PET_BRIDGE_URL || 'http://127.0.0.1:61944';
    const a = String(F._[0] || '').toLowerCase();
    let r;
    if (a === 'on' || a === 'off') r = await jpost(`${BRIDGE}/peek`, { on: a === 'on' });
    else if (a === 'now') r = await jpost(`${BRIDGE}/peek`, { now: true });
    else if (a === 'interval') {
      const m = Number(F._[1]);
      if (!Number.isFinite(m) || m <= 0) {
        const cur = await jget(`${BRIDGE}/peek`);
        const base = cur.data && cur.data.baseMs;
        console.log(base ? `现在是 ${Math.round(base / 60000)} 分钟一次` : '读不到当前间隔');
        return;
      }
      r = await jpost(`${BRIDGE}/peek`, { minutes: m });
    } else r = await jget(`${BRIDGE}/peek`);
    if (r.status !== 200) {
      console.log('失败：桥插件没在跑？(' + ((r.data && r.data.error) || r.status) + ')');
      return;
    }
    if (a === 'interval' && r.data && r.data.baseMs) {
      console.log(`好了，每 ${Math.round(r.data.baseMs / 60000)} 分钟瞄一次`
        + (r.data.factor !== 1 ? `（情绪让它缩到 ${Math.max(1, Math.round(r.data.intervalMs / 60000))} 分钟）` : ''));
      return;
    }
    console.log(JSON.stringify(r.data, null, 2));
    return;
  }

  if (cmd === 'mood') {
    // 情绪：她现在什么心情、因为什么。node pet.mjs mood | reset | urge
    // reset = 一键哄好，把账本清空。走桥插件（61944），状态活在 DSH 那边。
    // urge  = 立刻问她一句想不想自己开口（跟定时那条共用同一套判断）
    // intensity <quiet|normal|clingy|chatty> = 换浓度，随手拨，不用重启
    const BRIDGE = process.env.WHALE_PET_BRIDGE_URL || 'http://127.0.0.1:61944';
    const a = String(F._[0] || '').toLowerCase();
    const b = String(F._[1] || '').toLowerCase();
    const r = a === 'reset' ? await jpost(`${BRIDGE}/mood`, { reset: true })
      : a === 'urge' ? await jpost(`${BRIDGE}/mood`, { urge: true })
      : a === 'intensity' ? await jpost(`${BRIDGE}/mood`, { intensity: b })
      : await jget(`${BRIDGE}/mood`);
    if (r.status !== 200) {
      const opts = (r.data && r.data.options) || [];
      console.log('失败：' + ((r.data && r.data.error) || '桥插件没在跑？' + r.status)
        + (opts.length ? '　可选：' + opts.join(' / ') : ''));
      return;
    }
    const d = r.data || {};
    if (d.enabled === false) {
      console.log('情绪没开。配置里给 pet-bridge 加 mood: true，然后重启 DSH。');
      return;
    }
    const snap = d.snapshot || {};
    const axes = snap.axes || {};
    const pct = (n) => (n >= 0 ? '+' : '') + Math.round((Number(n) || 0) * 100);
    console.log(`${d.summary || ''}`);
    console.log(`档位 ${snap.tier || '-'}　亲近 ${pct(axes.closeness)}　心情 ${pct(axes.valence)}　想说话 ${pct(axes.expression)}`);
    if (axes.arousal != null || axes.dominance != null) {
      console.log(`形态　绷 ${pct(axes.arousal)}　势 ${pct(axes.dominance)}`);
    }
    if (snap.idleMinutes != null) console.log(`已经 ${Math.floor(snap.idleMinutes / 60)} 小时 ${snap.idleMinutes % 60} 分钟没人理她`);
    const vals = Object.entries(snap.values || {}).filter(([, v]) => v > 0.01);
    if (vals.length) console.log('账本：' + vals.map(([k, v]) => `${k}=${v.toFixed(2)}`).join('　'));
    if (d.log && d.log.length) {
      console.log('最近：');
      for (const e of d.log.slice(0, 5)) {
        const t = new Date(e.at).toLocaleTimeString('zh-CN');
        console.log(`  ${t}　${e.emotion} ${e.delta > 0 ? '+' : ''}${Number(e.delta).toFixed(2)}　${e.reason || ''}`);
      }
    }
    if (a === 'reset') console.log('（已经哄好了）');
    if (a === 'urge') {
      const u = d.urgeResult || {};
      if (u.spoke) {
        const where = u.steps > 1 ? `${u.window} 第${u.step + 1}/${u.steps}句` : u.window;
        console.log(`她开口了：${where}`);
      } else {
        console.log(`没开口：${u.why || '?'}`);
      }
    }
    if (a === 'intensity') console.log(`浓度拨到 ${d.intensity}`);
    const au = d.urge || {};
    if (au.enabled) {
      const win = Object.entries(au.windows || {}).filter(([, v]) => v.today > 0);
      console.log(`主动开口：浓度 ${au.intensity || '-'}　今天 ${au.today || 0} 句`
        + (au.dayCap ? ' / 上限 ' + au.dayCap : '')
        + (win.length ? '　' + win.map(([k, v]) => `${k}×${v.today}`).join('　') : ''));
      if (au.burst) {
        const b = au.burst;
        console.log(`正说到 ${b.window} 第 ${b.step + 1} 句，下一句还有 ${b.nextInSec} 秒`);
      }
    } else {
      console.log('主动开口：没开。配置里加 moodUrge: true。');
    }
    return;
  }

  if (cmd === 'fps') {
    // 舞台帧率上限：不设就是跟着显示器刷新率跑（144/165Hz 会白烧 CPU）
    const a = String(F._[0] || '').toLowerCase();
    const r = a === '' ? await jget(`${SHELL}/fps`) : await jpost(`${SHELL}/fps`, { fps: Number(a) });
    if (r.status !== 200) { console.log('失败：' + ((r.data && r.data.error) || r.status)); return; }
    console.log(JSON.stringify({ ok: true, fps: r.data.fps }, null, 2));
    return;
  }

  if (cmd === 'zones') {
    const force = !!(F.scan || F.force || F._[0] === 'scan');
    const r = await jget(`${SHELL}/zones${force ? '/scan' : ''}`);
    const z = (r.data && r.data.zones) || null;
    if (!z || !z.ok) {
      console.log('扫描失败：' + ((z && z.error) || (r.data && r.data.error) || 'unknown'));
      return;
    }
    const b = z.bbox;
    const rows = z.rows || [];
    const h = Math.max(0.001, b.bottom - b.top);
    const maxW = Math.max(0.001, ...rows.map((x) => x.w));
    console.log(`剪影 top=${b.top.toFixed(3)} bottom=${b.bottom.toFixed(3)} left=${b.left.toFixed(3)} right=${b.right.toFixed(3)}（行 ${rows.length}，${r.data.cached ? '缓存' : '刚扫'}）`);
    console.log(`脖子最窄点 ny=${z.neck ? z.neck.y.toFixed(3) : 'n/a'}（这是分区要用的锚点）`);
    console.log('身体比例  宽度  轮廓');
    for (const row of rows) {
      const p = (row.y - b.top) / h;
      if (p < -0.01 || p > 1.01) continue;
      const pct = Math.round(p * 100);
      if (pct % 2 !== 0) continue;
      console.log(`${String(pct).padStart(3)}%  ${row.w.toFixed(3)}  ${'#'.repeat(Math.round((row.w / maxW) * 42))}`);
    }
    return;
  }

  if (cmd === 'say') {
    const text = F._[0] || arg('text');
    if (!text) throw new Error('say 需要文本');
    const body = {
      text,
      voice: !!F.voice,
      emotion: arg('emotion') || undefined,
      gesture: arg('gesture') || undefined,
      ms: num('ms', Math.max(3000, String(text).length * 220 + 1800)),
    };
    const r = await jpost(`${SHELL}/say`, body);
    console.log(JSON.stringify({ ok: r.status === 200, ...r }, null, 2));
    return;
  }

  if (cmd === 'reply') {
    // 替主人回她一句：等价于点气泡上的小钮、打完字回车（走 DSH 侧的桌宠专用会话）
    const text = F._[0] || arg('text');
    if (!text) throw new Error('reply 需要文本');
    const r = await jpost(`${SHELL}/reply`, { text });
    console.log(JSON.stringify({ ok: r.status === 200, ...r.data }, null, 2));
    return;
  }

  if (cmd === 'mood') {    const r = await jpost(`${SHELL}/mood`, { emotion: F._[0], intensity: num('intensity', 0.7) });
    console.log(JSON.stringify({ status: r.status, ...r.data }, null, 2));
    return;
  }

  if (cmd === 'touch') {
    // 模拟「主人点了这里」：node pet.mjs touch head|chest|waist|skirt|leg|foot|neck|hair|body
    const zone = String(F._[0] || 'head');
    const r = await jpost(`${SHELL}/touch`, { zone, nx: num('nx', 0.5), ny: num('ny', 0.2) });
    console.log(JSON.stringify({ status: r.status, ...r.data }, null, 2));
    return;
  }

  if (cmd === 'touches') {
    // 最近点触记录：node pet.mjs touches 20
    const n = Number(F._[0]) || 20;
    const r = await jget(`${SHELL}/touches?limit=${n}`);
    console.log(JSON.stringify(r.data, null, 2));
    return;
  }

  if (cmd === 'sway') {
    const patch = {};
    for (const k of ['phys', 'tilt', 'period', 'pivot', 'mix']) if (F[k] !== undefined) patch[k] = Number(F[k]);
    if (F.on) patch.on = true;
    if (F.off) patch.on = false;
    const r = await jpost(`${SHELL}/sway`, patch);
    console.log(JSON.stringify(r.data, null, 2));
    return;
  }

  if (cmd === 'size') {
    const w = Number(F._[0]) || 380, h = Number(F._[1]) || 680;
    const r = await jpost(`${SHELL}/size`, { width: w, height: h });
    console.log(JSON.stringify(r.data, null, 2));
    return;
  }

  if (cmd === 'panel') {
    // 打开尺寸滑杆面板（和托盘「尺寸（滑杆调整）」同一个）
    const r = await jpost(`${SHELL}/panel`, {});
    console.log(JSON.stringify(r.data, null, 2));
    return;
  }

  if (cmd === 'cursor') {
    // 指针追踪：node pet.mjs cursor          读状态
    //           node pet.mjs cursor on|off   开/关（存 config.json）
    //           node pet.mjs cursor spin     手动推一节「绕圈生气」（调试）
    //           node pet.mjs cursor reset    清掉生气阶段与冷却
    const v = String(F._[0] || '');
    if (v === undefined || v === '') { const r = await jget(`${SHELL}/cursor`); console.log(JSON.stringify(r.data, null, 2)); return; }
    if (v === 'spin') { const r = await jpost(`${SHELL}/cursor`, { spin: true }); console.log(JSON.stringify(r.data, null, 2)); return; }
    if (v === 'reset') { const r = await jpost(`${SHELL}/cursor`, { reset: true }); console.log(JSON.stringify(r.data, null, 2)); return; }
    const r = await jpost(`${SHELL}/cursor`, { on: !/^(off|0|false|no)$/i.test(v) });
    console.log(JSON.stringify(r.data, null, 2));
    return;
  }

  if (cmd === 'fit') {
    const r = await jpost(`${SHELL}/fit`, { fit: F._[0] === 'portrait' || F._[0] === '近景' ? 'portrait' : 'full' });
    console.log(JSON.stringify(r.data, null, 2));
    return;
  }

  if (cmd === 'volume') {
    // 不带参数 = 读；带参数 = 设（0..1，也接受 60 这种百分数）
    const raw = F._[0];
    if (raw === undefined) {
      const s = await jget(`${SHELL}/status`);
      console.log(JSON.stringify({ volume: s.data && s.data.volume }, null, 2));
      return;
    }
    let v = Number(raw);
    if (Number.isFinite(v) && v > 1) v = v / 100;
    const r = await jpost(`${SHELL}/volume`, { volume: v });
    console.log(JSON.stringify(r.data, null, 2));
    return;
  }

  if (cmd === 'stop') {
    await jpost(`${STAGE}/api/stop`, {});
    console.log('{"ok":true}');
    return;
  }

  // 其余 = 组一个动作计划
  const actions = buildActions();
  if (!actions.length) return console.log(USAGE.trim());
  const plan = planOf(actions, arg('title'));
  const r = await execute(plan);
  const secs = planSeconds(actions);
  if (F.json) return console.log(JSON.stringify({ ...r, seconds: secs }, null, 2));
  if (!r.ok) {
    console.log(JSON.stringify({ ok: false, stage: r.stage, status: r.status, data: r.data }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(`ok ${actions.map((a) => a.kind).join('+')}  ${secs.toFixed(1)}s`);
  if (F.wait) await new Promise((res) => setTimeout(res, Math.round(secs * 1000)));
}

const USAGE = `
大肥鱼桌宠指挥台

  state                          看她现在在干什么
  stock                          列出可用表情 / 手势
  say "文本" --voice --emotion e  气泡 + 口型（--voice 现场合成，3~10 秒）
         [--gesture hand_on_chest]  说话时同时做手势（同帧下发，不排队）
  reply "文本"                   替主人回她一句（投给桌宠专用会话，等于点气泡上的回复钮）
  mood <name> [--intensity 0.7]  15 个预设情绪
  touch [zone]                   模拟点她一下（head/chest/waist/skirt/leg/foot/neck/hair）
  touches [n]                    最近 n 条点触记录（主人点了哪儿）
  zones [scan]                   量模型剪影轮廓，看分区对不对（换模型/换装后跑 scan 重标）
  interactive [on|off]           分区互动总开关（不带参数=读）
  bridge [on|off]                模型桥接：点她要不要叫醒 DSH 会话（不带参数=读）
  fps [n]                        舞台帧率上限（不带参数=读；60 默认，0 = 不限）
  dock [left|right|none] [--title "..."]  启动时贴到窗口旁边（默认找 DSH；不带参数=读）
  expr <表情> [--strength 0.9]   24 个表情
  gesture <name>                  hand_on_chest / point / grass
  look <left|right|up|down|center>
  nod [n] / shake [n] / tilt <left|right> / blink [n] / smile / talk
  pose "AngleZ=8 LeanInput=6"    直接写语义参数
  act '<json>'                   原始动作数组（逃生口）
  sway --phys 0.2 --tilt 0.6 --period 4.0 [--on|--off]
  size <宽> <高>                  改窗口大小
  panel                          打开尺寸滑杆面板（托盘「尺寸（滑杆调整）」）
  fit <full|portrait>            全身 / 近景
  cursor [on|off]                指针追踪（眼睛+头+身子跟着鼠标；不带参数=读）
  volume [0..1 或 0..100]        语音音量（不带参数=读）
  peek [on|off|now|interval <分>] 窥屏：隔一阵自己瞄屏幕再搭话；interval 换间隔（不用重启）
  mood [reset|urge|intensity <档>]  心情 / 哄好 / 立刻问她想不想开口 / 换主动开口的浓度
  stop                           停住并回待机

  任意动作可追加： --at 秒  --duration 秒  --and look=down --and tilt=right
                 --force（打断正在播放的动作）  --wait（等到演完）
`;

main().catch((e) => { console.error('ERR ' + e.message); process.exitCode = 1; });
