'use strict';
// 舞台自己的配置层。跟外壳的 data/config.json 分开存：两边可以同时跑，谁也不踩谁。
//
// 原则跟外壳那条一样：**不写死路径**。模型目录、Core、TTS 桥都能用参数或环境变量覆盖，
// 缺了要能跑，或者明确说出缺什么，不能一启动就黑屏。
//
// 只有「设一次就不动」的东西放这里（开关、帧率、摆动、圈数）。窗口位置尺寸另存 userData，
// 那个改得太频繁，混进来每次拖动都要写盘。
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
const CFG_FILE = path.join(DATA_DIR, 'stage-config.json');

const DEFAULTS = {
  interactive: true,     // 分区互动：点她按部位反应
  cursorTrack: true,     // 指针追踪：视线和身体跟着鼠标
  onTop: true,           // 置顶
  fps: 60,               // 舞台帧率上限（0 = 不限）；60 是手感值，别随手改
  sway: 1.6,             // 待机摆动倍数：头发物理全靠它
  spinTurns: 4,          // 绕她转几圈算一节（2~20）
  smartIgnore: true,     // 智能穿透：只在角色身上吃鼠标
  bridge: true,          // 点触转给 DSH 侧桥（61944）；关掉只断这一条，本地反应照做
  bridgeUrl: 'http://127.0.0.1:61944/event',
};

function load() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch (e) { raw = {}; }
  return { ...DEFAULTS, ...raw };
}

function save(patch) {
  const next = { ...load(), ...patch };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2) + '\n');
  } catch (e) {}
  return next;
}

module.exports = { APP_ROOT, DATA_DIR, CFG_FILE, DEFAULTS, load, save };
