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
  agentPreset: 'bigfish',      // 新建桌宠会话用的预设（人设要跟主会话一致）
  fallbackToMain: false,       // 桌宠会话建不起来时，要不要退回投主会话
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
  async function ensurePetSession(forceNew = false, retried = false) {
    if (petSid && petReady && !forceNew) return petSid;
    if (!petCreating) {
      petCreating = (async () => {
        if (typeof ctx.sessionController.create !== 'function') throw new Error('sessionController.create 不可用');
        const wanted = forceNew || !petSid ? randomUUID() : petSid;
        const created = await ctx.sessionController.create({ sessionId: wanted, agentPreset: cfg.agentPreset || undefined });
        const sid = (created && created.sessionId) || wanted;
        petSid = sid; petReady = true; persist();
        log(`pet session ready: ${sid} preset=${(created && created.agentPreset) || cfg.agentPreset || '-'}`);
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

  // ---- 投递 ----
  async function deliverTo(sid, text) {
    if (!sid) throw new Error('no session to wake');
    const resolved = await ctx.sessionController.resolveAgent(sid);
    if (!resolved || resolved.error) throw new Error('resolveAgent: ' + JSON.stringify((resolved && resolved.error) || null));
    const agent = resolved.agent;
    if (!agent || typeof agent.followup !== 'function') throw new Error('agent has no followup');
    const message = {
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    };
    agent.followup(message);
    const flushed = await ctx.sessions.flush(agent.session);
    return { sessionId: sid, flushed: !!flushed };
  }

  async function deliver(text) {
    if (cfg.mode === 'pet') {
      try {
        const sid = await ensurePetSession();
        return { ...(await deliverTo(sid, text)), target: 'pet' };
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
