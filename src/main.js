const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');

// —— 配置：所有外部依赖（鲸语仓库 / 模型 / Python / 端口 / 可选集成）都在 data/config.json ——
const CFG = require('./config');
const DATA = CFG.DATA_DIR;
app.setPath('userData', DATA);
app.setAppUserModelId('com.whale.pet.shell');
if (!app.requestSingleInstanceLock()) app.quit();

const loadCfg = CFG.load;
const saveCfg = CFG.save;

// 运行时路径对象；改了配置就调 refreshPaths() 重新摊平
let R = CFG.resolve();
let BASE = R.repo;          // 鲸语仓库目录（含 server.py）
let MODEL = R.model;        // 模型目录
let PYTHON = R.python;      // Python 解释器
let PORT = R.stagePort;     // 鲸语舞台端口
let REPO = BASE;
let MOOD_PORT = R.moodPort; // 本壳子的控制端口（情绪 / 气泡 / 指针 / 尺寸）
function refreshPaths() {
  R = CFG.resolve();
  BASE = R.repo; MODEL = R.model; PYTHON = R.python; PORT = R.stagePort; REPO = BASE; MOOD_PORT = R.moodPort;
  return R;
}
const stageUrl = (fit) => `http://127.0.0.1:${PORT}/?stage=1${fit === 'full' ? '&fit=full' : ''}&fps=${stageFpsOf()}`;
// 舞台帧率：高刷屏（144/165Hz）上 rAF 会跑满，Live2D 每帧要做参数求解+物理+蒙皮，白烧 CPU。
// 默认锁 60，0 = 不限。改完要重载舞台页面才生效。
const stageFpsOf = (cfg) => {
  const v = Number((cfg || loadCfg()).stageFps);
  return Number.isFinite(v) && v >= 0 ? v : 60;
};
// 存新的帧率并重载舞台（面板和 /fps 都走这里）。只重载页面，不动窗口也不重启。
function applyStageFps(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 240) return false;
  saveCfg({ stageFps: Math.round(n) });
  if (win && !win.isDestroyed()) win.loadURL(stageUrl(loadCfg().fit)).catch(() => {});
  return true;
}
const LOG_FILE = path.join(DATA, 'pet.log');
function plog(msg) {
  try { fs.mkdirSync(DATA, { recursive: true }); fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

let win = null, tray = null, panel = null, serverChild = null, spawnedServer = false;
let dragTimer = null, smart = true, alwaysOnTop = true, interactive = true, bridgeOn = true, replyBtnOn = true;
let watcherChild = null, autoMood = true, voicing = false, voicingTimer = null;
function setVoicing(on, ms = 0) {
  if (voicingTimer) { clearTimeout(voicingTimer); voicingTimer = null; }
  if (on) {
    voicing = true;
    if (ms > 0) {
      voicingTimer = setTimeout(() => { voicing = false; voicingTimer = null; }, ms);
    }
  } else {
    voicing = false;
  }
}
let voiceVolume = 0.5;   // 0..1，持久化在 config.json 的 voiceVolume
let lastSay = null;   // 最近一次实时合成的结果（给演示脚本判断节奏用）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 资源目录：assets 在仓库根，也就是 src 的上一层；打包后可能被搬到 resources 下，几处都试一遍。
// 以前这里少了 '..'，createFromPath 找不到文件就返回空图，托盘图标于是永远空白。
function assetPath(name) {
  const cands = [
    path.join(__dirname, '..', 'assets', name),
    path.join(__dirname, 'assets', name),
    path.join(process.resourcesPath || '', 'assets', name),
  ];
  for (const p of cands) { try { if (fs.existsSync(p)) return p; } catch {} }
  return cands[0];
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout: 800 }, (res) => { res.resume(); resolve(true); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function startServer() {
  if (serverChild) return;
  serverChild = spawn(PYTHON, ['-u', 'server.py', '--port', String(PORT)], {
    cwd: REPO,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, L2D_MODEL_DIR: MODEL, PYTHONIOENCODING: 'utf-8' },
  });
  spawnedServer = true;
  serverChild.on('exit', () => { serverChild = null; });
}

const MOODS = {
  happy: [['expression', { at: 0, duration: 2.6, name: '爱心眼', strength: 0.85, layer: 'exclusive' }], ['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { LeanInput: 10, AngleZ: 7, PositionX: 4, AngleY: -4 } }, { time: 0.9, values: { LeanInput: 14, AngleZ: 9, PositionX: 6, AngleY: 3 } }, { time: 1.6, values: { LeanInput: 9, AngleZ: 6, PositionX: 3, AngleY: -2 } }, { time: 2.2, values: { LeanInput: 3, AngleZ: 2, PositionX: 1, AngleY: 0 } }] }]],
  shy: [['expression', { at: 0, duration: 2.6, name: '脸红', strength: 0.9, layer: 'exclusive' }], ['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { LeanInput: 12, AngleZ: 9, AngleX: -12 } }, { time: 0.9, values: { LeanInput: 9, AngleZ: 7, AngleX: -9 } }, { time: 1.6, values: { LeanInput: 7, AngleZ: 5, AngleX: -6 } }, { time: 2.2, values: { LeanInput: 2, AngleZ: 2, AngleX: -2 } }] }]],
  excited: [['expression', { at: 0, duration: 2.6, name: '兔牙', strength: 0.9, layer: 'exclusive' }], ['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { LeanInput: 14, AngleZ: 10, PositionX: 6, AngleY: -6 } }, { time: 0.7, values: { LeanInput: 20, AngleZ: 13, PositionX: 9, AngleY: 5 } }, { time: 1.4, values: { LeanInput: 13, AngleZ: 9, PositionX: 5, AngleY: -3 } }, { time: 2.2, values: { LeanInput: 3, AngleZ: 2, PositionX: 1, AngleY: 0 } }] }]],
  thinking: [['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.3, values: { AngleY: 9, AngleZ: 5, LeanInput: 5 } }, { time: 1.0, values: { AngleY: 7, AngleZ: 4, LeanInput: 4 } }, { time: 1.7, values: { AngleY: 6, AngleZ: 3, LeanInput: 3 } }, { time: 2.2, values: { AngleY: 2, AngleZ: 1, LeanInput: 1 } }] }]],
  sleepy: [['expression', { at: 0, duration: 2.6, name: '眯眼', strength: 0.85, layer: 'exclusive' }], ['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { LeanInput: 9, AngleZ: 7, AngleY: -7, PositionY: -2 } }, { time: 0.9, values: { LeanInput: 11, AngleZ: 9, AngleY: -9, PositionY: -3 } }, { time: 1.6, values: { LeanInput: 9, AngleZ: 7, AngleY: -7, PositionY: -2 } }, { time: 2.2, values: { LeanInput: 3, AngleZ: 2, AngleY: -2, PositionY: 0 } }] }]],
  proud: [['expression', { at: 0, duration: 2.6, name: '屑屑眼', strength: 0.9, layer: 'exclusive' }], ['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { AngleY: -9, LeanInput: 6, AngleZ: -4 } }, { time: 0.9, values: { AngleY: -7, LeanInput: 5, AngleZ: -3 } }, { time: 1.6, values: { AngleY: -6, LeanInput: 4, AngleZ: -3 } }, { time: 2.2, values: { AngleY: -2, LeanInput: 1, AngleZ: -1 } }] }]],
  sad: [['expression', { at: 0, duration: 2.6, name: '流泪', strength: 0.75, layer: 'exclusive' }], ['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { AngleY: 9, LeanInput: -6, AngleZ: -4, PositionY: -2 } }, { time: 0.9, values: { AngleY: 10, LeanInput: -7, AngleZ: -5, PositionY: -3 } }, { time: 1.6, values: { AngleY: 8, LeanInput: -5, AngleZ: -3, PositionY: -2 } }, { time: 2.2, values: { AngleY: 2, LeanInput: -1, AngleZ: -1, PositionY: 0 } }] }]],
  annoyed: [['expression', { at: 0, duration: 2.6, name: '屑屑眼', strength: 0.9, layer: 'exclusive' }], ['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { AngleX: 9, LeanInput: 6, AngleZ: 4 } }, { time: 0.8, values: { AngleX: -9, LeanInput: 6, AngleZ: -4 } }, { time: 1.4, values: { AngleX: 7, LeanInput: 5, AngleZ: 3 } }, { time: 2.2, values: { AngleX: 0, LeanInput: 0, AngleZ: 0 } }] }]],
  surprised: [['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { LeanInput: -9, AngleZ: -7, AngleY: -9, PositionY: 3, ParamEyeLOpen: 1.35, ParamEyeROpen: 1.35, ParamBrowLY: 0.6, ParamBrowRY: 0.6 } }, { time: 0.9, values: { LeanInput: -6, AngleZ: -5, AngleY: -6, PositionY: 2, ParamEyeLOpen: 1.3, ParamEyeROpen: 1.3, ParamBrowLY: 0.5, ParamBrowRY: 0.5 } }, { time: 1.6, values: { LeanInput: -4, AngleZ: -3, AngleY: -4, PositionY: 1, ParamEyeLOpen: 1.15, ParamEyeROpen: 1.15, ParamBrowLY: 0.3, ParamBrowRY: 0.3 } }, { time: 2.2, values: { LeanInput: 0, AngleZ: 0, AngleY: 0, PositionY: 0, ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamBrowLY: 0, ParamBrowRY: 0 } }] }]],
  greeting: [['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { AngleY: -9, LeanInput: 5 } }, { time: 0.7, values: { AngleY: 7, LeanInput: 7 } }, { time: 1.3, values: { AngleY: -5, LeanInput: 5 } }, { time: 2.2, values: { AngleY: 0, LeanInput: 0 } }] }]],
  playful: [['expression', { at: 0, duration: 2.6, name: '兔牙', strength: 0.85, layer: 'exclusive' }], ['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { AngleZ: 12, LeanInput: 8, AngleX: 7 } }, { time: 0.9, values: { AngleZ: 10, LeanInput: 7, AngleX: 5 } }, { time: 1.6, values: { AngleZ: 8, LeanInput: 6, AngleX: 3 } }, { time: 2.2, values: { AngleZ: 2, LeanInput: 1, AngleX: 0 } }] }]],
  neutral: [['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.3, values: { AngleZ: 3, LeanInput: 2 } }, { time: 1.0, values: { AngleZ: 2, LeanInput: 2 } }, { time: 1.7, values: { AngleZ: 1, LeanInput: 1 } }, { time: 2.2, values: { AngleZ: 0, LeanInput: 0 } }] }]],
  flustered: [['expression', { at: 0, duration: 2.6, name: '流冷汗', strength: 0.8, layer: 'exclusive' }], ['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { AngleX: -11, LeanInput: 8 } }, { time: 0.8, values: { AngleX: 11, LeanInput: 8 } }, { time: 1.4, values: { AngleX: -7, LeanInput: 6 } }, { time: 2.2, values: { AngleX: 0, LeanInput: 0 } }] }]],
  confused: [['expression', { at: 0, duration: 2.6, name: '圈圈眼', strength: 0.85, layer: 'exclusive' }], ['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { AngleZ: -12, LeanInput: 7 } }, { time: 0.9, values: { AngleZ: -10, LeanInput: 6 } }, { time: 1.6, values: { AngleZ: -8, LeanInput: 5 } }, { time: 2.2, values: { AngleZ: -2, LeanInput: 1 } }] }]],
  pout: [['trajectory', { at: 0, duration: 2.4, frames: [{ time: 0.2, values: { LeanInput: -10, AngleZ: -8, AngleX: -8, ParamEyeLOpen: 0.2, ParamEyeROpen: 0.2, BrowInnerUp: 0.7, ParamMouthForm: -0.7 } }, { time: 0.9, values: { LeanInput: -8, AngleZ: -7, AngleX: -6, ParamEyeLOpen: 0.25, ParamEyeROpen: 0.25, BrowInnerUp: 0.6, ParamMouthForm: -0.6 } }, { time: 1.6, values: { LeanInput: -6, AngleZ: -5, AngleX: -4, ParamEyeLOpen: 0.4, ParamEyeROpen: 0.4, BrowInnerUp: 0.4, ParamMouthForm: -0.4 } }, { time: 2.2, values: { LeanInput: -1, AngleZ: -1, AngleX: -1, ParamEyeLOpen: 1, ParamEyeROpen: 1, BrowInnerUp: 0, ParamMouthForm: 0 } }] }]],
};
let lastInteract = Date.now(), lastMood = 0, lastTap = 0;

const MOOD_SCALE = 1.9; // 身体/头部动作统一放大倍数（调幅度就改这里）
const SCALE_KEYS = new Set(['LeanInput', 'AngleX', 'AngleY', 'AngleZ', 'PositionX', 'PositionY', 'PositionZ']);
function scaleMoodAction(kind, opt) {
  const o = { kind, ...opt };
  if (kind === 'trajectory' && Array.isArray(o.frames)) {
    o.frames = o.frames.map((f) => ({
      time: f.time,
      values: Object.fromEntries(Object.entries(f.values).map(([p, v]) => [p, SCALE_KEYS.has(p) ? Math.max(-30, Math.min(30, +(v * MOOD_SCALE).toFixed(2))) : v])),
    }));
  }
  return o;
}
function moodPlan(name, k) {
  const actions = (MOODS[name] || MOODS.neutral).map(([kind, opt]) => {
    const o = scaleMoodAction(kind, opt);
    o.strength = Math.max(0.15, Math.min(1, (opt.strength || 0.5) * k));
    return o;
  });
  const m = Object.keys(MOODS).includes(name) ? name : 'neutral';
  return { version: 1, title: `情绪 · ${m}`, intent: `情绪 · ${m}`, summary: `情绪 · ${m}`, actions };
}

function postPlan(plan) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ plan, backend: 'web' });
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/execute', method: 'POST', timeout: 6000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => { res.resume(); try { plog('postPlan status ' + res.statusCode + ' ' + String(plan && plan.title)); } catch {} resolve(res.statusCode === 200 || res.statusCode === 201); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body); req.end();
  });
}

// ---- 节律摇摆（待机时自动左右轻摆；用户动作来了让路）----
let planBusyUntil = 0;
let lastUserPlanAt = 0;
let swayEnabled = true;   // POST :61943/sway {"on":false} 可关（录制/实验用）
let swayCfg = { phys: 0, tilt: 0.6, period: 4.0, pivot: 100, mix: 0.9 };  // mix=AngleZ/AngleX 比例：0.9 抵消头部摆动，0 以头部摆为主（物理更活）  // phys=物理摆动倍率（腿/髋会跟着动），tilt=渲染层倾斜角度（度），period=周期（秒）

function planDuration(plan) {
  return Math.max(1, ...plan.actions.map((a) => Number(a.at || 0) + Number(a.duration || 2.5)));
}

function stopPlan() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/stop', method: 'POST', timeout: 3000, headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write('{}'); req.end();
  });
}

async function runPlan(plan, userAction, marginMs = 900) {
  if (userAction && Date.now() < planBusyUntil) { await stopPlan(); await sleep(140); }
  else { const w = planBusyUntil - Date.now(); if (w > 0) await sleep(w + 60); }
  let ok = await postPlan(plan);
  // 舞台被联动 watcher 的短动作占着时会 400：说话/情绪比它优先，抢几次
  for (let i = 0; i < 4 && !ok; i++) { await stopPlan(); await sleep(180); ok = await postPlan(plan); }
  const dur = planDuration(plan);
  planBusyUntil = Date.now() + (ok ? dur * 1000 + marginMs : 400);
  if (userAction) lastUserPlanAt = Date.now();
  return ok;
}

// 待机摇摆分两层，各管一段：
//   phys  —— 动作层小幅物理摆动：AngleX 带一点「头转」，但髋/腿会被物理带着真的动（主人要的腿上有动作）
//   tilt  —— 渲染层 canvas 微倾：只在需要额外幅度时补一点，纯倾斜、不会带来任何关节动作
// 标定参考（±18 单位，头/上身/腿三段质心位移）：
//   AngleX    头 22.1 / 上身 16.1 / 腿 8.0   ← 摇头也最大，所以基础幅度只给 6
//   AngleZ    头 22.0 / 上身 9.5 / 腿 −8.5   ← 歪头 + 腿反向，补一点拧身感
//   LeanInput 纵向 −16.2（前后探身）          ← 主人否掉，不用
//   PositionX 整体平移 0.9px/单位             ← 补一点重心位移
// 注：ParamBodyAngle* / HipAngle* 全是物理输出，接口直接拒（"归作者物理控制"），所以别想直接驱动身体角度。
// 关键：AngleX 与 AngleZ **同号**时头部横移互相抵消（头几乎不转），身体/腿的位移却叠加。
// 之前写成反号，头位移 16.9px、身体 9.9px，所以看着像「一直在左右摇头」。
const SWAY_BASE = { AngleX: 8, AngleZ: 7, PositionX: 3 };
const swayMix = () => (Number.isFinite(Number(swayCfg.mix)) ? Number(swayCfg.mix) : 0.9);

function swayPlan() {
  const CYCLE = Number(swayCfg.period) || 4.0;
  const CYCLES = 2;
  const N = 9 * CYCLES;
  const D = +(CYCLE * CYCLES + 0.4).toFixed(2);
  const k = Math.max(0, Number(swayCfg.phys) || 0);
  const start = 0.16;
  const step = (D - 0.34) / N;
  const frames = [];
  for (let i = 0; i <= N; i++) {
    const t = +(start + i * step).toFixed(2);
    const ph = (i / N) * Math.PI * 2 * CYCLES;
    const s = Math.sin(ph);
    frames.push({ time: t, values: {
      AngleX: +(SWAY_BASE.AngleX * k * s).toFixed(2),
      AngleZ: +(SWAY_BASE.AngleZ * k * swayMix() * s).toFixed(2),
      PositionX: +(SWAY_BASE.PositionX * k * s).toFixed(2),
    } });
  }
  return { version: 1, title: '待机 · 摇摆', intent: '待机 · 摇摆', summary: '待机 · 摇摆', actions: [{ kind: 'trajectory', at: 0, duration: D, frames }] };
}

function startSway() {
  syncSway();
  setInterval(async () => {
    if (!swayEnabled) return;
    if (!(Number(swayCfg.phys) > 0)) return;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (Date.now() < planBusyUntil + 250) return;
    if (Date.now() - lastUserPlanAt < 1500) return;
    const ok = await runPlan(swayPlan(), false, 380).catch(() => false);
    // 渲染层倾斜跟着这一发计划重锚相位，两层才不会互相抵消
    if (ok && Number(swayCfg.tilt) > 0) syncSwayPhase();
  }, 600);
}

function syncSwayPhase() {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.__petSwaySync && window.__petSwaySync(${Number(swayCfg.tilt) || 0}, ${Number(swayCfg.period) || 3.6}, ${Number(swayCfg.pivot) || 100})`).catch(() => {});
}

function syncSway() {
  if (!win || win.isDestroyed()) return;
  const tilt = Number(swayCfg.tilt) || 0;
  win.webContents.executeJavaScript(`window.__petSwaySet && window.__petSwaySet(${swayEnabled ? 'true' : 'false'}, ${tilt}, ${Number(swayCfg.period) || 3.6}, ${Number(swayCfg.pivot) || 100})`).catch(() => {});
}

async function sendMood(name, intensity = 0.6) {
  const now = Date.now();
  if (now - lastMood < 1200) return { ok: false, reason: 'cooldown' };
  const mood = Object.prototype.hasOwnProperty.call(MOODS, name) ? name : 'neutral';
  lastMood = now; lastInteract = now;
  // 联动 watcher 可能正占着舞台（会回 400），重试几发，别让情绪静默丢掉
  let ok = false;
  for (let i = 0; i < 3 && !ok; i++) {
    ok = await runPlan(moodPlan(mood, intensity), true);
    if (!ok) await sleep(240);
  }
  return { ok, emotion: mood };
}

function startMoodServer() {
  const srv = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/status') return send(200, { ok: true, moods: Object.keys(MOODS), port: MOOD_PORT, voicing, lastSay, volume: voiceVolume, interactive, bridge: bridgeOn, reply: replyBtnWanted(), fps: stageFpsOf(), dock: loadCfg().dock || 'none', dockTitle: loadCfg().dockTitle || '', lastTouch: touchRing.length ? touchRing[touchRing.length - 1] : null });
    // 气泡量测：头顶 y / 气泡实际位置与高度（排查「气泡压模型」用）
    if (req.method === 'GET' && req.url === '/bubble') {
      if (!win || win.isDestroyed()) return send(200, { ok: false, error: 'no window' });
      win.webContents.executeJavaScript('window.__petBubbleInfo ? window.__petBubbleInfo() : null')
        .then((v) => send(200, { ok: !!v, ...(v || {}) }))
        .catch((e) => send(200, { ok: false, error: e.message }));
      return;
    }
    // 阶段气泡：POST /tick {"text":"看 main.js","ms":3000}
    // 给联动 watcher 用的通道——周期通信只走这里，不碰模型动作（表情走舞台的 /api/execute）。
    if (req.method === 'POST' && req.url === '/tick') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(raw || '{}');
          // {"on":false} 也能当开关用（面板走 IPC，这里留给 CLI / 调试）
          if (typeof j.on === 'boolean') {
            saveCfg({ tickBubble: j.on });
            syncTickBubble();
            return send(200, { ok: true, on: tickBubbleOn() });
          }
          const r = petTick(j.text, j.ms);
          send(r ? 200 : 400, r ? { ok: true, ...r } : { ok: false, error: 'empty text' });
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/tick') {
      if (!win || win.isDestroyed()) return send(200, { ok: false, error: 'no window' });
      win.webContents.executeJavaScript('window.__petTickInfo ? window.__petTickInfo() : null')
        .then((v) => send(200, { ok: !!v, on: tickBubbleOn(), last: lastTick, ...(v || {}) }))
        .catch((e) => send(200, { ok: false, error: e.message }));
      return;
    }
    // 回复她：POST /reply {"text":"主人写的话"} —— 和点气泡上的小钮同一条路（CLI / 调试用）
    // {"open":true/false} 是给调试用的：不点鼠标也能把输入卡打开，验 UI 和键盘路径
    if (req.method === 'POST' && req.url === '/reply') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
      req.on('end', async () => {
        try {
          const j = JSON.parse(raw || '{}');
          if (typeof j.open === 'boolean') {
            if (!win || win.isDestroyed()) return send(200, { ok: false, error: 'no window' });
            const v = await win.webContents.executeJavaScript(`window.__petReply && window.__petReply(${j.open ? 'true' : 'false'})`).catch(() => null);
            return send(200, { ok: v !== null, open: j.open });
          }
          const r = await sendReply(j.text);
          return send(r.ok ? 200 : 502, r);
        } catch (e) { return send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    // TTS 保活 / 主动打招呼：POST /keepalive {"mode":"greet"|"ping"}（调试用，平时它自己每 15 分钟跑）
    if (req.method === 'POST' && req.url === '/keepalive') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1024) req.destroy(); });
      req.on('end', () => {
        let mode = '';
        try { mode = String((JSON.parse(raw || '{}') || {}).mode || ''); } catch {}
        if (!voiceEnabled()) return send(200, { ok: false, error: '没配 TTS（voicePrepare / voiceWavDir）' });
        if (keepAliveBusy || voicing) return send(200, { ok: false, busy: true });
        keepAliveTick(mode === 'greet' ? 'greet' : mode === 'ping' ? 'ping' : undefined);
        return send(200, { ok: true, mode: mode || 'auto' });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/reply') {
      if (!win || win.isDestroyed()) return send(200, { ok: false, error: 'no window' });
      win.webContents.executeJavaScript('window.__petReplyInfo ? window.__petReplyInfo() : null')
        .then((v) => send(200, { ok: !!v, btn: replyBtnWanted(), url: String(replyTarget()), ...(v || {}) }))
        .catch((e) => send(200, { ok: false, error: e.message }));
      return;
    }
    // 开关指针追踪：POST /cursor {"on":false,"amp":1}
    if (req.method === 'POST' && req.url === '/cursor') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(raw || '{}');
          if (typeof j.on === 'boolean') cursorTrack = j.on;
          if (j.spin) spinAdvance();                                   // 调试：手动推一节（不转圈也能验）
          if (Number.isFinite(Number(j.turns))) {                       // 调试：改「一节几圈」不用重启
            spinTurns = Math.min(20, Math.max(2, Math.round(Number(j.turns))));
            saveCfg({ spinTurns });
          }
          if (j.reset) { spinStage = 0; spinClear(); spinSuspendedUntil = 0; spinCooldownUntil = 0; }
          saveCfg({ cursorTrack });
          lastCursorKey = '';
          if (!cursorTrack && win && !win.isDestroyed()) { try { win.webContents.send('pet:cursor', null); } catch {} }
          send(200, { ok: true, track: cursorTrack, spin: { stage: spinStage, suspendedMs: Math.max(0, spinSuspendedUntil - Date.now()), cooldownMs: Math.max(0, spinCooldownUntil - Date.now()) } });
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/sway') return send(200, { ok: true, on: swayEnabled, ...swayCfg });
    // 指针追踪排查：窗口位置、全局指针、显示器与缩放、最近一次送出的载荷
    if (req.method === 'GET' && req.url === '/cursor') {
      if (!win || win.isDestroyed()) return send(200, { ok: false, error: 'no window' });
      const [wx, wy] = win.getPosition(); const [ww, wh] = win.getSize();
      const p = screen.getCursorScreenPoint();
      const z = spinZone(ww, wh);
      const zdx = p.x - (wx + z.cx), zdy = p.y - (wy + z.cy);
      return send(200, { ok: true, track: cursorTrack, win: { x: wx, y: wy, w: ww, h: wh },
        cursor: p, lastKey: lastCursorKey,
        spinZone: { ...z, dx: zdx, dy: zdy, dist: Math.round(Math.hypot(zdx, zdy)), inZone: inSpinZone(zdx, zdy, ww, wh) },
        spin: { stage: spinStage, suspendedMs: Math.max(0, spinSuspendedUntil - Date.now()), cooldownMs: Math.max(0, spinCooldownUntil - Date.now()), hist: spinHist.length, turns: spinTurns, accum: Number(spinAccum.toFixed(3)), dir: spinDir },
        displays: screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, work: d.workArea, scale: d.scaleFactor })) });
    }
    if (req.method === 'GET' && req.url === '/sway/plan') return send(200, swayPlan());
    // 摇摆参数：phys=物理摆动倍率（腿/髋跟着动），tilt=渲染层倾斜角度，period=周期
    if (req.method === 'POST' && req.url === '/sway') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 2048) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(raw || '{}');
          if (typeof j.on === 'boolean') swayEnabled = j.on;
          if (Number.isFinite(j.phys)) swayCfg.phys = Math.max(0, Math.min(3, j.phys));
          if (Number.isFinite(j.tilt)) swayCfg.tilt = Math.max(0, Math.min(4, j.tilt));
          if (Number.isFinite(j.amp)) swayCfg.tilt = Math.max(0, Math.min(4, j.amp)); // 兼容旧字段
          if (Number.isFinite(j.period)) swayCfg.period = Math.max(1.2, j.period);
          if (Number.isFinite(j.pivot)) swayCfg.pivot = Math.max(50, Math.min(110, j.pivot));
          if (Number.isFinite(j.mix)) swayCfg.mix = Math.max(-1.5, Math.min(1.5, j.mix));
          syncSway();
          send(200, { ok: true, on: swayEnabled, ...swayCfg });
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    // 语音音量：0..1，立刻生效并写进 config.json
    if (req.method === 'POST' && req.url === '/volume') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(raw || '{}');
          const v = setVolume(Number(j.volume));
          send(200, { ok: true, volume: v });
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    // 分区点击：外部（CLI / 调试 / 测试）也能触发一次「主人点了这里」
    if (req.method === 'POST' && req.url === '/touch') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 2048) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(raw || '{}');
          lastTap = 0;   // 调试入口不去抖
          const ev = handleTouch(j);
          send(200, { ok: !!ev, event: ev || null });
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    // 最近的点触事件：主人都点了哪儿、点了几下
    if (req.method === 'GET' && req.url.startsWith('/touches')) {
      let n = 20;
      try { n = Math.max(1, Math.min(200, Number(new URL('http://x' + req.url).searchParams.get('limit')) || 20)); } catch {}
      return send(200, { ok: true, items: touchRing.slice(-n) });
    }
    // 分区标定：扫一遍透明轮廓，返回剪影包围盒 + 每行宽度 + 自动找到的脖子位置
    if (req.method === 'GET' && req.url.startsWith('/zones')) {
      const force = /scan/.test(req.url);
      const job = (force || !zoneScan) ? requestZoneScan() : Promise.resolve(zoneScan);
      job.then((r) => send(200, { ok: !!r.ok, cached: !force && !!zoneScan, zones: r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    if (req.method === 'POST' && req.url === '/say') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
      req.on('end', async () => {
        try {
          const j = JSON.parse(raw || '{}');
          const ms = Number(j.ms) || 6000;
          const text = String(j.text || '');
          if (j.voice) {
            if (voicing) { send(200, { ok: false, busy: true }); return; }
            // 没配 TTS 的人：等价于一条普通气泡，不排三个点、不算 busy、不回 queued —— 别让人以为卡住了
            if (!voiceEnabled()) {
              send(200, { ok: true, queued: false, noTts: true });
              say(text, false, ms);
              runPlan({ version: 1, title: '说话', intent: '说话', summary: '说话', actions: sayActions(ms, j.emotion, j.mouth, j.gesture, j.moves) }, true).catch(() => {});
              return;
            }
            send(200, { ok: true, queued: true, early: !!j.early });
            petWait();   // 气泡先变三个点（合成期间就是这个等待态，说好过）
            // early：表情和手势不用等合成，先把脸换过去、手抬起来，省得那几秒像块木头。
            // 正文仍然等合成好了一起出（气泡/口型/声音同帧），这点别再改。
            if (j.early) {
              const earlyMs = Math.max(4000, Math.min(12000, text.length * 280));
              const earlyActions = [];
              const earlyExpr = sanitizeMoves(j.moves).filter((a) => a.kind === 'expression');
              // 她自己点了表情就用她的，别再让情绪预设盖一层（独占层会互相顶）
              if (!earlyExpr.length && j.emotion && MOODS[j.emotion]) for (const [kind, opt] of MOODS[j.emotion]) earlyActions.push(scaleMoodAction(kind, opt));
              for (const a of earlyExpr) earlyActions.push({ ...a, at: 0, duration: Math.max(2, Math.min(earlyMs / 1000, 8)) });
              if (j.gesture) earlyActions.push({ kind: 'gesture', name: String(j.gesture), at: 0, duration: Math.max(1.4, Math.min(earlyMs / 1000, 2.6)) });
              if (earlyActions.length > 0) {
                runPlan({ version: 1, title: '说话-准备', intent: '说话-准备', summary: '说话-准备', actions: earlyActions }, true).catch(() => {});
              }
            }
            prepareAndSay(text, j.emotion, j.gesture, j.moves);
            return;
          }
          say(text, false, ms);
          if (j.audio && win && !win.isDestroyed()) { try { win.webContents.executeJavaScript('window.__petPlay && window.__petPlay(' + JSON.stringify(String(j.audio)) + ')').catch(() => {}); } catch {} }
          runPlan({ version: 1, title: '说话', intent: '说话', summary: '说话', actions: sayActions(ms, j.emotion, j.mouth, j.gesture, j.moves) }, true).catch(() => {});
          send(200, { ok: true, mouth: ms });
        }
        catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/mood') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
      req.on('end', async () => {
        try { const j = JSON.parse(raw || '{}'); const r = await sendMood(j.emotion, j.intensity); send(200, r); }
        catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    // 贴窗口：POST /dock {"mode":"left|right|none","title":"DeepSeek Harness"}
    if (req.method === 'POST' && req.url === '/dock') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1024) req.destroy(); });
      req.on('end', async () => {
        try {
          const j = JSON.parse(raw || '{}');
          const r = await applyDock(j.mode || loadCfg().dock, { title: j.title });
          send(r.ok ? 200 : 404, r);
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/size') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(raw || '{}');
          const w = Math.max(240, Math.min(1600, Number(j.width) || 380));
          const h = Math.max(360, Math.min(2000, Number(j.height) || 680));
          setSize(w, h);
          send(200, { ok: true, width: w, height: h });
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    // 摆位置（和拖拽一样会记住，省得改尺寸后还得手动拖回去）
    if (req.method === 'POST' && req.url === '/position') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 512) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(raw || '{}');
          if (!win || win.isDestroyed()) return send(400, { ok: false, error: 'no window' });
          const x = Math.round(Number(j.x)), y = Math.round(Number(j.y));
          if (!Number.isFinite(x) || !Number.isFinite(y)) return send(400, { ok: false, error: 'bad x/y' });
          win.setPosition(x, y);
          saveCfg({ x, y });
          send(200, { ok: true, x, y });
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    // 分区互动总开关：GET 读、POST 设（不带 on 就是切换）
    if (req.url === '/interactive' && (req.method === 'GET' || req.method === 'POST')) {
      if (req.method === 'GET') return send(200, { ok: true, interactive });
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 256) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(raw || '{}');
          const on = typeof j.on === 'boolean' ? j.on : !interactive;
          send(200, { ok: true, interactive: setInteractive(on, true) });
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    // 模型桥接开关：点触要不要叫醒 DSH 会话
    if (req.url === '/bridge' && (req.method === 'GET' || req.method === 'POST')) {
      if (req.method === 'GET') return send(200, { ok: true, bridge: bridgeOn, url: String(loadCfg().bridgeUrl || '') });
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 256) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(raw || '{}');
          const on = typeof j.on === 'boolean' ? j.on : !bridgeOn;
          send(200, { ok: true, bridge: setBridge(on, true) });
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    // 舞台帧率：GET 读、POST 设（0 = 不限帧），改完重载舞台页面才生效
    if (req.url === '/fps' && (req.method === 'GET' || req.method === 'POST')) {
      if (req.method === 'GET') return send(200, { ok: true, fps: stageFpsOf() });
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 256) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(raw || '{}');
          const v = Number(j.fps);
          if (!applyStageFps(v)) throw new Error('fps 要在 0..240 之间（0 = 不限）');
          send(200, { ok: true, fps: stageFpsOf() });
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    // 打开尺寸滑杆面板（托盘菜单也是走这里）
    if (req.method === 'POST' && req.url === '/panel') { createPanel(); send(200, { ok: true }); return; }
    // 全身 / 近景：换的是舞台的 fit 参数，不走窗口大小
    if (req.method === 'POST' && req.url === '/fit') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(raw || '{}');
          const fit = j.fit === 'portrait' ? 'portrait' : 'full';
          saveCfg({ fit });
          loadStage();
          send(200, { ok: true, fit });
        } catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    send(404, { ok: false, error: 'not found' });
  });
  srv.on('error', () => {});
  srv.listen(MOOD_PORT, '127.0.0.1');
}

function idleTick() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (Date.now() - lastInteract < 120000 || Date.now() - lastMood < 120000) return;
  const pick = ['sleepy', 'neutral', 'happy', 'thinking'];
  sendMood(pick[Math.floor(Math.random() * pick.length)], 0.35);
}

// ---- 被摸到会说话：台词预合成缓存（点一下立刻出声，不用等 3~10 秒）----
// 2026-11-04 主人改口径：本地只出**语气词**（呃…／呜…／嘿嘿…／呀…），不出具体回应。
// 理由：她摸完会紧跟着一条模型的回话，本地要是先把话说死（「再摸就咬主人」），
// 模型那句就接不上了；语气词是个开口，什么回复都能往下接。分区仍然保留情绪。
const TAP_LINES = [
  { e: 'shy', t: ['呀…', '唔…'] },
  { e: 'happy', t: ['嘿嘿…', '嗯…'] },
  { e: 'playful', t: ['诶嘿…', '哼哼…'] },
  { e: 'proud', t: ['嗯哼…'] },
  { e: 'sleepy', t: ['唔…', '呼…'] },
  { e: 'neutral', t: ['嗯…', '啊…'] },
];
// ---- 分区互动：点哪儿算哪儿，并把「主人碰了哪里」反推给 DSH ----
// 区域比例由当前模型的透明轮廓标定：头 10–30%、胸 33–48%、腰 48–57.5%、裙 57.5–75%、腿 75–86.5%、脚 86.5–96%。
// 换模型后要重标（截图后用 alpha 逐行量左右边界），再改 preload.js 的 zoneOf。
// 台词一律是语气词：同一句能接住任何回复，也不会和接下来那条模型回话打架。
const TOUCH_ZONES = {
  hair:  { e: 'happy',     t: ['嘿嘿…', '欸…', '嗯…'] },
  head:  { e: 'happy',     t: ['唔…', '嘿嘿…', '嗯…'] },
  neck:  { e: 'shy',       t: ['呜…', '唔…', '呀…'] },
  chest: { e: 'shy',       t: ['诶…', '呀…', '唔…'] },
  waist: { e: 'flustered', t: ['唔…', '哈…', '呃…'] },
  skirt: { e: 'annoyed',   t: ['哼…', '呃…', '唔…'] },
  leg:   { e: 'annoyed',   t: ['呃…', '哼…', '呜…'] },
  foot:  { e: 'surprised', t: ['呀…', '啊…', '诶…'] },
  body:  { e: 'neutral',   t: ['嗯…', '唔…', '呃…'] },
};
const TOUCH_MANY = {
  head:  ['呃…', '唔…'],
  chest: ['呀…', '哼…'],
  skirt: ['哼…', '呃…'],
  leg:   ['哼…', '唔…'],
  default: ['呃…', '哼…'],
};
let touchSeq = 0;
const touchRing = [];
const touchFile = () => path.join(DATA, 'touch.jsonl');
const touchState = { zone: '', count: 0, at: 0 };
let bridgeWarned = false;

// ---- 分区标定：让 preload 扫一遍画布 alpha，量出模型自己的剪影 ----
// 分区必须相对模型算，不能相对窗口：窗口拉伸、缩放、换 fit、换装都会让写死的窗口比例漂。
let zoneScan = null;
let zonePending = null;
ipcMain.on('pet:zones-result', (_e, r) => {
  zoneScan = r && r.ok ? r : { ok: false };
  const done = zonePending;
  zonePending = null;
  if (done) done(zoneScan);
});
function requestZoneScan(timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) { resolve({ ok: false, error: 'no window' }); return; }
    if (zonePending) { resolve({ ok: false, error: 'busy' }); return; }
    zonePending = resolve;
    try { win.webContents.send('pet:zones-scan'); } catch { zonePending = null; resolve({ ok: false, error: 'send failed' }); return; }
    setTimeout(() => {
      if (zonePending === resolve) { zonePending = null; resolve({ ok: false, error: 'timeout' }); }
    }, timeoutMs);
  });
}

// 事件一条一行，超过 256KB 就轮转一份，避免无限长
function appendTouch(ev) {
  touchRing.push(ev);
  if (touchRing.length > 200) touchRing.shift();
  try {
    const f = touchFile();
    let size = 0;
    try { size = fs.statSync(f).size; } catch {}
    if (size > 256 * 1024) { try { fs.renameSync(f, f + '.1'); } catch {} }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify(ev) + '\n');
  } catch {}
}

// 反向桥：把事件 POST 给 DSH 侧的 dsh-pet-bridge（fire-and-forget，失败只记一次日志）
function forwardTouch(ev) {
  if (!bridgeOn) return;   // 模型桥接关了：本地反应照做，只是不叫醒会话
  const url = String(loadCfg().bridgeUrl || '').trim();
  if (!url) return;
  try {
    const u = new URL(url);
    const body = JSON.stringify(ev);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: (u.pathname || '/') + (u.search || ''),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 1500,
    }, (res) => { res.resume(); });
    req.on('error', (e) => { if (!bridgeWarned) { bridgeWarned = true; plog('bridge post failed: ' + e.message); } });
    req.on('timeout', () => { try { req.destroy(); } catch {} });
    req.end(body);
  } catch {}
}

function touchReaction(ev, now) {
  if (ev.zone === 'body') return;   // 兜底区交给 pet:tap 的旧台词池
  const z = TOUCH_ZONES[ev.zone] || TOUCH_ZONES.body;
  if (touchState.zone === ev.zone && now - touchState.at < 1600) touchState.count++;
  else { touchState.zone = ev.zone; touchState.count = 1; }
  touchState.at = now;
  const many = touchState.count >= 3;
  // 第二下只换表情不出声，第三下才发火：避免连点把气泡刷屏
  if (touchState.count === 2 && !many) {
    sendMood(z.e, 0.55).catch(() => {});
    return;
  }
  const pool = many ? (TOUCH_MANY[ev.zone] || TOUCH_MANY.default) : z.t;
  const line = pool[Math.floor(Math.random() * pool.length)];
  const mood = many ? 'annoyed' : z.e;
  if (voicing) { say(line, false, 4200); return; }
  if (!many && speakCached(line, mood)) return;   // 命中预合成：气泡/口型/声音同帧
  say(line, false, 4200);
  sendMood(mood, many ? 0.9 : 0.65).catch(() => {});
}

// 分区互动总开关：关掉后点她等于点空气（不写日志、不通桥、不说话），光标回系统默认。
// 退出开关状态由 config.interactive 记住，面板 / 托盘 / CLI 都走这里，即时生效不用重启。
function setInteractive(on, save) {
  interactive = !!on;
  if (save) saveCfg({ interactive });
  if (win && !win.isDestroyed()) { try { win.webContents.send('pet:interactive', interactive); } catch {} }
  return interactive;
}

// 模型桥接开关：关掉只断「点触 → DSH 会话」那条线，本地表情/台词/记账照做。
// 想自己逗她玩、又不想每摸一下都叫醒会话时用这个。
function setBridge(on, save) {
  bridgeOn = !!on;
  bridgeWarned = false;
  if (save) saveCfg({ bridge: bridgeOn });
  return bridgeOn;
}

// 一次点击：去抖 → 落盘 → 反推给 DSH → 本地反应
function handleTouch(p) {
  if (!interactive) return null;
  const now = Date.now();
  if (now - lastTap < 220) return null;
  lastTap = now; lastInteract = now;
  const zone = TOUCH_ZONES[p && p.zone] ? p.zone : 'body';
  const nx = Number(p && p.nx), ny = Number(p && p.ny);
  const ev = {
    ts: new Date(now).toISOString(),
    seq: ++touchSeq,
    zone,
    nx: Number.isFinite(nx) ? nx : null,
    ny: Number.isFinite(ny) ? ny : null,
    // nx/ny 现在是「模型剪影比例」不是窗口比例；calibrated=false 表示轮廓还没标定出来
    calibrated: !!(p && p.calibrated),
  };
  appendTouch(ev);
  forwardTouch(ev);
  touchReaction(ev, now);
  return ev;
}

const vcacheFile = () => path.join(DATA, 'voice-cache.json');
// 语音是可选集成：data/config.json 里给了 voicePrepare 脚本才启用，没给就纯文字气泡
const voiceScript = () => (loadCfg().voicePrepare || '').trim();
const voiceEnabled = () => { const s = voiceScript(); return !!s && fs.existsSync(s) && !!((loadCfg().voiceWavDir || '').trim()); };
function loadVCache() { try { return JSON.parse(fs.readFileSync(vcacheFile(), 'utf8').replace(/^\uFEFF/, '')) || {}; } catch { return {}; } }
function saveVCache(o) { try { fs.mkdirSync(path.dirname(vcacheFile()), { recursive: true }); fs.writeFileSync(vcacheFile(), JSON.stringify(o, null, 1)); } catch {} }
function sayPlan(ms, emotion, env, gesture) {
  return { version: 1, title: '说话', intent: '说话', summary: '说话', actions: sayActions(ms, emotion, env, gesture) };
}
function playInPage(audioUrl) {
  try { if (win && !win.isDestroyed()) win.webContents.executeJavaScript('window.__petPlay && window.__petPlay(' + JSON.stringify(audioUrl) + ')').catch(() => {}); } catch {}
}
// 命中缓存 → 气泡、口型、声音同一帧出来
function speakCached(text, emotion) {
  const c = loadVCache()[text];
  if (!c || !c.job_id) return false;
  const ms = Math.round((Number(c.duration) + 0.3) * 1000);
  say(text, false, ms);
  playInPage('/audio/' + c.job_id + '.wav');
  runPlan(sayPlan(ms, emotion, c.env), true).catch(() => {});
  return true;
}
let warming = null;
function warmVoices() {
  if (warming) return warming;
  warming = (async () => {
    const cache = loadVCache();
    for (const pool of [...TAP_LINES, ...Object.values(TOUCH_ZONES)]) {
      for (const text of pool.t) {
        if (cache[text]) continue;
        try {
          await new Promise((res) => {
            const ch = spawn('node', [voiceScript()], { env: { ...process.env, SAY_TEXT: text, WHALE_PET_DATA: DATA }, windowsHide: true, stdio: 'ignore' });
            ch.on('close', res); ch.on('error', res);
          });
          const info = JSON.parse(fs.readFileSync(path.join(DATA, 'voice-job.json'), 'utf8').replace(/^\uFEFF/, ''));
          if (!info.job_id) continue;
          const wav = path.join(loadCfg().voiceWavDir || '', info.job_id + '.wav');
          const n = Math.max(4, Math.min(58, Math.round(Number(info.duration) * 8)));
          const env = wavEnvelope(wav, n);
          const audioDir = path.join(BASE, 'web', 'audio');
          fs.mkdirSync(audioDir, { recursive: true });
          fs.copyFileSync(wav, path.join(audioDir, info.job_id + '.wav'));
          cache[text] = { job_id: info.job_id, duration: info.duration, env };
          saveVCache(cache);
          try { fs.appendFileSync(path.join(DATA, 'pet.log'), `${new Date().toISOString()} warm "${text}" ${info.job_id}\n`); } catch {}
        } catch {}
      }
    }
    try { fs.appendFileSync(path.join(DATA, 'pet.log'), `${new Date().toISOString()} warm done ${Object.keys(loadVCache()).length} lines\n`); } catch {}
  })();
  return warming;
}

// ---- TTS 保活 + 主动打招呼（2026-11-04 主人点的）----
// 背景：TTS 服务（9880）空闲一阵后第一句要 20~27 秒合成，气泡停在三个点很难看。
// 做法：每 15 分钟打一次声——最近没人理她就真说一句短招呼（气泡 / 口型 / 声音同帧），
// 有人在动就安静地只热一次服务（不出声、不进缓存），别在旁边念念叨叨。
const KEEPALIVE_MS = 15 * 60 * 1000;
const PING_TEXT = '嗯…';
const GREET_GAP_MS = 45 * 60 * 1000;   // 两句招呼至少隔这么久
const GREET_LINES = [
  ['嗯…主人在忙吗', 'thinking'],
  ['唔…我就在这儿哦', 'neutral'],
  ['主人，喝口水吧', 'happy'],
  ['呀…已经过了好一会儿了', 'surprised'],
  ['嘿嘿…主人是不是又忘了时间', 'playful'],
  ['主人，肩膀要不要捶一下', 'shy'],
  ['嗯…我一直在等你', 'neutral'],
  ['主人，眼睛离屏幕太近了', 'proud'],
];
let lastGreetAt = 0, keepAliveBusy = false;

// 只热服务：跑一次合成，把产物删掉，不进 voice-cache、不出声
function ttsPing() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let ch;
    try {
      ch = spawn('node', [voiceScript()], { env: { ...process.env, SAY_TEXT: PING_TEXT, WHALE_PET_DATA: DATA }, windowsHide: true, stdio: 'ignore' });
    } catch { resolve(0); return; }
    const done = () => {
      try {
        const info = JSON.parse(fs.readFileSync(path.join(DATA, 'voice-job.json'), 'utf8').replace(/^\uFEFF/, ''));
        fs.unlinkSync(path.join(loadCfg().voiceWavDir || '', info.job_id + '.wav'));   // 保活的产物不留
      } catch {}
      try { fs.appendFileSync(path.join(DATA, 'pet.log'), `${new Date().toISOString()} keepalive ping ${Date.now() - t0}ms\n`); } catch {}
      resolve(Date.now() - t0);
    };
    ch.on('close', done);
    ch.on('error', () => resolve(0));
  });
}

function greetOnce() {
  const [text, emotion] = GREET_LINES[Math.floor(Math.random() * GREET_LINES.length)];
  lastGreetAt = Date.now();
  try { fs.appendFileSync(path.join(DATA, 'pet.log'), `${new Date().toISOString()} greet "${text}"\n`); } catch {}
  prepareAndSay(text, emotion);
}

// force: 'greet' 强制打招呼 / 'ping' 强制只热服务 / 不传按「有没有人在动」自己判
function keepAliveTick(force) {
  if (!voiceEnabled() || keepAliveBusy || voicing) return;
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (loadCfg().voiceKeepAlive === false && !force) return;
  keepAliveBusy = true;
  const now = Date.now();
  const hour = new Date().getHours();
  const lastAny = Math.max(lastInteract, lastMood, (lastSay && lastSay.at) ? lastSay.at : 0);
  const busyRecently = now - lastAny < KEEPALIVE_MS;
  const canGreet = force === 'greet' || (force !== 'ping' && !busyRecently && hour >= 8 && hour < 24 && now - lastGreetAt > GREET_GAP_MS);
  const job = canGreet ? Promise.resolve(greetOnce()) : ttsPing();
  job.finally(() => { keepAliveBusy = false; });
}

ipcMain.on('pet:interact', () => { lastInteract = Date.now(); });ipcMain.on('pet:tap', (_e, p) => {
  // 旧版 preload 只发空 payload：当作身体来一下，保持兼容
  const ev = handleTouch(p || { zone: 'body' });
  if (!ev) return;
  if (ev.zone !== 'body') return;   // 具体部位由 touchReaction 反应
  // 兜底区（身体/没量准的地方）：只出一句语气词，等她后面那条模型回话接住
  const pool = TAP_LINES[Math.floor(Math.random() * TAP_LINES.length)];
  const line = pool.t[Math.floor(Math.random() * pool.t.length)];
  if (voicing) { say(line, false, 5200); runPlan(sayPlan(5200, pool.e), true).catch(() => {}); return; }
  if (speakCached(line, pool.e)) return;
  say(line, false, 5200);
  runPlan(sayPlan(5200, pool.e), true).catch(() => {});
});

const BUBBLE_JS = `(() => {
  if (window.__petSay) return;
  const style = document.createElement('style');
  style.textContent = '#pet-bubble{position:fixed;width:max-content;padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.93);color:#2b3d3a;font:22px/1.5 system-ui,"Microsoft YaHei";box-shadow:0 6px 18px rgba(0,0,0,.18);opacity:0;transition:opacity .22s;pointer-events:none;z-index:99999;white-space:pre-wrap;word-break:break-word}' +
    '#pet-bubble.pos-bottom{left:0;right:0;bottom:14px;margin:0 auto;max-width:62%;line-height:1.45}' +
    '#pet-bubble.pos-top{left:0;right:0;top:12px;margin:0 auto;max-width:62%;line-height:1.45}' +
    '#pet-bubble.pos-left{left:12px;top:50%;transform:translateY(-50%);max-width:38%;max-height:calc(100% - 60px);writing-mode:vertical-rl;text-orientation:upright;letter-spacing:.06em}' +
    '#pet-bubble.pos-right{right:12px;left:auto;top:50%;transform:translateY(-50%);max-width:38%;max-height:calc(100% - 60px);writing-mode:vertical-rl;text-orientation:upright;letter-spacing:.06em}' +
    '#pet-bubble .dot{display:inline-block;width:5px;height:5px;margin:0 2px;border-radius:50%;background:#2b3d3a;opacity:.3;animation:petDot 1.1s infinite}' +
    '#pet-bubble .dot:nth-child(2){animation-delay:.15s}#pet-bubble .dot:nth-child(3){animation-delay:.3s}@keyframes petDot{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}';
  // 阶段气泡：圆滚滚的泡，从上半身任意位置冒出来，边往上飘边左右晃。几颗一起，各自 2~4 秒飘完消失。
  // 外框 .pet-puff 只做位移（左右摆 + 上浮），.pet-tick 是那颗泡本体（圆/椭圆 + 高光）。
  style.textContent += '.pet-puff{position:fixed;left:0;top:0;pointer-events:none;z-index:99998;will-change:transform,opacity}' +
    '.pet-tick{position:relative;display:flex;align-items:center;justify-content:center;border-radius:50%;overflow:hidden;box-sizing:border-box;' +
    'background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.94),rgba(230,245,255,.82) 44%,rgba(172,212,242,.68) 100%);' +
    'color:#1c3550;font:13px/1.22 system-ui,"Microsoft YaHei";pointer-events:none;' +
    'box-shadow:0 5px 14px rgba(26,74,128,.16),inset 0 0 0 1.5px rgba(255,255,255,.7),inset 0 -9px 16px rgba(140,190,235,.22)}' +
    '.pet-tick::after{content:"";position:absolute;left:21%;top:12%;width:25%;height:15%;border-radius:50%;background:rgba(255,255,255,.92);filter:blur(1.2px);transform:rotate(-22deg)}' +
    '.pet-tick-txt{display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden;word-break:break-word;overflow-wrap:anywhere;white-space:pre-line}';
  // 回复她：气泡角上的小蓝钮 + 窗口内直接打字的输入卡。
  // 这两个是整窗唯一允许吃鼠标的 DOM（pointer-events:auto + data-pet-ui），
  // 气泡正文仍然穿透（不然在桌宠上摸来摸去会被气泡挡住）。
  style.textContent += '#pet-bubble-reply{position:fixed;left:0;top:0;width:26px;height:26px;border-radius:50%;background:linear-gradient(150deg,#5aa9ff,#2a7fff);box-shadow:0 3px 10px rgba(20,60,120,.35);display:flex;align-items:center;justify-content:center;cursor:pointer;pointer-events:auto;z-index:100000;opacity:0;visibility:hidden;transform:scale(.86);transition:opacity .16s,transform .16s}' +
    '#pet-bubble-reply.on{opacity:1;visibility:visible;transform:scale(1)}' +
    '#pet-bubble-reply:hover{transform:scale(1.1)}' +
    '#pet-bubble-reply svg{width:15px;height:15px;display:block;pointer-events:none}' +
    '#pet-reply-box{position:fixed;left:0;top:0;z-index:100001;display:flex;flex-direction:column;gap:3px;padding:7px 10px 6px;border-radius:14px;background:rgba(255,255,255,.97);border:1px solid rgba(120,180,240,.6);box-shadow:0 8px 24px rgba(20,50,90,.28);font:13px/1.3 system-ui,"Microsoft YaHei";pointer-events:auto;box-sizing:border-box}' +
    '#pet-reply-input{width:100%;border:0;outline:0;background:transparent;font:17px/1.35 system-ui,"Microsoft YaHei";color:#1f3a55;padding:1px 0;cursor:text}' +
    '#pet-reply-input::placeholder{color:#a6bccc}' +
    '#pet-reply-hint{font-size:11px;color:#7d9ab0;cursor:default;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
  document.head.appendChild(style);
  const el = document.createElement('div');
  el.id = 'pet-bubble';
  el.className = 'pos-bottom';
  document.body.appendChild(el);
  let timer = null, typer = null;
  // ---- 回复她（2026-11-04）----
  // 气泡右上角一个蓝色小钮，点开就在桌宠窗口里打字，回车把这句话投给桌宠专用会话。
  // 为什么画在页面里而不是壳子另开一个小窗：桌宠本来就是置顶透明窗，在这儿打字不用切窗、
  // 也多一个焦点对象；穿透由 preload 判（带 data-pet-ui 的元素算可交互）。
  // 注意按钮必须是气泡的**兄弟节点**：气泡正文是 textContent 反复覆写的（打字机），塞进去会被抹掉。
  const REPLY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 11.6c0 4.2-3.6 7.6-8 7.6-1.1 0-2.1-.2-3-.6L4 20.2l1.6-4.4c-.7-1.2-1.1-2.6-1.1-4.2 0-4.2 3.6-7.6 8-7.6s8 3.4 8 7.6z"/><path d="M8.4 11.4h7.2M8.4 14.6h4.4"/></svg>';
  const replyBtn = document.createElement('div');
  replyBtn.id = 'pet-bubble-reply';
  replyBtn.setAttribute('data-pet-ui', '1');
  replyBtn.title = '回复她';
  replyBtn.innerHTML = REPLY_ICON;
  document.body.appendChild(replyBtn);
  let replyEnabled = true, replyOpen = false, bubbleShown = false, nearBubble = null;
  const placeReplyBtn = () => {
    const r = el.getBoundingClientRect();
    const W = window.innerWidth || 380, H = window.innerHeight || 680;
    const x = Math.max(4, Math.min(W - 30, r.right - 14));
    const y = Math.max(4, Math.min(H - 30, r.top - 12));
    replyBtn.style.left = Math.round(x) + 'px';
    replyBtn.style.top = Math.round(y) + 'px';
  };
  const showReply = () => {
    bubbleShown = true;
    if (!replyEnabled) return;
    placeReplyBtn();
    replyBtn.classList.add('on');
  };
  const hideReply = () => {
    bubbleShown = false;
    nearBubble = null;
    replyBtn.classList.remove('on');
  };
  const holdBubble = () => {
    if (!bubbleShown) return;
    clearTimeout(timer);
    el.style.opacity = '1';
  };
  const releaseBubble = (delay) => {
    if (!bubbleShown) return;
    clearTimeout(timer);
    timer = setTimeout(() => { el.style.opacity = '0'; hideReply(); }, Math.max(0, Number(delay) || 0));
  };
  const placeReplyBox = () => {
    const box = document.getElementById('pet-reply-box');
    if (!box) return;
    const W = window.innerWidth || 380, H = window.innerHeight || 680;
    const bw = Math.min(420, Math.round(W * 0.92));
    box.style.width = bw + 'px';
    const bh = box.offsetHeight || 56;
    const r = el.getBoundingClientRect();
    // 气泡在下半屏就往上让，免得挡住她说话的那一行
    let top = (r.top + r.bottom) / 2 > H / 2 ? r.top - bh - 10 : r.bottom + 10;
    top = Math.max(6, Math.min(H - bh - 6, top));
    box.style.left = Math.round((W - bw) / 2) + 'px';
    box.style.top = Math.round(top) + 'px';
  };
  const closeReply = () => {
    const box = document.getElementById('pet-reply-box');
    if (box) box.remove();
    const was = replyOpen;
    replyOpen = false;
    if (was) document.dispatchEvent(new CustomEvent('pet:reply-close'));
    releaseBubble(900);
    return true;
  };
  const openReply = () => {
    if (replyOpen) { const i = document.getElementById('pet-reply-input'); if (i) { try { i.focus(); } catch (e) {} } return true; }
    replyOpen = true;
    holdBubble();
    replyBtn.classList.remove('on');
    const box = document.createElement('div');
    box.id = 'pet-reply-box';
    box.setAttribute('data-pet-ui', '1');
    box.innerHTML = '<input id="pet-reply-input" type="text" maxlength="200" autocomplete="off" spellcheck="false" placeholder="和她说一句"><div id="pet-reply-hint">回车发送 · Esc 取消</div>';
    document.body.appendChild(box);
    placeReplyBox();
    const inp = box.querySelector('input');
    const hint = box.querySelector('#pet-reply-hint');
    setTimeout(() => { try { inp.focus({ preventScroll: true }); } catch (e) {} }, 60);
    document.dispatchEvent(new CustomEvent('pet:reply-open'));   // 壳子：切可交互、拿焦点
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { closeReply(); return; }
      if (ev.key !== 'Enter') return;
      if (ev.isComposing || ev.keyCode === 229) return;   // 输入法选词的那下回车不算发送
      const text = String(inp.value || '').trim();
      if (!text) { closeReply(); return; }
      inp.readOnly = true;
      hint.textContent = '发送中…';
      document.dispatchEvent(new CustomEvent('pet:reply-send', { detail: text }));
    });
    return true;
  };
  window.__petReply = (open) => { if (open) return openReply(); closeReply(); return false; };
  window.__petReplySet = (on) => {
    replyEnabled = on !== false;
    if (!replyEnabled) replyBtn.classList.remove('on');
    else if (bubbleShown) { placeReplyBtn(); replyBtn.classList.add('on'); }
    return replyEnabled;
  };
  window.__petReplyInfo = () => ({ enabled: replyEnabled, open: replyOpen, shown: bubbleShown, text: replyOpen && document.getElementById('pet-reply-input') ? document.getElementById('pet-reply-input').value : '' });
  document.addEventListener('pet:reply-result', (ev) => {
    const r = (ev && ev.detail) || {};
    if (r.ok) {
      closeReply();
      if (typeof window.__petTick === 'function') window.__petTick('已送到她那儿', 2400);
      return;
    }
    const box = document.getElementById('pet-reply-box');
    if (!box) return;
    const inp = box.querySelector('input');
    const hint = box.querySelector('#pet-reply-hint');
    if (inp) inp.readOnly = false;
    if (hint) hint.textContent = String(r.error || '没发出去');
    if (inp) { try { inp.focus(); } catch (e) {} }
  });
  document.addEventListener('pet:reply-cancel', () => { if (replyOpen) closeReply(); });
  replyBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openReply(); });
  // 鼠标靠近气泡就先别淡（不然 5 秒的回复一变 3 秒就没了，钮都点不到）。
  // 页面这边自己看坐标就够了：mousemove 不管落点是不是可穿透元素都会到 window。
  window.addEventListener('mousemove', (e) => {
    if (!bubbleShown) return;
    const b = el.getBoundingClientRect();
    const near = e.clientX >= b.left - 12 && e.clientX <= b.right + 18 && e.clientY >= b.top - 18 && e.clientY <= b.bottom + 14;
    if (near === nearBubble) return;
    nearBubble = near;
    if (near) holdBubble();
    else if (!replyOpen) releaseBubble(1800);
  }, true);
  window.addEventListener('resize', () => { if (bubbleShown) placeReplyBtn(); placeReplyBox(); });

  window.__petPlay = (url) => { try { const a = new Audio(url); a.volume = (typeof window.__petVol === 'number' ? window.__petVol : 1); a.play().catch(() => {}); window.__petAudio = a; return true; } catch { return false; } };
  window.__petVol = 1;
  window.__petSetVol = (v) => { const n = Math.max(0, Math.min(1, Number(v))); if (Number.isFinite(n)) window.__petVol = n; if (window.__petAudio) { try { window.__petAudio.volume = window.__petVol; } catch {} } return window.__petVol; };
  window.__petPos = (pos) => {
    const p = ['bottom', 'top', 'left', 'right'].includes(pos) ? pos : 'bottom';
    el.className = 'pos-' + p;
    fitTop();
    if (bubbleShown) placeReplyBtn();
    return p;
  };
  // 顶部气泡贴模型头顶。头顶以前是写死的 168（只对 380×680 成立），换窗口大小后模型跟着缩放、
  // 168 不动 → 小尺寸时气泡压头发/脸。现在直接从 canvas 的 alpha 轮廓量头顶：
  // stage 模式给 PIXI 开了 preserveDrawingBuffer，可以把画面缩到 96 宽读像素。
  const GAP = 12, EDGE = 6, SAFETY = 6, BASE_FS = 22;
  const boxInfo = { key: '', at: 0, top: 0 };
  const measureHeadTop = (force) => {
    const c = document.getElementById('model-canvas');
    const W = window.innerWidth || 380, H = window.innerHeight || 680;
    if (!c || !c.width || !c.height) return 0;
    const key = W + 'x' + H;
    if (!force && boxInfo.key === key && performance.now() - boxInfo.at < 900) return boxInfo.top;
    try {
      const sw = 96, sh = Math.max(24, Math.round(sw * H / W));
      boxInfo.cv = boxInfo.cv || document.createElement('canvas');
      boxInfo.cv.width = sw; boxInfo.cv.height = sh;
      const ctx = boxInfo.cv.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, sw, sh);
      ctx.drawImage(c, 0, 0, sw, sh);
      const d = ctx.getImageData(0, 0, sw, sh).data;
      let t = -1;
      for (let y = 0; y < sh && t < 0; y++) {
        for (let x = 0; x < sw; x++) { if (d[(y * sw + x) * 4 + 3] > 12) { t = y; break; } }
      }
      boxInfo.top = t < 0 ? 0 : (t / sh) * H;
      boxInfo.key = key; boxInfo.at = performance.now();
      return boxInfo.top;
    } catch (e) { return boxInfo.top || 0; }
  };
  // 头顶上方空间不够时先缩字号（最小 13px）再放开宽度，保证气泡整块落在头发上面
  const fitTop = (force) => {
    if (!/pos-top/.test(el.className)) { el.style.top = ''; el.style.fontSize = ''; el.style.maxWidth = ''; el.style.padding = ''; el.style.lineHeight = ''; return; }
    const H = window.innerHeight || 680;
    const headTop = measureHeadTop(!!force) || Math.round(H * 0.247);
    const avail = Math.max(44, headTop - SAFETY - GAP - EDGE);
    el.style.fontSize = ''; el.style.maxWidth = ''; el.style.padding = ''; el.style.lineHeight = '';
    let h = el.offsetHeight || 0;
    if (h > avail) {
      // 先放宽 + 收紧行距/内边距，再缩字号（最小 14px：再小就看不清了）。
      // 窄窗口实在装不下时只允许压住头顶那撮头发，不会到脸。
      el.style.maxWidth = '92%'; el.style.padding = '7px 9px'; el.style.lineHeight = '1.32';
      let fs = BASE_FS, guard = 0;
      while ((h = el.offsetHeight || 0) > avail && fs > 14 && guard++ < 8) {
        fs = Math.max(14, Math.floor(fs * Math.max(0.82, avail / h)));
        el.style.fontSize = fs + 'px';
      }
    }
    el.style.top = Math.max(EDGE, headTop - SAFETY - GAP - (el.offsetHeight || 0)) + 'px';
  };
  window.addEventListener('resize', () => { fitTop(); setTimeout(fitTop, 400); setTimeout(fitTop, 1200); });
  // 量出来的东西给外面看（排查用）
  window.__petBubbleInfo = () => ({
    pos: String(el.className || '').replace(/^pos-/, ''),
    headTop: Math.round(measureHeadTop(true) * 10) / 10,
    top: el.style.top || null, height: el.offsetHeight || 0,
    gap: GAP, fontSize: el.style.fontSize || null, maxWidth: el.style.maxWidth || null,
    winW: window.innerWidth, winH: window.innerHeight, opacity: el.style.opacity || null, text: String(el.textContent || '').slice(0, 80),
  });
  const REPLY_HOLD_MS = 6500;   // 带回复钮的气泡至少活这么久，够把鼠标挪过去点它
  window.__petSay = (text, ms) => {
    const full = String(text || '');
    clearInterval(typer); clearTimeout(timer);
    el.textContent = '';
    el.style.opacity = '1';
    showReply();   // 一露头就挂回复钮，别等整句打完
    let i = 0;
    const step = () => {
      i++;
      el.textContent = full.slice(0, i);
      fitTop(i === 1);
      if (bubbleShown) placeReplyBtn();
      if (i >= full.length) { clearInterval(typer); typer = null; }
    };
    typer = setInterval(step, 34);
    step();
    releaseBubble(Math.max(Number(ms) || 6000, full.length * 34 + 1400, replyEnabled ? REPLY_HOLD_MS : 0));
  };
  window.__petWait = (label) => {
    clearInterval(typer); typer = null;
    clearTimeout(timer);
    hideReply();   // 三个点的等待态没东西可回
    const txt = document.createElement('span');
    txt.textContent = label ? String(label) + ' ' : '';
    el.textContent = '';
    if (label) el.appendChild(txt);
    for (let i = 0; i < 3; i++) { const d = document.createElement('span'); d.className = 'dot'; el.appendChild(d); }
    el.style.opacity = '1';
    fitTop(true);
  };
  // ---- 阶段气泡：思考 / 跑命令 / 读文件这些过程提示，像气泡一样往上飘 ----
  // 每颗都是独立元素：出生在她右肩外侧，随机散开，边飘边淡，单颗 2~4 秒；
  // 最多同时挂 5 颗，再多的把最老的挤掉。位置不写死——先量剪影，换窗口/换 fit 都不用改。
  const tickBox = { key: '', at: 0, top: 0, bottom: 0, left: 0, right: 0, shoulder: 0 };
  const measureBox = (force) => {
    const c = document.getElementById('model-canvas');
    const W = window.innerWidth || 380, H = window.innerHeight || 680;
    if (!c || !c.width || !c.height) return null;
    const key = W + 'x' + H;
    if (!force && tickBox.key === key && performance.now() - tickBox.at < 700) return tickBox.key === key ? tickBox : null;
    try {
      const sw = 96, sh = Math.max(24, Math.round(sw * H / W));
      tickBox.cv = tickBox.cv || document.createElement('canvas');
      tickBox.cv.width = sw; tickBox.cv.height = sh;
      const ctx = tickBox.cv.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, sw, sh);
      ctx.drawImage(c, 0, 0, sw, sh);
      const d = ctx.getImageData(0, 0, sw, sh).data;
      let top = -1, bottom = -1, left = sw, right = -1;
      const rights = new Int16Array(sh).fill(-1);
      const lefts = new Int16Array(sh).fill(sw);
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          if (d[(y * sw + x) * 4 + 3] <= 12) continue;
          if (top < 0) top = y;
          bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
          if (x > rights[y]) rights[y] = x;
          if (x < lefts[y]) lefts[y] = x;
        }
      }
      // 肩线：只看「头到肩」这一小段的外沿（不含尾巴和裙摆，尾巴会把整条横幅推歪）
      let shoulder = right, shoulderL = left;
      if (top >= 0) {
        const band = Math.max(1, Math.round((bottom - top) * 0.22));
        shoulder = -1; shoulderL = sw;
        for (let y = top; y <= Math.min(bottom, top + band); y++) {
          if (rights[y] > shoulder) shoulder = rights[y];
          if (lefts[y] < shoulderL) shoulderL = lefts[y];
        }
        if (shoulder < 0) shoulder = right;
        if (shoulderL >= sw) shoulderL = left;
      }
      tickBox.top = top < 0 ? 0 : top * (H / sh);
      tickBox.bottom = bottom < 0 ? H : bottom * (H / sh);
      tickBox.left = left >= sw ? 0 : left * (W / sw);
      tickBox.right = right < 0 ? W : (right + 1) * (W / sw);
      tickBox.shoulder = shoulder < 0 ? W : (shoulder + 1) * (W / sw);
      tickBox.shoulderL = shoulderL >= sw ? 0 : shoulderL * (W / sw);
      // 逐行轮廓（窗口坐标）：出生点要在上半身里随机挑，光靠左右肩不够用
      const rowsL = new Array(sh), rowsR = new Array(sh);
      for (let y = 0; y < sh; y++) {
        rowsL[y] = lefts[y] >= sw ? -1 : lefts[y] * (W / sw);
        rowsR[y] = rights[y] < 0 ? -1 : (rights[y] + 1) * (W / sw);
      }
      tickBox.rowsL = rowsL; tickBox.rowsR = rowsR;
      tickBox.key = key; tickBox.at = performance.now();
    } catch (e) { tickBox.key = ''; }
    return tickBox.key === key ? tickBox : null;
  };
  // 出生点（2026-11-04 主人要的）：不再固定在左右两侧，改成上半身轮廓里随机挑一点。
  // 剪影测量那边存了逐行左右沿：先随机一行（头顶往下 6%~46%），再在这一行里随机横坐标。
  // 四分之三的泡落在这一行的外侧两段（头发边 / 肩 / 手臂），四分之一整行随机，
  // 这样正脸不会被泡糊住，又确实是「上半身哪儿都可能冒」。
  const TICK_BAND_TOP = 0.06, TICK_BAND_BOTTOM = 0.46;
  const tickSpot = () => {
    const W = window.innerWidth || 380, H = window.innerHeight || 680;
    const b = measureBox(false);
    if (!b || !b.rowsL || !b.rowsR) return { x: W * (0.28 + Math.random() * 0.44), y: H * (0.14 + Math.random() * 0.22) };
    const hh = Math.max(1, b.bottom - b.top);
    const y = b.top + hh * (TICK_BAND_TOP + Math.random() * (TICK_BAND_BOTTOM - TICK_BAND_TOP));
    const n = b.rowsL.length;
    const row = Math.max(0, Math.min(n - 1, Math.round((y / H) * (n - 1))));
    const l = b.rowsL[row], r = b.rowsR[row];
    if (l >= 0 && r > l + 6) {
      const span = r - l;
      let t;
      if (Math.random() < 0.25) t = 0.14 + Math.random() * 0.72;
      else t = Math.random() < 0.5 ? 0.04 + Math.random() * 0.28 : 0.68 + Math.random() * 0.28;
      return { x: l + span * t, y };
    }
    // 这一行几乎没扫到东西（头顶边缘 / 侧脸）：退到整条剪影中线附近，别扔到窗外
    const mid = ((b.left || 0) + (b.right || W)) / 2;
    return { x: mid + (Math.random() - 0.5) * Math.max(40, (b.right - b.left) * 0.5), y };
  };
  const MAX_TICK = 5;
  const tickPool = [];
  let tickOn = true;
  window.__petTickSet = (on) => {
    tickOn = on !== false;
    if (!tickOn) for (const el of tickPool.splice(0)) el.remove();
    return tickOn;
  };
  // 一颗泡 = 外框 .pet-puff（只负责飘：上浮 + 左右摆 + 微转）+ 泡本体 .pet-tick（圆/椭圆 + 高光）
  window.__petTick = (text, ms) => {
    if (!tickOn) return null;
    const full = String(text == null ? '' : text).replace(/\\s+/g, ' ').trim().slice(0, 40);
    if (!full) return null;
    const life = Math.max(2000, Math.min(4000, Number(ms) || 3000));   // 单颗 2~4 秒
    const nchar = full.length;
    // 泡的大小跟着字数走：短句是小圆泡，长一点就摊成椭圆（横竖比最多 1.5，别摊成条）
    const hh = Math.round(Math.max(54, Math.min(80, 52 + nchar * 1.6)));
    const aspect = Math.min(1.45, 1 + Math.max(0, nchar - 9) * 0.022);
    const ww = Math.round(hh * aspect);
    const puff = document.createElement('div');
    puff.className = 'pet-puff';
    const el = document.createElement('div');
    el.className = 'pet-tick';
    el.style.width = ww + 'px';
    el.style.height = hh + 'px';
    const txt = document.createElement('div');
    txt.className = 'pet-tick-txt';
    // 文字框取内接矩形（0.71 倍），这样贴在椭圆上也不会被圆角切掉笔画
    const boxW = Math.round(ww * 0.71), boxH = Math.round(hh * 0.71);
    txt.style.width = boxW + 'px';
    txt.style.height = boxH + 'px';
    // 短中文短语手动对半分两行（查查/文档），不然在圆泡里会被挤成 3+1 的字数
    let shown = full;
    if (nchar >= 4 && nchar <= 10 && !/[\\sA-Za-z0-9]/.test(full)) {
      const cut = Math.ceil(nchar / 2);
      shown = full.slice(0, cut) + '\\n' + full.slice(cut);
    }
    txt.textContent = shown;
    el.appendChild(txt);
    puff.appendChild(el);
    document.body.appendChild(puff);
    // 字号自适应：泡小字多就往下缩，13 → 9px
    let fs = 13;
    txt.style.fontSize = fs + 'px';
    while (fs > 9 && txt.scrollHeight > boxH + 1) { fs -= 1; txt.style.fontSize = fs + 'px'; }
    const W = window.innerWidth || 380, H = window.innerHeight || 680;
    // 和已经在飘的泡别叠在一起：位置随机抽，抽到挤了就重抽，最多试 7 次
    const overlaps = (l, t) => {
      for (const p of tickPool) {
        const q = p.getBoundingClientRect();
        if (l + ww + 6 < q.left || l > q.right + 6) continue;
        if (t + hh + 6 < q.top || t > q.bottom + 6) continue;
        return true;
      }
      return false;
    };
    let spot = tickSpot(), left = 0, top = 0;
    for (let k = 0; k < 7; k++) {
      spot = tickSpot();
      left = Math.max(2, Math.min(W - ww - 2, Math.round(spot.x - ww / 2)));
      top = Math.max(2, Math.min(H - hh - 2, Math.round(spot.y - hh / 2)));
      if (!overlaps(left, top)) break;
    }
    puff.style.left = left + 'px';
    puff.style.top = top + 'px';
    // 飘升距离：够到顶部还剩 4px 就行，别飞出窗外
    const rise = Math.round(Math.min(72 + Math.random() * 62, Math.max(28, top - 4)));
    // 整体漂移：八成往外飘（离开身体中线），这样正脸不容易被几颗泡糊住
    const bodyX = (() => { const bb = measureBox(false); return bb ? ((bb.left || 0) + (bb.right || W)) / 2 : W / 2; })();
    const outward = spot.x >= bodyX ? 1 : -1;
    const dir = Math.random() < 0.8 ? outward : (Math.random() < 0.5 ? -1 : 1);
    const drift = dir * (12 + Math.random() * 24);                              // 整体往一边偏
    const amp = 7 + Math.random() * 10;                                         // 左右抖动幅度
    const freq = 0.8 + Math.random() * 0.9;                                     // 一趟晃几个来回
    const phase = Math.random() * Math.PI * 2;
    const steps = Math.max(20, Math.min(34, Math.round(life / 130)));
    const frames = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const ramp = Math.min(1, t * 1.8);                            // 刚冒出来先别晃，站稳了再摆
      const sw = Math.sin(phase + t * Math.PI * 2 * freq) * ramp;
      const x = drift * t + amp * sw;
      const y = -rise * (0.3 * t + 0.7 * t * t);                    // 越飘越快，像真气泡
      const rot = sw * 4.2;
      const o = t < 0.07 ? t / 0.07 : (t < 0.6 ? 1 : Math.max(0, (1 - t) / 0.4));
      const s = t < 0.14 ? 0.6 + (t / 0.14) * 0.48 : (t < 0.26 ? 1.08 - ((t - 0.14) / 0.12) * 0.08 : 1);
      frames.push({
        offset: +t.toFixed(3),
        opacity: +o.toFixed(3),
        transform: 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) rotate(' + rot.toFixed(2) + 'deg) scale(' + s.toFixed(3) + ')',
      });
    }
    puff.dataset.dbg = JSON.stringify({ w: ww, h: hh, fs, left, top, spot: [Math.round(spot.x), Math.round(spot.y), Math.round(rise), Math.round(amp), +freq.toFixed(2)] });
    const anim = puff.animate(frames, { duration: life, easing: 'linear', fill: 'forwards' });
    const drop = () => { puff.remove(); const i = tickPool.indexOf(puff); if (i >= 0) tickPool.splice(i, 1); };
    anim.onfinish = drop;
    anim.oncancel = drop;
    tickPool.push(puff);
    while (tickPool.length > MAX_TICK) { const old = tickPool.shift(); if (old) old.remove(); }
    return { text: full, ms: life, w: ww, h: hh, fs, count: tickPool.length };
  };
  window.__petTickInfo = () => ({
    on: tickOn, count: tickPool.length,
    items: tickPool.map((el) => ({ text: String(el.textContent || '').slice(0, 24), left: el.style.left, top: el.style.top, opacity: getComputedStyle(el).opacity, dbg: el.dataset.dbg || '' })),
    box: { top: Math.round(tickBox.top), bottom: Math.round(tickBox.bottom), left: Math.round(tickBox.left), right: Math.round(tickBox.right), shoulder: Math.round(tickBox.shoulder) },
    winW: window.innerWidth, winH: window.innerHeight,
  });

  // ---- 待机摇摆：整幅画面以脚为支点微倾 ----
  // 为什么不用动作接口：模型的身体角度是物理输出（ParamBodyAngle* / HipAngle*），
  // 语义接口只放 AngleX(摇头)/AngleZ(歪头)/AngleY/LeanInput(前后)/PositionX 几个输入，
  // 做不出「头不动的侧腰」，所以改在渲染层给 canvas 加一点点旋转，视觉上就是身体轻轻左右摆。
  window.__petSway = { on: true, amp: 0, period: 3.6, pivot: 100 };
  let swayT0 = performance.now();
  window.__petSwaySet = (on, amp, period, pivot) => {
    if (typeof on === 'boolean') window.__petSway.on = on;
    if (Number.isFinite(amp)) window.__petSway.amp = Math.max(0, Math.min(4, amp));
    if (Number.isFinite(period)) window.__petSway.period = Math.max(1.2, period);
    if (Number.isFinite(pivot)) window.__petSway.pivot = Math.max(50, Math.min(110, pivot));
    return window.__petSway;
  };
  // 让渲染层倾斜的相位跟动作层计划对齐（每发一次摇摆计划就重锚一次）
  window.__petSwaySync = (amp, period, pivot) => {
    if (Number.isFinite(amp)) window.__petSway.amp = Math.max(0, Math.min(4, amp));
    if (Number.isFinite(period)) window.__petSway.period = Math.max(1.2, period);
    if (Number.isFinite(pivot)) window.__petSway.pivot = Math.max(50, Math.min(110, pivot));
    swayT0 = performance.now();
    return window.__petSway;
  };
  (() => {
    const frame = (now) => {
      const s = window.__petSway;
      const c = document.getElementById('model-canvas');
      if (c) {
        if (s.on && s.amp > 0) {
          const a = s.amp * Math.sin(((now - swayT0) / 1000 / s.period) * Math.PI * 2);
          c.style.transformOrigin = '50% ' + s.pivot + '%';
          c.style.transform = 'rotate(' + a.toFixed(3) + 'deg)';
        } else if (c.style.transform) {
          c.style.transform = '';
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  })();
})()`;
// 气泡走紧凑排版：段间空行压成一个换行（2026-11-01 主人：一整行空的太松散）。
// 只影响显示，语音那边照旧用原文。
function compactBubble(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
function say(text, voice, ms) {
  if (!win || win.isDestroyed()) return;
  const t = compactBubble(text).slice(0, 300);
  win.webContents.executeJavaScript(`window.__petSay && window.__petSay(${JSON.stringify(t)}, ${Number(ms) || 6000})`).catch(() => {});
  // 旧的一次性播报脚本（notifyVoice）只有配了才用；没配就只是气泡，绝不让它变成报错。
  // 2026-11-04 主人要求：TTS 全程可选，没有本地合成服务的人也必须能正常用桌宠。
  const notify = String(loadCfg().notifyVoice || '').trim();
  if (voice && notify) {
    try { spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', notify, '-Text', t], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
}
function petWait() {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript('window.__petWait && window.__petWait()').catch(() => {});
}
// 阶段气泡（周期通信专用）：往上飘的小气泡，不动模型、不压说话气泡，单颗 2~4 秒
// 面板 / 托盘能关（config.tickBubble）；关掉后 /tick 只回 ok:true + off:true，不再画
let lastTick = null;
const tickBubbleOn = () => loadCfg().tickBubble !== false;
function syncTickBubble() {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.__petTickSet && window.__petTickSet(${tickBubbleOn() ? 'true' : 'false'})`).catch(() => {});
}
function petTick(text, ms) {
  if (!win || win.isDestroyed()) return null;
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!t) return null;
  const dur = Math.max(2000, Math.min(4000, Number(ms) || 3000));
  lastTick = { text: t, ms: dur, at: new Date().toISOString() };
  if (!tickBubbleOn()) return { ...lastTick, off: true };
  try {
    win.webContents.executeJavaScript(`window.__petTick && window.__petTick(${JSON.stringify(t)}, ${dur})`).catch(() => {});
  } catch {}
  return lastTick;
}
function applyBubblePos(pos) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.__petPos && window.__petPos(${JSON.stringify(pos)})`).catch(() => {});
}

// ---- 回复她（2026-11-04）----
// 桌宠里打的一句话 → DSH 侧的桌宠专用会话。和点触走同一座桥（dsh-pet-bridge），
// 只是文本换成主人自己写的；桥那边按「一轮对话」跑，说完再把她的回话回流成气泡，
// 所以这里只管把话送出去，不管回话。
const REPLY_URL_FALLBACK = 'http://127.0.0.1:61944/say';
function replyBtnWanted() {
  return replyBtnOn !== false && !!String(loadCfg().bridgeUrl || '').trim();
}
function syncReplyBtn() {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.__petReplySet && window.__petReplySet(${replyBtnWanted() ? 'true' : 'false'})`).catch(() => {});
}
function setReplyBtn(on, save) {
  replyBtnOn = !!on;
  if (save) saveCfg({ replyBtn: replyBtnOn });
  syncReplyBtn();
  return replyBtnOn;
}
function replyTarget() {
  try {
    const u = new URL(String(loadCfg().bridgeUrl || '').trim() || REPLY_URL_FALLBACK);
    u.pathname = '/say';
    u.search = '';
    u.hash = '';
    return u;
  } catch {
    return new URL(REPLY_URL_FALLBACK);
  }
}
function sendReply(text) {
  return new Promise((resolve) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!t) { resolve({ ok: false, error: '空的' }); return; }
    let u;
    try { u = replyTarget(); } catch (e) { resolve({ ok: false, error: 'bridgeUrl 配得不对：' + e.message }); return; }
    const body = JSON.stringify({ text: t });
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 12000,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(raw || '{}'); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && j.ok !== false) resolve({ ok: true, text: t, target: j.target || '', sessionId: j.sessionId || '' });
        else resolve({ ok: false, error: j.error || ('桥回了 HTTP ' + res.statusCode) });
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: '连不上 DSH 侧的桥：' + e.message }));
    req.on('timeout', () => { try { req.destroy(); } catch {} });
    req.end(body);
  });
}
// 音量只作用于页面内的 Web Audio（实时语音 + 预合成台词都走这条）
function syncVolume() {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.__petSetVol && window.__petSetVol(${Number(voiceVolume) || 0})`).catch(() => {});
}
function setVolume(v) {
  const n = Math.max(0, Math.min(1, Number(v)));
  if (!Number.isFinite(n)) return voiceVolume;
  voiceVolume = n;
  saveCfg({ voiceVolume: n });
  syncVolume();
  return n;
}
// 指令动作白名单：会话里写错的东西一律丢掉，别让一条坏数据把整句话搞没
const CUE_KINDS = new Set(['trajectory', 'look', 'nod', 'shake_head', 'tilt', 'smile', 'blink', 'expression', 'gesture', 'talk', 'pose']);
const CUE_PARAMS = {
  look: ['AngleX', 'AngleY'], nod: ['AngleY'], shake_head: ['AngleX'], tilt: ['AngleZ'],
  smile: ['EyeSmile', 'MouthSmile_L', 'MouthSmile_R'], blink: ['ParamEyeLOpen', 'ParamEyeROpen'],
  talk: ['ParamMouthOpenY'],
};
function sanitizeMoves(moves) {
  if (!Array.isArray(moves)) return [];
  const out = [];
  for (const a of moves) {
    if (!a || typeof a !== 'object' || !CUE_KINDS.has(a.kind)) continue;
    const at = Number(a.at);
    const dur = Number(a.duration);
    const m = { ...a, at: Number.isFinite(at) ? Math.max(0, Math.min(60, at)) : 0 };
    if (Number.isFinite(dur)) m.duration = Math.max(0.2, Math.min(20, dur));
    // 舞台的两条硬限制：眨眼太快、点头太密都会 400，这里兜一手
    if (m.kind === 'blink') m.duration = Math.max(Number(m.duration) || 0.4, (Number(m.count) || 1) * 0.35, 0.4);
    if (m.kind === 'nod' || m.kind === 'shake_head') m.duration = Math.max(Number(m.duration) || 1.4, (Number(m.count) || 2) * 0.5);
    out.push(m);
    if (out.length >= 22) break;
  }
  return out;
}
function actionParams(a) {
  if (a.kind === 'pose') return Object.keys(a.values || {});
  if (a.kind === 'trajectory') {
    const s = new Set();
    for (const f of a.frames || []) for (const k of Object.keys(f.values || {})) s.add(k);
    return [...s];
  }
  if (a.kind === 'expression' || a.kind === 'gesture') return [];   // 独占层 / 关节，舞台自己管
  return CUE_PARAMS[a.kind] || [];
}
// 兜底：两条动作抢同一个参数时舞台会 400，这里按顺序把后一条往后挪。
// 正常路径上桥已经排过一遍，这里防的是「情绪预设 + 指令动作」这种跨来源的撞车。
function staggerConflicts(actions) {
  const booked = [];
  for (const a of actions) {
    const ps = actionParams(a);
    if (!ps.length) continue;
    let latest = -Infinity;
    for (const p of ps) for (const b of booked) if (b.param === p && b.to > latest) latest = b.to;
    if (latest > Number(a.at || 0)) a.at = +(latest + 0.05).toFixed(2);
    for (const p of ps) booked.push({ param: p, to: Number(a.at || 0) + Number(a.duration || 0) });
  }
  return actions;
}

function sayActions(ms, emotion, env, gesture, moves) {
  const dur = Math.min(20, Math.max(1, Number(ms) / 1000));
  const frames = [];
  if (Array.isArray(env) && env.length >= 2) {
    const n = Math.min(58, env.length);
    const span = Math.max(0.24, dur - 0.34);
    const step = span / (n - 1);
    for (let i = 0; i < n; i++) frames.push({ time: +(0.15 + i * step).toFixed(2), values: { ParamMouthOpenY: Math.max(0.05, Math.min(1, Number(env[i]) || 0)) } });
  } else {
    for (let t = 0.15, k = 0; t <= dur - 0.15 && frames.length < 58; t += 0.12, k++) frames.push({ time: +t.toFixed(2), values: { ParamMouthOpenY: k % 2 === 0 ? 0.95 : 0.1 } });
  }
  const actions = [{ kind: 'trajectory', at: 0, duration: dur, frames }];
  // talk 是纯口型指令，说话时已经有一条口型轨迹了，留着必撞
  const extra = sanitizeMoves(moves).filter((a) => a.kind !== 'talk');
  // 她自己点了表情就别让情绪预设再盖一次，表情是独占层，两个一起下会互相顶
  const hasOwnExpr = extra.some((a) => a.kind === 'expression');
  if (emotion && MOODS[emotion]) {
    for (const [kind, opt] of MOODS[emotion]) {
      if (hasOwnExpr && kind === 'expression') continue;
      if (extra.length && kind === 'trajectory') continue;   // 她自己写了动作，情绪的背景摆动让位
      actions.push(scaleMoodAction(kind, opt));
    }
  }
  // 手势和口型可以同帧下发（不同参数），这样「说话时手放胸前」不需要排队等半天
  if (gesture) actions.push({ kind: 'gesture', name: String(gesture), at: 0, duration: Math.max(1.4, Math.min(dur, 2.6)) });
  // 指令动作跟口型编在同一条计划里：一次下发，不会互相 stop
  for (const a of extra) {
    if (actions.length >= 24) break;
    actions.push(a);
  }
  return staggerConflicts(actions);
}
// 从合成出来的 WAV 算音量包络（每窗 RMS → 0.05..0.95），给口型用
function wavEnvelope(file, n) {
  const buf = fs.readFileSync(file);
  let pos = 12, bits = 16, dataOff = 0, dataSize = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') bits = buf.readUInt16LE(pos + 22);
    if (id === 'data') { dataOff = pos + 8; dataSize = size; break; }
    pos += 8 + size + (size % 2);
  }
  const step = bits / 8;
  const total = Math.floor(dataSize / step);
  const win = Math.max(1, Math.floor(total / n));
  const rms = [];
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = i * win; j < Math.min(total, (i + 1) * win); j++) {
      const v = bits === 16 ? buf.readInt16LE(dataOff + j * 2) / 32768 : buf[dataOff + j] / 128;
      sum += v * v; cnt++;
    }
    rms.push(Math.sqrt(sum / Math.max(1, cnt)));
  }
  const sm = rms.map((v, i) => (rms[i - 1] ?? v) * 0.25 + v * 0.5 + (rms[i + 1] ?? v) * 0.25);
  const mx = Math.max(...sm, 1e-4);
  return sm.map((v) => +(0.05 + Math.min(1, Math.pow(v / mx, 0.75)) * 0.9).toFixed(3));
}

// 实时链路：现场合成 → 包络口型 → 页面内 Web Audio 播放 + 气泡 + 口型同帧
// 旧实现用 SoundPlayer（启动偏 1~2s）且口型恒定开合，主人要的是真实效果，所以全换掉。
// 合成期间气泡停在省略号（/say 里先调 petWait），别先漏正文——这是说好的。
function prepareAndSay(text, emotion, gesture, moves) {
  if (!voiceEnabled()) {   // 没配 TTS 就只出气泡，不要把 /say 变成报错
    say(text, false, Math.max(2500, Math.min(9000, text.length * 260)));
    return;
  }
  setVoicing(true, 30000);   // 合成中先锁定 voicing（带 30s 兜底防泄露）
  const t0 = Date.now();
  const child = spawn('node', [voiceScript()], { env: { ...process.env, SAY_TEXT: text, WHALE_PET_DATA: DATA }, windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', async () => {
    const synthMs = Date.now() - t0;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(DATA, 'voice-job.json'), 'utf8').replace(/^\uFEFF/, ''));
      if (!info.job_id) throw new Error(info.error || 'prepare failed');
      const wav = path.join(loadCfg().voiceWavDir || '', info.job_id + '.wav');
      const dur = Math.min(20, Math.max(1, Number(info.duration) + 0.35));
      const ms = Math.round(dur * 1000);
      const n = Math.max(4, Math.min(58, Math.round(dur * 8)));
      let env = null;
      try { env = wavEnvelope(wav, n); } catch {}
      // 放进页面能取的目录，用 Web Audio 播（延迟 ~80ms，而不是 SoundPlayer 的 1~2s）
      // 注意：BASE 已经是 ...\tools\jingyu，所以这里**不能**再拼 '..'，否则会落到
      //      ...\tools\jingyu-live2d-agent-main\web\audio（页面取不到的错目录）→ 404 静音。
      const audioDir = path.join(BASE, 'web', 'audio');
      const audioUrl = '/audio/' + info.job_id + '.wav';
      let audioReady = false;
      try {
        fs.mkdirSync(audioDir, { recursive: true });
        fs.copyFileSync(wav, path.join(audioDir, info.job_id + '.wav'));
        audioReady = true;
      } catch (e) {
        try { fs.appendFileSync(path.join(DATA, 'pet.log'), `${new Date().toISOString()} audio-copy-fail ${audioDir} ${String(e.message).slice(0, 120)}\n`); } catch {}
      }
      say(text, false, ms);
      if (audioReady) {
        if (win && !win.isDestroyed()) {
          try { win.webContents.executeJavaScript('window.__petPlay && window.__petPlay(' + JSON.stringify(audioUrl) + ')').catch(() => {}); } catch {}
        }
      } else {
        // 兜底：页面取不到文件时用系统播放器，慢一点但保证有声音
        try { spawn('powershell', ['-NoProfile', '-Command', `(New-Object System.Media.SoundPlayer '${wav}').PlaySync()`], { windowsHide: true, stdio: 'ignore' }); } catch {}
      }
      lastSay = { text, jobId: info.job_id, synthMs, dur: +dur.toFixed(2), mouth: env ? env.length : 0, at: Date.now() };
      // 保持 voicing 锁定直到音频真正播放完毕（dur * 1000 + 400ms 缓冲）
      setVoicing(true, ms + 400);
      await runPlan({ version: 1, title: '说话', intent: '说话', summary: '说话', actions: sayActions(ms, emotion, env, gesture, moves) }, true);
      try { fs.appendFileSync(path.join(DATA, 'pet.log'), `${new Date().toISOString()} realtime say synth=${synthMs}ms dur=${dur.toFixed(2)}s mouth=${env ? env.length : 0} ${info.job_id}\n`); } catch {}
    } catch (e) {
      try { fs.appendFileSync(path.join(DATA, 'pet.log'), `${new Date().toISOString()} prep-error ${String(e.message).slice(0, 160)}\n`); } catch {}
      say(text, false, 6000);
      setVoicing(false);
      postPlan({ version: 1, title: '说话', intent: '说话', summary: '说话', actions: sayActions(6000, emotion, null, gesture, moves) });
    }
  });
}
function startWatcher() {
  if (watcherChild) return;
  if (!loadCfg().dshWatch || !R.sessions) return;   // 可选集成：默认关，没配会话目录也不启动
  try {
    watcherChild = spawn('node', [path.join(__dirname, '..', 'integ', 'dsh-watch.mjs')], {
      windowsHide: true, stdio: 'ignore',
      env: {
        ...process.env,
        DSH_SESSIONS_DIR: R.sessions,
        WHALE_PET_DATA: DATA,
        WHALE_PET_STAGE: `http://127.0.0.1:${PORT}`,
        WHALE_PET_SHELL: `http://127.0.0.1:${MOOD_PORT}`,
        WHALE_PET_MOOD: (loadCfg().moodJson || '').trim(),
      },
    });
    watcherChild.on('exit', () => { watcherChild = null; });
  } catch {}
}
function stopWatcher() {
  if (watcherChild) {
    try { spawn('taskkill', ['/PID', String(watcherChild.pid), '/T', '/F'], { windowsHide: true }); } catch {}
    watcherChild = null;
  }
}
async function ensureServerThenLoad() {
  if (!(await ping())) {
    startServer();
    for (let i = 0; i < 40 && !(await ping()); i++) await sleep(500);
  }
  loadStage();
}

let loadAttempts = 0;
function loadStage() {
  if (!win || win.isDestroyed()) return;
  loadAttempts++;
  win.loadURL(stageUrl(loadCfg().fit)).catch(() => {
    if (loadAttempts < 60) setTimeout(loadStage, 1500);
  });
}

// ---- 贴窗口：启动时把自己摆到目标窗口旁边（默认找 DSH 那个浏览器窗口）----
// 窗口矩形靠 scripts/find-window.ps1 枚举顶层窗口拿到（纯 ASCII JSON，不碰编码）。
function findDockTarget(title) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, '..', 'scripts', 'find-window.ps1');
    if (!fs.existsSync(script) || !title) return resolve(null);
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Title', title],
      { timeout: 8000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
          const j = JSON.parse(line);
          if (!j || j.ok === false || !Number.isFinite(j.w) || j.w < 100) return resolve(null);
          resolve(j);
        } catch { resolve(null); }
      });
  });
}

// 贴着目标窗口外侧放：right = 它的右边，left = 它的左边；垂直居中对齐
function dockRect(t, mode) {
  const [ww, wh] = win.getSize();
  const gap = Math.max(0, Math.min(80, Number(loadCfg().dockGap ?? 8)));
  let x = mode === 'left' ? t.x - ww - gap : t.x + t.w + gap;
  let y = t.y + Math.round((t.h - wh) / 2);
  const pt = { x: Math.max(t.x, Math.min(t.x + t.w, x + Math.round(ww / 2))), y: y + Math.round(wh / 2) };
  const d = screen.getDisplayNearestPoint(pt).workArea;
  x = Math.max(d.x - Math.round(ww * 0.25), Math.min(x, d.x + d.width - Math.round(ww * 0.75)));
  y = Math.max(d.y, Math.min(y, d.y + d.height - wh));
  return { x: Math.round(x), y: Math.round(y) };
}

// 返回 {ok, x, y, title?}；找不到窗口就保持原位（别把她甩到屏幕外）
async function applyDock(mode, opts = {}) {
  const m = mode === 'left' || mode === 'right' ? mode : 'none';
  if (opts.persist !== false) saveCfg({ dock: m });
  if (!win || win.isDestroyed() || m === 'none') return { ok: true, dock: m, moved: false };
  // 目标窗口名一定来自配置（或这次调用传的），代码里不写死任何人的窗口
  const title = String(opts.title || loadCfg().dockTitle || '').trim();
  if (!title) return { ok: false, dock: m, moved: false, error: '还没设 dockTitle：要贴哪个窗口，填它标题里的一段' };
  const t = await findDockTarget(title);
  if (!t) return { ok: false, dock: m, error: `没找到标题含「${title}」的窗口`, moved: false };
  const p = dockRect(t, m);
  win.setPosition(p.x, p.y);
  saveCfg({ x: p.x, y: p.y });
  return { ok: true, dock: m, moved: true, x: p.x, y: p.y, target: { x: t.x, y: t.y, w: t.w, h: t.h } };
}

function createWindow() {
  const cfg = loadCfg();
  const area = screen.getPrimaryDisplay().workArea;
  const width = cfg.width || 380, height = cfg.height || 680;
  const x = Number.isFinite(cfg.x) ? cfg.x : area.x + area.width - width - 40;
  const y = Number.isFinite(cfg.y) ? cfg.y : area.y + area.height - height - 40;
  smart = cfg.smart !== false; alwaysOnTop = cfg.onTop !== false;

  win = new BrowserWindow({
    x, y, width, height, show: false, transparent: true, frame: false, hasShadow: false,
    resizable: true, movable: true, minimizable: true, maximizable: false, skipTaskbar: true,
    alwaysOnTop: true, roundedCorners: false, backgroundColor: '#00000000',
    icon: assetPath('icon-256.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false, spellcheck: false },
  });
  win.setAlwaysOnTop(alwaysOnTop, 'screen-saver');
  win.webContents.on('did-finish-load', async () => {
    loadAttempts = 0;
    win.webContents.executeJavaScript(BUBBLE_JS).then(() => { applyBubblePos(loadCfg().bubblePos || 'bottom'); syncSway(); syncVolume(); syncTickBubble(); syncReplyBtn(); }).catch(() => {});
    // 第一次露脸前先贴到目标窗口旁边（设置里的 dock），找不到就还按上次的坐标站
    const dm = loadCfg().dock;
    if ((dm === 'left' || dm === 'right') && !win.isVisible()) {
      try { await applyDock(dm, { persist: false }); } catch {}
    }
    if (!win.isVisible()) win.show();
    // 页面刚加载时模型还没画出来，等它站稳再量剪影，这样第一次点击就不用现场扫
    setTimeout(() => { try { win.webContents.send('pet:zones-reset'); } catch {} }, 2500);
  });
  win.webContents.on('context-menu', () => popupTrayMenu());
  let boundsTimer = null;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      const [w, h] = win.getSize();
      saveCfg({ x, y, width: w, height: h });
    }, 400);
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);
  win.on('closed', () => { win = null; });
  ensureServerThenLoad();
}

function stopDrag() { if (dragTimer) { clearInterval(dragTimer); dragTimer = null; } }

ipcMain.on('pet:ignore', (_e, ignore) => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!ignore, { forward: true }); });
// 回复输入卡：打开时把窗口拉到前台拿焦点（不聚焦就打不了字）；发送走 sendReply
ipcMain.on('pet:reply-open', () => {
  if (!win || win.isDestroyed()) return;
  try { if (!win.isVisible()) win.show(); } catch {}
  try { win.focus(); } catch {}
});
ipcMain.handle('pet:reply-send', (_e, text) => sendReply(text));
ipcMain.on('pet:drag-start', () => {
  if (!win || dragTimer) return;
  const start = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return stopDrag();
    const p = screen.getCursorScreenPoint();
    win.setPosition(wx + p.x - start.x, wy + p.y - start.y);
  }, 16);
});
ipcMain.on('pet:drag-end', stopDrag);
ipcMain.on('pet:need-smart', (e) => {
  try {
    e.sender.send('pet:smart', smart);
    e.sender.send('pet:interactive', interactive);
  } catch {}
});

// ---- 指针追踪：主进程轮询全局鼠标，窗口穿透也照样能看 ----
// 归一化到桌宠窗口：x/y ∈ -1..1（右/上为正）；指针离开桌宠所在屏幕时送 null，模型自然回到待机
let cursorTrack = true, cursorTimer = null, lastCursorKey = '', lastCursorSentAt = 0;

// 绕着她转圈 → 眩晕 → 嫌弃 → 黑脸生气 → 冷却（2026-11-01 主人点的玩法）
// 判据：以**头部**为圆心（不是模型中心：头在窗口约 22% 高处），指针到头的半径 > 55px 时累计有向转角。
// 2026-11-01 主人反馈「两圈太灵敏」→ 一节改成攒满 turnsPerStage 圈（默认 6，config.spinTurns 可调 2~20），
// 不再用「时间窗内凑够一圈」那种判法：手一停（gapMs）、离开调戏区、或明确反向就清零重来。
const SPIN = { gapMs: 700, minR: 55, headX: 0.503, headY: 0.22, zoneR: 0.27, stageGap: 900, turnsPerStage: 6 };
let spinHist = [], spinStage = 0, spinSuspendedUntil = 0, spinCooldownUntil = 0, spinLastStageAt = 0;
let spinAccum = 0, spinDir = 0, spinLastA = null, spinAccumAt = 0;
let spinTurns = SPIN.turnsPerStage;   // 一节要转几圈：启动时从 config.spinTurns 读（2~20）
const COOLDOWN_MS = 26000;

function exprPlan(name, secs, strength) {
  return { version: 1, title: 'pet · ' + name, intent: 'pet · ' + name, summary: 'pet · ' + name,
    actions: [{ kind: 'expression', name, strength: Number.isFinite(strength) ? strength : 1, layer: 'exclusive', at: 0.12, duration: secs }] };
}

// 第三节用的一套：黑脸 + 手放胸前（模型自带 hand_on_chest 手势）
function angerPlan() {
  return { version: 1, title: 'pet · 生气', intent: 'pet · 生气', summary: 'pet · 生气',
    actions: [
      { kind: 'expression', name: '黑脸', strength: 1, layer: 'exclusive', at: 0.12, duration: 5 },
      { kind: 'gesture', name: 'hand_on_chest', at: 0.3, duration: 4.6 },
    ] };
}

// 抢一下舞台：先停掉联动的短动作，再重试着把这一发塞进去（引擎同时只收一个计划）
function pushPetPlan(plan, ms) {
  return (async () => {
    await stopPlan(); await sleep(150);
    let ok = false;
    for (let i = 0; i < 6 && !ok; i++) { ok = await postPlan(plan); if (!ok) await sleep(280); }
    if (ok) planBusyUntil = Date.now() + Math.max(1200, Number(ms) || 3000);
    return ok;
  })().catch(() => false);
}

function spinAdvance() {
  const now = Date.now();
  if (now < spinCooldownUntil || now - spinLastStageAt < SPIN.stageGap) return;
  spinLastStageAt = now; spinStage++; spinClear();
  if (spinStage === 1) {
    // 第一节：转晕了，眼睛成漩涡，暂时不理鼠标
    spinSuspendedUntil = now + 3600;
    pushPetPlan(exprPlan('圈圈眼', 3.2), 3800);
  } else if (spinStage === 2) {
    // 第二节：嫌弃（整身预设），被围着转已经开始不耐烦
    spinSuspendedUntil = now + 4000;
    sendMood('annoyed', 0.8).catch(() => {});
  } else {
    // 第三节：真生气了——黑脸 + 手放胸前，彻底不看鼠标，进冷却；冷却结束才恢复
    spinSuspendedUntil = now + COOLDOWN_MS;
    spinCooldownUntil = now + COOLDOWN_MS;
    pushPetPlan(angerPlan(), 6200);
  }
}

// 调戏区：以头部为圆心的圆（跟着窗口尺寸缩放）
function spinZone(ww, wh) {
  return {
    cx: Math.round(ww * SPIN.headX),
    cy: Math.round(wh * SPIN.headY),
    r: Math.max(120, Math.round(wh * SPIN.zoneR)),
  };
}
function inSpinZone(dx, dy, ww, wh) {
  return Math.hypot(dx, dy) <= spinZone(ww, wh).r;
}

function spinClear() { spinAccum = 0; spinDir = 0; spinLastA = null; spinHist = []; }

function spinDetect(p, wx, wy, ww, wh) {
  const now = Date.now();
  if (spinStage >= 3 && now >= spinCooldownUntil) { spinStage = 0; spinClear(); }
  if (now < spinCooldownUntil || now < spinSuspendedUntil) { spinClear(); return; }
  const z = spinZone(ww, wh);
  const dx = p.x - (wx + z.cx), dy = p.y - (wy + z.cy);   // 相对头部，不是窗口中心
  const dist = Math.hypot(dx, dy);
  if (dist < SPIN.minR || dist > z.r) { spinClear(); return; }   // 手离开调戏区：之前的都不算
  // 手停了：断档超过 gapMs 就作废，别让好几段零碎的转合成一节
  if (now - spinAccumAt > SPIN.gapMs) { spinAccum = 0; spinDir = 0; spinLastA = null; }
  const a = Math.atan2(dy, dx);
  spinHist.push({ t: now, a });
  if (spinHist.length > 240) spinHist.shift();   // 只留作调试回看
  if (spinLastA === null) { spinLastA = a; spinAccumAt = now; return; }
  let d = a - spinLastA;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  spinLastA = a;
  if (Math.abs(d) < 0.002) return;   // 抖动/停手不算转角，也不刷新断档计时
  spinAccumAt = now;
  const dir = d > 0 ? 1 : -1;
  if (spinDir === 0) { spinDir = dir; spinAccum = 0; }
  else if (dir !== spinDir && Math.abs(d) > 0.35) { spinDir = dir; spinAccum = 0; }   // 明确反手：重新数
  spinAccum += d;
  const need = Math.PI * 2 * spinTurns;
  if (Math.abs(spinAccum) >= need) spinAdvance();
}

function startCursorTrack() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible() || !cursorTrack) return;
    const p = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    const [ww, wh] = win.getSize();
    const display = screen.getDisplayNearestPoint(p);
    const petDisplay = screen.getDisplayNearestPoint({ x: wx + Math.round(ww / 2), y: wy + Math.round(wh / 2) });
    let payload = null;
    if (display.id === petDisplay.id) {
      const cx = (p.x - wx) / Math.max(1, ww), cy = (p.y - wy) / Math.max(1, wh);
      let x = Math.max(-1, Math.min(1, cx * 2 - 1));
      let y = Math.max(-1, Math.min(1, 1 - cy * 2));
      if (Math.abs(x) < 0.04 && Math.abs(y) < 0.04) { x = 0; y = 0; }   // 死区，正中间不抖
      payload = { x: +x.toFixed(3), y: +y.toFixed(3), inside: cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1 };
      spinDetect(p, wx, wy, ww, wh);
      if (Date.now() < spinSuspendedUntil) payload = null;   // 生气/发晕期间不看鼠标
    }
    const key = payload ? `${payload.x},${payload.y}` : 'null';
    if (key !== lastCursorKey || Date.now() - lastCursorSentAt > 400) {
      lastCursorKey = key; lastCursorSentAt = Date.now();
      try { win.webContents.send('pet:cursor', payload); } catch {}
    }
  }, 33);
}

// ---- 尺寸面板 ----
ipcMain.handle('size:get', () => {
  const [w, h] = win && !win.isDestroyed() ? win.getSize() : [380, 680];
  return { w, h, min: SIZE_MIN, max: SIZE_MAX, aspect: w / Math.max(1, h) };
});

// ---- 配置面板：路径 / 端口 / 可选集成 ----
ipcMain.handle('cfg:get', () => ({ cfg: loadCfg(), resolved: R }));
ipcMain.handle('cfg:save', (_e, patch) => {
  saveCfg(patch || {});
  if (patch && typeof patch.interactive === 'boolean') setInteractive(patch.interactive, false);   // 存过了，只广播
  if (patch && typeof patch.bridge === 'boolean') setBridge(patch.bridge, false);
  if (patch && typeof patch.tickBubble === 'boolean') syncTickBubble();
  if (patch && typeof patch.replyBtn === 'boolean') setReplyBtn(patch.replyBtn, false);   // 存过了，只广播
  // 帧率改了要重载舞台才生效（只重载页面，不动窗口）
  if (patch && patch.stageFps !== undefined) applyStageFps(patch.stageFps);
  const r = refreshPaths();
  plog('config saved: ' + JSON.stringify(patch || {}));
  return r;
});
ipcMain.handle('cfg:pick', async (_e, kind) => {
  const { dialog } = require('electron');
  const wantFile = kind === 'pythonPath';
  const res = await dialog.showOpenDialog(panel && !panel.isDestroyed() ? panel : undefined, {
    title: wantFile ? '选择 Python 解释器' : '选择目录',
    properties: wantFile ? ['openFile'] : ['openDirectory'],
    filters: wantFile ? [{ name: 'Python', extensions: ['exe'] }] : undefined,
  });
  return res.canceled || !res.filePaths.length ? '' : res.filePaths[0];
});
ipcMain.handle('cfg:restart', () => { app.relaunch(); app.exit(0); });
ipcMain.on('size:preview', (_e, p) => { if (p) applySize(p.w, p.h, false); });
ipcMain.on('size:commit', (_e, p) => {
  if (!p) return;
  const r = applySize(p.w, p.h, true);
  if (r && panel && !panel.isDestroyed()) { try { panel.webContents.send('size:changed', r); } catch {} }
});
ipcMain.on('size:close', () => { if (panel && !panel.isDestroyed()) panel.close(); });
// Ctrl + 滚轮：每档 40px（按高度），比例保持
ipcMain.on('pet:wheel-resize', (_e, dir) => {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getSize();
  const nh = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(h + (Number(dir) > 0 ? 40 : -40))));
  applySize(Math.round(nh * (w / Math.max(1, h))), nh, true);
});

function trayIcon() {
  const p = assetPath('icon-32.png');
  const img = nativeImage.createFromPath(p);
  // 加载不到只会得到空图、托盘一片空白，而且不报错，所以留一行日志方便排查
  if (img.isEmpty()) plog('tray icon EMPTY: ' + p);
  else plog('tray icon ok: ' + p + ' ' + JSON.stringify(img.getSize()));
  return img;
}

function popupTrayMenu() {
  if (!tray) return;
  tray.popUpContextMenu();
}

function shortcutFile() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '大肥鱼桌宠.lnk');
}
function autostartOn() { return fs.existsSync(shortcutFile()); }
function setAutostart(on) {
  if (on) {
    shell.writeShortcutLink(shortcutFile(), 'create', { target: process.execPath, args: `"${__dirname}"`, cwd: __dirname, icon: assetPath('icon-256.png'), description: '大肥鱼桌宠' });
  } else if (fs.existsSync(shortcutFile())) fs.unlinkSync(shortcutFile());
}

// 尺寸：滑杆按「高度」调，宽度跟着当前比例走；脚底为锚，往上长
const SIZE_MIN = 420, SIZE_MAX = 1400;
function applySize(w, h, save) {
  if (!win || win.isDestroyed()) return null;
  const W = Math.max(240, Math.min(1600, Math.round(Number(w) || 380)));
  const H = Math.max(360, Math.min(2000, Math.round(Number(h) || 680)));
  const [ox, oy] = win.getPosition();
  const [ow, oh] = win.getSize();
  const d = screen.getDisplayNearestPoint({ x: ox + Math.round(ow / 2), y: oy + Math.round(oh / 2) }).workArea;
  win.setSize(W, H);
  let nx = Math.round(ox + ow / 2 - W / 2);
  let ny = Math.round(oy + oh - H);
  nx = Math.min(Math.max(nx, d.x - Math.round(W * 0.3)), d.x + d.width - Math.round(W * 0.7));
  ny = Math.min(Math.max(ny, d.y), d.y + d.height - 80);
  win.setPosition(nx, ny);
  if (save) saveCfg({ width: W, height: H });
  // 剪影缓存在 preload 里，尺寸一变就得重扫，不然点哪儿都会跟着旧比例漂
  try { win.webContents.send('pet:zones-reset'); } catch {}
  return { width: W, height: H };
}
function setSize(w, h) { return applySize(w, h, true) || { width: w, height: h }; }

// 设置面板（小程序窗）：尺寸滑杆 + 依赖路径
function createPanel() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return panel; }
  const area = screen.getPrimaryDisplay().workArea;
  const PW = 396, PH = 760; // 高度贴着内容，不留空白（内容约 736，留 24 余量）
  panel = new BrowserWindow({
    width: PW, height: PH,
    x: area.x + Math.round((area.width - PW) / 2), y: area.y + Math.round((area.height - PH) / 2),
    frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#00000000', roundedCorners: true,
    icon: assetPath('icon-256.png'),
    webPreferences: { preload: path.join(__dirname, 'panel-preload.js'), contextIsolation: true, sandbox: false, spellcheck: false },
  });
  panel.setAlwaysOnTop(true, 'screen-saver');
  panel.loadFile(path.join(__dirname, 'panel.html')).catch(() => {});
  panel.once('ready-to-show', () => { if (panel && !panel.isDestroyed()) panel.show(); });
  panel.on('closed', () => { panel = null; });
  return panel;
}

function buildMenu() {
  const fitNow = loadCfg().fit === 'full' ? 'full' : 'portrait';
  const bubbleNow = loadCfg().bubblePos || 'bottom';
  const dockNow = loadCfg().dock || 'none';
  const dockClick = (mode) => { applyDock(mode).then((r) => { if (!r.ok) say(r.error || '没找到窗口', false, 4000); }).catch(() => {}); };
  return Menu.buildFromTemplate([
    { label: win && win.isVisible() ? '隐藏' : '显示', click: () => { if (!win) return createWindow(); win.isVisible() ? win.hide() : win.show(); } },
    { type: 'separator' },
    // 顶层只留 5 组：互动 / 外观 / 情绪 / 设置 / 更多。开关类都收进「互动」，别越铺越长。
    { label: '互动', submenu: [
      { label: '分区互动（点她按部位反应，光标变软点）', type: 'checkbox', checked: interactive, click: (item) => setInteractive(item.checked, true) },
      { label: '模型桥接（点她会叫醒 DSH 会话）', type: 'checkbox', checked: bridgeOn, click: (item) => setBridge(item.checked, true) },
      { label: '气泡回复钮（点她在桌宠里直接回话）', type: 'checkbox', checked: replyBtnOn, click: (item) => setReplyBtn(item.checked, true) },
      { label: '指针追踪（视线与身体跟着鼠标）', type: 'checkbox', checked: cursorTrack, click: (item) => { cursorTrack = item.checked; saveCfg({ cursorTrack }); lastCursorKey = ''; if (!cursorTrack && win && !win.isDestroyed()) { try { win.webContents.send('pet:cursor', null); } catch {} } } },
      { label: '智能穿透（只在角色身上响应）', type: 'checkbox', checked: smart, click: (item) => { smart = item.checked; saveCfg({ smart }); if (win) win.webContents.send('pet:smart', smart); } },
      { label: '自动情绪（跟随 DSH 回复）', type: 'checkbox', checked: autoMood, click: (item) => { autoMood = item.checked; saveCfg({ autoMood }); autoMood ? startWatcher() : stopWatcher(); } },
    ] },
    { label: '外观', submenu: [
      { label: '全身 / 近景', submenu: [
        { label: '近景（默认）', type: 'radio', checked: fitNow !== 'full', click: () => { saveCfg({ fit: 'portrait' }); loadStage(); } },
        { label: '全身', type: 'radio', checked: fitNow === 'full', click: () => { saveCfg({ fit: 'full' }); loadStage(); } },
      ] },
      { label: '尺寸', submenu: [
        { label: '小（300 × 520）', click: () => setSize(300, 520) },
        { label: '中（380 × 680）', click: () => setSize(380, 680) },
        { label: '大（480 × 860）', click: () => setSize(480, 860) },
        { type: 'separator' },
        { label: '滑杆微调…', click: () => createPanel() },
        { label: '也可 Ctrl + 滚轮（角色身上）', enabled: false },
      ] },
      { label: '气泡位置', submenu: [['bottom','底部'],['top','顶部'],['left','左侧（竖排）'],['right','右侧（竖排）']].map(([p,label]) => ({ label, type: 'radio', checked: bubbleNow === p, click: () => { saveCfg({ bubblePos: p }); applyBubblePos(p); } })) },
      { label: '贴窗口（启动时）', submenu: [
        { label: '贴在它左边', type: 'radio', checked: dockNow === 'left', click: () => dockClick('left') },
        { label: '贴在它右边', type: 'radio', checked: dockNow === 'right', click: () => dockClick('right') },
        { label: '不贴（记住上次位置）', type: 'radio', checked: dockNow === 'none', click: () => dockClick('none') },
        { type: 'separator' },
        { label: '现在就贴一次', click: () => dockClick(dockNow === 'none' ? 'right' : dockNow) },
        { label: `目标窗口：${loadCfg().dockTitle || '（没设，改 config.json 的 dockTitle）'}`, enabled: false },
      ] },
      ...(voiceEnabled() ? [{ label: `语音音量（${Math.round(voiceVolume * 100)}%）`, submenu: [[1,'100%'],[0.7,'70%'],[0.55,'55%'],[0.4,'40%'],[0.25,'25%'],[0.1,'10%']].map(([v,label]) => ({ label, type: 'radio', checked: Math.abs(voiceVolume - v) < 0.01, click: () => setVolume(v) })) }] : []),
      { type: 'separator' },
      { label: '置顶显示', type: 'checkbox', checked: alwaysOnTop, click: (item) => { alwaysOnTop = item.checked; saveCfg({ onTop: alwaysOnTop }); if (win) win.setAlwaysOnTop(alwaysOnTop, 'screen-saver'); } },
    ] },
    { label: '情绪', submenu: [
      ...[['happy','开心'],['shy','害羞'],['excited','兴奋'],['thinking','思考'],['sleepy','困'],['proud','得意'],['annoyed','嫌弃'],['surprised','吃惊']].map(([e, label]) => ({ label, click: () => sendMood(e, 0.7) })),
      { type: 'separator' },
      { label: '随机来一个', click: () => { const ks = Object.keys(MOODS); sendMood(ks[Math.floor(Math.random() * ks.length)], 0.7); } },
    ] },
    { label: '设置…（尺寸 / 鲸语 / 模型 / 端口）', click: () => createPanel() },
    { type: 'separator' },
    { label: '更多', submenu: [
      { label: '重新载入', click: () => loadStage() },
      { label: '打开鲸语工作台', click: () => shell.openExternal(`http://127.0.0.1:${PORT}/`) },
      { label: '复制舞台地址（OBS 用）', click: () => clipboard.writeText(stageUrl('portrait')) },
      { type: 'separator' },
      { label: '开机自启', type: 'checkbox', checked: autostartOn(), click: (item) => setAutostart(item.checked) },
    ] },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => {
  stopDrag();
  if (serverChild) {
    try { spawn('taskkill', ['/PID', String(serverChild.pid), '/T', '/F'], { windowsHide: true }); } catch {}
  }
});

app.whenReady().then(() => {
  refreshPaths();   // 先摊平配置，才知道鲸语在哪、模型在哪
  smart = loadCfg().smart !== false;
  alwaysOnTop = loadCfg().onTop !== false;
  interactive = loadCfg().interactive !== false;
  bridgeOn = loadCfg().bridge !== false;
  replyBtnOn = loadCfg().replyBtn !== false;
  autoMood = loadCfg().autoMood !== false;
  cursorTrack = loadCfg().cursorTrack !== false;
  { const st = Number(loadCfg().spinTurns); spinTurns = Number.isFinite(st) ? Math.min(20, Math.max(2, Math.round(st))) : SPIN.turnsPerStage; }
  const vv = Number(loadCfg().voiceVolume);
  voiceVolume = Number.isFinite(vv) ? Math.max(0, Math.min(1, vv)) : 0.5;
  saveCfg({ autoMood, voiceVolume });
  startMoodServer();   // 控制端口先起：配置没填好也能用面板改
  if (R.ok) {
    createWindow();
  } else {
    // 第一次跑 / 配置不完整：直接开设置面板，让人填鲸语和模型目录
    plog('config incomplete: ' + R.problems.join(' | '));
    createPanel();
  }
  tray = new Tray(trayIcon());
  tray.setToolTip('桌宠 · 右键菜单');
  tray.setContextMenu(buildMenu());
  setInterval(() => { if (tray) tray.setContextMenu(buildMenu()); }, 3000);
  if (R.ok) {
    startSway();
    startCursorTrack();
    if (autoMood) startWatcher();
    setTimeout(() => { if (voiceEnabled()) warmVoices().catch(() => {}); }, 9000);   // 舞台起来后再预合成台词
    setInterval(idleTick, 45000);
    // TTS 保活：启动 90 秒后先热一次（省得开工第一句等 27 秒），之后每 15 分钟一次
    setTimeout(() => keepAliveTick(), 90000);
    setInterval(() => keepAliveTick(), KEEPALIVE_MS);
  }
});
