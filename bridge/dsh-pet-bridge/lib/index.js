// dsh-pet-bridge — 反向桥：桌面桌宠的「点触事件」→ DSH 会话里的一条用户消息。
//
// 桌宠外壳（whale-pet-shell）在 data/config.json 里配 bridgeUrl = http://127.0.0.1:61944/event，
// 每次主人点她（分区：头发/脑袋/脖子/胸口/腰/裙摆/腿/脚）都会 POST 一条事件过来。
//
// ── 两种模式（config.mode）─────────────────────────────────────────────
// pet（默认） **专用桌宠会话**。第一次点触时建一个固定会话（标题「桌宠互动」），
//             之后所有点触都投给它。主会话完全不参与——主人正在写代码时，
//             上下文里不会凭空多出一条「主人刚刚碰了你的胸口」。
// main        旧行为。投给当前最近活跃的会话（或 /bind 指定的会话），
//             followup 会排在主人当前这一轮之后，等于插进等候区。
//
// 投递通道与 dsh-schedule 的提醒投递同一条：sessionController.resolveAgent → agent.followup → sessions.flush。
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCues } from './cues.js';
import { createPeek } from './peek.js';
import { createMood } from './mood/index.js';

// 自带一件式日志：宿主那边的 console 很少能看到，出问题得能自己留痕
// 默认写 $DSH_HOME/logs/pet-bridge.log；也可以给 WHALE_PET_BRIDGE_LOG 一个绝对路径，留空则不写
const LOG = process.env.WHALE_PET_BRIDGE_LOG
  || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'logs', 'pet-bridge.log') : '');
function log(msg) {
  if (!LOG) return;
  try {
    mkdirSync(join(LOG, '..'), { recursive: true });
    appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}
log('module imported');

export const name = 'pet-bridge';
export const inject = ['sessions', 'sessionController'];

/**
 * 从时间戳数组里数 24 小时内的条数。纯函数，给测试和调试用。
 * 额度的口径只有一处，别在别处再写一遍。
 */
export function countSpeak(logList, at = Date.now()) {
  const since = at - 24 * 3600 * 1000;
  return (Array.isArray(logList) ? logList : []).filter((t) => Number(t) >= since).length;
}

/**
 * 某一档给多少主动额度。0 表示不限。
 * 额度挂在「主动说话浓度」上，不挂在窥屏档位上——
 * 说多少句是「说」的属性，多久看一眼是「看」的属性，两件事不该混。
 */
export function speakCapOf(presets, name) {
  const p = presets && presets[String(name || '')];
  return Math.max(0, Number(p && p.dayCap) || 0);
}

const DEFAULTS = {
  port: 61944,
  mode: 'pet',                 // 'pet' = 专用桌宠会话；'main' = 投主会话（旧行为）
  sessionId: '',               // mode=main 时钉死一个会话；留空就自动跟最近活跃的
  petSessionId: '',            // mode=pet 的固定会话 id；留空自动生成，落盘复用
  petSessionTitle: '桌宠互动',
  // 桌面会话用哪个预设。**默认留空 = 用这个进程的默认预设**，插件不替使用者挑性格：
  // 别人拉下来装的是自己的桌宠，不是作者那只。想让它有独立人设就填自己预设的名字，
  // 通常配成「只有人设、没有工具」的那只，省得桌宠那股劲儿跟写代码混在一起。
  agentPreset: '',
  // 她怎么称呼使用者。留空 = 不称呼，注入的提示词里就不会出现任何称谓。
  // 这个值只影响提示词里那几句前缀，不改任何人设文件。
  address: '',
  fallbackToMain: false,       // 桌宠会话建不起来时，要不要退回投主会话
  echoToPet: true,             // 会话里说完的话回送到桌宠气泡（不然只能在聊天窗里干看着）
  petSayUrl: 'http://127.0.0.1:61943/say',
  petStageUrl: 'http://127.0.0.1:61942',  // 舞台：只有动作没台词时直接砸 plan 用
  // 每条投递前要不要附一段「你现在什么状态」（当前表情、在不在说话、上次说了啥）
  appendState: true,
  echoMaxChars: 180,           // 气泡装不下长篇，超了截断
  echoDelayMs: 900,            // 一轮里可能有好几条 assistant 消息，等最后一条再出气泡
  echoVoice: false,            // true = 气泡同时走 TTS（3~10 秒，会跟点触本地的语音撞车）
  echoVoiceMaxChars: 40,       // 只有这么短的回复才念出声：长句合成慢、还会念到一半就断
  minIntervalMs: 1200,         // 同一部位在这个间隔内只投一次
  maxPerMinute: 24,            // 每分钟最多投递几条，防止连点刷屏
  quiet: false,
  // ---- 窥屏（2026-11-05）----
  // 隔一阵自己瞄一眼前台窗口，主动在桌面上说一句。默认关，用 /peek 或托盘菜单开。
  peek: false,
  peekIntervalMs: 30 * 60 * 1000,   // 老的手动档用；新的是档位（peekPersona）
  peekPersona: '',                  // 空着就用 profile.peekPersona.default，现在是「温和」
  peekQuietFrom: 1,                 // 静默时段（整点小时）：1 点到
  peekQuietTo: 8,                   // 8 点之间都不打扰
  peekMaxLines: 80,                 // OCR 最多收几行，再多都是废话
  peekMaxChars: 300,                // 塞进消息的屏幕文字上限
  peekScale: 2,                     // 截图放大倍数后再 OCR（中文小字 2x 明显更准）
  peekOcrPython: '',                // RapidOCR 的 Python 解释器（venv 里的 python.exe），留空只用系统 OCR
  peekOcrScript: '',                // RapidOCR 的入口脚本 ocr.py，留空同上
  peekTarget: '',                   // 钉死要瞄的窗口（进程名或标题片段），留空就跟任务栏顺序走
  peekTimeoutMs: 20000,             // 探针整轮超时（RapidOCR 冷启动要 5 秒量级），超了就 kill 当这轮跳过
  peekTmpDir: '',                   // 截图 + JSON 的落点，默认 $DSH_HOME/tmp/pet-peek
  // ---- 情绪（2026-11-06）----
  // 是不是会因为你冷落她而真的不高兴。默认关：老用户拉下来行为一个字不变。
  mood: false,
  moodFile: '',                     // 状态文件，默认 $DSH_HOME/pet-mood.json
  moodProfile: '',                  // 外置情绪表（JSON），和默认表合并；改参数不用动代码
  moodGates: false,                 // 闸门：冷战期真的按概率不理人。参数调好之前别开
  moodTickMs: 5 * 60 * 1000,        // 多久结算一次衰减（也顺手把状态落盘）
  // ---- 主动开口（2026-11-06）----
  // 光有情绪还是被动的：生气要等被摸一下才发作。开了这个，情绪够了她自己会把话送到桌面上。
  // 默认关，它真的会打断主人正在干的事，要不要开是使用者的决定，不是插件的。
  moodUrge: false,
  moodUrgeTickMs: 20 * 1000,        // 多久问一次「她想不想开口」。纯计算，20 秒一次也不心疼
  // 整体浓度：quiet / normal / clingy / chatty。主打陪伴的人设成 clingy 就够了，
  // 不用逐档改参数。留空 = 用 profile 里写的那档。
  moodUrgeIntensity: '',
  moodUrgeCooldownMs: 10 * 60 * 1000, // 投递失败后先歇一会儿，别每分钟重试
};

const ZONE_LABEL = {
  hair: '头发', head: '脑袋', neck: '脖子', chest: '胸口',
  waist: '腰', skirt: '裙摆', leg: '腿', foot: '脚', body: '身子',
};

function pickSession(items) {
  for (const it of items || []) {
    if (!it) continue;
    if (it.subagent || it.parentSessionId || it.origin === 'subagent' || it.delegationDepth > 0) continue;
    const id = it.id || it.sessionId || (it.meta && it.meta.id);
    if (id) return id;
  }
  return null;
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  log(`apply called (port=${cfg.port}, mode=${cfg.mode}, hasSessionController=${!!ctx.sessionController}, hasSessions=${!!ctx.sessions})`);
  const statePath = cfg.statePath || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'pet-bridge.json') : '');
  let bound = cfg.sessionId || '';
  let petSid = cfg.petSessionId || '';
  let petReady = false;        // 本进程里已经确认这个会话能投（create 幂等，但别每次点都问一遍）
  let petPresetReal = '';      // create() 真正用的预设：和配置不一致 = 这个进程里没有那个预设
  let petCreating = null;
  let lastAt = 0;
  let lastZone = '';
  let zoneCount = 0;
  let windowStart = Date.now();
  let windowCount = 0;
  const recent = [];
  let peekOn = cfg.peek === true || cfg.peek === 'on';
  // 主动开口的浓度。配置里给了就用配置的，否则沿用上一次拨到的那档（跨重启记得）
  let urgeIntensity = cfg.moodUrgeIntensity || '';
  // 窥屏基准间隔。同样可以运行时改，改完落盘。
  // 现在主入口是档位（peekPersona），这个值只在手动档和老配置里用得上。
  let peekIntervalMs = Number(cfg.peekIntervalMs) || 30 * 60 * 1000;
  // 窥屏档位：拨的是性子，不是分钟数。空着就用 profile 里的默认档
  let peekPersona = String(cfg.peekPersona || '');

  if (statePath) {
    try {
      const st = JSON.parse(readFileSync(statePath, 'utf8'));
      if (!bound && st.sessionId) bound = st.sessionId;
      if (!petSid && st.petSessionId) petSid = st.petSessionId;
      if (typeof st.peekOn === 'boolean') peekOn = st.peekOn;   // 开关要跨重启记住
      if (Number(st.peekIntervalMs) > 0) peekIntervalMs = Number(st.peekIntervalMs);
      if (`${st.peekPersona || ''}`) peekPersona = String(st.peekPersona);
      if (!urgeIntensity && st.urgeIntensity) urgeIntensity = st.urgeIntensity;
    } catch {}
  }
  function persist() {
    if (!statePath) return;
    try { writeFileSync(statePath, JSON.stringify({ sessionId: bound, petSessionId: petSid, peekOn, peekIntervalMs, peekPersona, urgeIntensity, at: new Date().toISOString() }, null, 1)); } catch {}
  }

  // ---- 情绪（2026-11-06）----
  // 只在这里建一次。默认关着，关着的时候 mood 是 null，下面每处都靠这个判断短路，
  // 老用户拉下来行为和以前完全一样。
  const mood = cfg.mood === true || cfg.mood === 'on'
    ? createMood({
        file: cfg.moodFile || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'pet-mood.json') : ''),
        profileFile: cfg.moodProfile || '',
        urgeIntensity,
        log,
      })
    : null;
  let moodTimer = null;

  // ---- 主会话（mode=main 才用）----
  async function currentSession() {
    let listed = null;
    try {
      const res = await ctx.sessionController.list({});
      listed = pickSession(res && res.items);
    } catch (e) {
      ctx.logger?.warn?.('pet-bridge: list failed: ' + e.message);
    }
    if (listed && listed !== bound) { bound = listed; persist(); }
    return bound;
  }

  // ---- 专用桌宠会话（mode=pet）----
  // create() 的语义是「建一个或幂等收养一个」：同一个 id 重复调用就是找回原会话，
  // 所以这里可以放心地在每次启动后第一次点触时再建，不用记「建过没有」。
  //
  // 但归档过的会话也被「收养」得回来：create() 不报错，followup 也照样 accept，
  // 而那个会话根本不会再跑一轮 → 桌宠一声不响。所以用之前必须先确认它没被归档。
  function archivedIds() {
    try {
      const ids = ctx.workspaceRegistry && ctx.workspaceRegistry.archivedSessionIds;
      if (Array.isArray(ids)) return ids;
    } catch {}
    try {
      const p = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'storages', 'workspace.json') : '';
      if (!p) return null;
      const st = JSON.parse(readFileSync(p, 'utf8'));
      const ids = st && st.global && st.global.archivedSessionIds;
      return Array.isArray(ids) ? ids : null;
    } catch { return null; }
  }
  function isArchived(sid) {
    if (!sid) return false;
    const ids = archivedIds();
    return Array.isArray(ids) && ids.includes(sid);
  }

  async function ensurePetSession(forceNew = false, retried = false) {
    if (petSid && isArchived(petSid)) {
      log('pet session is archived, minting a new one: ' + petSid);
      petSid = ''; petReady = false; persist();
    }
    if (petSid && petReady && !forceNew) return petSid;
    if (!petCreating) {
      petCreating = (async () => {
        if (typeof ctx.sessionController.create !== 'function') throw new Error('sessionController.create 不可用');
        const wanted = forceNew || !petSid ? randomUUID() : petSid;
        const created = await ctx.sessionController.create({ sessionId: wanted, agentPreset: cfg.agentPreset || undefined });
        const sid = (created && created.sessionId) || wanted;
        if (isArchived(sid)) throw new Error('adopted session is archived: ' + sid);
        petSid = sid; petReady = true; persist();
        // create 会照实返回它采用的预设；和配置不符 = 这个进程没加载那个预设（patch 要重启才生效）
        petPresetReal = (created && created.agentPreset) || cfg.agentPreset || '';
        log(`pet session ready: ${sid} preset=${petPresetReal || '-'}`);
        if (cfg.agentPreset && petPresetReal && petPresetReal !== cfg.agentPreset) {
          log(`警告：会话预设是 ${petPresetReal}，配置要的是 ${cfg.agentPreset}（这个预设没在这个进程里注册？）`);
        }
        // 会话列表里能一眼认出来；改名失败不影响投递
        try { await ctx.sessionController.rename({ sessionId: sid, title: cfg.petSessionTitle }); } catch (e) { log('rename failed: ' + e.message); }
        return sid;
      })().finally(() => { petCreating = null; });
    }
    try {
      return await petCreating;
    } catch (e) {
      // 旧 id 收养不上（被归档/删了）：换一个新 id 再试一次
      if (!retried && petSid) {
        log('pet session unusable, minting a new one: ' + e.message);
        petSid = ''; petReady = false; persist();
        return ensurePetSession(true, true);
      }
      petReady = false;
      throw e;
    }
  }

  // ---- 回流：会话里说的话 → 桌宠气泡 ----
  // 没有这一段，点触的结果只会躺在那个会话窗口里，主人在桌面上什么都看不到。
  // 做法：投完消息后等这一轮跑完（agent.whenIdle），再从会话里读**本轮新增的** assistant 消息。
  // 早先试过监听 ctx.on('session/event') 的 assistant/message，实测一条都没触发（日志里 4 次点触 0 次回流），
  // 所以不再依赖事件派发，直接读 session.deriveMessages()。
  let echoLastAt = 0;

  function bubbleText(blocks) {
    let t = (blocks || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
    t = t
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')        // 贴纸 / 图片
      .replace(/```[\s\S]*?```/g, '')               // 代码块
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')            // 粗体
      .replace(/~~([^~]+)~~/g, '$1')                // 删除线
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')    // 斜体
      .replace(/^\s{0,3}[>#]+\s*/gm, '')            // 标题 / 引用记号
      .replace(/^\s*[-*+]\s+/gm, '')                // 列表记号
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')      // 链接只留文字
      .replace(/^\s*---+\s*$/gm, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return t;
  }

  // 一轮可能有好几条 assistant 消息（边说边调工具）：只用最后一条，
  // 前面的多是「我先看看」这类过程话，拼起来气泡会变成刷屏。
  // 台词里的方括号指令交给 cues.js：认得的编译成舞台动作并从台词里剥掉，
  // 认不得的原样留在气泡里（[图片] 这种照旧显示），绝不吞字。
  let lastCue = null;   // /health 能看最近一次解析了什么

  function replyTextOf(blocksList) {
    const texts = blocksList.map((bl) => bubbleText(bl)).filter(Boolean);
    if (!texts.length) return { text: '', emotion: null, gesture: null, moves: [], notes: [] };
    const parsed = parseCues(texts[texts.length - 1]);
    let t = parsed.text;
    const notes = parsed.notes.slice();
    if (t.length > cfg.echoMaxChars) {
      t = t.slice(0, Math.max(1, cfg.echoMaxChars - 1)).trimEnd() + '…';
      notes.push(`台词超过 ${cfg.echoMaxChars} 字，已截断`);
    }
    lastCue = {
      at: new Date().toISOString(),
      text: t,
      emotion: parsed.emotion,
      gesture: parsed.gesture,
      moves: parsed.moves.map((m) => m.kind),
      notes,
    };
    return { text: t, emotion: parsed.emotion, gesture: parsed.gesture, moves: parsed.moves, notes };
  }

  // 没有台词只有动作时，直接丢给舞台演（气泡那边不需要出东西）
  async function actOnStage(moves) {
    const plan = { version: 1, title: 'cue · 纯动作', intent: 'cue', summary: 'cue', actions: moves };
    const res = await fetch(`${cfg.petStageUrl}/api/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan, backend: 'web' }),
      signal: AbortSignal.timeout(6000),
    }).catch(() => null);
    if (!res || !res.ok) throw new Error('stage HTTP ' + (res ? res.status : 'n/a'));
    return true;
  }

  async function sayOnPet(text, cues = {}) {
    const ms = Math.min(24000, Math.max(3000, 1800 + text.length * 140));   // 口型时长跟着字数走
    const body = { text, ms };
    if (cues.emotion) body.emotion = cues.emotion;     // 让这句话配着脸，不只是字幕
    if (cues.gesture) body.gesture = cues.gesture;
    // 指令解析出来的动作跟着 /say 一起走，外壳会和口型编进同一条计划，不会互相打断
    if (Array.isArray(cues.moves) && cues.moves.length) body.moves = cues.moves;
    // 短回复念出来：early 让壳子先把气泡放出来，合成完再补声音，别让人干等三秒。
    // 超过 echoVoiceMaxChars 的只出文字——合成慢，而且一口气念长了不好听。
    const cap = Number(cfg.echoVoiceMaxChars) || 40;
    if (cfg.echoVoice && text.length <= cap) { body.voice = true; body.early = true; }
    const res = await fetch(cfg.petSayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('say HTTP ' + res.status);
    return true;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function assistantMessages(session) {
    try {
      const msgs = typeof session.deriveMessages === 'function' ? session.deriveMessages() : [];
      return (msgs || []).filter((m) => m && m.role === 'assistant');
    } catch (e) {
      log('deriveMessages failed: ' + e.message);
      return [];
    }
  }

  // 投完就挂一个「等这轮结束再出气泡」的尾巴，不阻塞投递本身
  function scheduleEcho(agent, seenIds) {
    if (!cfg.echoToPet) return;
    (async () => {
      const started = Date.now();
      while (agent.status === 'idle' && Date.now() - started < 8000) await sleep(120);   // 等驱动真的起来
      try {
        if (typeof agent.whenIdle === 'function') await agent.whenIdle();
      } catch {}
      const fresh = assistantMessages(agent.session).filter((m) => !seenIds.has(m.id));
      if (!fresh.length) { log('echo: idle but no new assistant message'); return; }
      const reply = replyTextOf(fresh.map((m) => m.content));
      if (!reply.text && !reply.moves.length) { log('echo: assistant message had no text'); return; }
      const wait = cfg.echoDelayMs || 0;
      const gap = Date.now() - echoLastAt;
      if (gap < wait) await sleep(wait - gap);   // 连着两轮时别把气泡叠在一起
      echoLastAt = Date.now();
      try {
        if (reply.text) await sayOnPet(reply.text, reply);
        else await actOnStage(reply.moves);
        log(`echoed to pet (${reply.text.length} chars, moves=${reply.moves.length}`
          + `${reply.emotion ? ', ' + reply.emotion : ''}${reply.gesture ? ', ' + reply.gesture : ''}`
          + `${reply.notes.length ? '，注意：' + reply.notes.join('；') : ''})`);
      } catch (e) {
        log('echo to pet failed: ' + e.message);
      }
    })().catch((e) => log('echo pipeline failed: ' + e.message));
  }

  if (cfg.echoToPet) log('echo to pet enabled -> ' + cfg.petSayUrl);

  // ---- 投递 ----
  // 桌面会话的口径（2026-11-02 主人要的）：话要短、别排版。
  // 2026-11-03 把字数从 20~40 压到 5~20：要念出来，长句合成太慢。
  // 2026-11-04 动作语法搬进 persona\PET-STAGE.md（桌宠预设里的控制卡），
  //            这里只留一句提醒——每条消息都附全量手册太贵了。
  const PET_HINT = '\n（桌面上：一句 5～20 字。身体用方括号指令，像 [脸红] [nod:2] [look:down]，'
    + '桥会执行并从气泡里摘掉，完整写法见你的控制卡。）';

  // 每轮附一句「你现在什么状态」，省得她重复做同一个动作、也不知道自己刚才说过什么
  async function petStateLine() {
    if (!cfg.appendState) return '';
    const bits = [];
    try {
      const base = String(cfg.petSayUrl).replace(/\/say\/?$/, '');
      if (base !== String(cfg.petSayUrl)) {
        const s = await fetch(`${base}/status`, { signal: AbortSignal.timeout(600) })
          .then((r) => r.json()).catch(() => null);
        if (s) {
          if (s.voicing) bits.push('正在出声');
          const last = s.lastSay && s.lastSay.text ? String(s.lastSay.text) : '';
          if (last) bits.push(`刚说「${last.slice(0, 14)}${last.length > 14 ? '…' : ''}」`);
        }
      }
    } catch {}
    if (lastCue && lastCue.moves.length && Date.now() - Date.parse(lastCue.at) < 180000) {
      bits.push(`上一次动了 ${lastCue.moves.join('+')}`);
    }
    return bits.length ? `（你现在：${bits.join('，')}。）` : '';
  }

  async function deliverTo(sid, text, echo = false) {
    if (!sid) throw new Error('no session to wake');
    const resolved = await ctx.sessionController.resolveAgent(sid);
    if (!resolved || resolved.error) throw new Error('resolveAgent: ' + JSON.stringify((resolved && resolved.error) || null));
    const agent = resolved.agent;
    if (!agent || typeof agent.followup !== 'function') throw new Error('agent has no followup');
    // 先把「发之前已有的回复」记下来，等这轮跑完只有新增的才算本轮的回应
    const seen = echo ? new Set(assistantMessages(agent.session).map((m) => m.id)) : null;
    const message = {
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    };
    agent.followup(message);
    const flushed = await ctx.sessions.flush(agent.session);
    if (echo) scheduleEcho(agent, seen);
    return { sessionId: sid, flushed: !!flushed };
  }

  // ── 主动说话的额度（2026-11-07）──────────────────────────────────────
  // 窥屏和主动开口共用一份，额度由窥屏档位决定。
  //
  // 之前两条管道各算各的：窥屏投递不计入 urge 的 today，档位调成「黏人」以后
  // 几分钟就说一句，十几分钟就把 urge 那 8 句吃光，日上限形同虚设。
  // 主人 2026-11-07 看出来了。合过来之后「她盯得多紧」这一个档位同时管手感。
  //
  // 只记内存，重启清零：这不是计费，是防刷屏，重启几次也不会变成一百句。
  const speakLog = [];
  const SPEAK_KEEP = 200;

  /** 24 小时内主动说过几句。 */
  function speakToday(at = Date.now()) {
    return countSpeak(speakLog, at);
  }

  /** 现在这一档给多少额度。0 或没配置就是不限。 */
  function speakCap() {
    try {
      const u = mood && mood.profile && mood.profile.urge;
      if (!u) return 0;
      return speakCapOf(u.presets, u.intensity || 'normal');
    } catch { return 0; }
  }

  async function deliver(text, opts = {}) {
    // 主动开口（窥屏、urge）先过额度。点触回复不算：主人摸她，她必须理。
    if (opts.proactive) {
      const cap = speakCap();
      if (cap > 0 && speakToday() >= cap) {
        log(`speak budget used up (${speakToday()}/${cap})，这次不说了`);
        return { ok: false, skipped: 'budget', cap, today: speakToday() };
      }
    }
    const markSpoke = () => {
      if (!opts.proactive) return;
      speakLog.push(Date.now());
      while (speakLog.length > SPEAK_KEEP) speakLog.shift();
    };

    if (cfg.mode === 'pet') {
      try {
        const sid = await ensurePetSession();
        // 情绪卡只在桌宠会话里拼。main 模式是把点触投进主人正在写代码的那个会话，
        // 往里塞一句「你现在有点不痛快」既污染上下文，也让她在干活时突然演情绪。
        // 平静时 cue() 返回空串，不占 token。
        const extra = PET_HINT + (mood ? safeCue(opts) : '') + (await petStateLine().catch(() => ''));
        const r = await deliverTo(sid, text + extra, true);   // 只有投桌宠会话才回气泡
        markSpoke();
        return { ...r, target: 'pet' };
      } catch (e) {
        petReady = false;   // 下一次点触重新建
        if (!cfg.fallbackToMain) throw e;
        log('pet session unavailable, falling back to main: ' + e.message);
      }
    }
    const sid = await currentSession();
    const r = await deliverTo(sid, text);
    markSpoke();
    return { ...r, target: 'main' };
  }

  /** 取情绪卡。任何异常都吞掉：情绪是附加的，不该让投递失败。 */
  function safeCue(opts = {}) {
    try {
      return mood.cue(Date.now(), opts);
    } catch (e) {
      log('mood cue failed: ' + e.message);
      return '';
    }
  }

  /** 使用者怎么称呼自己。空 = 不称呼，别替别人的人设定规矩。 */
  function address() {
    return String(cfg.address || '').trim();
  }

  function describe(ev) {
    const label = ZONE_LABEL[ev.zone] || ev.zone || '身子';
    const where = (ev.nx != null && ev.ny != null) ? `（位置 ${ev.nx}, ${ev.ny}）` : '';
    const nth = zoneCount >= 2 ? `，第 ${zoneCount} 下` : '';
    const who = address();
    // 没配称呼就写「有人」：句子照样通顺，也不用凭空给使用者安一个身份。
    const hit = who ? `${who}刚刚碰了你的${label}` : `刚刚有人碰了你的${label}`;
    return `（桌宠｜${hit}${nth}${where}）`;
  }

  function shouldWake(ev) {
    const now = Date.now();
    if (now - windowStart > 60000) { windowStart = now; windowCount = 0; }
    if (windowCount >= cfg.maxPerMinute) return 'rate-limited';
    if (ev.zone === lastZone && now - lastAt < cfg.minIntervalMs) { zoneCount++; return 'merged'; }
    zoneCount = 1;
    return 'ok';
  }

  function send(res, code, obj) {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    } catch {}
  }

  // ---- 窥屏（2026-11-05）----
  // 定时瞄前台窗口 → OCR → 当成一条「事件」投给桌宠会话（跟她主动搭话一个管道）。
  // 开关状态落 pet-bridge.json，重启也记得。
  const peek = createPeek({
    cfg: {
      ...cfg,
      peek: peekOn,
      peekIntervalMs,
      // 档位名和档位表分开传：一个是「现在是什么性子」，一个是「有哪些性子可选」
      peekPersona,
      peekPersonaTable: cfg.peekPersonaTable || (mood && mood.profile && mood.profile.peekPersona) || null,
    },
    log,
    deliver,
    // 窥屏看到了什么 → 给情绪记一笔。看见了在忙还是摸鱼，是两回事。
    onScene: (p) => { if (mood) { try { mood.peekScene(p); } catch (e) { log('mood scene failed: ' + e.message); } } },
    // 全屏打完了 → 记一条此刻。全屏期间重探针是瞎的，轻探针是唯一知道那阵多长的。
    onGameEnd: (g) => {
      if (!mood) return;
      try { mood.scene({ category: 'game-over', label: g.title || g.proc || '', minutes: g.minutes }); }
      catch (e) { log('mood game-end failed: ' + e.message); }
    },
    // 看到感兴趣的东西 → 记一条「想看看」的此刻。词表在 profile.interest 里，改词不动代码。
    onInterest: (w, title) => {
      if (!mood) return;
      try { mood.scene({ category: 'interest', label: title || '', interest: w.id, interestLabel: w.label || w.id }); }
      catch (e) { log('mood interest failed: ' + e.message); }
    },
    // 兴趣词表跟着 profile 走：加一个词只改 profile，不用碰 peek。
    // 配置里给了 interestWords 就用配置的，方便单独调这一块。
    interestWords: cfg.interestWords || (mood && mood.profile && mood.profile.interest) || null,
    // 主动程度跟着情绪走：冷战降频，黏人时加倍。mood 关着就是恒等 1。
    intervalFactor: () => (mood ? (mood.gate('proactive').intervalFactor || 1) : 1),
    onStateChange: (s) => {
      peekOn = peek.on;
      if (s && s.persona) peekPersona = String(s.persona);
      if (s && Number(s.manualMs) > 0) peekIntervalMs = Number(s.manualMs);
      persist();
    },
  });

  // ---- 主动开口（2026-11-06）----
  // 情绪够了她自己开口，不等主人来碰。跟窥屏走同一条投递管道（deliver → followup），
  // 谁也不认识谁：urge 只管「该不该说」，peek 只管「看见什么」，两条都能单独关掉。
  //
  // 判断全是纯计算，一分钟问一次也不心疼；真正花钱的是 speak 之后那一轮会话。
  let urgeTimer = null;
  let urgeBusy = false;
  let urgeBackoffUntil = 0;
  let lastUrgeNote = '';

  function urgePrompt(d) {
    const mins = Math.max(1, Math.round(d.idleMin));
    const nth = d.attempt + 1;
    const inBurst = (Number(d.step) || 0) > 0;
    const who = address();
    // 有称呼就用称呼，没有就说「没有人」——两种都不缺主语的别扭感。
    const opener = who ? `这次不是${who}叫你` : '这次没有人叫你';
    return `（桌宠｜${opener}，是你自己想开口。`
      + `${d.hint}`
      // 此刻层带来的具体事实：「你打了四十分钟游戏」这种，模型自己猜不出来
      + (d.detail ? `你知道的情况：${d.detail}。` : '')
      + (inBurst
        // 一阵里的第二、三句：不提醒的话模型容易一次把想说的全说完，后面就空了
        ? `这是这一阵的第 ${d.step + 1} 句。只说你这一句，别把后面想说的都一次说完。`
        : `离上次有人跟你说上话已经 ${mins} 分钟了，这是你今天第 ${nth} 次自己搭话。`)
      + '说完就等着，别连发。）';
  }

  async function urgeStep(reason = 'timer') {
    if (!mood || !cfg.moodUrge) return { ok: false, why: 'off' };
    if (urgeBusy) return { ok: false, why: 'busy' };
    if (cfg.quiet) return { ok: false, why: 'quiet' };
    if (urgeBackoffUntil && Date.now() < urgeBackoffUntil) return { ok: false, why: 'backoff' };
    // 窥屏刚替她说过话就别再补一句：两条管道汇到同一个气泡，会像复读。
    // 只挡「新开一阵」，一阵里接着说的那几句要放行，不然连怼就断了。
    const lastPeek = Date.parse((peek.state() || {}).lastAt || '') || 0;
    const inBurst = !!(mood.state().urge || {}).burst;

    let d;
    try {
      d = mood.urge();
    } catch (e) {
      log('urge decide failed: ' + e.message);
      return { ok: false, why: 'error' };
    }
    if (!d.speak) { lastUrgeNote = '不想开口（' + d.why + '）'; return { ok: true, spoke: false, why: d.why }; }
    if (!inBurst && lastPeek && Date.now() - lastPeek < 10 * 60 * 1000) {
      return { ok: false, why: 'just-spoke' };
    }

    urgeBusy = true;
    try {
      // 主动开口自己已经把「此刻」那条事实写进提示词了，情绪卡别再重复一遍。
      // proactive 让它跟窥屏共用同一份日额度。
      const r = await deliver(urgePrompt(d), { skipMoment: true, proactive: true });
      // 投递成功才记账：失败一次还想再试一次，不该直接扣掉她一次机会
      mood.markUrge(d);
      const where = d.steps > 1 ? `${d.window} 第${d.step + 1}/${d.steps}句` : d.window;
      lastUrgeNote = `开口 ${where}`;
      log(`urge spoke window=${d.window} step=${d.step + 1}/${d.steps} tier=${d.tier} `
        + `idle=${Math.round(d.idleMin)}min preset=${d.preset} heat=${d.heat} via=${reason} target=${r.target}`);
      return {
        ok: true, spoke: true, window: d.window, step: d.step, steps: d.steps,
        tier: d.tier, idleMin: Math.round(d.idleMin), target: r.target,
      };
    } catch (e) {
      urgeBackoffUntil = Date.now() + Math.max(60000, Number(cfg.moodUrgeCooldownMs) || 600000);
      lastUrgeNote = '开口失败：' + e.message;
      log('urge deliver failed: ' + e.message);
      return { ok: false, why: e.message };
    } finally {
      urgeBusy = false;
    }
  }

  const server = createServer((req, res) => {
    const url = new URL('http://x' + (req.url || '/'));
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        ok: true, port: cfg.port, mode: cfg.mode,
        sessionId: bound, petSessionId: petSid, petSessionTitle: cfg.petSessionTitle,
        petPreset: petPresetReal || cfg.agentPreset || '',
        petPresetWanted: cfg.agentPreset || '',
        petArchived: isArchived(petSid),
        echo: { on: !!cfg.echoToPet, url: cfg.petSayUrl, voice: !!cfg.echoVoice, maxChars: cfg.echoMaxChars },
        peek: peek.state(),
        mood: mood ? mood.state().summary : 'off',
        urge: { on: !!(mood && cfg.moodUrge), last: lastUrgeNote },
        lastCue,
        recent: recent.slice(-10),
      });
    }
    if (req.method === 'GET' && url.pathname === '/peek') {
      return send(res, 200, { ok: true, ...peek.state() });
    }
    if (req.method === 'GET' && url.pathname === '/recent') {
      return send(res, 200, { ok: true, items: recent.slice(-30) });
    }
    // 她现在什么心情。默认关着的时候返回 enabled:false，不是 404 —— 前端不用分两种错误处理。
    if (req.method === 'GET' && url.pathname === '/mood') {
      return send(res, 200, { ok: true, enabled: !!mood, ...(mood ? mood.state() : {}) });
    }
    if (req.method !== 'POST') return send(res, 404, { ok: false, error: 'not found' });

    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, error: 'bad json' }); }

      // 手动钉主会话（mode=main 时有用）
      if (url.pathname === '/bind') {
        const id = String(body.sessionId || '').trim();
        if (!id) return send(res, 400, { ok: false, error: 'sessionId required' });
        bound = id; persist();
        return send(res, 200, { ok: true, sessionId: bound });
      }
      // 桌宠会话被聊脏了 / 想换新的：下一次点触重建一个
      if (url.pathname === '/reset-pet-session') {
        petSid = ''; persist();
        return send(res, 200, { ok: true, petSessionId: '', note: 'next touch creates a new pet session' });
      }
      // 窥屏开关 / 档位 / 立刻试一次（放在 quiet 之前：静默是点触的事，不该挡住窥屏的控制）
      if (url.pathname === '/peek') {
        if (typeof body.on === 'boolean') peek.setOn(body.on);
        // {"persona":"yandere"} = 换性子。这是主入口，托盘拨的就是它。
        if (body.persona) {
          const r = peek.setPersona(body.persona);
          if (!r.ok) return send(res, 400, { ok: false, ...r });
          peekPersona = r.persona;
          persist();
          return send(res, 200, { ok: true, ...r, ...peek.state() });
        }
        // 老接口：直接给分钟数。会切到手动档，档位显示成「手动」。
        if (body.intervalMs != null || body.minutes != null) {
          const ms = body.minutes != null ? Number(body.minutes) * 60000 : Number(body.intervalMs);
          const applied = peek.setIntervalMs(ms);
          peekIntervalMs = applied;
          peekPersona = 'manual';
          persist();
          return send(res, 200, { ok: true, intervalMs: applied, persona: 'manual', ...peek.state() });
        }
        if (body.now) {
          const r = await peek.run('manual').catch((e) => ({ ok: false, error: e.message }));
          return send(res, 200, { ok: true, result: r, state: peek.state() });
        }
        return send(res, 200, { ok: true, ...peek.state() });
      }
      // 情绪：三个会改账本的动作，参数改了要重启，避免线上参数漂移
      if (url.pathname === '/mood') {
        if (!mood) return send(res, 200, { ok: true, enabled: false, note: 'mood 没开，配置里把 mood 设成 true' });
        // {"calm":true} = 哄好她。只清负面，亲近和好心情留着。托盘默认用这个
        if (body.calm) {
          const r = mood.calm();
          return send(res, 200, { ok: true, ...mood.state(), calm: true, cleared: r.cleared, note: '已经哄好了' });
        }
        // {"reset":true} = 彻底重来。整本清空，清之前自动存一份备份
        if (body.reset) {
          const r = mood.resetAll();
          return send(res, 200, { ok: true, ...mood.state(), reset: true, backup: r.backup || '', note: '账本清空了，旧的在备份里' });
        }
        // {"restore":true} = 从备份恢复
        if (body.restore) {
          const r = mood.restoreBackup();
          if (!r.ok) return send(res, 400, { ok: false, error: r.error, ...mood.state() });
          return send(res, 200, { ok: true, ...mood.state(), restore: true, note: '恢复了' });
        }
        if (body.scene) {
          try { mood.scene(body.scene); } catch (e) { return send(res, 500, { ok: false, error: e.message }); }
        }
        // {"urge":true} = 立刻问她一句想不想开口（调试用，不改变任何记账）
        // 结果放 urgeResult：urge 这个键是状态摘要，别被动作结果顶掉
        if (body.urge) {
          const r = await urgeStep('manual').catch((e) => ({ ok: false, error: e.message }));
          return send(res, 200, { ok: true, urgeResult: r, ...mood.state() });
        }
        // {"intensity":"clingy"} = 换主动开口的浓度。随手拨，不用重启
        if (body.intensity) {
          const r = mood.setIntensity(body.intensity);
          if (!r.ok) return send(res, 400, { ok: false, ...r });
          urgeIntensity = r.intensity;
          persist();
          log('mood urge intensity -> ' + r.intensity);
          return send(res, 200, { ok: true, ...r, ...mood.state() });
        }
        return send(res, 200, { ok: true, enabled: true, ...mood.state() });
      }
      if (cfg.quiet) return send(res, 200, { ok: true, skipped: 'quiet' });

      const isEvent = url.pathname === '/event';
      const text = isEvent ? describe(body) : String(body.text || '').trim();
      if (!text) return send(res, 400, { ok: false, error: 'empty' });

      if (isEvent) {
        // 被摸了这个事实先记下来，哪怕下面因为限流不投递 —— 她该记得有人来找过她。
        // 同一部位两分钟内只记一次，防止连点把情绪点爆。
        if (mood) {
          try { mood.touch(body); } catch (e) { log('mood touch failed: ' + e.message); }
        }
        const verdict = shouldWake(body);
        recent.push({ at: new Date().toISOString(), zone: body.zone || '', verdict });
        if (recent.length > 60) recent.shift();
        if (verdict !== 'ok') return send(res, 200, { ok: true, skipped: verdict, zone: body.zone || '' });

        // 情绪闸门：她可能真的不理人。概率和延迟都从 profile 的 gates.touch 里读，
        // 这里只负责照做，不自己发明规则。默认关着，等参数调顺了再打开。
        if (mood && cfg.moodGates) {
          const g = mood.gate('touch');
          const respond = typeof g.respond === 'number' ? g.respond : 1;
          if (respond < 1 && Math.random() > respond) {
            recent.push({ at: new Date().toISOString(), zone: body.zone || '', verdict: 'mood-silent' });
            log(`mood gate: 不理 zone=${body.zone || '-'} tier=${mood.snapshot().tier}`);
            return send(res, 200, { ok: true, skipped: 'mood-silent', why: '她现在不太想理人', zone: body.zone || '' });
          }
          // 延迟最多 1.5 秒：这是「犹豫了一下」不是「卡住了」，
          // 再长壳子那边等得心慌，也会让挂着的 HTTP 请求随时超时。
          const delay = Math.min(1500, Number(g.extraDelayMs) || 0);
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }
      }
      const now = Date.now();
      // 主人在气泡里回她一句 = 一次真心互动，够把委屈清零
      if (!isEvent && mood) {
        try { mood.speech(text, now); } catch (e) { log('mood speech failed: ' + e.message); }
      }
      try {
        const r = await deliver(text);
        lastAt = now; lastZone = isEvent ? (body.zone || '') : lastZone;
        windowCount++;
        log(`delivered zone=${body.zone || '-'} target=${r.target} session=${r.sessionId} flushed=${r.flushed}`);
        return send(res, 200, { ok: true, ...r, text });
      } catch (e) {
        log('deliver failed: ' + e.message);
        ctx.logger?.warn?.('pet-bridge: deliver failed: ' + e.message);
        return send(res, 500, { ok: false, error: e.message });
      }
    });
  });

  server.on('error', (e) => { log('server error: ' + e.message); ctx.logger?.warn?.('pet-bridge: server error: ' + e.message); });
  server.listen(cfg.port, '127.0.0.1', () => log(`listening on 127.0.0.1:${cfg.port} (mode=${cfg.mode})`));
  ctx.logger?.info?.(`pet-bridge listening on 127.0.0.1:${cfg.port} (mode=${cfg.mode})`);
  peek.start();

  // 情绪需要一个「即使没人点也会自己走」的时钟：衰减、攒委屈、落盘。
  // 读的时候也会顺手结算一次，所以这个定时器挂了也不会让情绪停在原地，只是落盘晚一点。
  if (mood) {
    moodTimer = setInterval(() => {
      try { mood.tick(); } catch (e) { log('mood tick failed: ' + e.message); }
    }, Math.max(60000, Number(cfg.moodTickMs) || 300000));
    if (moodTimer.unref) moodTimer.unref();
    log('mood enabled: ' + (cfg.moodFile || '$DSH_HOME/pet-mood.json'));
  }

  // 光有情绪还是被动的。开了 moodUrge，她自己会在情绪够的时候开口。
  // 一分钟问一次是纯计算；真到要说话那一步，一次投递就是一轮极短的会话。
  if (mood && cfg.moodUrge) {
    urgeTimer = setInterval(() => {
      urgeStep('timer').catch((e) => log('urge tick failed: ' + e.message));
    }, Math.max(5000, Number(cfg.moodUrgeTickMs) || 20000));
    if (urgeTimer.unref) urgeTimer.unref();
    const inten = (mood.state().urge || {}).intensity || 'normal';
    log(`mood urge enabled (tick=${Number(cfg.moodUrgeTickMs) || 20000}ms intensity=${inten})`);
  }

  ctx.on('dispose', () => {
    try { peek.stop(); } catch {}
    try { if (moodTimer) clearInterval(moodTimer); } catch {}
    try { if (urgeTimer) clearInterval(urgeTimer); } catch {}
    try { server.close(); } catch {}
  });
}
