// 棉花糖自检：node scripts/doctor.mjs
//
// 只查「跑不起来」的那几件事：模型找不找得到、Cubism Core 在不在、控制口通不通、语音桥有没有。
// 以前这份是给旧外壳查环境的（端口 61942/61943、外部舞台补丁那些），新舞台自带渲染，
// 那些项全部作废，这里重写成跟棉花糖一一对应的检查。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = path.join(ROOT, 'stage');
const CFG_FILE = path.join(ROOT, 'data', 'stage-config.json');
const PORT = 61945;

const say = (s = '') => console.log(s);
const kv = (k, v) => console.log('  ' + String(k).padEnd(14) + ' ' + v);
const ok = (v) => (v ? '✓ ' : '✗ ') + (v ? '在' : '缺');

function cfg() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch (e) { return {}; }
}

function modelDirOf(c) {
  const fromEnv = process.env.WHALE_MODEL_DIR || '';
  const given = fromEnv || String(c.modelDir || '');
  return given ? path.resolve(given) : path.join(ROOT, 'models');
}

function findModel(dir) {
  try {
    const f = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith('.model3.json'));
    return f ? path.join(dir, f) : '';
  } catch (e) { return ''; }
}

function findCore(c, dir) {
  const given = process.env.WHALE_CUBISM_CORE || String(c.cubismCore || '');
  const list = [
    given,
    path.join(STAGE, 'vendor', 'live2dcubismcore.min.js'),
    path.join(ROOT, 'vendor', 'live2dcubismcore.min.js'),
    path.join(dir, 'live2dcubismcore.min.js'),
  ].filter(Boolean);
  return list.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } }) || '';
}

async function ping(p, p2) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const r = await fetch('http://127.0.0.1:' + p + p2, { signal: ctl.signal });
    return r.ok ? r.status : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

const c = cfg();
const dir = modelDirOf(c);
const model = findModel(dir);
const core = findCore(c, dir);

say('棉花糖 自检');
say('');
say('[1] 模型');
kv('目录', fs.existsSync(dir) ? dir : dir + '  （不存在）');
kv('model3.json', model ? path.basename(model) : '（目录里没有 *.model3.json）');
if (!model) say('     → 换模型：--model <目录> / WHALE_MODEL_DIR / data\\stage-config.json 的 modelDir');
kv('Cubism Core', core ? core : '（没找到，用 --core 或配置 cubismCore 指过去）');

say('');
say('[2] 舞台');
const st = await ping(PORT, '/status');
kv('控制口 ' + PORT, st ? 'HTTP ' + st : '没起来（桌面那只还在跑吗）');
if (st) {
  const r = await ping(PORT, '/state');
  kv('/state', r ? 'HTTP ' + r : '读不到');
}

say('');
say('[3] 可选集成');
const voice = process.env.WHALE_VOICE_PREPARE || 'F:\\DaFeiYu\\tools\\pet-voice-prepare.mjs';
kv('语音桥', fs.existsSync(voice) ? voice : '（没配，只有气泡没有声音）');
kv('TTS 服务', (await ping(9880, '/health')) ? '在' : '没起来（保活会自己拉，冷启动第一句慢）');
kv('DSH 桥 61944', (await ping(61944, '/health')) ? '在' : '没起来（点触叫醒、回复钮会失效）');

say('');
say('[4] 数据');
kv('配置文件', fs.existsSync(CFG_FILE) ? CFG_FILE : '（第一次运行会自己建）');
kv('Node', process.version);
const problems = [];
if (!model) problems.push('没有模型');
if (!core) problems.push('没有 Cubism Core');
if (problems.length) {
  say('');
  say('!! ' + problems.join('、') + '：这两样缺一个舞台就是一片空白');
  process.exitCode = 1;
} else {
  say('');
  say('-- 必需的都在');
}
