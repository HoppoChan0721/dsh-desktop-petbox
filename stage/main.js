// 自建轻量舞台的独立入口。刻意跟 src/main.js 完全分开：
// 现役桌宠照旧跑它自己的入口，这里只负责「我们自己的舞台」能不能站起来。
//
// 跑法：node_modules\electron\dist\electron.exe stage\main.js --model="模型目录" [--core="core 文件"] [--cdp=9340]
//   --core 不给就依次找：环境变量 WHALE_CUBISM_CORE、鲸语 1.4 部署里的 vendor、模型目录
const { app, BrowserWindow, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
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
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  const modelFile = fs.readdirSync(MODEL_DIR).find((f) => f.toLowerCase().endsWith('.model3.json')) || '';
  console.log(JSON.stringify({ modelDir: MODEL_DIR, modelFile: modelFile ? '(found)' : 'MISSING', core: CORE_FILE ? '(found)' : 'MISSING' }));
  await win.loadURL('pet://stage/index.html?model=' + encodeURIComponent(modelFile));
});

app.on('window-all-closed', () => app.quit());
