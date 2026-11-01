const { ipcRenderer, contextBridge } = require('electron');

// 主进程每 ~33ms 送来全局指针（相对窗口归一化 -1..1，指针不在桌宠所在屏幕时送 null）
const cursorListeners = new Set();
ipcRenderer.on('pet:cursor', (_e, c) => { for (const fn of cursorListeners) { try { fn(c); } catch {} } });
contextBridge.exposeInMainWorld('petCursor', {
  on(fn) { if (typeof fn === 'function') cursorListeners.add(fn); },
  off(fn) { cursorListeners.delete(fn); },
});

let smart = true;
let ignored = null;
let dragging = false;
let alphaBroken = false;

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
document.addEventListener('mousemove', (e) => {
  if (!smart) return;
  const over = overPet(e.clientX, e.clientY);
  sendIgnore(!over);
  const now = Date.now();
  if (over && now - lastInteractSent > 2500) { lastInteractSent = now; ipcRenderer.send('pet:interact'); }
}, true);

window.addEventListener('click', (e) => {
  if (dragging || e.altKey) return;
  if (alphaAt(e.clientX, e.clientY) > 12) ipcRenderer.send('pet:tap');
}, true);

window.addEventListener('mousedown', (e) => {
  if (e.button === 0 && e.altKey) {
    dragging = true;
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
});

ipcRenderer.on('pet:smart', (_e, on) => {
  smart = !!on;
  sendIgnore(true);
  if (!smart) sendIgnore(false);
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
