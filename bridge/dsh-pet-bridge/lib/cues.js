// 桌宠指令解析器：把一句话里的方括号指令拆成「气泡台词 + 舞台动作」。
//
// 会话里写：[脸红] 主人回来啦
// 桥里得到：{ text: '主人回来啦', moves: [{kind:'expression', name:'脸红', ...}] }
// 外壳 /say 收到 moves 后跟口型同帧下发，一次计划演完，不会互相打断。
//
// 设计原则
//   1. 认不出来的方括号原样留在台词里，绝不吞字（[图片]、[链接] 这类照常显示）
//   2. 只认白名单：24 个表情 / 15 个情绪 / 3 个手势 / 9 种动作 / 33 个语义参数
//   3. 越界一律夹紧到合法范围，不报错打断，但记一条 notes 给日志看
//   4. 时间轴用 [at:秒] 推游标，默认全部 at=0 同帧并发（说话时点头+歪头是并行的）
import { readFileSync } from 'node:fs';

// ── 白名单 ─────────────────────────────────────────────
export const EXPRESSIONS = [
  '体型1', '体型2', '体型默认', '兔牙', '前倾', '加载', '单片眼镜', '圈圈眼', '尾巴切换', '屑屑眼',
  '流冷汗', '流泪', '爱心眼', '眯眼', '胸衣', '脸红', '裙子切换', '钢盆', '鞋子', '食指伸出',
  '食指收起', '黑框眼镜', '黑脸', '＞＜',
];

export const EMOTIONS = [
  'happy', 'shy', 'excited', 'thinking', 'sleepy', 'proud', 'sad', 'annoyed', 'surprised',
  'greeting', 'playful', 'neutral', 'flustered', 'confused', 'pout',
];

export const GESTURES = ['hand_on_chest', 'point', 'grass'];

export const LOOK_DIRECTIONS = ['left', 'right', 'up', 'down', 'center'];
export const TILT_DIRECTIONS = ['left', 'right'];
export const BLINK_SIDES = ['both', 'left', 'right'];

// 语义输入参数与合法区间，抄自舞台 /api/capabilities
const PARAM_RANGE = {
  AngleX: [-30, 30], AngleY: [-30, 30], AngleZ: [-30, 30],
  PositionX: [-30, 30], PositionY: [-30, 30], PositionZ: [-30, 30],
  LeanInput: [-30, 30],
  ParamEyeBallX: [-1, 1], ParamEyeBallY: [-1, 1],
  ParamEyeLOpen: [0, 1.5], ParamEyeROpen: [0, 1.5],
  ParamMouthForm: [-1, 1], ParamMouthOpenY: [0, 1],
  EyeSmile: [-1, 1], MouthSmile_L: [0, 1], MouthSmile_R: [0, 1],
  ParamBrowLY: [-1, 1], ParamBrowRY: [-1, 1], BrowInnerUp: [0, 1],
  CheeckPuff: [0, 1], JawOpen: [0, 1], ParamBreath: [0, 1],
  Mouthpucker: [0, 1], MouthFunnel: [0, 1], MouthX: [-1, 1],
  MouthPressLipOpen: [-1, 1], MouthPuckerWiden: [-1, 1],
  REyeSquint: [0, 1], LEyeSquint: [0, 1], TongueOut: [0, 1], NoseNeer: [0, 1],
  MouthRollUpper: [0, 1], MouthRollLower: [0, 1],
};

const MAX_ACTIONS = 24;        // 舞台 plan 上限
const MAX_PLAN_SECONDS = 60;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toNum = (v, dflt) => (Number.isFinite(Number(v)) ? Number(v) : dflt);

// 每种动作会占用哪些语义参数。舞台不允许两条动作同时驱动同一个参数
// （实测：[look:down] 和 [nod:2] 同时 → 400「动作 3 与 4 同时控制 AngleY」）。
// 所以这里先算占用，撞了就自动把后一条往后挪，语义变成「先看一眼再点头」。
const PARAM_OF = {
  look: ['AngleX', 'AngleY'],
  nod: ['AngleY'],
  shake_head: ['AngleX'],
  tilt: ['AngleZ'],
  smile: ['EyeSmile', 'MouthSmile_L', 'MouthSmile_R'],
  blink: ['ParamEyeLOpen', 'ParamEyeROpen'],
  talk: ['ParamMouthOpenY'],
};

function paramsOf(a) {
  if (a.kind === 'pose') return Object.keys(a.values || {});
  if (a.kind === 'trajectory') {
    const s = new Set();
    for (const f of a.frames || []) for (const k of Object.keys(f.values || {})) s.add(k);
    return [...s];
  }
  if (a.kind === 'expression' || a.kind === 'gesture') return [];   // 独占层 / 关节，交给舞台自己管
  return PARAM_OF[a.kind] || [];
}

// 同名动作的中文别名，让她写得顺手
const ALIASES = {
  表情: 'expr', 神情: 'expr',
  看: 'look', 视线: 'look',
  点头: 'nod', 摇头: 'shake', 歪头: 'tilt', 眨眼: 'blink', 微笑: 'smile', 说话: 'talk',
  手势: 'gesture', 姿态: 'pose', 情绪: 'emotion', 时间: 'at', 保持: 'hold',
};

function normVerb(v) {
  const k = String(v || '').toLowerCase().trim();
  return ALIASES[k] || k;
}

// 明确是指令的动词：写错参数时整条吃掉并记一笔，免得气泡里冒出 [emotion:unknown] 这种半截标记
const KNOWN_VERBS = new Set([
  'emotion', 'gesture', 'expr', 'look', 'nod', 'shake', 'tilt', 'blink',
  'smile', 'talk', 'pose', 'at', 'hold', 'act',
]);

// 扫描方括号，允许 act:[{...}] 这种嵌套
function scan(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '[') { i++; continue; }
    let depth = 0, j = i;
    for (; j < text.length; j++) {
      if (text[j] === '[') depth++;
      else if (text[j] === ']') { depth--; if (depth === 0) break; }
    }
    if (j >= text.length) break;
    spans.push({ start: i, end: j + 1, inner: text.slice(i + 1, j) });
    i = j + 1;
  }
  return spans;
}

// 解析单个方括号内容，返回 { kind, value } 或 null
function parseOne(raw) {
  const inner = raw.trim();
  if (!inner) return null;

  // 裸表情名：[脸红]
  if (EXPRESSIONS.includes(inner)) return { kind: 'expr', name: inner };

  // 不带参数的动作也要认：[smile] [talk] 以前会原样漏进气泡，因为下面那个正则只认冒号
  const bareVerb = normVerb(inner);
  if (bareVerb === 'smile') return { kind: 'smile', seconds: 1.8 };
  if (bareVerb === 'talk') return { kind: 'talk', seconds: 2.4 };

  const m = inner.match(/^([^:：]+)[:：](.*)$/);
  if (!m) return null;
  const verb = normVerb(m[1]);
  const rest = m[2].trim();
  const parts = rest.split(/[:：]/).map((s) => s.trim());

  switch (verb) {
    case 'emotion': return EMOTIONS.includes(parts[0].toLowerCase()) ? { kind: 'emotion', name: parts[0].toLowerCase() } : null;
    case 'gesture': return GESTURES.includes(parts[0]) ? { kind: 'gesture', name: parts[0], seconds: toNum(parts[1], 2.6) } : null;
    case 'expr': {
      const name = EXPRESSIONS.includes(parts[0]) ? parts[0] : null;
      if (!name) return null;
      return {
        kind: 'expr', name,
        strength: clamp(toNum(parts[1], 1), 0, 1),
        seconds: toNum(parts[2], 2.6),
        layer: parts[3] === 'overlay' ? 'overlay' : 'exclusive',
      };
    }
    case 'look': {
      const d = LOOK_DIRECTIONS.includes(parts[0]?.toLowerCase()) ? parts[0].toLowerCase() : 'center';
      return { kind: 'look', direction: d, seconds: toNum(parts[1], 1.2) };
    }
    case 'nod': {
      // 舞台的硬限制：每次点头至少 0.45 秒，不然 400「重复点头／摇头的时间太短」
      const count = clamp(Math.round(toNum(parts[0], 2)), 1, 4);
      return { kind: 'nod', count, seconds: Math.max(toNum(parts[1], 1.4), count * 0.5) };
    }
    case 'shake': {
      const count = clamp(Math.round(toNum(parts[0], 2)), 1, 4);
      return { kind: 'shake_head', count, seconds: Math.max(toNum(parts[1], 1.6), count * 0.5) };
    }
    case 'tilt': return { kind: 'tilt', direction: parts[0]?.toLowerCase() === 'left' ? 'left' : 'right', seconds: toNum(parts[1], 1.8) };
    case 'blink': {
      // 眨眼同理：次数一多，时长不够就是「眨眼频率过高」
      const side = BLINK_SIDES.includes(parts[0]?.toLowerCase()) ? parts[0].toLowerCase() : 'both';
      const count = clamp(Math.round(toNum(parts[0], 1)), 1, 4);
      return { kind: 'blink', side, count, seconds: Math.max(toNum(parts[1], 0.4), count * 0.35, 0.4) };
    }
    case 'smile': return { kind: 'smile', seconds: toNum(parts[0], 1.8) };
    case 'talk': return { kind: 'talk', seconds: toNum(parts[0], 2.4) };
    case 'pose': {
      const values = {};
      for (const kv of rest.split(/[,，]/)) {
        const [k, v] = kv.split('=').map((s) => (s || '').trim());
        const range = PARAM_RANGE[k];
        if (!range || !Number.isFinite(Number(v))) continue;
        values[k] = clamp(Number(v), range[0], range[1]);
      }
      return Object.keys(values).length ? { kind: 'pose', values, seconds: toNum(parts.find((p) => /^[\d.]+$/.test(p)), 2.2) } : null;
    }
    case 'at': return { kind: 'at', seconds: clamp(toNum(parts[0], 0), 0, MAX_PLAN_SECONDS) };
    case 'hold': {
      // [hold:脸红:6] / [hold:look:down:5] 让某个动作挂久一点
      const secs = toNum(parts[parts.length - 1], 6);
      const sub = parseOne(parts.slice(0, -1).join(':'));
      if (!sub || sub.kind === 'at') return null;
      sub.seconds = secs;
      if (sub.kind === 'expr' && sub.strength == null) sub.strength = 1;
      return sub;
    }
    case 'act': {
      try {
        const j = JSON.parse(rest);
        const list = Array.isArray(j) ? j : [j];
        if (!list.length) return null;
        return { kind: 'act', actions: list };
      } catch { return null; }
    }
    default:
      return null;
  }
}

/**
 * 把一段回复切成「干净台词 + 动作列表」。
 * @param {string} text 原始 assistant 文本
 * @returns {{text:string, emotion:string|null, gesture:string|null, moves:object[], notes:string[]}}
 */
export function parseCues(text) {
  const src = String(text || '');
  const spans = scan(src);
  const notes = [];
  const moves = [];
  let emotion = null;
  let gesture = null;
  let cursor = 0;          // [at:x] 推出来的默认起点
  const keep = [];         // 未被消费的片段（认不出的方括号原样保留）
  const consumed = new Set();

  for (const span of spans) {
    const parsed = parseOne(span.inner);
    if (!parsed) {
      // 看着像指令但参数不合法 → 吃掉并记一笔；普通方括号（[图片] 这种）原样留着
      const mm = span.inner.trim().match(/^([^:：]+)[:：]/);
      if (mm && KNOWN_VERBS.has(normVerb(mm[1]))) {
        consumed.add(span);
        notes.push(`指令没认出来：${span.raw}`);
        continue;
      }
      keep.push(span);
      continue;
    }
    consumed.add(span);

    if (parsed.kind === 'at') { cursor = parsed.seconds; continue; }
    if (parsed.kind === 'emotion') { emotion = parsed.name; continue; }
    if (parsed.kind === 'gesture') {
      // 手势交给 /say 的 gesture 字段：外壳本来就和口型同帧下发，别在 moves 里再来一遍
      gesture = parsed.name;
      continue;
    }
    if (parsed.kind === 'act') {
      for (const a of parsed.actions) {
        if (!a || typeof a !== 'object' || !a.kind) { notes.push('act 里有条动作没有 kind'); continue; }
        moves.push({ ...a, at: clamp(toNum(a.at, cursor), 0, MAX_PLAN_SECONDS) });
      }
      continue;
    }
    if (parsed.kind === 'expr') {
      moves.push({
        kind: 'expression', name: parsed.name, strength: parsed.strength,
        layer: parsed.layer, at: cursor, duration: clamp(toNum(parsed.seconds, 2.6), 0.2, 20),
      });
      continue;
    }
    moves.push({ ...parsed, at: cursor, duration: clamp(toNum(parsed.seconds, 2.2), 0.2, 20), seconds: undefined });
    for (const k of Object.keys(moves[moves.length - 1])) if (moves[moves.length - 1][k] === undefined) delete moves[moves.length - 1][k];
  }

  // 数量和时间上限：超了保留前面
  if (moves.length > MAX_ACTIONS) {
    notes.push(`动作 ${moves.length} 条超过上限 ${MAX_ACTIONS}，多的丢掉了`);
    moves.length = MAX_ACTIONS;
  }

  // 同一参数被两条动作同时驱动，舞台会直接 400。按书写顺序排一遍，
  // 撞上就往后挪到下一条空出来为止（不合并、不改幅度，只错开时间）。
  const booked = [];
  for (const a of moves) {
    const ps = paramsOf(a);
    if (ps.length) {
      let latest = -Infinity;
      for (const p of ps) for (const b of booked) if (b.param === p && b.to > latest) latest = b.to;
      if (latest > Number(a.at || 0)) {
        a.at = +(latest + 0.05).toFixed(2);
        notes.push(`${a.kind} 挪到 ${a.at}s，让前面那个动作先演完`);
      }
      for (const p of ps) booked.push({ param: p, to: Number(a.at || 0) + Number(a.duration || 0) });
    }
  }

  const end = moves.reduce((m, a) => Math.max(m, Number(a.at || 0) + Number(a.duration || 0)), 0);
  if (end > MAX_PLAN_SECONDS) {
    notes.push(`时间轴 ${end.toFixed(1)}s 超过上限，已压到 ${MAX_PLAN_SECONDS}s`);
    for (const a of moves) a.duration = clamp(Number(a.duration || 0.2), 0.2, Math.max(0.2, MAX_PLAN_SECONDS - Number(a.at || 0)));
  }
  moves.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));

  // 重建台词：只挖掉被消费掉的方括号，其余原样
  let out = '';
  let pos = 0;
  for (const span of spans) {
    if (!consumed.has(span)) continue;
    out += src.slice(pos, span.start);
    pos = span.end;
  }
  out += src.slice(pos);
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/^[\s,，、。:：]+/, '').replace(/\s+$/g, '');

  return { text: out, emotion, gesture, moves, notes };
}

// 读舞台能力清单时用，不在热路径
export function capabilitiesFile(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
