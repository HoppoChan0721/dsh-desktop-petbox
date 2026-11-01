// ============================================================================
// DSH → 桌宠 联动（conductor v3，2026-10-31）
//
// v2 只会看「回合结束后的语气」和「25 秒没答完就思考」，所以中间几十秒她是呆的。
// v3 直接读会话事件流，把**过程中**的每一种状态都演出来：
//
//   主人发话        → 抬头 + 点头          (listen)
//   我在生成        → 眯眼 + 歪头 + 视线偏上 (think)
//   跑工具          → 按工具类型给不同姿态   (tool:read / write / shell / web / subagent ...)
//   工具卡很久      → 流冷汗               (stall)
//   工具报错        → 流冷汗 + 摇头         (error)
//   子代理在跑      → 看向旁边 + 圈圈眼      (subagent)
//   答完了          → 按回复语气给表情       (done)
//   什么都没发生    → 待机（交给外壳的摇摆）
//
// 关键点：全部走 61942 的 /api/compile + /api/execute（跟 pet.mjs 同一条通道）；
// 状态只在**变化时**下发，长状态定期续一次，避免每 700ms 抽一次脸。
//
// 用法：
//   node dsm-watch.mjs            # 正常跑（Electron 外壳启动时自动拉起）
//   node dsm-watch.mjs --dry      # 只打印推导出的状态，不碰桌宠（调试用）
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// 路径全部来自环境变量（外壳启动时按 data/config.json 注入），没给就报错退出
const DATA = process.env.WHALE_PET_DATA || path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'data');
const ROOT = process.env.DSH_SESSIONS_DIR || '';
const STAGE = process.env.WHALE_PET_STAGE || 'http://127.0.0.1:61942';
const SHELL = process.env.WHALE_PET_SHELL || 'http://127.0.0.1:61943';
const MOOD_JSON = process.env.WHALE_PET_MOOD || '';
if (!ROOT) {
  console.error('dsh-watch: 没设置 DSH_SESSIONS_DIR（在外壳的设置面板里填会话目录）');
  process.exit(1);
}
const STATE = path.join(DATA, 'watch-state.json');
const LOG = path.join(DATA, 'watch.log');
const PIDFILE = path.join(DATA, 'watch.pid');

const DRY = process.argv.includes('--dry');
const PROBE = process.argv.includes('--probe');
const TICK_MS = 700;
const STALL_MS = 45000;      // 一个工具跑超过这么久 → 流冷汗（20s 太敏感，正常命令都能跑 20~30s）
const SUBAGENT_FRESH_MS = 15000;
const REMIND_MS = 6500;      // 长状态续期周期（要略大于 plan 时长 5.5s + 引擎占用窗口）
const THINK_DIZZY_MS = 16000; // 同一段思考持续这么久 → 插一次「圈圈眼」（想晕了），一个回合一次
const FIDGET_GAP_MS = 70000;  // 闲着的时候每隔这么久来一个小动作，别像雕像
const DEBOUNCE_MS = 1800;     // 新状态要先稳住这么久才切（我这边一步 0.5~2 秒，不防抖就会抽风）
const MIN_GAP_MS = 2600;      // 两次下发之间至少隔这么久（done/error/listen 例外）

function log(s) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + s + '\n'); } catch {}
  if (DRY) console.log(new Date().toISOString().slice(11, 19), s);
}

// ---------------------------------------------------------------- 单实例
if (!DRY && !PROBE) {
  try {
    const pid = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
    if (pid && pid !== process.pid) {
      process.kill(pid, 0);
      log(`已有实例 pid=${pid}，退出`);
      process.exit(0);
    }
  } catch {}
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(PIDFILE, String(process.pid)); } catch {}
  const bye = () => { try { if (Number(fs.readFileSync(PIDFILE, 'utf8').trim()) === process.pid) fs.unlinkSync(PIDFILE); } catch {} process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}

// ---------------------------------------------------------------- 状态
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch { return {}; }
}
function saveState(patch) {
  const next = { ...loadState(), ...patch };
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(next)); } catch {}
  return next;
}

async function jpost(url, body, ms = 4000) {
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  } catch (e) { return { status: 0, data: { error: e.message } }; }
}
async function jget(url, ms = 2000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch (e) { return { status: 0, data: { error: e.message } }; }
}

// ---------------------------------------------------------------- 会话日志
// 每个文件一份缓存（子代理和主会话会交替出现，单槽缓存会反复解压）
const caches = new Map();
const notMain = new Set();

function listCandidates() {
  const out = [];
  let slices = [];
  try { slices = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return out; }
  for (const s of slices) {
    if (!s.isDirectory()) continue;
    const sd = path.join(ROOT, s.name);
    let ses = [];
    try { ses = fs.readdirSync(sd, { withFileTypes: true }); } catch { continue; }
    for (const ss of ses) {
      if (!ss.isDirectory()) continue;
      const p = path.join(sd, ss.name, 'session.v4.jsonl.zstd');
      try { const st = fs.statSync(p); out.push({ p, mtime: st.mtimeMs, size: st.size }); } catch {}
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 12);
}

function readEvents(file) {
  const c = caches.get(file.p);
  if (c && c.size === file.size && c.mtime === file.mtime) return c.parsed;
  let raw;
  try { raw = zlib.zstdDecompressSync(fs.readFileSync(file.p)).toString('utf8').split('\n').filter(Boolean); }
  catch (e) { log('解压失败 ' + e.message); return null; }
  // 只有尾部会长，前面复用已解析结果
  const parsed = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    if (c && c.raw[i] === raw[i]) parsed[i] = c.parsed[i];
    else { try { parsed[i] = JSON.parse(raw[i]); } catch { parsed[i] = null; } }
  }
  if (caches.size > 6) caches.delete(caches.keys().next().value);
  caches.set(file.p, { size: file.size, mtime: file.mtime, raw, parsed });
  return parsed;
}

function isSubagentFile(events) {
  try {
    const head = events[0];
    const d = (head && head.data) || head || {};
    return d.origin === 'subagent' || Number(d.delegationDepth || 0) > 0;
  } catch { return false; }
}

// 主会话：从新到旧，跳过子代理
function mainSession() {
  for (const c of listCandidates()) {
    if (notMain.has(c.p)) continue;
    const ev = readEvents(c);
    if (!ev || !ev.length) continue;
    if (isSubagentFile(ev)) { notMain.add(c.p); continue; }
    return { file: c, events: ev };
  }
  return null;
}

function subagentFresh(ownPath) {
  const now = Date.now();
  for (const c of listCandidates()) {
    if (c.p === ownPath) continue;
    if (now - c.mtime > SUBAGENT_FRESH_MS) continue;
    const ev = readEvents(c);
    if (ev && ev.length && isSubagentFile(ev)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 状态推导
// 从最后一个 turn/start 往后走，得出：在不在回合内 / 卡在哪个工具 / 最后事件
function derive(events) {
  let turnStartIdx = -1, lastEnd = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const r = events[i];
    if (!r) continue;
    if (!lastEnd && r.type === 'turn/end') lastEnd = r;
    if (r.type === 'turn/start') { turnStartIdx = i; break; }
  }
  if (turnStartIdx < 0) return { idle: true };

  const started = events[turnStartIdx];
  const inFlight = !lastEnd || (started.seq > lastEnd.seq);

  // 用 callId 配对（tool/result 的 message.toolCallId），别靠「下一条就算收尾」猜
  const openCalls = new Map();
  let pendingTool = null, lastToolError = null, lastToolName = null, lastType = null, lastTime = 0, lastToolAt = 0;
  for (let i = turnStartIdx; i < events.length; i++) {
    const r = events[i];
    if (!r) continue;
    if (r.type === 'tool/call') {
      const cid = (r.data && r.data.callId) || String(r.seq);
      const name = (r.data && r.data.name) || 'tool';
      openCalls.set(cid, { name, seq: r.seq, at: Number(r.time) || Date.now() });
      lastToolName = name;
    } else if (r.type === 'tool/result') {
      const msg = (r.data && r.data.message) || {};
      if (msg.isError) lastToolError = { seq: r.seq, at: Number(r.time) || Date.now() };
      if (msg.toolCallId) openCalls.delete(msg.toolCallId);
      else openCalls.clear();
    }
    if (r.type) { lastType = r.type; lastTime = Number(r.time) || lastTime; }
    if (r.type === 'tool/call' || r.type === 'tool/result') lastToolAt = Math.max(lastToolAt, Number(r.time) || 0);
  }
  for (const v of openCalls.values()) if (!pendingTool || v.at > pendingTool.at) pendingTool = v;

  return {
    idle: false, inFlight, turn: started.data && started.data.turn, startedAt: Number(started.time) || 0,
    pendingTool, lastToolName, lastToolError, lastType, lastTime, lastToolAt,
    endSeq: lastEnd ? lastEnd.seq : null, events,
  };
}

// 回合结束后的正文 → 语气
const RULES = [
  ['sad', 1.4, ['抱歉', '对不起', '失败了', '没成', '搞错了', '弄坏', '遗憾', '可惜']],
  ['surprised', 1.3, ['诶', '咦', '竟然', '居然', '没想到', '等等']],
  ['excited', 1.2, ['终于', '成功了', '搞定', '跑通', '通了', '完成', '做好']],
  ['proud', 1.1, ['搞定', '修好', '通过了', '拿到了', '全部通过', '都好了']],
  ['shy', 1.1, ['害羞', '不好意思', '唔', '脸红', '才没有']],
  ['annoyed', 1.1, ['哼', '讨厌', '烦人', '别闹']],
  ['sleepy', 0.9, ['困', '睡', '晚安', '哈欠', '累']],
  ['playful', 0.9, ['嘿嘿', '逗', '捉弄', '嘛']],
  ['happy', 0.8, ['喜欢', '开心', '好耶', '哈哈', '太好了', '不错']],
  ['thinking', 0.6, ['想想', '分析', '检查', '方案', '需要确认', '研究']],
];
function classify(text) {
  const t = String(text || '').slice(-1600);
  let best = null, bestScore = 0;
  for (const [mood, w, words] of RULES) {
    let hits = 0;
    for (const x of words) if (t.includes(x)) hits++;
    if (hits && hits * w > bestScore) { bestScore = hits * w; best = mood; }
  }
  return best;
}
function lastAssistantText(events, turn) {
  for (let i = events.length - 1; i >= 0; i--) {
    const r = events[i];
    if (!r || r.type !== 'assistant/message') continue;
    if (r.data && r.data.turn !== turn) continue;
    const c = (r.data && r.data.message && r.data.message.content) || [];
    const t = c.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n').trim();
    if (t) return t;
  }
  return '';
}

// ---------------------------------------------------------------- 动作配方
// 每个状态 = 一组**变体**：进状态时加权随机挑一个（避开上次用过的），续期沿用同一个。
// 每 6.5 秒换一张脸反而更累，所以「随机」只发生在状态切换那一刻。
// 引擎约束记牢：同一 plan 里不能两条动作控同一参数——`前倾` 自带 LeanInput；`look` 与 `nod` 都动 AngleY。
const HOLD_KINDS = new Set(['think', 'read', 'write', 'shell', 'web', 'subagent', 'stall']);

const L = (dir, at = 0.2) => ({ kind: 'look', direction: dir, at, duration: 1.2 });
const T = (dir, at = 0.3) => ({ kind: 'tilt', direction: dir, at, duration: 1.8 });
const N = (count = 1, at = 0.2) => ({ kind: 'nod', count, at, duration: 1.2 + (count - 1) * 0.4 });
const SH = (count = 1, at = 0.2) => ({ kind: 'shake_head', count, at, duration: 1.6 });
const BL = (count = 1, at = 0.2) => ({ kind: 'blink', side: 'both', count, at, duration: 0.4 + count * 0.25 });
const SM = (at = 0.2) => ({ kind: 'smile', at, duration: 1.8 });

// 每个状态 = 「标识动作」固定（read 一定低头、write 一定前倾、subagent 一定看向旁边）
//        + 「表情」按权重随机       + 「附加小动作」随机
// faces: [[表情名 | null, 权重], ...]；acts 是标识动作；accents 是可选项（null = 不加）
const RIGS = {
  think: {
    faces: [['加载', 6], ['眯眼', 3], ['屑屑眼', 1], ['圈圈眼', 1]],
    acts: [],
    accents: [null, null, L('up'), T('right'), T('left')],
  },
  read: {
    faces: [[null, 4], ['眯眼', 2], ['圈圈眼', 1]],
    acts: [L('down')],
    accents: [null, null, T('right', 0.7), BL(1, 0.9)],
  },
  write: {
    // 2026-11-01：原来靠「前倾」表情俯身，但那会驱动 LeanInput，和桌宠指针追踪撞车；
    // 改成「眯眼（专注落笔）/ 单片眼镜 / 屑屑眼」，身体留给指针追踪与待机。
    faces: [['眯眼', 4], ['单片眼镜', 3], ['屑屑眼', 1]],
    acts: [],
    accents: [L('down'), L('down'), null, T('right', 0.6)],
  },
  shell: {
    // 2026-11-01：原来靠「前倾」表情俯身，但那会驱动 LeanInput，和桌宠的指针追踪撞车；
    // 改成「黑框眼镜（盯终端）/ 眯眼（专注）/ 加载」这些只在脸上的表达，身体留给指针追踪和待机。
    faces: [['黑框眼镜', 4], ['眯眼', 3], ['加载', 1]],
    acts: [L('down')],
    accents: [null, null, T('right', 0.8)],
  },
  web: {
    faces: [['兔牙', 3], ['加载', 2], [null, 2], ['爱心眼', 1]],
    acts: [L('up')],
    accents: [null, null],
  },
  subagent: {
    faces: [['圈圈眼', 4], [null, 1], ['眯眼', 1]],
    acts: [L('left')],
    accents: [null, T('left', 0.7)],
  },
  stall: {
    faces: [['流冷汗', 4], ['＞＜', 1], ['眯眼', 1]],
    acts: [L('up')],
    accents: [null, T('right', 0.7)],
  },
  error: {
    faces: [['流冷汗', 3], ['流泪', 1], [null, 2]],
    acts: [SH(1)],
    accents: [null],
  },
  dizzy: { faces: [['圈圈眼', 1]], acts: [T('right', 0.4)], accents: [null] },
  listen: {
    faces: [[null, 3], ['兔牙', 1]],
    acts: [N(1)],
    accents: [null, null, SM()],
  },
  fidget: {
    faces: [[null, 6], ['眯眼', 1], ['兔牙', 1]],
    acts: [],
    accents: [BL(1), T('left'), T('right'), L('left'), L('right'), SM(), N(1)],
  },
  done_happy: { faces: [['爱心眼', 3], ['兔牙', 2], [null, 2]], acts: [N(1)], accents: [null] },
  done_excited: { faces: [['兔牙', 3], ['爱心眼', 2], [null, 1]], acts: [N(2)], accents: [null] },
  done_proud: { faces: [['屑屑眼', 3], ['兔牙', 1]], acts: [N(1)], accents: [null] },
  done_shy: { faces: [['脸红', 1]], acts: [T('left')], accents: [null] },
  done_sad: { faces: [['流泪', 1]], acts: [L('down')], accents: [null] },
  done_annoyed: { faces: [['黑脸', 1]], acts: [T('right')], accents: [null] },
  done_playful: { faces: [['屑屑眼', 1]], acts: [T('right')], accents: [null] },
  done_sleepy: { faces: [['＞＜', 1], ['眯眼', 1]], acts: [L('down')], accents: [null] },
};

function pickWeighted(list, avoidIdx = -1) {
  let pool = list.map((_, i) => i).filter((i) => i !== avoidIdx);
  if (!pool.length) pool = list.map((_, i) => i);
  const total = pool.reduce((s, i) => s + (list[i][1] || 1), 0);
  let r = Math.random() * total;
  for (const i of pool) { r -= (list[i][1] || 1); if (r <= 0) return i; }
  return pool[pool.length - 1];
}

// 挑一份 plan：表情随机（避开这个状态上次用过的），动作由 RIGS 决定
function pickPlan(kind, lastFace = -1) {
  const rig = RIGS[kind] || { faces: [[null, 1]], acts: [], accents: [null] };
  const fi = pickWeighted(rig.faces, lastFace);
  const face = rig.faces[fi][0];
  const accents = rig.accents || [null];
  const accent = accents[Math.floor(Math.random() * accents.length)] || null;
  const acts = [...(rig.acts || []), ...(accent ? [accent] : [])];
  return { plan: buildPlan(kind, face, acts), faceIdx: fi, face, acts };
}

// 枚举一个状态的所有「表情 × 附加」组合（给 --probe 用）
function allCombos(kind) {
  const rig = RIGS[kind] || { faces: [[null, 1]], acts: [], accents: [null] };
  const out = [];
  rig.faces.forEach((f, fi) => {
    (rig.accents || [null]).forEach((acc, ai) => {
      out.push({ fi, ai, plan: buildPlan(kind, f[0], [...(rig.acts || []), ...(acc ? [acc] : [])]) });
    });
  });
  return out;
}

function buildPlan(kind, face, acts = []) {
  // 引擎一次只跑一份 plan，时长就是「占用窗口」：长状态 5.5s 一版、每 6.5s 续一次
  const d = HOLD_KINDS.has(kind) ? 5.5 : 2.5;
  const actions = [];
  if (face) actions.push({ kind: 'expression', name: face, strength: 0.85, layer: 'exclusive', at: 0, duration: d });
  for (const a of acts) actions.push({ ...a });
  const title = `联动 · ${kind}${face ? ' · ' + face : ''}`;
  return { version: 1, title, intent: title, summary: title, actions: actions.slice(0, 24) };
}

async function applyPlan(plan, allowStop = true) {
  if (DRY) { log('DRY → ' + plan.title); return true; }
  let r = await jpost(`${STAGE}/api/execute`, { plan, backend: 'web' });
  if (r.status === 400 && allowStop) {
    // 状态真的变了 → 打断上一段，宁可换得快一点
    await jpost(`${STAGE}/api/stop`, {});
    await new Promise((res) => setTimeout(res, 140));
    r = await jpost(`${STAGE}/api/execute`, { plan, backend: 'web' });
  }
  if (r.status === 400) return false;   // 续期时撞上占用窗口 → 下个 tick 再来，别硬打断
  const ok = r.status === 200 || r.status === 201;
  if (!ok) log(`apply ${plan.title} 失败 ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  return ok;
}

// ---------------------------------------------------------------- 主循环
const MOOD_MAP = {
  '开心': 'happy', '高兴': 'happy', '愉快': 'happy', '害羞': 'shy', '难为情': 'shy',
  '兴奋': 'excited', '期待': 'excited', '困': 'sleepy', '困倦': 'sleepy', '累': 'sleepy',
  '难过': 'sad', '失落': 'sad', '心疼': 'sad', '得意': 'proud', '骄傲': 'proud',
  '嫌弃': 'annoyed', '生气': 'annoyed', '不爽': 'annoyed', '吃惊': 'surprised', '惊讶': 'surprised',
  '思考': 'thinking', '专注': 'thinking', '撒娇': 'playful', '调皮': 'playful',
  '平静': 'neutral', '平常': 'neutral', '闷': 'pout', '委屈': 'pout', '困惑': 'confused',
};
const MOOD_TO_DONE = { happy: 'done_happy', excited: 'done_excited', shy: 'done_shy', sad: 'done_sad', annoyed: 'done_annoyed', playful: 'done_playful', sleepy: 'done_sleepy', proud: 'done_proud' };

let applied = { kind: null, at: 0, since: 0, plan: null, face: null };
let pending = { kind: null, since: 0 };
let lastEndSeen = undefined;
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    // 0. 外壳/舞台在不在；她在说话时一概不动
    const st = await jget(`${SHELL}/status`);
    if (st.status === 0) return;
    if (st.data && st.data.voicing) return;

    const main = mainSession();
    if (!main) return;
    const snap = derive(main.events);
    const saved = loadState();

    // 1. 真实心情（mood.json）变了 → 走 /mood，一次（没配心情文件就跳过）
    try {
      if (!MOOD_JSON) throw 0;
      const m = JSON.parse(fs.readFileSync(MOOD_JSON, 'utf8').replace(/^\uFEFF/, ''));
      if (m && m.updatedAt && m.updatedAt !== saved.moodAt) {
        const emo = MOOD_MAP[m.mood] || 'neutral';
        await jpost(`${SHELL}/mood`, { emotion: emo, intensity: Math.min(0.9, Number(m.intensity) || 0.6) });
        saveState({ moodAt: m.updatedAt, lastMood: emo });
        log(`心情 ${m.mood} → ${emo}`);
      }
    } catch {}

    if (snap.idle) return;

    // 2. 决定当前状态
    let kind = null;
    const now = Date.now();
    if (snap.inFlight) {
      if (snap.pendingTool) {
        const name = String(snap.pendingTool.name || '');
        const ran = now - (snap.pendingTool.at || now);
        kind = ran > STALL_MS ? 'stall'
          : /subagent|task|workflow/.test(name) ? 'subagent'
          : /web|search|fetch|research|domain|platform|video|image/.test(name) ? 'web'
          : /^(pwsh|bash|shell)$/.test(name) ? 'shell'
          : /^(write|edit)$/.test(name) ? 'write'
          : /^(read|grep|glob)$/.test(name) ? 'read'
          : 'think';
        if (subagentFresh(main.file.p) && kind === 'think') kind = 'subagent';
      } else {
        kind = 'think';
        if (subagentFresh(main.file.p)) kind = 'subagent';
      }
    } else {
      // 回合刚结束
      if (lastEndSeen === undefined) { lastEndSeen = snap.endSeq; saveState({ lastEndSeq: snap.endSeq }); }
      const fresh = snap.endSeq && snap.endSeq !== saved.lastEndSeq;
      if (fresh) {
        const text = lastAssistantText(main.events, snap.turn);
        const mood = classify(text);
        kind = MOOD_TO_DONE[mood] || 'done_happy';
        saveState({ lastEndSeq: snap.endSeq, lastTurn: snap.turn, inFlightSince: null });
        log(`回合 ${snap.turn} 结束 → ${kind}（${mood || '无语气'}）`);
      } else {
        // 闲着：每 FIDGET_GAP_MS 来一个小动作，别像雕像
        if (now - (saved.fidgetAt || 0) > FIDGET_GAP_MS && now - applied.at > 5000) {
          kind = 'fidget';
          saveState({ fidgetAt: now });
        } else {
          kind = null;   // 保持现状（表情会自己淡回），别每 700ms 重放
        }
      }
    }

    // 同一段思考拖太久 → 插一次「圈圈眼」（想晕了），一个回合一次
    // 注意要 already-in-think：否则首帧 applied.since=0 会立刻误触发
    if (kind === 'think' && applied.kind === 'think' && now - applied.since > THINK_DIZZY_MS && saved.dizzyTurn !== snap.turn) {
      kind = 'dizzy';
      saveState({ dizzyTurn: snap.turn });
      log('思考超时 → 圈圈眼');
    }

    if (!kind) return;

    // 3. 防抽风
    //   a) 连续用工具时，两个 call 之间那零点几秒的「think」不要切——不然就是鬼畜
    const TOOL_KINDS = new Set(['read', 'write', 'shell', 'web', 'subagent']);
    if (kind === 'think' && TOOL_KINDS.has(applied.kind) && now - (snap.lastToolAt || 0) < 3000) return;
    //   b) 新状态先稳定 DEBOUNCE_MS 才切；两次下发之间至少隔 MIN_GAP_MS（done/error/listen 例外）
    const hold = HOLD_KINDS.has(kind);
    const urgent = kind.startsWith('done_') || kind === 'error' || kind === 'listen';
    if (kind !== applied.kind) {
      if (!urgent) {
        if (pending.kind !== kind) { pending = { kind, since: now }; return; }
        if (now - pending.since < DEBOUNCE_MS) return;
        if (now - applied.at < MIN_GAP_MS) return;
      }
    } else {
      pending = { kind: null, since: 0 };
      if (!(hold && now - applied.at > REMIND_MS)) return;
    }

    const isRefresh = kind === applied.kind;
    const pick = isRefresh && applied.plan
      ? { plan: applied.plan, face: applied.face, faceIdx: (saved.lastFace || {})[kind] }
      : pickPlan(kind, (saved.lastFace || {})[kind] ?? -1);
    if (!pick.plan) return;
    if (await applyPlan(pick.plan, !isRefresh)) {
      applied = { kind, at: now, since: isRefresh ? applied.since : now, plan: pick.plan, face: pick.face };
      saveState({ lastKind: kind, lastKindAt: now, lastFace: { ...(saved.lastFace || {}), [kind]: pick.faceIdx ?? -1 } });
      if (!isRefresh) {
        pending = { kind: null, since: 0 };
        log(`状态 → ${kind}${pick.face ? ' · ' + pick.face : ''}`);
      }
    }
  } finally {
    busy = false;
  }
}

if (process.argv.includes('--probe')) {
  // 每个状态的「表情 × 附加」组合都试一遍，看引擎接不接受（参数冲突会返回 400）
  let total = 0, fails = 0;
  for (const kind of Object.keys(RIGS)) {
    for (const { fi, ai, plan } of allCombos(kind)) {
      await jpost(`${STAGE}/api/stop`, {});
      await new Promise((res) => setTimeout(res, 110));
      const r = await jpost(`${STAGE}/api/execute`, { plan, backend: 'web' });
      total++;
      const ok = r.status === 200 || r.status === 201;
      if (!ok) { fails++; console.log(`FAIL ${kind} f${fi}/a${ai} ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`); }
      await new Promise((res) => setTimeout(res, 220));
      await jpost(`${STAGE}/api/stop`, {});
      await new Promise((res) => setTimeout(res, 110));
    }
  }
  console.log(`[probe] ${total - fails}/${total} OK`);
  process.exit(fails ? 1 : 0);
}

tick().catch((e) => log('tick 异常 ' + e.message));
setInterval(() => { tick().catch((e) => log('tick 异常 ' + e.message)); }, TICK_MS);
