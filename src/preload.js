const { ipcRenderer, contextBridge } = require('electron');

// 主进程每 ~33ms 送来全局指针（相对窗口归一化 -1..1，指针不在桌宠所在屏幕时送 null）
const cursorListeners = new Set();
ipcRenderer.on('pet:cursor', (_e, c) => { for (const fn of cursorListeners) { try { fn(c); } catch {} } });
contextBridge.exposeInMainWorld('petCursor', {
  on(fn) { if (typeof fn === 'function') cursorListeners.add(fn); },
  off(fn) { cursorListeners.delete(fn); },
});

let smart = true;
let interactive = true;   // 分区互动开关：关掉后点她不会再触发反应，光标也回到系统默认
let overNow = null;
let ignored = null;
let dragging = false;
let alphaBroken = false;
let uiLock = false;       // 回复输入卡开着：这段时间整窗都吃鼠标（不然打字时还在穿透）

// 悬停在她身上时的光标：一个蓝色软点 + 白描边，热点在正中。比手型光标柔和，也不抢她。
const PET_CURSOR_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'>"
  + "<circle cx='16' cy='16' r='10' fill='#5aa9ff' fill-opacity='0.28'/>"
  + "<circle cx='16' cy='16' r='5.5' fill='#2a7fff' fill-opacity='0.95' stroke='#ffffff' stroke-width='2'/></svg>";
const PET_CURSOR = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(PET_CURSOR_SVG) + '") 16 16, pointer';

function applyCursor(over) {
  if (over === overNow) return;
  overNow = over;
  // 互动关掉时一律默认光标；开着且压在她身上才换，离开立刻复原
  document.documentElement.style.cursor = (interactive && over) ? PET_CURSOR : 'default';
}

function sendIgnore(v) {
  if (v === ignored) return;
  ignored = v;
  ipcRenderer.send('pet:ignore', v);
}

function hitRect() {
  const el = document.getElementById('scene');
  if (!el || !el.dataset.hit) return null;
  const [x, y, w, h] = el.dataset.hit.split(',').map(Number);
  if (![x, y, w, h].every(Number.isFinite) || w <= 2 || h <= 2) return null;
  return { x, y, w, h };
}

// 读画布该点 alpha：透明像素 = 点击穿透，角色像素 = 可交互
function alphaAt(x, y) {
  const c = document.getElementById('model-canvas');
  if (!c) return 0;
  let gl = null;
  try { gl = c.getContext('webgl2') || c.getContext('webgl'); } catch { alphaBroken = true; return 0; }
  if (!gl) { alphaBroken = true; return 0; }
  const r = c.getBoundingClientRect();
  const dpr = c.width / Math.max(1, r.width);
  const px = Math.round(x * dpr);
  const py = Math.round((r.height - y) * dpr);
  const buf = new Uint8Array(4);
  try { gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf); } catch { alphaBroken = true; return 0; }
  return buf[3];
}

function overPet(x, y) {
  const a = alphaAt(x, y);
  if (a > 12) return true;
  if (!alphaBroken) return false;
  const r = hitRect();
  if (!r) return false;
  return x >= r.x - 4 && x <= r.x + r.w + 4 && y >= r.y - 4 && y <= r.y + r.h + 4;
}

let lastInteractSent = 0;
// 像素命中测试要 readPixels，每次都带 GPU 同步；高刷鼠标 400~1000Hz 时一秒能触发上百次，
// 拖动中尤其明显（画面一顿一顿地闪）。同一帧内不重复读，同一小格 120ms 内直接复用上次结果。
let lastHit = { x: -9999, y: -9999, at: 0, over: false };
function overPetCached(x, y) {
  const now = performance.now();
  const same = Math.abs(x - lastHit.x) < 3 && Math.abs(y - lastHit.y) < 3;
  if (same && now - lastHit.at < 120) return lastHit.over;
  if (now - lastHit.at < 16) return lastHit.over;
  const over = overPet(x, y);
  lastHit = { x, y, at: now, over };
  return over;
}
// 页面里带 data-pet-ui 的元素（气泡回复钮、回复输入卡）是整窗唯一的可点 DOM。
// 它们外面全是穿透区，所以悬停到它们身上时也必须先关掉穿透，否则点不到。
function uiAt(x, y) {
  try {
    const t = document.elementFromPoint(x, y);
    return !!(t && t.closest && t.closest('[data-pet-ui]'));
  } catch { return false; }
}
document.addEventListener('mousemove', (e) => {
  // 拖动中一律不碰穿透/光标：一直按住 Alt 拖的时候鼠标在窗口里挪来挪去，随手一算就可能判成
  // 「离开角色」→ 窗口变穿透 → 拖动断掉、窗口在可点/穿透之间来回切、屏幕跟着闪。拖动期间保持原样。
  if (dragging) return;
  if (!smart) { applyCursor(false); return; }
  const ui = uiLock || uiAt(e.clientX, e.clientY);
  const over = ui || overPetCached(e.clientX, e.clientY);
  sendIgnore(!over);
  applyCursor(ui ? false : over);
  const now = Date.now();
  if (over && !ui && now - lastInteractSent > 2500) { lastInteractSent = now; ipcRenderer.send('pet:interact'); }
}, true);

// ---- 回复她：页面里开的输入卡 → 主进程 → DSH 侧桌宠会话 ----
// 用 document 上的 CustomEvent 通信，不往页面里塞 API：注入脚本和 preload 分处两个世界，
// CustomEvent 是两边都能看见的那一层。
document.addEventListener('pet:reply-open', () => {
  uiLock = true;
  overNow = null;
  sendIgnore(false);
  ipcRenderer.send('pet:reply-open');
});
document.addEventListener('pet:reply-close', () => {
  uiLock = false;
  sendIgnore(true);
});
document.addEventListener('pet:reply-send', (e) => {
  const text = String(e.detail || '');
  ipcRenderer.invoke('pet:reply-send', text).then((r) => {
    document.dispatchEvent(new CustomEvent('pet:reply-result', { detail: r || {} }));
  }).catch((err) => {
    document.dispatchEvent(new CustomEvent('pet:reply-result', { detail: { ok: false, error: String((err && err.message) || err) } }));
  });
});

// ---- 剪影标定 ----
// 分区比例必须相对「模型自己」而不是窗口：窗口拉伸、Ctrl+滚轮缩放、换 fit、换模型或换装，
// 模型在画布里的位置和大小都会变，写死窗口比例就会像「点胸判成脖子」这样漂。
// 所以启动后扫一遍 canvas 的 alpha 轮廓，量出剪影包围盒，之后点击都换算成模型比例。
let profile = null;        // { bbox:{top,bottom,left,right}, rows:[{y,l,r,w}], at, canvasH }

function modelCanvas() {
  const c = document.getElementById('model-canvas');
  if (!c) return null;
  let gl = null;
  try { gl = c.getContext('webgl2') || c.getContext('webgl'); } catch { return null; }
  return gl ? { gl, c } : null;
}

// 逐行读 alpha，得到剪影轮廓（canvas 归一化，y 向下）
function scanProfile() {
  const ctx = modelCanvas();
  if (!ctx) return null;
  const { gl, c } = ctx;
  const W = c.width, H = c.height;
  if (W < 8 || H < 8) return null;
  const step = Math.max(1, Math.ceil(H / 192));
  const buf = new Uint8Array(W * 4);
  const rows = [];
  for (let yy = 0; yy < H; yy += step) {
    try { gl.readPixels(0, H - 1 - yy, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf); } catch { return null; }
    let l = -1, r = -1;
    for (let x = 0; x < W; x++) if (buf[x * 4 + 3] > 12) { l = x; break; }
    if (l < 0) continue;
    for (let x = W - 1; x >= 0; x--) if (buf[x * 4 + 3] > 12) { r = x; break; }
    rows.push({ y: yy / Math.max(1, H - 1), l: l / Math.max(1, W - 1), r: r / Math.max(1, W - 1), w: (r - l) / Math.max(1, W - 1) });
  }
  if (rows.length < 4) return null;
  let left = 1, right = 0;
  for (const row of rows) { if (row.l < left) left = row.l; if (row.r > right) right = row.r; }
  return {
    bbox: { top: rows[0].y, bottom: rows[rows.length - 1].y, left, right },
    rows,
    at: Date.now(),
    canvasH: H,
  };
}

// 脖子 = 头下方最窄的那一段，用轮廓宽度曲线自动找，不靠硬编码
function detectNeck(p) {
  if (!p || !p.rows || p.rows.length < 12) return null;
  const h = p.bbox.bottom - p.bbox.top;
  if (h <= 0.05) return null;
  const from = p.bbox.top + h * 0.12;
  const to = p.bbox.top + h * 0.40;
  let best = null;
  for (const row of p.rows) {
    if (row.y < from || row.y > to) continue;
    if (!best || row.w < best.w) best = row;
  }
  if (!best) return null;
  return { y: (best.y - p.bbox.top) / h, w: best.w };
}

// 点击坐标 → 模型比例（剪影左上角为 0,0）；没有轮廓时退回 canvas 比例
function toModelXY(clientX, clientY) {
  const c = document.getElementById('model-canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  const cx = (clientX - r.left) / r.width;
  const cy = (clientY - r.top) / r.height;
  const p = profile;
  if (!p) return { mx: cx, my: cy, calibrated: false };
  const bh = Math.max(0.01, p.bbox.bottom - p.bbox.top);
  const bw = Math.max(0.01, p.bbox.right - p.bbox.left);
  return { mx: (cx - p.bbox.left) / bw, my: (cy - p.bbox.top) / bh, calibrated: true };
}

// 点击落在身体的哪一段（模型比例）。数值是按当前模型实测标定的：截窗口截图 + 测每一行的
// alpha 左右边界，量出头顶(0%) → 发箍 4.8% → 下巴 17.2% → 脖子 20.3% → 胸 34.0% →
// 腰 40.8% → 裙摆 63.1% → 脚踝 95.4%。换模型或换装（剪影变了）就重跑 `pet.mjs zones scan`
// 核一遍再改这里；只要还是这套衣服，窗口拉大缩小、Ctrl+滚轮缩放都不用重标，因为已经归一化到剪影。
const ZONE_BANDS = [
  [0.048, 'hair'],
  [0.172, 'head'],
  [0.203, 'neck'],
  [0.340, 'chest'],
  [0.408, 'waist'],
  [0.631, 'skirt'],
  [0.954, 'leg'],
  [1.02, 'foot'],
];
function zoneOf(my, p) {
  if (!p) return 'body';
  for (const [edge, name] of ZONE_BANDS) if (my < edge) return name;
  return 'body';
}

window.addEventListener('click', (e) => {
  if (!interactive) return;   // 互动关掉：点她等于点空气，穿透照旧
  if (dragging || e.altKey) return;
  if (!(alphaAt(e.clientX, e.clientY) > 12)) return;
  if (!profile) { const p0 = scanProfile(); if (p0) profile = p0; }   // 没标定就先量一次，宁可慢一帧也不错判
  const p = profile;
  const at = toModelXY(e.clientX, e.clientY);
  if (!at) return;
  const clamp = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  ipcRenderer.send('pet:tap', {
    nx: clamp(at.mx),
    ny: clamp(at.my),
    zone: zoneOf(at.my, p),
    calibrated: !!at.calibrated,
  });
}, true);

// 主进程要轮廓：扫一遍回传（一次性，用来标定分区 / 换模型后重标）
ipcRenderer.on('pet:zones-scan', () => {
  const p = scanProfile();
  if (p) profile = p;
  const neck = detectNeck(p);
  ipcRenderer.send('pet:zones-result', p ? { ok: true, bbox: p.bbox, rows: p.rows, neck, at: p.at } : { ok: false });
});

ipcRenderer.on('pet:zones-prime', () => {
  if (profile) return;
  const p = scanProfile();
  if (p) profile = p;
});

// 窗口尺寸 / fit 变了：模型在画布里的位置和大小都变了，剪影必须重扫，否则分区跟着漂
ipcRenderer.on('pet:zones-reset', () => {
  profile = null;
  setTimeout(() => { const p = scanProfile(); if (p) profile = p; }, 600);
});

window.addEventListener('mousedown', (e) => {
  if (e.button === 0 && e.altKey) {
    dragging = true;
    lastHit = { x: -9999, y: -9999, at: 0, over: false };
    sendIgnore(false);   // 拖动期间窗口必须一直吃鼠标，否则 mouseup 收不到、拖动停不下来
    e.preventDefault();
    ipcRenderer.send('pet:drag-start');
  }
}, true);

window.addEventListener('mouseup', () => {
  if (dragging) {
    dragging = false;
    ipcRenderer.send('pet:drag-end');
  }
}, true);

window.addEventListener('blur', () => {
  if (dragging) {
    dragging = false;
    ipcRenderer.send('pet:drag-end');
  }
  // 输入卡开着时点了别处：收掉，别留一个抢焦点的空窗
  if (uiLock) document.dispatchEvent(new CustomEvent('pet:reply-cancel'));
});

ipcRenderer.on('pet:smart', (_e, on) => {
  smart = !!on;
  sendIgnore(true);
  if (!smart) { applyCursor(false); sendIgnore(false); }
});

// 分区互动总开关：面板 / 托盘 / CLI 都能改，即时生效，不用重启
ipcRenderer.on('pet:interactive', (_e, on) => {
  interactive = !!on;
  overNow = null;
  applyCursor(false);
  document.documentElement.style.cursor = 'default';
});

// Ctrl + 滚轮 = 微调桌宠尺寸（主进程改窗口，比例不变）
window.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  ipcRenderer.send('pet:wheel-resize', e.deltaY > 0 ? -1 : 1);
}, { passive: false });

window.addEventListener('DOMContentLoaded', () => {
  sendIgnore(true);
  ipcRenderer.send('pet:need-smart');
});
