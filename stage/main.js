// 自建轻量舞台的独立入口。刻意跟 src/main.js 完全分开：
// 现役桌宠照旧跑它自己的入口，这里只负责「我们自己的舞台」能不能站起来。
//
// 跑法：node_modules\electron\dist\electron.exe stage\main.js --model="模型目录" [--core="core 文件"] [--cdp=9340] [--port=61945]
//   --core 不给就依次找：环境变量 WHALE_CUBISM_CORE、鲸语 1.4 部署里的 vendor、模型目录
const { app, BrowserWindow, protocol, net, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

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

protocol.registerSchemesAsPrivileged([{
  scheme: 'pet',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}]);

// 透明置顶窗在 Windows 上会被 Chromium 判成「被别人挡住」而暂停渲染，拖动时还会在两态之间翻，
// 表现出来就是模型一闪一闪。桌宠永远置顶，这套遮挡计算纯属误判，直接关掉。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

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
    if (rel.startsWith('core/')) {
      if (!CORE_FILE) return new Response('cubism core missing', { status: 404 });
      return net.fetch(pathToFileURL(CORE_FILE).toString());
    }
    return fileResponse(STAGE_DIR, rel);
  });

  const win = new BrowserWindow({
    width: 531,
    height: 950,
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

  // 指针：主进程每 33ms 读一次全局光标，归一化后送进页面。页面拿到的永远是真实位置，
  // 不依赖鼠标事件——桌宠大部分时间是穿透的，页面根本收不到 mousemove。
  const cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    const [ww, wh] = win.getSize();
    const cx = (p.x - wx) / Math.max(1, ww);
    const cy = (p.y - wy) / Math.max(1, wh);
    const x = Math.max(-1, Math.min(1, cx * 2 - 1));
    const y = Math.max(-1, Math.min(1, 1 - cy * 2));
    try {
      win.webContents.send('stage:cursor', {
        x: +x.toFixed(3), y: +y.toFixed(3),
        inside: cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1,
      });
    } catch (e) {}
  }, 33);
  win.on('closed', () => clearInterval(cursorTimer));

  const modelFile = fs.readdirSync(MODEL_DIR).find((f) => f.toLowerCase().endsWith('.model3.json')) || '';
  console.log(JSON.stringify({ modelDir: MODEL_DIR, modelFile: modelFile ? '(found)' : 'MISSING', core: CORE_FILE ? '(found)' : 'MISSING' }));
  await win.loadURL('pet://stage/index.html?model=' + encodeURIComponent(modelFile));

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

  const routes = {
    '/state': async () => {
      const s = await win.webContents.executeJavaScript('window.__petEngine ? window.__petEngine.state() : null');
      const info = await win.webContents.executeJavaScript('window.__stageInfo || null');
      return { ...s, model: MODEL_DIR, motions: info && info.motions, expressions: info && info.expressions };
    },
    '/say': (q) => {
      const text = q.get('text') || '';
      const ms = Number(q.get('ms')) || 1200;
      push({ type: 'talk', ms, text });
      const emo = q.get('emotion');
      if (emo) push({ type: 'emotion', name: emo });
      const mo = q.get('motion');
      if (mo) push({ type: 'motion', name: mo });
      return { pushed: true, text, ms, emotion: emo || null, motion: mo || null };
    },
    '/motion': (q) => {
      const name = q.get('name') || '';
      if (!name) throw new Error('缺 name');
      push({ type: 'motion', name });
      return { pushed: true, name };
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
