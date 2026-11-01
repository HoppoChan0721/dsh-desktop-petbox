// 桥的冒烟测试：不开 DSH，用假 ctx 跑真代码，验证「点触进专用会话、主会话零打扰」。
// 跑法：node test/smoke.mjs   （临时文件落在 test/.tmp，跑完自动清）
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

const TMP = join(import.meta.dirname, '.tmp');
process.env.WHALE_PET_BRIDGE_LOG = join(TMP, 'bridge.log');

let fail = 0;
const ok = (label, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `：得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`}`);
};

function makeCtx({ createFails = false } = {}) {
  const calls = { create: [], rename: [], followup: [], flush: [], list: 0 };
  const handlers = {};
  const sessions = { flush: async (s) => { calls.flush.push(s.id); return true; } };
  const sessionController = {
    list: async () => { calls.list++; return { items: [{ id: 'main-session-1' }] }; },
    create: async (req) => {
      calls.create.push(req);
      if (createFails) throw new Error('boom');
      return { sessionId: req.sessionId, agentPreset: req.agentPreset };
    },
    rename: async (req) => { calls.rename.push(req); return { sessionId: req.sessionId, title: req.title }; },
    resolveAgent: async (sid) => ({
      agent: { session: { id: sid }, followup: (m) => calls.followup.push({ sid, text: m.content[0].text }) },
    }),
  };
  const ctx = {
    sessions, sessionController,
    logger: { info() {}, warn() {} },
    on: (ev, fn) => { handlers[ev] = fn; },
  };
  ctx.dispose = () => handlers.dispose && handlers.dispose();
  return { ctx, calls };
}

async function boot(cfg, ctxOpts) {
  mkdirSync(TMP, { recursive: true });
  const { ctx, calls } = makeCtx(ctxOpts);
  const statePath = cfg.statePath || join(TMP, `state-${cfg.port}.json`);
  apply(ctx, { ...cfg, statePath });
  // 等 listen 起来
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${cfg.port}/health`); return { ctx, calls, statePath }; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error('server never came up');
}

const post = async (port, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

rmSync(TMP, { recursive: true, force: true });

// ── 场景 1：默认 pet 模式 ──────────────────────────────
{
  const { ctx, calls, statePath } = await boot({ port: 62001, mode: 'pet', agentPreset: 'bigfish', minIntervalMs: 0 });
  ok('第 1 次点触前：create 没被调用', calls.create.length, 0);
  const r1 = await post(62001, '/event', { zone: 'chest', nx: 0.5, ny: 0.26 });
  ok('第 1 次点触：target=pet', r1.json.target, 'pet');
  ok('第 1 次点触：只建了 1 个会话', calls.create.length, 1);
  ok('第 1 次点触：建会话带 bigfish 预设', calls.create[0].agentPreset, 'bigfish');
  ok('第 1 次点触：会话改名「桌宠互动」', calls.rename[0].title, '桌宠互动');
  ok('第 1 次点触：消息落在新建的会话里', calls.followup[0].sid === calls.create[0].sessionId, true);
  ok('第 1 次点触：消息正文是分区描述', /桌宠｜主人刚刚碰了你的胸口/.test(calls.followup[0].text), true);

  const r2 = await post(62001, '/event', { zone: 'head' });
  ok('第 2 次点触：不再重复建会话', calls.create.length, 1);
  ok('第 2 次点触：仍投同一个会话', calls.followup[1].sid, calls.followup[0].sid);

  ok('主会话从未被 list 过（也就没投过它）', calls.list, 0);
  ok('主会话 main-session-1 一条消息都没收到', calls.followup.some((f) => f.sid === 'main-session-1'), false);
  ok('flush 每次都调了', calls.flush.length, 2);
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  ok('会话 id 落盘复用', st.petSessionId, calls.create[0].sessionId);
  ctx.dispose();
}

// ── 场景 2：重启后沿用旧 id ──────────────────────────────
{
  const key = 'state-restart.json';
  const p1 = 62003, p2 = 62004;
  const first = await boot({ port: p1, mode: 'pet', minIntervalMs: 0 });
  await post(p1, '/event', { zone: 'leg' });
  const savedId = first.calls.create[0].sessionId;
  const st = first.statePath;
  first.ctx.dispose();
  // 把状态文件挪成下一次要用的
  const fs = await import('node:fs');
  fs.copyFileSync(st, join(TMP, key));
  const second = await boot({ port: p2, mode: 'pet', minIntervalMs: 0, statePath: join(TMP, key) });
  await post(p2, '/event', { zone: 'waist' });
  ok('重启后仍投落盘的那个会话', second.calls.followup[0].sid, savedId);
  ok('重启后 create 也是幂等收养同一个 id', second.calls.create[0].sessionId, savedId);
  second.ctx.dispose();
}

// ── 场景 3：create 挂了 ──────────────────────────────
{
  const { ctx, calls } = await boot({ port: 62005, mode: 'pet', minIntervalMs: 0, fallbackToMain: false }, { createFails: true });
  const r = await post(62005, '/event', { zone: 'hair' });
  ok('建会话失败：返回 500', r.status, 500);
  ok('建会话失败：没有偷偷投主会话', calls.followup.some((f) => f.sid === 'main-session-1'), false);
  ctx.dispose();
}

// ── 场景 4：fallbackToMain=true 才退回主会话 ──────────────
{
  const { ctx, calls } = await boot({ port: 62006, mode: 'pet', minIntervalMs: 0, fallbackToMain: true }, { createFails: true });
  const r = await post(62006, '/event', { zone: 'hair' });
  ok('开了兜底：target=main', r.json.target, 'main');
  ok('开了兜底：确实投给了主会话', calls.followup[0].sid, 'main-session-1');
  ctx.dispose();
}

// ── 场景 5：旧行为 main 模式还在 ──────────────────────────
{
  const { ctx, calls } = await boot({ port: 62007, mode: 'main', minIntervalMs: 0 });
  const r = await post(62007, '/event', { zone: 'foot' });
  ok('main 模式：target=main', r.json.target, 'main');
  ok('main 模式：会先 list 找活跃会话', calls.list > 0, true);
  ok('main 模式：不建新会话', calls.create.length, 0);
  ctx.dispose();
}

// ── 场景 6：/reset-pet-session 换新会话 ──────────────────
{
  const { ctx, calls } = await boot({ port: 62008, mode: 'pet', minIntervalMs: 0 });
  await post(62008, '/event', { zone: 'chest' });
  const oldId = calls.create[0].sessionId;
  await post(62008, '/reset-pet-session', {});
  await post(62008, '/event', { zone: 'chest' });
  ok('reset 之后会建一个新 id', calls.create[1].sessionId !== oldId, true);
  ok('reset 之后的消息投给新会话', calls.followup[1].sid, calls.create[1].sessionId);
  ctx.dispose();
}

// ── 场景 7：/health 能看模式 ──────────────────────────────
{
  const { ctx } = await boot({ port: 62009, mode: 'pet', minIntervalMs: 0 });
  const h = await (await fetch('http://127.0.0.1:62009/health')).json();
  ok('health 带 mode', h.mode, 'pet');
  ok('health 带 petSessionId 字段', 'petSessionId' in h, true);
  ctx.dispose();
}

if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `\n${fail} 项失败` : '\n全过');
process.exit(fail ? 1 : 0);
