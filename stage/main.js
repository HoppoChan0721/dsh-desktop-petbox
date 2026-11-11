// 自建轻量舞台的独立入口。刻意跟 src/main.js 完全分开：
// 现役桌宠照旧跑它自己的入口，这里只负责「我们自己的舞台」能不能站起来。
//
// 跑法：node_modules\electron\dist\electron.exe stage\main.js --model="模型目录" [--core="core 文件"] [--cdp=9340] [--port=61945]
//   --core 不给就依次找：环境变量 WHALE_CUBISM_CORE、鲸语 1.4 部署里的 vendor、模型目录
const { app, BrowserWindow, protocol, net, screen, ipcMain, Menu, Tray, nativeImage, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const drag = require('./drag');
const gaze = require('./gaze');
const Cfg = require('./config');
const KeepAlive = require('./keepalive');
const Text = require('./text');
const Touch = require('./touch');
const Mood = require('./mood');
const Plan = require('./plan');

// 单实例：托盘图标点第二遍、开机自启和手动启动撞在一起时，别再开第二只
let activeWin = null;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (activeWin && !activeWin.isDestroyed()) { activeWin.show(); activeWin.focus(); }
  });
}

const arg = (name, dflt = '') => {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3).replace(/^"|"$/g, '') : dflt;
};

const STAGE_DIR = __dirname;
const MODEL_DIR = path.resolve(arg('model', 'F:\\DaFeiYu\\tools\\jingyu\\model\\DeepSeek'));
const CORE_FILE = (() => {
  const given = arg('core', process.env.WHALE_CUBISM_CORE || '');
  const candidates = [
    given,
    'F:\\DaFeiYu\\tools\\jingyu\\jingyu-live2d-agent-main\\web\\vendor\\live2dcubismcore.min.js',
    path.join(MODEL_DIR, 'live2dcubismcore.min.js'),
  ].filter(Boolean);
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || '';
})();

// 窗口大小和位置记在 userData 里，重启不用重新调。
// 只存一百来个字节，不进仓库（userData 在系统盘，仓库只放代码）。
function boundsPath() { return path.join(app.getPath('userData'), 'stage-window.json'); }
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsPath(), 'utf8'));
    if (b && Number.isFinite(b.width) && Number.isFinite(b.height) && b.width > 100 && b.height > 100) return b;
  } catch (e) {}
  return null;
}

// 设置面板的位置单独记：她身上那个舞台窗有自己的一份，混一起会互相拽
function panelPosPath() { return path.join(app.getPath('userData'), 'panel-window.json'); }
function loadPanelPos() {
  try {
    const b = JSON.parse(fs.readFileSync(panelPosPath(), 'utf8'));
    if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) return { x: b.x, y: b.y };
  } catch (e) {}
  return null;
}
function savePanelPos(p) {
  try {
    fs.mkdirSync(path.dirname(panelPosPath()), { recursive: true });
    fs.writeFileSync(panelPosPath(), JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) }) + '\n');
  } catch (e) {}
}
// 存的位置可能来自另一块已拔掉的屏：至少留 80px 落在某块屏里，否则当没存过。
// 不这么判的话，拔了副屏再开面板 = 面板开在看不见的地方，人还以为它没打开。
function posOnScreen(pos, w, h) {
  if (!pos) return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    const ox = Math.min(a.x + a.width, pos.x + w) - Math.max(a.x, pos.x);
    const oy = Math.min(a.y + a.height, pos.y + h) - Math.max(a.y, pos.y);
    return ox >= 80 && oy >= 80;
  });
}

// 语音是可选集成：给了 TTS 桥脚本才有声音，没给就纯文字气泡，绝不因为缺 TTS 报错。
// 桥的协议（沿用外壳那份）：环境变量 SAY_TEXT 传文本，stdout 打一行 JSON {job_id, duration}，
// wav 落在 VOICE_DIR 里叫做 <job_id>.wav。
const VOICE_PREPARE = arg('voice', process.env.WHALE_VOICE_PREPARE || 'F:\\DaFeiYu\\tools\\pet-voice-prepare.mjs');
const VOICE_DIR = arg('voice-dir', process.env.WHALE_VOICE_DIR || 'F:\\AI\\VoiceService\\gateway\\downloads');

protocol.registerSchemesAsPrivileged([{
  scheme: 'pet',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

// 透明置顶窗在 Windows 上会被 Chromium 判成「被别人挡住」而暂停渲染，拖动时还会在两态之间翻，
// 表现出来就是模型一闪一闪。桌宠永远置顶，这套遮挡计算纯属误判，直接关掉。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// 页面是自己开的窗口，放语音不该要求用户先点一下
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 调试口必须在 app ready 之前挂，晚一步 Chromium 就不认
const cdpPort = arg('cdp', process.env.WHALE_STAGE_CDP || '');
if (/^\d+$/.test(cdpPort)) app.commandLine.appendSwitch('remote-debugging-port', cdpPort);

function fileResponse(baseDir, rel) {
  const root = path.resolve(baseDir);
  const target = path.resolve(root, decodeURIComponent(rel || ''));
  if (target !== root && !target.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
  if (!fs.existsSync(target)) return new Response('not found: ' + rel, { status: 404 });
  return net.fetch(pathToFileURL(target).toString());
}

app.whenReady().then(async () => {
  protocol.handle('pet', (req) => {
    const url = new URL(req.url);
    // 统一放在 pet://stage 一个源下：/model/* → 模型目录，/core/* → Cubism Core，其余 → stage 目录。
    // 分开成 pet://model 之类的独立源会被当成跨域，fetch 直接失败。
    const rel = url.pathname.replace(/^\//, '');
    if (rel.startsWith('model/')) return fileResponse(MODEL_DIR, rel.slice('model/'.length));
    if (rel.startsWith('voice/')) return fileResponse(VOICE_DIR, rel.slice('voice/'.length));
    if (rel.startsWith('core/')) {
      if (!CORE_FILE) return new Response('cubism core missing', { status: 404 });
      return net.fetch(pathToFileURL(CORE_FILE).toString());
    }
    return fileResponse(STAGE_DIR, rel);
  });

  const saved = loadBounds();
  let cfg = Cfg.load();
  const win = new BrowserWindow({
    width: saved ? saved.width : 531,
    height: saved ? saved.height : 950,
    x: saved ? saved.x : undefined,
    y: saved ? saved.y : undefined,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    alwaysOnTop: cfg.onTop !== false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(STAGE_DIR, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  if (cfg.onTop !== false) win.setAlwaysOnTop(true, 'screen-saver');
  activeWin = win;

  // 指针策略全在 gaze.js 里：主进程每 33ms 读一次全局光标，归一化后送进页面。
  // 页面拿到的永远是真实位置，不依赖鼠标事件——桌宠大部分时间是穿透的，页面根本收不到 mousemove。
  // 它同时负责那套手感细节：鼠标停太久就当人走开、离开本屏回正、正中心死区、绕头转圈的三节。
  // 「转圈之后长什么样」在主进程下面 spinReact 里决定，gaze 只给节号。
  const tracker = gaze.createStageGaze({
    getWindow: () => win,
    onCursor: (c) => {
      try { if (win && !win.isDestroyed()) win.webContents.send('stage:cursor', c); } catch (e) {}
    },
    onSpin: (stage) => spinReact(stage),
  });
  win.on('closed', () => tracker.stop());
  // 配置里存着的开关，启动就应用，不用等菜单点一遍
  tracker.setTrack(cfg.cursorTrack !== false);
  tracker.setSpinTurns(cfg.spinTurns);

  // 页面标定完剪影会把头顶位置报上来，绕圈判定就用真实的头当圆心
  ipcMain.on('stage:head', (_e, h) => { tracker.setHead(h); });

  let saveTimer = null;
  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(boundsPath(), JSON.stringify(win.getBounds())); } catch (e) {}
    }, 400);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('close', () => { try { fs.writeFileSync(boundsPath(), JSON.stringify(win.getBounds())); } catch (e) {} });

  // ---- 交互：穿透、拖动、滚轮缩放、点她 --------------------------------------
  // forward: true 是关键——窗口不吃鼠标时仍然把 mousemove 送进页面，否则页面永远不知道该「醒过来」，
  // 一旦穿透就再也点不到她。
  ipcMain.on('stage:ignore', (_e, ignore) => {
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!!ignore, { forward: true });
  });

  let dragState = null;
  let dragTimer = null;
  const scaleAt = (x, y) => {
    try { return screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).scaleFactor || 1; } catch (e) { return 1; }
  };
  const stopDrag = () => {
    if (dragTimer) { clearInterval(dragTimer); dragTimer = null; }
    dragState = null;
  };
  ipcMain.on('stage:drag-start', () => {
    if (!win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    dragState = drag.createDragState(win.getBounds(), c, scaleAt(c.x, c.y));
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      if (!dragState || !win || win.isDestroyed()) { stopDrag(); return; }
      const next = drag.dragFrame(dragState, screen.getCursorScreenPoint(), scaleAt);
      if (next) win.setBounds(next);
    }, 16);
  });
  ipcMain.on('stage:drag-end', stopDrag);
  win.on('closed', stopDrag);

  // Ctrl + 滚轮：以底部中心为锚点缩放，脚不动、只有个头变高
  ipcMain.on('stage:wheel', (_e, dir) => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const k = dir > 0 ? 1.06 : 1 / 1.06;
    const [w, h] = drag.clampSize(b.width * k, b.height * k);
    win.setBounds({ x: Math.round(b.x + (b.width - w) / 2), y: Math.round(b.y + (b.height - h)), width: w, height: h });
  });

  // ---- 点触账本 --------------------------------------------------------------
  // 流水落 data/touch.jsonl，统计落 data/touch-stats.json，跟外壳那套是同一份文件，
  // 所以以前攒的亲密度不会因为换舞台清零。
  // 「摸完长什么样」由 touch.decide 决定：部位表情 + 语气词，另加两种语境
  // （隔很久没摸会一惊一乍、今天被摸太多会黏人）和连击翻脸。
  const book = Touch.createTouchBook({ dir: Cfg.DATA_DIR });
  let bridgeWarned = false;

  // 反向桥：把点触事件 POST 给 DSH 侧的 dsh-pet-bridge（fire-and-forget，失败只记一次）
  function forwardTouch(ev) {
    if (cfg.bridge === false) return;
    const url = String(cfg.bridgeUrl || 'http://127.0.0.1:61944/event').trim();
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
      req.on('error', (e) => { if (!bridgeWarned) { bridgeWarned = true; console.log('bridge post failed: ' + e.message); } });
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} });
      req.end(body);
    } catch (e) {}
  }

  // ---- DSH 侧桥的迷你客户端 ------------------------------------------------
  // 窥屏、主动开口这些开关都住在桥里（61944），舞台只是遥控器。
  // 为什么菜单要能点：这套东西是给人下载的，别人不一定会敲命令行；
  // 桥没在跑的时候不能装作有这个功能，菜单项要灰掉并说清楚原因。
  const bridgeBase = () => {
    try {
      const u = new URL(String(cfg.bridgeUrl || '').trim() || 'http://127.0.0.1:61944/event');
      return u.origin;
    } catch (e) { return 'http://127.0.0.1:61944'; }
  };
  let bridgeState = { at: 0, ok: false, health: null, mood: null, error: '' };

  function bridgeReq(method, path, body, timeoutMs) {
    return new Promise((resolve) => {
      let u;
      try { u = new URL(bridgeBase() + path); } catch (e) { resolve({ ok: false, error: '地址不对' }); return; }
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + (u.search || ''),
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
        timeout: timeoutMs || 2500,
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({ ok: false, error: '返回不是 JSON' }); }
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.code === 'ECONNREFUSED' ? '桥没在跑' : e.message }));
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve({ ok: false, error: '桥超时' }); });
      if (payload) req.write(payload);
      req.end();
    });
  }

  // 缓 8 秒：菜单点一次只查一次，别每次打开都打三个请求
  async function refreshBridge(force) {
    if (!force && Date.now() - bridgeState.at < 8000) return bridgeState;
    const health = await bridgeReq('GET', '/health');
    const ok = !!(health && health.ok !== false && (health.port || health.peek || health.petSessionId));
    const mood = ok ? await bridgeReq('GET', '/mood') : null;
    bridgeState = { at: Date.now(), ok, health, mood, error: ok ? '' : (health && health.error) || '桥没在跑' };
    return bridgeState;
  }

  const taps = [];
  ipcMain.on('stage:tap', (_e, payload) => {
    const r = book.record(payload || {});
    if (!r) return;
    taps.push(r.ev);
    if (taps.length > 60) taps.shift();
    forwardTouch(r.ev);
    const react = r.reaction;
    // 表情由主进程统一决定：部位默认表情 + 语境覆盖（黏人/一惊一乍/翻脸），
    // 页面那边只负责点头摇头，别两边同时改表情互相打。
    if (react.emotion) push({ type: 'emotion', name: react.emotion, ms: react.many ? 2600 : 1800 });
    if (react.text) push({ type: 'say', text: react.text, ms: 2600 });
    console.log(JSON.stringify({ tap: r.ev, react: { emotion: react.emotion, text: react.text, tone: react.tone, many: react.many } }));
  });

  const modelFile = fs.readdirSync(MODEL_DIR).find((f) => f.toLowerCase().endsWith('.model3.json')) || '';
  console.log(JSON.stringify({ modelDir: MODEL_DIR, modelFile: modelFile ? '(found)' : 'MISSING', core: CORE_FILE ? '(found)' : 'MISSING' }));
  // 舞台页的启动参数：帧率上限、待机摆动倍数都从配置来，托盘/面板改完就重载一遍。
  // 优先级：命令行参数 > 配置 > 默认。
  const stageUrl = () => {
    const q = new URLSearchParams({ model: modelFile });
    const fpsArg = arg('fps', '');
    const fps = fpsArg !== '' ? Number(fpsArg) : Number(cfg.fps);
    if (Number.isFinite(fps) && fps >= 0) q.set('fps', String(Math.round(fps)));
    const swayArg = arg('sway', process.env.WHALE_SWAY || '');
    const sway = swayArg !== '' ? Number(swayArg) : Number(cfg.sway);
    if (Number.isFinite(sway) && sway > 0) q.set('sway', String(sway));
    // 音量必须从一开始就在 URL 里：页面拿不到就是 0，等于全静音。
    // 后面虽然 push 补一次，但那次可能赶在页面注册监听之前就丢了。
    const volArg = arg('volume', '');
    const vol = volArg !== '' ? Number(volArg) : Number(cfg.voiceVolume);
    if (Number.isFinite(vol)) q.set('volume', String(Math.min(1, Math.max(0, vol))));
    return 'pet://stage/index.html?' + q.toString();
  };
  const loadStage = () => win.loadURL(stageUrl()).catch(() => {});
  await loadStage();
  // 页面每次载入（含改帧率/摆动后的重载）都要重新把「回复钮开没开」「音量多大」告诉它
  const pushReplyConfig = () => push({ type: 'reply-set', on: cfg.replyBtn !== false, always: !!cfg.replyAlways });
  const pushVolume = () => push({ type: 'volume', value: Number(cfg.voiceVolume) });
  const pushSmart = () => push({ type: 'smart', value: cfg.smartIgnore !== false });
  win.webContents.on('did-finish-load', () => { pushReplyConfig(); pushVolume(); pushSmart(); });

  // ---- 控制口 ---------------------------------------------------------------
  // 一个只监听本机的 HTTP 口，外部（命令行、以后的气泡/情绪端口）通过它跟她说话。
  // 端口刻意避开现役桌宠那套 61942/61943/9333 和 dsh-pet-bridge 的 61944。
  const PORT = Number(arg('port', process.env.WHALE_STAGE_PORT || '61945'));
  const push = (cmd) => {
    try { if (win && !win.isDestroyed()) win.webContents.send('stage:command', cmd); return true; } catch (e) { return false; }
  };
  const json = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  };

  // 绕着她转圈的三节：发晕 → 嫌弃 → 生气（外壳那套玩法，2026-11-01 主人点的）。
  // 这里只决定「长什么样」：表情走模型自带的，动作走 motion，台词只用语气词——
  // 语气词是个开口，什么回复都能往下接；说死了后面那条真回复就接不上。
  // 第三节的手要「抬到胸口一直按着」：举手动作用 hold 停在最后一帧，等黑脸快走完
  // 再用模型自带的「举手切默认手」放下来。lowerLead = 提前多少毫秒开始放，
  // 放下来要 1.017 秒，让它和黑脸同时复原，而不是脸先好了手还举着。
  const SPIN_REACT = {
    1: { emotion: '圈圈眼', ms: 3200, line: '呀…头好晕…' },
    2: { emotion: '屑屑眼', ms: 2600, line: '哼…' },
    3: { emotion: '黑脸', ms: 6500, line: '别转了…', motion: 'HandRaise', hold: true, lower: 'HandLower', lowerLead: 1000 },
  };
  let spinLowerTimer = null;
  function spinReact(stage) {
    const r = SPIN_REACT[stage];
    if (!r) return;
    push({ type: 'emotion', name: r.emotion, ms: r.ms });
    if (r.motion) push({ type: 'motion', name: r.motion, hold: !!r.hold });
    if (r.line) push({ type: 'say', text: r.line, ms: 2600 });
    if (r.lower) {
      // 表情到点会自己 resetExpression；手提前 lowerLead 开始放，两件事同一刻收尾
      clearTimeout(spinLowerTimer);
      const at = Math.max(0, r.ms - (r.lowerLead || 0));
      spinLowerTimer = setTimeout(() => push({ type: 'motion', name: r.lower }), at);
    }
    console.log(JSON.stringify({ spin: stage, emotion: r.emotion, motion: r.motion || null }));
  }

  tracker.start();

  // 调 TTS 桥：合成 + 下载 wav，回 {job_id, duration}。冷启动第一句要 27 秒，别当坏。
  const voiceReady = () => { try { return fs.existsSync(VOICE_PREPARE); } catch (e) { return false; } };
  const prepareVoice = (text) => new Promise((resolve, reject) => {
    if (!voiceReady()) return reject(new Error('没有 TTS 桥脚本：' + VOICE_PREPARE));
    let out = '';
    let child;
    try {
      child = spawn('node', [VOICE_PREPARE], {
        env: { ...process.env, SAY_TEXT: text, WHALE_PET_DATA: path.join(STAGE_DIR, '..', 'data') },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { return reject(e); }
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', reject);
    child.on('close', () => {
      const line = String(out).trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
      if (!line) return reject(new Error('TTS 桥没有输出 JSON'));
      try {
        const job = JSON.parse(line);
        if (job.error) return reject(new Error(String(job.error)));
        resolve(job);
      } catch (e) { reject(e); }
    });
  });

  // ---- 语音保活 ---------------------------------------------------------------
  // 服务闲下来只有两种状态：没起、或者起了但模型没进显存，第一句都得等 27 秒。
  // 定时探活，冷了拉起来顺手热一次；她自己说过话就不用热（模型本来就热）。
  const keepAlive = KeepAlive.createKeepAlive({
    enabled: cfg.ttsKeepAlive !== false,
    intervalMs: Math.max(1, Number(cfg.ttsKeepMinutes) || 5) * 60000,
    healthUrl: arg('tts-health', process.env.WHALE_TTS_HEALTH || String(cfg.ttsHealthUrl || '')),
    startScript: arg('tts-start', process.env.WHALE_TTS_START || String(cfg.ttsStartScript || '')),
    prepareVoice,
    // 热身那句 wav 是垃圾，合成完立刻删，别让 downloads 里堆满「嗯」
    dropWav: (id) => { try { fs.unlinkSync(path.join(VOICE_DIR, id + '.wav')); } catch (e) {} },
    log: (m) => console.log('[keepalive] ' + m),
  });
  // 启动两秒半后先探一次，之后按配置的间隔
  keepAlive.start({ intervalMs: Math.max(1, Number(cfg.ttsKeepMinutes) || 5) * 60000 });

  // ---- 第 6 步：阶段气泡 / 回复她 / plan 执行 ---------------------------------
  // 这三样是 DSH 侧桥（dsh-pet-bridge）在用的口子，原来在外壳里，现在搬到舞台，协议不变。
  let lastTick = null;
  let lastReply = null;

  function petTick(text, ms) {
    const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!t) return null;
    const dur = Math.max(2000, Math.min(4000, Number(ms) || 3000));
    lastTick = { text: t, ms: dur, at: new Date().toISOString() };
    if (cfg.tickBubble === false) return { ...lastTick, off: true };
    push({ type: 'tick', text: t, ms: dur });
    return lastTick;
  }

  // 回复往桥上砸，跟点触走同一个地址（bridgeUrl 换个 path 到 /say）
  const REPLY_URL_FALLBACK = 'http://127.0.0.1:61944/say';
  function replyUrl() {
    try {
      const u = new URL(String(cfg.bridgeUrl || '').trim() || REPLY_URL_FALLBACK);
      u.pathname = '/say';
      u.search = '';
      u.hash = '';
      return u;
    } catch (e) { return new URL(REPLY_URL_FALLBACK); }
  }

  function sendReply(text) {
    return new Promise((resolve) => {
      const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!t) { resolve({ ok: false, error: '空的' }); return; }
      let u;
      try { u = replyUrl(); } catch (e) { resolve({ ok: false, error: 'bridgeUrl 配得不对：' + e.message }); return; }
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
          lastReply = { text: t, at: new Date().toISOString(), status: res.statusCode };
          if (res.statusCode >= 200 && res.statusCode < 300) {
            push({ type: 'tick', text: '已送到她那儿', ms: 2400 });
            resolve({ sent: true, text: t, status: res.statusCode });
          } else {
            push({ type: 'tick', text: '没送出去', ms: 2400 });
            resolve({ sent: false, text: t, status: res.statusCode, body: raw.slice(0, 200) });
          }
        });
      });
      req.on('error', (e) => {
        lastReply = { text: t, at: new Date().toISOString(), error: e.message };
        push({ type: 'tick', text: '桥没开', ms: 2400 });
        resolve({ sent: false, error: e.message });
      });
      req.on('timeout', () => { try { req.destroy(); } catch (e) {} });
      req.end(body);
    });
  }

  // 桥在「只有动作没台词」时砸过来的 plan。能认的只有 expression / motion / gesture，
  // pose 和 trajectory 是外壳那套参数级编排，这里用不到，跳过并如实回报。
  function runPlan(plan) {
    const r = Plan.toCommands(plan);
    if (!r.commands.length && !r.skipped.length) throw new Error('plan 里没有可执行动作');
    for (const cmd of r.commands) push(cmd);
    return { applied: r.applied, skipped: r.skipped, title: r.title };
  }

  // ---- 会话联动：所有 DSH 会话的进度都往她身上冒小泡 -------------------------
  // 以前是外壳在跑 integ\dsh-watch.mjs：它读 DSH 的会话事件流，把「在生成 / 跑工具 / 读文件 /
  // 子代理在跑 / 报错 / 答完了」翻成人话，再从上半身冒一颗 2~4 秒的小泡。搬到舞台时这条没接，
  // 于是只剩 DSH 桥自己那条（只盯桌宠会话）。
  // 现在接回来了：谁的会话在动都能冒泡，不只桌宠自己那个。
  const WATCHER = path.join(STAGE_DIR, '..', 'integ', 'dsh-watch.mjs');
  const SESSIONS_DIR = arg('sessions', process.env.WHALE_SESSIONS_DIR || String(cfg.sessionsDir || 'F:\\DaFeiYu\\sessions'));
  let watcherChild = null;
  let watcherNote = '';

  function watcherState() {
    return {
      enabled: cfg.sessionWatch !== false,
      running: !!(watcherChild && !watcherChild.killed),
      pid: watcherChild ? watcherChild.pid : null,
      sessionsDir: SESSIONS_DIR,
      note: watcherNote || (cfg.sessionWatch === false ? '关着' : null),
    };
  }

  function startWatcher() {
    if (watcherChild) return watcherState();
    if (cfg.sessionWatch === false) { watcherNote = '关着'; return watcherState(); }
    try { if (!fs.existsSync(WATCHER)) { watcherNote = '缺 integ/dsh-watch.mjs'; return watcherState(); } } catch (e) { watcherNote = '看不到 watcher 文件'; return watcherState(); }
    try { if (!SESSIONS_DIR || !fs.existsSync(SESSIONS_DIR)) { watcherNote = '会话目录找不到：' + SESSIONS_DIR; return watcherState(); } } catch (e) { watcherNote = '会话目录读不了'; return watcherState(); }
    const ports = listenPorts();
    try {
      const child = spawn('node', [WATCHER], {
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          DSH_SESSIONS_DIR: SESSIONS_DIR,
          WHALE_PET_DATA: Cfg.DATA_DIR,
          // 表情走 /api/execute，气泡走 /tick；这两条老地址就是别名口留着的理由
          WHALE_PET_STAGE: 'http://127.0.0.1:' + (ports[1] || ports[0]),
          WHALE_PET_SHELL: 'http://127.0.0.1:' + (ports[2] || ports[0]),
          WHALE_PET_MOOD: String(cfg.moodJson || Cfg.MOOD_JSON),
        },
      });
      watcherChild = child;
      watcherNote = '';
      child.on('exit', () => { watcherChild = null; });
      child.on('error', (e) => { watcherNote = '起不来：' + ((e && e.message) || e); watcherChild = null; });
    } catch (e) {
      watcherNote = '起不来：' + ((e && e.message) || e);
    }
    return watcherState();
  }

  function stopWatcher() {
    if (!watcherChild) return watcherState();
    try { spawn('taskkill', ['/PID', String(watcherChild.pid), '/T', '/F'], { windowsHide: true }); } catch (e) {}
    watcherChild = null;
    watcherNote = '已停';
    return watcherState();
  }

  const routes = {
    '/state': async () => {
      const s = await win.webContents.executeJavaScript('window.__petEngine ? window.__petEngine.state() : null');
      const info = await win.webContents.executeJavaScript('window.__stageInfo || null');
      const stats = await win.webContents.executeJavaScript('window.__stageStats ? window.__stageStats() : null');
      return { ...s, model: MODEL_DIR, motions: info && info.motions, expressions: info && info.expressions, stats, gaze: tracker.state() };
    },
    // 指针策略：看状态、开关追踪、手动挂起。
    // /gaze?circle=2 是演示/自检钩子——走真实的绕圈判定和三节反应，只是不真的挪鼠标。
    '/gaze': (q) => {
      if (q.get('track') !== null) tracker.setTrack(q.get('track') !== '0');
      if (q.get('suspend') !== null) tracker.suspend(Number(q.get('suspend')) || 0);
      if (q.get('circle') !== null) {
        const r = tracker.simulateCircle(Number(q.get('circle')) || 1, { r: Number(q.get('r')) || undefined });
        return { ...tracker.state(), simulated: r };
      }
      return tracker.state();
    },
    '/say': (q) => {
      // 台词先过一道「剥舞台说明」：桥认不出的 [眼神闪烁] 这种原来会挂在气泡里还被念出来。
      // 这一层是兜底——旧桥、命令行、别的调用方都可能直接塞带括号的文本过来。
      const raw = q.get('text') || '';
      if (!raw) throw new Error('缺 text');
      const text = Text.stripDirections(raw);
      if (!text) return { pushed: false, skipped: '只有舞台说明，没有台词', raw };
      const emo = q.get('emotion');
      const mo = q.get('motion');
      const wantVoice = q.get('voice') === '1' || q.get('voice') === 'true';
      if (emo) push({ type: 'emotion', name: emo, ms: Number(q.get('emotionMs')) || 0 });
      if (mo) push({ type: 'motion', name: mo });
      if (!wantVoice) {
        const ms = Number(q.get('ms')) || 0;
        push({ type: 'say', text, ms });
        return { pushed: true, text, ms: ms || null, voice: false, emotion: emo || null, motion: mo || null };
      }
      // 语音要等合成：先冒等待泡，好了气泡和声音一起出场，字按音频时长摊平
      push({ type: 'wait' });
      prepareVoice(text).then((job) => {
        keepAlive.noteSay();   // 刚合过成就说明模型是热的，别再白热一次
        const ms = Math.round((Number(job.duration) || 0) * 1000);
        push({ type: 'say', text, ms: ms + 700, reveal: Math.round(ms * 0.92), voice: true });
        push({ type: 'voice', url: 'pet://stage/voice/' + encodeURIComponent(job.job_id) + '.wav' });
      }).catch((e) => {
        push({ type: 'say', text, ms: 0, voice: true });
        push({ type: 'error', text: 'TTS：' + ((e && e.message) || e) });
      });
      return { pushed: true, text, voice: true, queued: true, emotion: emo || null, motion: mo || null };
    },
    '/voice': (q) => {
      const job = q.get('job') || '';
      if (!job) throw new Error('缺 job（wav 的 job_id）');
      push({ type: 'voice', url: 'pet://stage/voice/' + encodeURIComponent(job) + '.wav' });
      return { pushed: true, job, ready: voiceReady() };
    },
    '/voice-stop': () => {
      push({ type: 'voice-stop' });
      return { pushed: true };
    },
    '/wait': (q) => {
      push({ type: 'wait', ms: Number(q.get('ms')) || 0 });
      return { pushed: true };
    },
    '/bubble': (q) => {
      push({ type: q.get('hide') !== null ? 'bubble-hide' : 'wait' });
      return { pushed: true };
    },
    '/motion': (q) => {
      const name = q.get('name') || '';
      if (!name) throw new Error('缺 name');
      const hold = q.get('hold') === '1' || q.get('hold') === 'true';
      push({ type: 'motion', name, hold });
      return { pushed: true, name, hold };
    },
    '/motion-stop': () => {
      push({ type: 'stop' });
      return { pushed: true };
    },
    '/emotion': (q) => {
      const name = q.get('name') || '';
      if (!name) throw new Error('缺 name');
      push({ type: 'emotion', name });
      return { pushed: true, name };
    },
    // 心情端口的作用：把 `persona\mood.ps1` 那台状态机的七种心情翻成舞台反应。
    // 两种用法：
    //   /mood?emotion=害羞&intensity=0.8   直接给
    //   /mood                               读 mood.json（mood.ps1 的落盘文件）自动跟
    '/mood': (q) => {
      let name = q.get('emotion') || q.get('mood') || '';
      let k = q.get('intensity');
      let source = 'query';
      if (!name) {
        try {
          const file = String(cfg.moodJson || Cfg.MOOD_JSON);
          const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
          name = String(j.mood || '');
          if (k === null) k = j.intensity;
          source = file;
        } catch (e) {
          throw new Error('没有 emotion 参数，也读不到 mood.json：' + ((e && e.message) || e));
        }
      }
      // 会话联动的 watcher 会往这里砸英文情绪（happy / shy …），舞台只认七种中文心情。
      // 认不出来就安静跳过，别抛错——一抛错它每 700ms 撞一次，日志会被刷满。
      if (!Mood.names().includes(name)) return { pushed: false, skipped: '舞台不认这个心情：' + name, source };
      const p = Mood.plan(name, k === null ? undefined : Number(k));
      push({ type: 'mood', plan: p });
      if (p.expression) push({ type: 'emotion', name: p.expression, ms: p.expressionMs });
      return { pushed: true, source, plan: p };
    },
    // 心情表自检：有哪些、各自会变成什么样
    '/moods': () => ({ moods: Mood.names().map((n) => Mood.plan(n, Mood.DEFAULT_INTENSITY)) }),
    '/keepalive': async (q) => {
      if (q.get('on') !== null) applyConfig({ ttsKeepAlive: q.get('on') !== '0' && q.get('on') !== 'false' });
      if (q.get('minutes') !== null) applyConfig({ ttsKeepMinutes: Math.max(1, Math.min(240, Number(q.get('minutes')) || 5)) });
      if (q.get('now') !== null) return await keepAlive.tick();
      if (q.get('warm') !== null) return await keepAlive.warm();
      return keepAlive.status();
    },
    // 会话联动：所有 DSH 会话在干什么 → 阶段气泡。
    // 不带参数 = 看状态；?on=1|0 开关（落盘）；?restart=1 重启一次
    '/watch': (q) => {
      if (q.get('on') !== null) applyConfig({ sessionWatch: q.get('on') !== '0' && q.get('on') !== 'false' });
      if (q.get('restart') !== null) { stopWatcher(); return startWatcher(); }
      return watcherState();
    },
    // 语音音量：0~1，改了立刻生效（走 GainNode，不重载页面）
    '/volume': (q) => {
      // 三种写法都收：?value=0.6、?v=0.6、POST {"volume":0.6}
      const raw = q.get('value') !== null ? q.get('value')
        : q.get('v') !== null ? q.get('v')
          : q.get('volume') !== null ? q.get('volume') : null;
      if (raw === null) return { volume: Number(cfg.voiceVolume) };
      const v = Math.min(1, Math.max(0, Number(raw)));
      if (!Number.isFinite(v)) throw new Error('value 要是 0~1 的数');
      applyConfig({ voiceVolume: v });
      return { volume: Number(cfg.voiceVolume) };
    },
    '/pointer': (q) => {
      if (q.get('reset') !== null) {
        push({ type: 'pointer', value: null, lock: false });
        return { pushed: true, lock: false };
      }
      const x = Number(q.get('x') || 0);
      const y = Number(q.get('y') || 0);
      const lock = q.get('hold') === '1';
      push({ type: 'pointer', value: { x, y }, lock });
      return { pushed: true, x, y, lock };
    },
    '/taps': (q) => {
      const n = Math.max(1, Math.min(60, Number(q.get('n')) || 20));
      return { taps: taps.slice(-n) };
    },
    // 记账自检：最近 n 条流水 + 亲密度统计
    '/touches': (q) => {
      const n = Math.max(1, Math.min(200, Number(q.get('n')) || 20));
      let lines = [];
      try {
        lines = fs.readFileSync(book.ledgerFile, 'utf8').split('\n').filter((l) => l.trim());
      } catch (e) {}
      const tail = lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch (e) { return { raw: l }; } });
      return { count: lines.length, ledger: book.ledgerFile, touches: tail };
    },
    '/affinity': () => ({ affinity: book.info() }),
    '/zones': async () => {
      const z = await win.webContents.executeJavaScript('window.__stageZones ? window.__stageZones() : null');
      return { zones: z };
    },
    // 读几个参数当前值：排查「某条驱动到底有没有生效」用（比如摆动的身体角）
    '/params': async (q) => {
      const ids = (q.get('ids') || 'AngleX,ParamBodyAngleX,ParamBodyAngleZ,ParamAngleX').split(',').map((s) => s.trim()).filter(Boolean);
      const v = await win.webContents.executeJavaScript('window.__stageInspect ? window.__stageInspect(' + JSON.stringify(ids) + ') : null');
      return { params: v };
    },
    '/window': (q) => {
      const b = win.getBounds();
      const [w, h] = drag.clampSize(Number(q.get('w')) || b.width, Number(q.get('h')) || b.height);
      const x = q.get('x') !== null ? Number(q.get('x')) : b.x;
      const y = q.get('y') !== null ? Number(q.get('y')) : b.y;
      win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
      push({ type: 'zones-reset' });
      return { bounds: win.getBounds() };
    },
    // 托盘/面板改开关以后，命令行也读得到当前配置
    // 面板：不带参数就开/抬到前面；?reset=1 回正中；?where=1 报当前窗口坐标（调试用）；
    // ?at=120,300 摆过去（脚本/自检用，跟手拖一样会落盘）
    '/panel': (q) => {
      if (q.get('toggle') !== null) return { visible: togglePanel() };
      if (q.get('close') !== null) {
        if (panel && !panel.isDestroyed()) panel.close();
        return { closed: true };
      }
      openPanel();
      if (q.get('reset') !== null) return { centered: centerPanel() };
      if (q.get('at') !== null) {
        const [x, y] = String(q.get('at')).split(',').map((n) => Number(n));
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('at 要写成 x,y');
        if (panel && !panel.isDestroyed()) { panel.setPosition(Math.round(x), Math.round(y)); savePanelPos({ x, y }); }
      }
      if (q.get('where') !== null) {
        const b = panel && !panel.isDestroyed() ? panel.getBounds() : null;
        return {
          opened: true,
          bounds: b,
          saved: loadPanelPos(),
          displays: screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scale: d.scaleFactor })),
        };
      }
      return { opened: true };
    },
    // 菜单结构自检：不做任何事，只把当前菜单拍平成文字，方便远程确认项和勾选状态
    '/menu': async (q) => {
      // ?open=1 按托盘右键那条路真弹一次（自检用：确认 popUpContextMenu 这条路不炸）
      if (q.get('open') !== null) {
        await trayMenu();
        return { opened: true, tray: !!tray };
      }
      // 先问一次桥，否则桥那几项的勾选状态会是空的（菜单自己弹之前也会问）
      try { await refreshBridge(); } catch (e) {}
      const flat = [];
      const walk = (items, depth) => {
        for (const it of items) {
          if (it.type === 'separator') continue;
          flat.push('  '.repeat(depth) + (it.checked === true ? '[x] ' : it.checked === false ? '[ ] ' : '') + (it.label || ''));
          if (it.submenu) walk(it.submenu, depth + 1);
        }
      };
      walk(menuTemplate(), 0);
      return { menu: flat, tray: !!tray, panel: !!(panel && !panel.isDestroyed()) };
    },
    '/config': (q) => {
      if (q.get('json') !== null) {
        const patch = JSON.parse(q.get('json'));
        return applyConfig(patch);
      }
      return { cfg: Cfg.load() };
    },
    // ---- 第 6 步：给 DSH 侧用的那几条 ------------------------------------------
    // 桥（dsh-pet-bridge，61944）现在的配置是 petSayUrl=61943/say、petStageUrl=61942，
    // 所以控制口额外监听这两个端口，桥不用改一行配置就能连上新舞台。
    '/status': () => ({
      port: PORT,
      ports: listenPorts(),
      interactive: cfg.interactive !== false,
      bridge: cfg.bridge !== false,
      tick: cfg.tickBubble !== false,
      reply: { btn: cfg.replyBtn !== false, always: !!cfg.replyAlways, url: String(replyUrl()) },
      voice: voiceReady(),
      volume: Number(cfg.voiceVolume),
      keepalive: keepAlive.status(),
      panel: panelInfo(),
      watch: watcherState(),
      affinity: book.info(),
      lastTick,
      lastReply,
    }),
    // 阶段气泡：POST /tick {"text":"看 main.js","ms":3000}
    // {"on":false} 当开关用（面板之外留个远程口）
    '/tick': (q) => {
      const body = q.body || {};
      if (typeof body.on === 'boolean') return { on: applyConfig({ tickBubble: body.on }).cfg.tickBubble !== false };
      const r = petTick(q.get('text') || '', q.get('ms'));
      if (!r) throw new Error('缺 text');
      return r;
    },
    // 回复她：POST /reply {"text":"主人写的话"}；{"open":true} 只把输入卡打开（调试用）
    '/reply': async (q) => {
      const body = q.body || {};
      if (q.get('open') !== null) {
        const open = q.get('open') !== '0' && q.get('open') !== 'false';
        if (open && win && !win.isDestroyed()) { win.show(); win.focus(); }
        push({ type: 'reply-open', open });
        return { open };
      }
      if (q.get('text') !== null) return sendReply(q.get('text'));
      return { btn: cfg.replyBtn !== false, always: !!cfg.replyAlways, url: String(replyUrl()) };
    },
    // 打断当前动作：会话联动的 watcher 在状态真变了的时候会先打一枪再重投
    '/api/stop': () => {
      push({ type: 'stop' });
      return { stopped: true };
    },
  // 桥在「只有动作没台词」时往这里砸 plan：POST /api/execute {"plan":{...}}
    '/api/execute': (q) => {
      let plan = q.body && q.body.plan;
      if (!plan && q.get('plan')) plan = JSON.parse(q.get('plan'));
      if (!plan) throw new Error('缺 plan');
      return runPlan(plan);
    },
    // 复原服装：换装是状态不是动作，穿上就下不来，得有个按钮让她换回来
    '/outfit/reset': () => {
      push({ type: 'outfit-reset' });
      return { pushed: true };
    },
    // 智能穿透开关（关掉 = 整块窗口都吃鼠标，连透明处也吃）
    '/smart': (q) => {
      if (q.get('on') !== null) applyConfig({ smartIgnore: q.get('on') !== '0' && q.get('on') !== 'false' });
      return { smartIgnore: cfg.smartIgnore !== false };
    },
    // 桥的状态快照：菜单、面板、命令行都读这一份，别各自打请求
    '/bridge': async () => {
      const st = await refreshBridge(true);
      return {
        ok: st.ok,
        error: st.error || '',
        base: bridgeBase(),
        peek: st.health ? st.health.peek : null,
        urge: st.mood ? st.mood.urge : null,
        moodSummary: st.mood && st.mood.summary ? st.mood.summary : null,
      };
    },
    // 窥屏开关 / 档位 / 立刻瞄一眼：转发给桥，舞台不自己存
    '/peek': async (q) => {
      const body = {};
      if (q.get('on') !== null) body.on = q.get('on') !== '0' && q.get('on') !== 'false';
      if (q.get('persona') !== null) body.persona = q.get('persona');
      if (q.get('now') !== null) body.now = q.get('now') !== '0';
      if (!Object.keys(body).length) {
        const st = await refreshBridge(true);
        return { ok: st.ok, peek: st.health ? st.health.peek : null, error: st.error || '' };
      }
      const r = await bridgeReq('POST', '/peek', body, 60000);
      bridgeState.at = 0;
      return { bridge: r };
    },
    // 主动开口的浓度档：quiet / normal / clingy / chatty / unbound
    '/urge': async (q) => {
      if (q.get('intensity') !== null || (q.body && q.body.intensity)) {
        const r = await bridgeReq('POST', '/mood', { intensity: q.get('intensity') || (q.body && q.body.intensity) });
        bridgeState.at = 0;
        return { bridge: r };
      }
      if (q.get('now') !== null) {
        const r = await bridgeReq('POST', '/mood', { urge: true }, 60000);
        bridgeState.at = 0;
        return { bridge: r };
      }
      const st = await refreshBridge(true);
      return { ok: st.ok, urge: st.mood ? st.mood.urge : null, error: st.error || '' };
    },
  };

  // ---- 尺寸 / 托盘 / 右键菜单 / 设置面板 ------------------------------------
  // 面板和菜单都只是「遥控器」：真正做事的是 applySize、applyConfig 这两个函数，
  // 控制口的路由也用它们，所以三条入口改出来的结果一定一致。
  const SIZE_MIN_H = 420;
  const SIZE_MAX_H = 1400;
  let panel = null;
  let tray = null;

  function applySize(w, h) {
    if (!win || win.isDestroyed()) return null;
    const [ox, oy] = win.getPosition();
    const [ow, oh] = win.getSize();
    const d = screen.getDisplayNearestPoint({ x: ox + Math.round(ow / 2), y: oy + Math.round(oh / 2) }).workArea;
    // 上限跟着这块屏的工作区走：150% 缩放的 1080p 上工作区只有 ~900 DIP 高，撑出去系统会自己改尺寸，然后拖动就闪
    const W = Math.max(240, Math.min(1600, Math.min(Math.round(Number(w) || 380), Math.round(d.width * 0.96))));
    const H = Math.max(360, Math.min(2000, Math.min(Math.round(Number(h) || 680), Math.round(d.height * 0.96))));
    win.setBounds({ x: Math.round(ox + ow / 2 - W / 2), y: Math.round(oy + oh - H), width: W, height: H });
    saveBounds();
    // 尺寸一变剪影就得重标定，否则点哪儿都按旧比例漂
    push({ type: 'zones-reset' });
    return { width: W, height: H };
  }

  function sizeInfo() {
    const [w, h] = win.getSize();
    const b = win.getBounds();
    const d = screen.getDisplayNearestPoint({ x: b.x + Math.round(w / 2), y: b.y + Math.round(h / 2) }).workArea;
    return { w, h, min: SIZE_MIN_H, max: Math.min(SIZE_MAX_H, Math.round(d.height * 0.96)), aspect: w / Math.max(1, h) };
  }

  // 配置改了就地生效；帧率/摆动要重载舞台页才吃到
  function applyConfig(patch) {
    const p = patch || {};
    const before = Cfg.load();
    cfg = Cfg.save(p);
    if ('interactive' in p) push({ type: 'interactive', value: cfg.interactive !== false });
    if ('cursorTrack' in p) tracker.setTrack(cfg.cursorTrack !== false);
    if ('onTop' in p && win && !win.isDestroyed()) win.setAlwaysOnTop(cfg.onTop !== false, 'screen-saver');
    if ('spinTurns' in p) tracker.setSpinTurns(cfg.spinTurns);
    if ('replyBtn' in p || 'replyAlways' in p) pushReplyConfig();
    if ('voiceVolume' in p) pushVolume();
    if ('ttsKeepAlive' in p) keepAlive.setEnabled(p.ttsKeepAlive !== false);
    if ('ttsKeepMinutes' in p) keepAlive.setIntervalMs(Math.max(1, Number(p.ttsKeepMinutes) || 5) * 60000);
    if ('sessionWatch' in p) {
      if (cfg.sessionWatch === false) stopWatcher(); else startWatcher();
    }
    if ('smartIgnore' in p) pushSmart();
    let reloaded = false;
    if (('fps' in p || 'sway' in p) && (Number(before.fps) !== Number(cfg.fps) || Number(before.sway) !== Number(cfg.sway))) {
      loadStage();
      reloaded = true;
    }
    return { cfg, reloaded };
  }

  const PANEL_W = 400;
  const PANEL_H = 824;

  // 面板回到屏幕正中（拖丢了、换屏了、或者就是看它碍事）
  function centerPanel() {
    if (!panel || panel.isDestroyed()) return null;
    const [w, h] = panel.getSize();
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const x = d.x + Math.round((d.width - w) / 2);
    const y = d.y + Math.round((d.height - h) / 2);
    panel.setPosition(x, y);
    savePanelPos({ x, y });
    return panel.getBounds();
  }

  // 托盘点开面板之后，点面板外面就收起——弹出式面板的常规手势。
  // 记一下「刚刚是被点外面关掉的」，不然托盘左键那一下：blur 先关、click 后到，
  // 就会当成「没开过」又开一个新的，看着像点了关不掉。
  let panelBlurClosedAt = 0;

  function panelInfo() {
    const open = !!(panel && !panel.isDestroyed());
    return { open, visible: open ? panel.isVisible() : false, focused: open ? panel.isFocused() : false, autoClose: cfg.panelAutoClose === true };
  }

  // 托盘左键 = 开关设置面板（她藏起来的时候先把她叫回来）。
  // 以前左键也弹菜单：菜单没点选就一直在那儿，面板还会一直挂着，主人被这个坑过。
  function togglePanel() {
    if (panel && !panel.isDestroyed()) {
      if (panel.isVisible()) { panel.close(); return false; }
      panel.show(); panel.focus(); return true;
    }
    // 上一拍是被「点外面」关的 → 这一下就是在收它，别再开回来
    if (Date.now() - panelBlurClosedAt < 600) return false;
    openPanel();
    return true;
  }

  function trayLeftClick() {
    if (win && !win.isDestroyed() && !win.isVisible()) { win.show(); return; }
    togglePanel();
  }

  function openPanel() {
    if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return panel; }
    // 头一次开（或上次那块屏已经不在了）就居中——居中在哪块屏？跟着鼠标那块，
    // 主副屏都接的人不会希望面板跑到另一头去。
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const PW = PANEL_W;
    const PH = PANEL_H;
    const saved = loadPanelPos();
    const useSaved = posOnScreen(saved, PW, PH);
    panel = new BrowserWindow({
      width: PW,
      height: PH,
      // 上次拖到哪儿就开在哪儿；第一次开（或那块屏没了）才居中
      x: useSaved ? saved.x : area.x + Math.round((area.width - PW) / 2),
      y: useSaved ? saved.y : area.y + Math.round((area.height - PH) / 2),
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: path.join(STAGE_DIR, 'panel-preload.js'), contextIsolation: true, sandbox: false },
    });
    panel.setAlwaysOnTop(true, 'screen-saver');
    // 兜底居中的时候顺手把位置落盘：不然文件里一直留着那个够不着的坐标
    if (!useSaved) { const b = panel.getBounds(); savePanelPos({ x: b.x, y: b.y }); }
    panel.loadFile(path.join(STAGE_DIR, 'panel.html')).catch(() => {});
    panel.once('ready-to-show', () => { if (panel && !panel.isDestroyed()) panel.show(); });
    // 拖动会连发一串 moved，攒 400ms 再落盘，别每帧写一次盘。
    // 定时器里要用「这个窗口」而不是全局 panel：旧窗口的定时器要是晚到一步，
    // 全局 panel 已经指向新窗口了，就会把新窗口的坐标当成旧窗口的存下去。
    const self = panel;
    let saveTimer = 0;
    self.on('moved', () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveTimer = 0;
        if (self && !self.isDestroyed()) { const b = self.getBounds(); savePanelPos({ x: b.x, y: b.y }); }
      }, 400);
    });
    self.on('closed', () => { if (saveTimer) clearTimeout(saveTimer); if (panel === self || !panel || panel.isDestroyed()) panel = null; });
    // 点面板外面（失焦）就收起来。开关在面板里，默认开：
    // 这套东西别人也下载，有人喜欢让它开着不动，那就得能关。
    self.on('blur', () => {
      if (cfg.panelAutoClose !== true) return;
      if (!self || self.isDestroyed()) return;
      panelBlurClosedAt = Date.now();
      self.close();
    });
    return self;
  }

  // 帧率/摆动/圈数/尺寸/开关全都在设置面板里，菜单里不再给一份
  const VOL_CHOICES = [0.2, 0.4, 0.6, 0.8, 1];

  const URGE_LABEL = { quiet: '安静', normal: '正常', clingy: '黏人', chatty: '话痨', unbound: '不拦着' };
  function urgeLabel(urge) {
    if (!urge) return '未知';
    if (urge.enabled === false) return '关着';
    return URGE_LABEL[urge.intensity] || urge.intensity || '正常';
  }

  function menuTemplate() {
    const now = Cfg.load();
    const vol = Number.isFinite(Number(now.voiceVolume)) ? Number(now.voiceVolume) : 0.6;
    const ka = keepAlive.status();
    const KA_TEXT = { idle: '还没探过', off: '没开', down: '服务没起来', starting: '正在拉起', warming: '正在热身', warm: '热着', up: '起来了但没热身' };
    const kaText = KA_TEXT[ka.state] || ka.state;
    // 桥没在跑的时候，窥屏/主动开口这些项灰掉并写清原因——
    // 这套东西是给别人下载的，不能让人点了没反应还不知道为什么。
    const bs = bridgeState;
    const live = !!bs.ok;
    const peek = bs.health && bs.health.peek;
    const urgeCfg = bs.mood && bs.mood.urge;
    const personas = (peek && Array.isArray(peek.personas) ? peek.personas : []).map((p) => ({
      key: p.key, label: p.label, note: p.note,
    }));
    const urgeLevels = [
      ['quiet', '安静（一天四五句）'],
      ['normal', '正常'],
      ['clingy', '黏人'],
      ['chatty', '话痨'],
      ['unbound', '不拦着（不限句数）'],
    ];
    // 这里只留「面板里没有的」桥侧动作：阶段气泡/回复钮那几个开关在设置面板里，
    // 菜单再放一份就是两处维护两份状态，早晚对不上。
    const talkItems = [
      { label: '窥屏（隔一阵自己瞄屏幕再搭话）' + (live ? '' : ' · 桥没在跑'), enabled: live, submenu: live ? [
        { label: peek && peek.on ? '关掉窥屏' : '打开窥屏', click: () => bridgeReq('POST', '/peek', { on: !(peek && peek.on) }).then(() => { bridgeState.at = 0; }) },
        { type: 'separator' },
        ...personas.map((p) => ({
          label: `${p.label}（${p.note}）`, type: 'radio', checked: peek && peek.persona === p.key,
          click: () => bridgeReq('POST', '/peek', { persona: p.key }).then(() => { bridgeState.at = 0; }),
        })),
        { type: 'separator' },
        { label: '现在瞄一眼', click: () => bridgeReq('POST', '/peek', { now: true }, 60000).then(() => { bridgeState.at = 0; }) },
      ] : [{ label: '桥没在跑，这个功能得装 dsh-pet-bridge', enabled: false }] },
      { label: `主动开口 · ${urgeLabel(urgeCfg)}` + (live ? '' : ' · 桥没在跑'), enabled: live, submenu: live ? [
        ...urgeLevels.map(([k, label]) => ({
          label, type: 'radio', checked: !!(urgeCfg && urgeCfg.intensity === k),
          click: () => bridgeReq('POST', '/mood', { intensity: k }).then(() => { bridgeState.at = 0; }),
        })),
        { type: 'separator' },
        { label: '现在让她说一句', enabled: !!(urgeCfg && urgeCfg.enabled), click: () => bridgeReq('POST', '/mood', { urge: true }, 60000).then(() => { bridgeState.at = 0; }) },
      ] : [{ label: '桥没在跑，这个功能得装 dsh-pet-bridge', enabled: false }] },
    ];

    // 菜单只放「做得出一件事」的东西：开关和数值一律在设置面板里，别两处维护两份状态。
    // 留在菜单里的三类：面板没有的（桥侧窥屏/主动开口、复原服装、重载）、
    // 手边要快调的（音量）、以及一次性的动作（隐藏、退出）。
    return [
      { label: panel && !panel.isDestroyed() && panel.isVisible() ? '收起设置面板' : '打开设置面板…', click: () => togglePanel() },
      { label: '左键图标 = 开关面板 · 右键 = 这个菜单', enabled: false },
      { type: 'separator' },
      { label: '语音', submenu: [
        { label: `音量 · ${Math.round(vol * 100)}%`, submenu: [
          ...VOL_CHOICES.map((v) => ({
            label: Math.round(v * 100) + '%', type: 'radio', checked: Math.abs(vol - v) < 0.01, click: () => applyConfig({ voiceVolume: v }),
          })),
          { type: 'separator' },
          { label: '滑杆微调…（设置面板）', click: () => openPanel() },
        ] },
        { type: 'separator' },
        { label: `保活 · ${kaText}（点一下重新探）`, click: () => keepAlive.tick().catch(() => {}) },
        { label: '现在就预热（要等几十秒）', click: () => keepAlive.warm().catch(() => {}) },
        { label: '开关和间隔在设置面板里', enabled: false },
        { type: 'separator' },
        { label: '语音桥：' + (voiceReady() ? '有' : '没装，只有气泡没有声音'), enabled: false },
      ] },
      { label: live ? '搭话（DSH 桥）' : '搭话（DSH 桥没在跑）', submenu: talkItems },
      { type: 'separator' },
      { label: '外观', submenu: [
        { label: '复原服装（衣服回默认档）', click: () => push({ type: 'outfit-reset' }) },
      ] },
      { label: '重新载入舞台', click: () => loadStage() },
      { type: 'separator' },
      { label: win && win.isVisible() ? '藏起来（托盘里点左键叫回）' : '显示出来', click: () => { if (!win) return; win.isVisible() ? win.hide() : win.show(); } },
      { label: '退出', click: () => app.quit() },
    ];
  }

  // 弹菜单前先问一次桥：窥屏/主动开口的勾选状态得是当下的，不能是十分钟前的缓存。
  // 桥没装或没跑也很快——连接被拒是毫秒级，不会让菜单卡住。
  //
  // 「点菜单外面要自己收起来」这条：托盘菜单必须走 tray.popUpContextMenu()，
  // 它会把菜单的宿主窗口设成托盘、拿到正常的激活权，Windows 才会在点到别处时收掉。
  // 之前一律用 Menu.popup({ window: win })：桌宠窗是透明置顶、还常年穿透不吃鼠标，
  // 菜单借它的壳弹出却拿不到激活，点外面没有任何事件把它关掉，就一直挂着。
  let openMenu = null;

  async function buildMenu() {
    if (!win || win.isDestroyed()) return null;
    try { await refreshBridge(); } catch (e) {}
    if (!win || win.isDestroyed()) return null;
    return Menu.buildFromTemplate(menuTemplate());
  }

  // 托盘右键：交给 Tray 自己弹，点外面自动关
  async function trayMenu() {
    const m = await buildMenu();
    if (!m) return;
    openMenu = m;
    tray.popUpContextMenu(m);
    // 菜单是同步阻塞之外的东西，没有「关闭」回调；下一次弹之前把它置空就行
    setTimeout(() => { if (openMenu === m) openMenu = null; }, 30000);
  }

  // 右键她本人：这时候窗口是活的、鼠标在窗口上，普通 popup 的关闭逻辑是好的
  async function popupMenu() {
    const m = await buildMenu();
    if (!m) return;
    openMenu = m;
    m.popup({ window: win, callback: () => { if (openMenu === m) openMenu = null; } });
  }

  function createTray() {
    const iconPath = path.join(STAGE_DIR, 'tray-32.png');
    let img = nativeImage.createFromPath(iconPath);
    // 图标加载不到只会得到空图、托盘一片空白，还不报错——留一行日志方便排查
    console.log(JSON.stringify({ trayIcon: img.isEmpty() ? 'EMPTY:' + iconPath : img.getSize() }));
    tray = new Tray(img);
    tray.setToolTip('安娜 · 鲸鱼舞台');
    // 左键开关设置面板，右键才是菜单——托盘的老规矩，别反着来
    tray.on('click', () => trayLeftClick());
    tray.on('right-click', () => trayMenu());
  }

  ipcMain.on('stage:menu', () => popupMenu());
  ipcMain.on('stage:reply', (_e, text) => { sendReply(text).catch(() => {}); });
  ipcMain.on('panel:close', () => { if (panel && !panel.isDestroyed()) panel.close(); });
  ipcMain.handle('panel:state', () => ({ size: sizeInfo(), cfg: Cfg.load(), model: MODEL_DIR, controlPort: PORT, keepalive: keepAlive.status(), voice: voiceReady() }));
  ipcMain.handle('panel:size', (_e, p) => applySize(p && p.w, p && p.h));
  ipcMain.handle('panel:save', (_e, patch) => applyConfig(patch));

  createTray();
  win.on('closed', () => {
    try { if (tray) tray.destroy(); } catch (e) {}
    try { if (panel && !panel.isDestroyed()) panel.close(); } catch (e) {}
  });

  // 控制口：GET 走查询串，POST 走 JSON 体。两种都支持，因为老的 DSH 桥全是 POST JSON，
  // 命令行和手工排查习惯用 GET。参数合并规则：体里有这个键就用体的，否则看查询串。
  function makeQuery(sp, body) {
    return {
      body: body || {},
      get(key) {
        const b = body || {};
        if (Object.prototype.hasOwnProperty.call(b, key)) {
          const v = b[key];
          if (v === null || v === undefined) return null;
          if (typeof v === 'object') return JSON.stringify(v);
          return String(v);
        }
        return sp.get(key);
      },
    };
  }

  const portsListening = [];
  function listenPorts() { return portsListening.slice(); }

  function makeServer() {
    return http.createServer((req, res) => {
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return json(res, 400, { error: 'bad url' }); }
      const handler = routes[url.pathname];
      if (!handler) return json(res, 404, { error: 'unknown route', routes: Object.keys(routes) });
      const run = (body) => {
        Promise.resolve()
          .then(() => handler(makeQuery(url.searchParams, body), req))
          .then((out) => json(res, 200, { ok: true, ...out }))
          .catch((e) => json(res, 500, { ok: false, error: (e && e.message) || String(e) }));
      };
      if (req.method === 'POST' || req.method === 'PUT') {
        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
        req.on('end', () => {
          let body = {};
          try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = {}; }
          run(body);
        });
        return;
      }
      run({});
    });
  }

  function listen(port, label) {
    const srv = makeServer();
    srv.on('error', (e) => {
      // 端口被占不算失败：老外壳可能正占着 61942/61943，舞台照样跑
      console.log(JSON.stringify({ port, label, error: (e && e.message) || String(e) }));
    });
    srv.listen(port, '127.0.0.1', () => {
      portsListening.push(port);
      console.log(JSON.stringify({ port, label, listening: true }));
    });
    return srv;
  }

  // 主口 61945；另外两个是给 DSH 桥的别名口（桥里写死 61942/61943），
  // 这样不用改桥的配置就能连上新舞台。
  const aliasList = String(arg('alias-ports', process.env.WHALE_STAGE_ALIAS_PORTS || '61942,61943'))
    .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0 && n !== PORT);
  const servers = [listen(PORT, 'control'), ...aliasList.map((p) => listen(p, 'alias'))];
  // 会话联动要等别名口起来再拉：watcher 按老地址（61942/61943）往那儿砸气泡和表情
  setTimeout(() => { try { startWatcher(); } catch (e) {} }, 1500);
  app.on('will-quit', () => {
    try { stopWatcher(); } catch (e) {}
    for (const s of servers) { try { s.close(); } catch (e) {} }
  });
});

app.on('window-all-closed', () => app.quit());
