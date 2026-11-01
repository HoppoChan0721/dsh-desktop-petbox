'use strict';
// 配置层：所有路径都不写死在代码里，全部来自 data/config.json。
// 这个文件是所有"别人装得上"的前提：壳子只负责窗口、托盘、穿透、面板和玩法，
// 鲸语、模型、TTS 全是外部依赖，缺了就要能跑（或者能明确告诉人缺什么）。
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(APP_ROOT, 'data');
const CFG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  // —— 必需：鲸语仓库（含 server.py / launch.py 的那个目录）——
  jingyuRepo: '',
  // —— 必需：模型目录（含 *.model3.json、moc3、贴图、physics）——
  modelDir: '',
  // —— 可选：Python 解释器；留空自动探测 python / py -3 ——
  pythonPath: '',
  // —— 端口 ——
  stagePort: 61942,
  moodPort: 61943,
  // —— 可选集成：默认全关 ——
  dshWatch: false,          // DSH 会话联动（需要 DSH 的会话目录）
  dshSessionsDir: '',
  moodJson: '',             // 可选：外部心情文件（DSH 的 mood.json），没有就跳过
  voicePrepare: '',         // 外部 TTS 桥脚本，给了才有语音
  voiceWavDir: '',          // TTS 输出目录
  notifyVoice: '',          // 一次性播报脚本（可留空）
  // —— 运行状态（程序自己写回）——
  x: null, y: null, width: 531, height: 950,
  fit: 'portrait',
  smart: true,
  onTop: true,
  cursorTrack: true,
  autoMood: true,
  voiceVolume: 0.5,
  bubblePos: 'bottom',
};

function load() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  return { ...DEFAULTS, ...raw };
}

function save(patch) {
  const next = { ...load(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

// 把配置摊平成运行时用的路径对象，同时收集"缺什么"
function resolve(cfg = load()) {
  const repo = (cfg.jingyuRepo || '').trim();
  const model = ((cfg.modelDir || '').trim()) || (repo ? path.join(repo, 'model', 'DeepSeek') : '');
  const python = (cfg.pythonPath || '').trim() || process.env.WHALE_PET_PYTHON || 'python';
  const sessions = (cfg.dshSessionsDir || '').trim();

  const problems = [];
  if (!repo) problems.push('还没填鲸语目录（含 server.py 的文件夹）');
  else if (!exists(path.join(repo, 'server.py'))) problems.push(`鲸语目录里找不到 server.py：${repo}`);
  if (!model) problems.push('还没填模型目录');
  else if (!exists(model)) problems.push(`模型目录不存在：${model}`);
  else {
    let hasModel3 = false;
    try { hasModel3 = fs.readdirSync(model).some((f) => f.toLowerCase().endsWith('.model3.json')); } catch {}
    if (!hasModel3) problems.push(`模型目录里没有 *.model3.json：${model}`);
  }
  if (cfg.dshWatch && !sessions) problems.push('开了 DSH 联动但没填会话目录');

  return {
    appRoot: APP_ROOT,
    dataDir: DATA_DIR,
    cfgFile: CFG_FILE,
    repo, model, python, sessions,
    stagePort: Number(cfg.stagePort) || 61942,
    moodPort: Number(cfg.moodPort) || 61943,
    voiceReady: !!(cfg.voicePrepare && cfg.voiceWavDir),
    problems,
    ok: problems.length === 0,
  };
}

module.exports = { APP_ROOT, DATA_DIR, CFG_FILE, DEFAULTS, load, save, resolve };
