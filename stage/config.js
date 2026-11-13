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
// 心情是 persona 那边的状态机在维护，舞台只读它的落盘结果
const MOOD_JSON = process.env.WHALE_MOOD_JSON || 'F:\\DaFeiYu\\persona\\mood.json';

const DEFAULTS = {
  interactive: true,     // 分区互动：点她按部位反应
  cursorTrack: true,     // 指针追踪：视线和身体跟着鼠标
  onTop: true,           // 置顶
  fps: 60,               // 舞台帧率上限（0 = 不限）；60 是手感值，别随手改
  sway: 1.6,             // 待机摆动倍数：头发物理全靠它
  // 整身摇摆（渲染层）：整个模型绕脚底转多少度、几秒一个来回。0 = 关。
  // 老外壳那套「整张画面以脚为支点微倾」，这里是转模型本身，坐标系不动，点击不受影响。
  swayTilt: 0.8,
  swayTiltPeriod: 7,
  spinTurns: 4,          // 绕她转几圈算一节（2~20）
  smartIgnore: true,     // 智能穿透：只在角色身上吃鼠标
  bridge: true,          // 点触转给 DSH 侧桥（61944）；关掉只断这一条，本地反应照做
  bridgeUrl: 'http://127.0.0.1:61944/event',
  moodJson: MOOD_JSON,   // 心情来源文件
  tickBubble: true,      // 阶段气泡：DSH 会话跑长任务时从肩线冒小泡
  replyBtn: true,        // 回复钮：说完话冒出来一个小钮，点开能直接打字
  replyAlways: false,    // 常驻：钮一直挂在头顶右侧
  panelAutoClose: false, // 设置面板失焦就收起；默认关——主人要的是「菜单」能自己关，面板要能一直摆着
  sessionWatch: true,    // 会话联动：任何 DSH 会话在跑都能让她冒阶段小泡（要 sessionsDir 存在）
  sessionsDir: 'F:\\DaFeiYu\\sessions',   // DSH 会话事件流目录；没有就自动不启用，不报错
  voiceVolume: 0.6,      // 语音音量 0~1；只影响听感，口型大小照旧
  ttsKeepAlive: true,    // 语音服务保活：定时探活，服务冷着就拉起来并热身，别让第一句等 27 秒
  ttsKeepMinutes: 5,     // 探活间隔（分钟）；探活本身很便宜，热身只在服务刚起来那次做
  ttsHealthUrl: 'http://127.0.0.1:9880/health',                    // 网关自己的 /health
  ttsStartScript: 'F:\\AI\\VoiceService\\gateway\\start.ps1',      // 不在跑就拿它拉起来；路径不存在就只报状态
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

module.exports = { APP_ROOT, DATA_DIR, CFG_FILE, MOOD_JSON, DEFAULTS, load, save };
