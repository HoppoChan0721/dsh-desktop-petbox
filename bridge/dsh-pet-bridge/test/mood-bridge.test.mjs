// 接线测试：不起 DSH，用假 ctx 跑真 index.js，验证情绪层真的接进去了。
//
//   node --test test/mood-bridge.test.mjs
//
// 前两份测的是「引擎算得对不对」，这一份测的是「引擎有没有被接上」——
// 情绪卡有没有拼进投递、闸门有没有真的拦、/mood 端点通不通。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { apply } from '../lib/index.js';
import { SCHEMA_VERSION, DEFAULT_PROFILE } from '../lib/mood/profile.js';

const TMP = join(import.meta.dirname, '.tmp-mood');
mkdirSync(TMP, { recursive: true });
delete process.env.WHALE_PET_BRIDGE_LOG;   // 测试别往真日志里写

function makeCtx() {
  const calls = { followup: [] };
  const transcripts = new Map();
  const sessionController = {
    list: async () => ({ items: [{ id: 'main-1' }] }),
    create: async (req) => ({ sessionId: req.sessionId, agentPreset: req.agentPreset }),
    rename: async (req) => ({ sessionId: req.sessionId, title: req.title }),
    resolveAgent: async (sid) => {
      if (!transcripts.has(sid)) transcripts.set(sid, []);
      const agent = {
        session: { id: sid, deriveMessages: () => transcripts.get(sid) },
        status: 'idle',
        waiters: [],
        followup: (m) => {
          calls.followup.push({ sid, text: m.content[0].text });
          agent.status = 'running';
          setTimeout(() => { agent.status = 'idle'; agent.waiters.splice(0).forEach((r) => r()); }, 5);
        },
        whenIdle: () => new Promise((res) => { if (agent.status === 'idle') return res(); agent.waiters.push(res); }),
      };
      return { agent };
    },
  };
  const handlers = {};
  const ctx = {
    sessions: { flush: async () => true },
    sessionController,
    workspaceRegistry: { archivedSessionIds: [] },
    logger: { info() {}, warn() {} },
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn); },
    emit: (ev, ...args) => (handlers[ev] || []).forEach((fn) => fn.apply(ctx, args)),
  };
  ctx.dispose = () => ctx.emit('dispose');
  return { ctx, calls };
}

/** 写一份「正在冷战」的状态文件，让桥一启动就是个生气的她。 */
function writeColdState(file) {
  const now = Date.now();
  const emotions = {};
  for (const [name, v] of Object.entries({ upset: 0.6, anger: 0.5 })) {
    emotions[name] = { value: v, at: now };
  }
  writeFileSync(file, JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    emotions,
    tier: 'cold',
    cooldowns: {},
    log: [{ at: now, emotion: 'anger', delta: 0.45, reason: '看见他在玩' }],
    lastInteractionAt: now - 8 * 3600000,
    lastSignalAt: now,
  }), 'utf8');
}

async function boot(port, cfg) {
  const { ctx, calls } = makeCtx();
  apply(ctx, { port, mode: 'pet', agentPreset: 'p', minIntervalMs: 0, maxPerMinute: 100, statePath: join(TMP, `s-${port}.json`), ...cfg });
  for (let i = 0; i < 40; i++) {
    try { await fetch(`http://127.0.0.1:${port}/health`); return { ctx, calls }; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error('server never came up');
}

const post = async (port, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const get = async (port, path) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, json: await res.json() };
};

test('情绪关着的时候，投递内容里一个字都不多', async () => {
  const { ctx, calls } = await boot(62101, { mood: false });
  try {
    await post(62101, '/event', { zone: 'head' });
    const text = calls.followup.at(-1).text;
    // 注意：原有的 petStateLine 本来就会写「（你现在：表情…）」，所以不能按「你现在」判，
    // 只按情绪卡特有的说法判。
    assert.ok(!/不痛快|真在生气|心情不错|在担心|吃醋/.test(text), '关着就不该出现情绪卡');
    const m = await get(62101, '/mood');
    assert.equal(m.json.enabled, false);
    assert.equal(m.json.ok, true, '关着也回 200，不是 404');
  } finally { ctx.dispose(); }
});

test('打开情绪后，投递里带上她的状态', async () => {
  const file = join(TMP, 'cold-1.json');
  writeColdState(file);
  const { ctx, calls } = await boot(62102, { mood: true, moodFile: file });
  try {
    const m = await get(62102, '/mood');
    assert.equal(m.json.enabled, true);
    assert.equal(m.json.snapshot.tier, 'cold');
    assert.ok(m.json.summary.length > 0);

    await post(62102, '/event', { zone: 'head' });
    const text = calls.followup.at(-1).text;
    assert.match(text, /生气/, '冷战期投递该带上生气的指令');
    assert.match(text, /一句/, '原有的行为口径不能丢');
  } finally { ctx.dispose(); }
});

test('闸门没开时，冷战也照样投递', async () => {
  const file = join(TMP, 'cold-2.json');
  writeColdState(file);
  const { ctx, calls } = await boot(62103, { mood: true, moodFile: file, moodGates: false });
  try {
    const r = await post(62103, '/event', { zone: 'head' });
    assert.notEqual(r.json.skipped, 'mood-silent');
    assert.equal(calls.followup.length, 1);
  } finally { ctx.dispose(); }
});

test('闸门打开后，冷战期会出现「不理人」', async () => {
  const file = join(TMP, 'cold-3.json');
  writeColdState(file);
  const { ctx } = await boot(62104, { mood: true, moodFile: file, moodGates: true });
  try {
    let silent = 0;
    for (let i = 0; i < 20; i++) {
      const r = await post(62104, '/event', { zone: 'waist' });
      if (r.json.skipped === 'mood-silent') silent++;
    }
    // gates.touch.cold.respond 是 0.3，二十次里不回的概率极高
    assert.ok(silent > 0, '冷战期该有不理人的时候');
    assert.ok(silent < 20, '也不能一次都不理');
  } finally { ctx.dispose(); }
});

test('一键哄好之后立刻变回平静，也重新肯理人', async () => {
  const file = join(TMP, 'cold-4.json');
  writeColdState(file);
  const { ctx } = await boot(62105, { mood: true, moodFile: file, moodGates: true });
  try {
    const before = await get(62105, '/mood');
    assert.equal(before.json.snapshot.tier, 'cold');

    const r = await post(62105, '/mood', { reset: true });
    assert.equal(r.json.snapshot.tier, 'calm');

    const after = await get(62105, '/mood');
    assert.equal(after.json.snapshot.tier, 'calm');
    assert.equal(after.json.snapshot.values.upset, 0);

    const touch = await post(62105, '/event', { zone: 'head' });
    assert.notEqual(touch.json.skipped, 'mood-silent');
  } finally { ctx.dispose(); }
});

test('情绪模块出问题也不会挡住宿主流程', async () => {
  const { ctx, calls } = await boot(62106, { mood: true, moodFile: join(TMP, 'no-such-dir', 'x.json') });
  try {
    const r = await post(62106, '/event', { zone: 'leg' });
    assert.equal(r.status, 200);
    assert.equal(calls.followup.length, 1, '写不了状态文件也要照常投递');
  } finally {
    ctx.dispose();
    rmSync(join(TMP, 'no-such-dir'), { recursive: true, force: true });
  }
});

test('main 模式下不往主人的工作会话里塞情绪卡', async () => {
  const file = join(TMP, 'cold-main.json');
  writeColdState(file);
  const { ctx, calls } = await boot(62107, { mode: 'main', mood: true, moodFile: file, sessionId: 'main-1' });
  try {
    const r = await post(62107, '/event', { zone: 'head' });
    assert.equal(r.status, 200);
    const text = calls.followup.at(-1).text;
    assert.ok(!/你现在/.test(text), 'main 模式只投点触描述，不演情绪');
    assert.match(text, /碰了你的/, '原来的点触描述还得在');
  } finally { ctx.dispose(); }
});

test('主动开口关着时，没人碰她她一个字都不说', async () => {
  const file = join(TMP, 'cold-urge-off.json');
  writeColdState(file);
  const { ctx, calls } = await boot(62108, { mood: true, moodFile: file, moodUrge: false });
  try {
    const r = await post(62108, '/mood', { urge: true });
    assert.equal(r.json.urgeResult.why, 'off');
    assert.equal(calls.followup.length, 0, '关着就不该有投递');
  } finally { ctx.dispose(); }
});

test('冷战期她自己会开口，不用主人先动手', async () => {
  const file = join(TMP, 'cold-urge-on.json');
  writeColdState(file);
  const { ctx, calls } = await boot(62109, { mood: true, moodFile: file, moodUrge: true });
  try {
    const r = await post(62109, '/mood', { urge: true });
    assert.equal(r.json.urgeResult.spoke, true);
    assert.equal(r.json.urgeResult.window, 'cold-drift');

    const text = calls.followup.at(-1).text;
    assert.match(text, /不是主人叫你/, '要告诉她这次是自己想开口');
    assert.match(text, /生闷气/, '语气要跟着档位走');
    assert.match(text, /一句/, '原来的行为口径不能丢');

    const after = await get(62109, '/mood');
    assert.equal(after.json.urge.windows['cold-drift'].total, 1, '说过就要记账');
    assert.equal(after.json.urge.today, 1);

    // 紧接着再问一次：全局最小间隔会把它挡住，不会连发
    const again = await post(62109, '/mood', { urge: true });
    assert.equal(again.json.urgeResult.spoke, false);
  } finally { ctx.dispose(); }
});

test('平静的时候就算问她也不开口', async () => {
  const file = join(TMP, 'calm-urge.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, emotions: {}, tier: 'calm', cooldowns: {}, log: [], lastInteractionAt: Date.now() - 4 * 3600000 }), 'utf8');
  const { ctx, calls } = await boot(62110, { mood: true, moodFile: file, moodUrge: true });
  try {
    const r = await post(62110, '/mood', { urge: true });
    assert.equal(r.json.urgeResult.spoke, false);
    assert.equal(calls.followup.length, 0);
  } finally { ctx.dispose(); }
});

test('浓度能随手拨，写错了只回 400 不炸', async () => {
  const file = join(TMP, 'calm-intensity.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION, emotions: {}, tier: 'calm', cooldowns: {}, log: [], lastInteractionAt: Date.now() - 4 * 3600000 }), 'utf8');
  const { ctx } = await boot(62111, { mood: true, moodFile: file, moodUrge: true });
  try {
    const before = await get(62111, '/mood');
    assert.equal(before.json.urge.intensity, 'normal');

    const r = await post(62111, '/mood', { intensity: 'chatty' });
    assert.equal(r.status, 200);
    assert.equal(r.json.intensity, 'chatty');
    assert.equal((await get(62111, '/mood')).json.urge.intensity, 'chatty');

    const bad = await post(62111, '/mood', { intensity: 'nope' });
    assert.equal(bad.status, 400);
    assert.ok(Array.isArray(bad.json.options));
    assert.equal((await get(62111, '/mood')).json.urge.intensity, 'chatty', '写错了不该把原来那档弄丢');
  } finally { ctx.dispose(); }
});

test('窥屏档位能拨，拨完落盘', async () => {
  const stateFile = join(TMP, 's-62112.json');
  const { ctx } = await boot(62112, {
    peek: false,
    statePath: stateFile,
    peekPersonaTable: DEFAULT_PROFILE.peekPersona,
  });
  try {
    // 默认档：拨的是性子，不是分钟数
    const a = (await get(62112, '/peek')).json;
    assert.equal(a.persona, 'gentle', '默认是温和');
    assert.equal(a.personaLabel, '温和');
    assert.ok(a.sampleMs >= 600000 && a.sampleMs <= 1800000, '抽样落在温和区间');

    // 换档
    const r = await post(62112, '/peek', { persona: 'cool' });
    assert.equal(r.status, 200);
    assert.equal(r.json.persona, 'cool');
    assert.ok(r.json.sampleMs >= 1800000 && r.json.sampleMs <= 5400000, '冷淡档该落在半小时到一小时半');

    // 写错档位名：不崩，给可选名单
    const bad = await post(62112, '/peek', { persona: 'nope' });
    assert.equal(bad.status, 400);
    assert.ok(Array.isArray(bad.json.options) && bad.json.options.length >= 3);

    // 老接口还在，但会切到手动档
    const ms = await post(62112, '/peek', { intervalMs: 5000 });
    assert.equal(ms.json.persona, 'manual');
    assert.equal(ms.json.sampleMs, 60000, '太短要夹住');

    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(saved.peekPersona, 'manual', '拨过的档要能跨重启');
    assert.equal(saved.peekIntervalMs, 60000);
  } finally { ctx.dispose(); }
});

test.after(() => { rmSync(TMP, { recursive: true, force: true }); });
