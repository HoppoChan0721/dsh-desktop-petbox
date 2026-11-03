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

const DEFAULTS = {
  port: 61944,
  mode: 'pet',                 // 'pet' = 专用桌宠会话；'main' = 投主会话（旧行为）
  sessionId: '',               // mode=main 时钉死一个会话；留空就自动跟最近活跃的
  petSessionId: '',            // mode=pet 的固定会话 id；留空自动生成，落盘复用
  petSessionTitle: '桌宠互动',
  agentPreset: 'bigfish-pet',  // 新建桌宠会话用的预设：主人 2026-11-03 给桌宠单独做的那个（只有人设、没有工具）
  fallbackToMain: false,       // 桌宠会话建不起来时，要不要退回投主会话
  echoToPet: true,             // 会话里说完的话回送到桌宠气泡（不然只能在聊天窗里干看着）
  petSayUrl: 'http://127.0.0.1:61943/say',
  echoMaxChars: 180,           // 气泡装不下长篇，超了截断
  echoDelayMs: 900,            // 一轮里可能有好几条 assistant 消息，等最后一条再出气泡
  echoVoice: false,            // true = 气泡同时走 TTS（3~10 秒，会跟点触本地的语音撞车）
  echoVoiceMaxChars: 40,       // 只有这么短的回复才念出声：长句合成慢、还会念到一半就断
  minIntervalMs: 1200,         // 同一部位在这个间隔内只投一次
  maxPerMinute: 24,            // 每分钟最多投递几条，防止连点刷屏
  quiet: false,
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

  if (statePath) {
    try {
      const st = JSON.parse(readFileSync(statePath, 'utf8'));
      if (!bound && st.sessionId) bound = st.sessionId;
      if (!petSid && st.petSessionId) petSid = st.petSessionId;
    } catch {}
  }
  function persist() {
    if (!statePath) return;
    try { writeFileSync(statePath, JSON.stringify({ sessionId: bound, petSessionId: petSid, at: new Date().toISOString() }, null, 1)); } catch {}
  }

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
  // 表情/手势用 [emotion:shy] [gesture:hand_on_chest] 写在开头，这里摘出来并剥掉。
  const EMOTIONS = new Set(['happy', 'shy', 'excited', 'thinking', 'sleepy', 'proud', 'sad', 'annoyed', 'surprised', 'greeting', 'playful', 'neutral', 'flustered', 'confused', 'pout']);
  const GESTURES = new Set(['hand_on_chest', 'point', 'grass']);
  const CUE_RE = /\[\s*(emotion|gesture)\s*[:：]\s*([A-Za-z_]+)\s*\]/g;

  function takeCues(t) {
    const cues = { emotion: null, gesture: null };
    const clean = String(t).replace(CUE_RE, (_m, k, v) => {
      const key = String(k).toLowerCase();
      const val = String(v).toLowerCase();
      if (key === 'emotion' && EMOTIONS.has(val)) cues.emotion = val;
      if (key === 'gesture' && GESTURES.has(val)) cues.gesture = val;
      return '';
    });
    return { clean: clean.replace(/^[\s,，、。:：]+/, '').trim(), cues };
  }

  function replyTextOf(blocksList) {
    const texts = blocksList.map((bl) => bubbleText(bl)).filter(Boolean);
    if (!texts.length) return { text: '', emotion: null, gesture: null };
    const last = takeCues(texts[texts.length - 1]);
    let t = last.clean;
    if (!t) return { text: '', emotion: null, gesture: null };
    if (t.length > cfg.echoMaxChars) t = t.slice(0, Math.max(1, cfg.echoMaxChars - 1)).trimEnd() + '…';
    return { text: t, emotion: last.cues.emotion, gesture: last.cues.gesture };
  }

  async function sayOnPet(text, cues = {}) {
    const ms = Math.min(24000, Math.max(3000, 1800 + text.length * 140));   // 口型时长跟着字数走
    const body = { text, ms };
    if (cues.emotion) body.emotion = cues.emotion;     // 让这句话配着脸，不只是字幕
    if (cues.gesture) body.gesture = cues.gesture;
    // 短回复念出来：early 让壳子先把气泡放出来，合成完再补声音，别让人干等三秒。
    // 超过 echoVoiceMaxChars 的只出文字——合成慢，而且一口气念长了不好听。
    const cap = Number(cfg.echoVoiceMaxChars) || 40;
    if (cfg.echoVoice && text.length <= cap) { body.voice = true; body.early = true; }
    const res = await fetch(cfg.petSayUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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
      if (!reply.text) { log('echo: assistant message had no text'); return; }
      const wait = cfg.echoDelayMs || 0;
      const gap = Date.now() - echoLastAt;
      if (gap < wait) await sleep(wait - gap);   // 连着两轮时别把气泡叠在一起
      echoLastAt = Date.now();
      try {
        await sayOnPet(reply.text, reply);
        log(`echoed to pet (${reply.text.length} chars${reply.emotion ? ', ' + reply.emotion : ''}${reply.gesture ? ', ' + reply.gesture : ''})`);
      } catch (e) {
        log('echo to pet failed: ' + e.message);
      }
    })().catch((e) => log('echo pipeline failed: ' + e.message));
  }

  if (cfg.echoToPet) log('echo to pet enabled -> ' + cfg.petSayUrl);

  // ---- 投递 ----
  // 桌面会话的口径（2026-11-02 主人要的）：话要短、别排版，顺带把表情/手势交给她自己挑。
  const PET_HINT = '\n（这是在桌面上说话：一句就够，20～40 字，别用列表 / 标题 / 代码块。'
    + '想让她带着脸说话，就在最前面写 [emotion:shy]；想加手势再写 [gesture:hand_on_chest]。'
    + '表情可用：' + [...EMOTIONS].join(' / ') + '；手势可用：' + [...GESTURES].join(' / ') + '。'
    + '这两个标记会被摘掉，不会出现在气泡里。）';

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

  async function deliver(text) {
    if (cfg.mode === 'pet') {
      try {
        const sid = await ensurePetSession();
        return { ...(await deliverTo(sid, text + PET_HINT, true)), target: 'pet' };   // 只有投桌宠会话才回气泡
      } catch (e) {
        petReady = false;   // 下一次点触重新建
        if (!cfg.fallbackToMain) throw e;
        log('pet session unavailable, falling back to main: ' + e.message);
      }
    }
    const sid = await currentSession();
    return { ...(await deliverTo(sid, text)), target: 'main' };
  }

  function describe(ev) {
    const label = ZONE_LABEL[ev.zone] || ev.zone || '身子';
    const where = (ev.nx != null && ev.ny != null) ? `（位置 ${ev.nx}, ${ev.ny}）` : '';
    const nth = zoneCount >= 2 ? `，第 ${zoneCount} 下` : '';
    return `（桌宠｜主人刚刚碰了你的${label}${nth}${where}）`;
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
        recent: recent.slice(-10),
      });
    }
    if (req.method === 'GET' && url.pathname === '/recent') {
      return send(res, 200, { ok: true, items: recent.slice(-30) });
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
      if (cfg.quiet) return send(res, 200, { ok: true, skipped: 'quiet' });

      const isEvent = url.pathname === '/event';
      const text = isEvent ? describe(body) : String(body.text || '').trim();
      if (!text) return send(res, 400, { ok: false, error: 'empty' });

      if (isEvent) {
        const verdict = shouldWake(body);
        recent.push({ at: new Date().toISOString(), zone: body.zone || '', verdict });
        if (recent.length > 60) recent.shift();
        if (verdict !== 'ok') return send(res, 200, { ok: true, skipped: verdict, zone: body.zone || '' });
      }
      const now = Date.now();
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
  ctx.on('dispose', () => { try { server.close(); } catch {} });
}
