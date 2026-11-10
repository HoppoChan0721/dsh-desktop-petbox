// 自建轻量舞台的独立入口。刻意跟 src/main.js 完全分开：
// 现役桌宠照旧跑它自己的入口，这里只负责「我们自己的舞台」能不能站起来。
//
// 跑法：node_modules\electron\dist\electron.exe stage\main.js --model="模型目录" [--core="core 文件"] [--cdp=9340] [--port=61945]
//   --core 不给就依次找：环境变量 WHALE_CUBISM_CORE、鲸语 1.4 部署里的 vendor、模型目录
const { app, BrowserWindow, protocol, net, screen, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const drag = require('./drag');
const gaze = require('./gaze');

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
    webPreferences: {
      preload: path.join(STAGE_DIR, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

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

  const taps = [];
  ipcMain.on('stage:tap', (_e, payload) => {
    const rec = Object.assign({}, payload || {});
    if (!rec.at) rec.at = Date.now();
    taps.push(rec);
    if (taps.length > 60) taps.shift();
    console.log(JSON.stringify({ tap: rec }));
  });

  const modelFile = fs.readdirSync(MODEL_DIR).find((f) => f.toLowerCase().endsWith('.model3.json')) || '';
  console.log(JSON.stringify({ modelDir: MODEL_DIR, modelFile: modelFile ? '(found)' : 'MISSING', core: CORE_FILE ? '(found)' : 'MISSING' }));
  // --sway=1.6 待机摆动幅度倍数：头发/裙摆的物理全靠它，太小看着死。不填就用引擎默认。
  const swayArg = arg('sway', process.env.WHALE_SWAY || '');
  await win.loadURL('pet://stage/index.html?model=' + encodeURIComponent(modelFile) + (swayArg ? '&sway=' + encodeURIComponent(swayArg) : ''));

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
      const text = q.get('text') || '';
      if (!text) throw new Error('缺 text');
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
    '/zones': async () => {
      const z = await win.webContents.executeJavaScript('window.__stageZones ? window.__stageZones() : null');
      return { zones: z };
    },
    '/window': (q) => {
      const b = win.getBounds();
      const [w, h] = drag.clampSize(Number(q.get('w')) || b.width, Number(q.get('h')) || b.height);
      const x = q.get('x') !== null ? Number(q.get('x')) : b.x;
      const y = q.get('y') !== null ? Number(q.get('y')) : b.y;
      win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
      return { bounds: win.getBounds() };
    },
  };

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return json(res, 400, { error: 'bad url' }); }
    const handler = routes[url.pathname];
    if (!handler) return json(res, 404, { error: 'unknown route', routes: Object.keys(routes) });
    Promise.resolve()
      .then(() => handler(url.searchParams, req))
      .then((body) => json(res, 200, { ok: true, ...body }))
      .catch((e) => json(res, 500, { ok: false, error: (e && e.message) || String(e) }));
  });
  server.on('error', (e) => console.log(JSON.stringify({ controlPort: PORT, error: (e && e.message) || String(e) })));
  server.listen(PORT, '127.0.0.1', () => console.log(JSON.stringify({ controlPort: PORT, listening: true })));
  app.on('will-quit', () => { try { server.close(); } catch (e) {} });
});

app.on('window-all-closed', () => app.quit());
