// whale-pet-shell 自检：一条命令把「你的机器和作者机器不一样的地方」全摆出来。
//
//   npm run doctor            # 只看，不改
//   npm run doctor -- --fix   # 顺手把鲸语的舞台补丁补上（幂等，自动备份 .whale-pet-bak）
//
// 为什么要这个：桌宠里那些「我这儿好好的、别人那儿闪 / 变大 / 口型不同步」的毛病，几乎都不是
// 代码逻辑错，而是机器差异——缩放比例、显示器数量、Electron 版本、鲸语有没有打补丁、端口被占。
// 这些信息自己问一圈很费劲，所以让程序自己报。只读、不上传、不联网（除了 ping 本机端口）。
const { app, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CFG = require(path.join(ROOT, 'src', 'config.js'));
const FIX = process.argv.includes('--fix');
const OUT = [];
const say = (s = '') => { OUT.push(s); };
const kv = (k, v) => say('  ' + String(k).padEnd(22) + v);

const ping = (port, p) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 1200 }, (res) => { res.resume(); resolve(res.statusCode || 0); });
  req.on('timeout', () => { req.destroy(); resolve(0); });
  req.on('error', () => resolve(0));
});

function patchState(repo) {
  // 每项给「补丁注释标记」和「功能探针」两种判据：老版本补丁、手改过的文件没有注释标记，
  // 但功能是在的（patch/apply-jingyu.mjs 自己也认这两种），别误报成没打。
  const map = [
    ['app.mjs 舞台模式', path.join(repo, 'web', 'app.mjs'), 'whale-pet-patch:stage-mode', 'const stageMode='],
    ['app.mjs 读像素', path.join(repo, 'web', 'app.mjs'), 'whale-pet-patch:preserve', 'preserveDrawingBuffer'],
    ['app.mjs 锁帧', path.join(repo, 'web', 'app.mjs'), 'whale-pet-patch:fps', 'maxFPS'],
    ['app.mjs 遮罩缓冲', path.join(repo, 'web', 'app.mjs'), 'whale-pet-patch:clip-mask', 'boostClippingMask'],
    ['app.mjs 暴露 engine', path.join(repo, 'web', 'app.mjs'), 'whale-pet-patch:expose', '__stageEngine'],
    ['engine.mjs 指针阶段', path.join(repo, 'web', 'engine.mjs'), 'whale-pet-patch:pointer', 'applyPointer'],
  ];
  const out = [];
  for (const [name, file, mark, probe] of map) {
    let src = null;
    try { src = fs.readFileSync(file, 'utf8'); } catch {}
    const marked = !!src && src.includes(mark);
    const built = !!src && src.includes(probe);
    out.push({ name, ok: marked || built, marked, exists: !!src });
  }
  return out;
}

app.whenReady().then(async () => {
  const cfg = CFG.load();
  const R = CFG.resolve(cfg);

  say('whale-pet-shell 自检  ' + new Date().toISOString());
  say('='.repeat(64));

  say('');
  say('[1] 运行环境（本仓库实测：Electron 45.2.x）');
  kv('Electron', process.versions.electron);
  kv('Chromium', process.versions.chrome);
  kv('Node', process.versions.node);
  kv('系统', process.platform + ' ' + process.arch + ' / ' + (require('node:os').release()));
  kv('仓库', ROOT);
  const ev = String(process.versions.electron || '');
  if (!ev.startsWith('45.')) say('  !! Electron 版本和作者实测的不一致：透明窗口 / 音频行为可能就不一样。建议 npm i electron@45.2.1');

  say('');
  say('[2] 显示器与缩放（窗口「变大 / 闪」的头号来源）');
  const ds = screen.getAllDisplays();
  const scales = new Set(ds.map((d) => d.scaleFactor));
  ds.forEach((d, i) => {
    kv('显示器 ' + i, 'DIP ' + d.bounds.width + 'x' + d.bounds.height + ' @' + d.bounds.x + ',' + d.bounds.y
      + '  缩放 ' + Math.round(d.scaleFactor * 100) + '%'
      + '  物理 ' + Math.round(d.bounds.width * d.scaleFactor) + 'x' + Math.round(d.bounds.height * d.scaleFactor)
      + '  主屏' + (d.id === screen.getPrimaryDisplay().id ? '是' : '否'));
  });
  if (scales.size > 1) {
    say('  !! 各屏缩放不一样：窗口从一块屏拖到另一块屏时，系统会按新缩放重算尺寸。');
    say('     新版已经按物理尺寸换算、拖动时冻结宽高，最多在跨屏的一瞬间跳一下；');
    say('     如果还在持续变大，把这段输出发给作者。');
  } else if ([...scales][0] !== 1) {
    say('  -- 全屏统一缩放 ' + Math.round([...scales][0] * 100) + '%：配置里的宽高是 DIP，100% 机器上的 736x1320');
    say('     到 150% 上会按 1.5 倍显示（这是 Windows 的规矩，不是 bug）。嫌大就在面板里调小一档。');
  }
  // GPU 状态要等 GPU 进程真的起来才准：whenReady 刚回来的那一瞬间读，webgl 会假报 disabled_off
  await new Promise((r) => setTimeout(r, 1200));
  const gpu = app.getGPUFeatureStatus ? app.getGPUFeatureStatus() : {};
  const gl = String(gpu.webgl2 || gpu.webgl || '未知');
  kv('WebGL', gl + (gl === 'enabled' ? '' : '（enabled 才算走硬件）'));
  if (/unavailable|software|disabled/i.test(gl)) {
    say('  !! WebGL 没走硬件：透明窗口在软件渲染下容易闪、也吃 CPU。更新显卡驱动，或加启动参数 --ignore-gpu-blocklist');
  }

  say('');
  say('[3] 配置');
  kv('配置文件', fs.existsSync(CFG.CFG_FILE) ? CFG.CFG_FILE : '不存在（第一次运行会弹设置面板）');
  kv('鲸语目录', R.repo || '（空）');
  kv('模型目录', R.model || '（空）');
  kv('Python', R.python);
  kv('端口', '舞台 ' + R.stagePort + ' / 控制 ' + R.moodPort);
  if (R.problems.length) {
    say('  !! 缺东西：');
    for (const p of R.problems) say('     - ' + p);
  } else say('  -- 必需项齐全');

  say('');
  say('[4] 鲸语舞台补丁（没打 = 没有像素穿透 / 没有指针追踪 / 口型可能不动）');
  const st = patchState(R.repo || '');
  for (const s of st) kv(s.name, s.ok ? (s.marked ? '已打' : '已打（手改版）') : (s.exists ? '未打' : '文件不存在'));
  const missing = st.filter((s) => s.exists && !s.ok);
  if (missing.length && FIX) {
    say('  -- 正在补打补丁…');
    const r = spawnSync(process.env.npm_node_execpath || 'node', [path.join(ROOT, 'patch', 'apply-jingyu.mjs'), '--repo', R.repo], { encoding: 'utf8' });
    say('  ' + String(r.stdout || r.stderr || '').trim().split('\n').join('\n  '));
  } else if (missing.length) {
    say('  !! 有 ' + missing.length + ' 处没打。跑 npm run doctor -- --fix，或手动：');
    say('     node patch/apply-jingyu.mjs --repo "' + R.repo + '"');
  }

  say('');
  say('[5] 端口');
  const s1 = await ping(R.stagePort, '/api/state');
  const s2 = await ping(R.moodPort, '/status');
  kv('舞台 ' + R.stagePort + ' /api/state', s1 ? 'HTTP ' + s1 : '没起来（壳子会自己拉 server.py）');
  kv('控制 ' + R.moodPort + ' /status', s2 ? 'HTTP ' + s2 : '没起来（壳子没在跑？）');

  say('');
  say('[6] 语音（可选）');
  const vs = String(cfg.voicePrepare || '').trim();
  const vd = String(cfg.voiceWavDir || '').trim();
  kv('voicePrepare', vs ? (fs.existsSync(vs) ? vs : vs + '  ← 文件不存在') : '（没配，哑巴模式）');
  kv('voiceWavDir', vd ? (fs.existsSync(vd) ? vd : vd + '  ← 目录不存在') : '（没配）');
  let cacheN = 0;
  try { cacheN = Object.keys(JSON.parse(fs.readFileSync(path.join(R.dataDir, 'voice-cache.json'), 'utf8').replace(/^\uFEFF/, ''))).length; } catch {}
  kv('预合成缓存', cacheN + ' 条');
  const audioDir = path.join(R.repo || '', 'web', 'audio');
  kv('舞台 audio 目录', fs.existsSync(audioDir) ? audioDir : '不存在（说话时会自动建）');

  say('');
  say('[7] 日志里最近 5 条说话的时序');
  try {
    const log = fs.readFileSync(path.join(R.dataDir, 'pet.log'), 'utf8').split('\n').filter((l) => l.includes('realtime say')).slice(-5);
    if (!log.length) say('  （还没有）');
    for (const l of log) say('  ' + l.replace(/^\S+T\S+Z\s/, ''));
  } catch { say('  （没有 pet.log）'); }

  say('');
  say('='.repeat(64));
  say('把上面整段复制给作者就行。里面没有账号、路径以外的隐私信息。');

  process.stdout.write(OUT.join('\n') + '\n');
  app.exit(0);
});
