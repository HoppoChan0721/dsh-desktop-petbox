'use strict';
// TTS 保活。本地 CosyVoice 网关闲着的时候只有两种状态：进程没起、或者进程起了但模型还没进显存。
// 两种都是「下一句要等 27 秒」。这个模块定时做三件事：
//
//   1. GET /health 探活（2.5 秒超时，不碰模型，最便宜）
//   2. 不通就拿 start.ps1 把服务拉起来（脱离父进程、隐藏窗口）
//   3. 服务刚起来的那一次，用一句「嗯」合成一发，把模型顶进显存，wav 立刻删
//
// 探活是常驻的，热身只在「刚起来」和「进程启动那一次」做。
// 中途她自己说过话（noteSay）就不重复热身——模型本来就热着。
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const HEALTH_TIMEOUT = 2500;   // 探活超时；本地 loopback，2.5 秒已经是死的
const START_WAIT_MS = 15000;   // 拉起脚本最多等这么久：脚本本身几秒就退，剩下的交给健康检查
const POLL_MS = 1000;
const WARM_TEXT = '嗯';
const MIN_INTERVAL_MS = 60000;

function ping(url) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      const u = new URL(url);
      req = http.request({
        hostname: u.hostname,
        port: u.port || 80,
        path: (u.pathname || '/') + (u.search || ''),
        method: 'GET',
        timeout: HEALTH_TIMEOUT,
      }, (res) => { res.resume(); fin(res.statusCode >= 200 && res.statusCode < 400); });
    } catch (e) { fin(false); return; }
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} fin(false); });
    req.on('error', () => fin(false));
    req.end();
  });
}

function createKeepAlive(opts) {
  const o = opts || {};
  const healthUrl = String(o.healthUrl || '');
  const startScript = String(o.startScript || '');
  const prepareVoice = typeof o.prepareVoice === 'function' ? o.prepareVoice : null;
  const dropWav = typeof o.dropWav === 'function' ? o.dropWav : () => {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const warmText = o.warmText || WARM_TEXT;

  let enabled = o.enabled !== false;
  let intervalMs = Math.max(MIN_INTERVAL_MS, Number(o.intervalMs) || 5 * 60000);
  let timer = null;
  let firstTimer = null;
  let running = false;
  // 起手就当「需要热身」：进程刚起来，服务是不是热的我们不知道，热一次最保险
  let needWarm = true;
  // 拉起脚本自己的输出，`/keepalive` 里能看到尾巴，排查「为什么拉不起来」用
  let startLog = '';
  let startCode = null;
  // 这一轮服务是不是真的热着：热过一次、或者她自己刚说过话。
  // 光看 /health 只知道进程活着，模型进没进显存它不说，所以只有这两种情况才算「暖」。
  let warmKnown = false;

  const st = {
    state: 'idle',      // idle | off | down | starting | warming | warm | up
    lastCheckAt: 0,
    lastOkAt: 0,
    lastWarmAt: 0,
    lastWarmMs: 0,
    warmCount: 0,
    lastError: '',
    healthUrl,
  };

  function snapshot() {
    return {
      enabled,
      state: st.state,
      healthUrl: st.healthUrl,
      startScript: startScript || null,
      intervalMinutes: Math.round(intervalMs / 60000),
      lastCheckAt: st.lastCheckAt || null,
      lastOkAt: st.lastOkAt || null,
      lastWarmAt: st.lastWarmAt || null,
      lastWarmMs: st.lastWarmMs || null,
      warmCount: st.warmCount,
      needWarm,
      lastError: st.lastError || null,
      startLog: startLog.trim() ? startLog.trim().slice(-600) : null,
    };
  }

  // 拉起服务。刻意留一份 stderr：Start-Process 起不来的时候，报错只有脚本自己知道，
  // 藏起来就变成「45 秒还没通」这种没法查的结论。
  function launchService() {
    if (!startScript) return false;
    try { if (!fs.existsSync(startScript)) return false; } catch (e) { return false; }
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', startScript], {
        windowsHide: true,
        // 别加 detached：Windows 上 detached + 管道拿不到任何输出，脚本挂了也静悄悄（实测 exit 0 空串）
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const keep = (d) => {
        startLog += d.toString();
        if (startLog.length > 4000) startLog = startLog.slice(-4000);
      };
      if (child.stdout) child.stdout.on('data', keep);
      if (child.stderr) child.stderr.on('data', keep);
      child.on('error', (e) => { startLog += '\nspawn: ' + ((e && e.message) || e); });
      child.on('close', (code) => { startCode = code; });
      child.unref();
      // 子进程还握着管道，别让它拖住事件循环；我们只靠健康检查判断成败
      if (child.stdout) child.stdout.unref && child.stdout.unref();
      if (child.stderr) child.stderr.unref && child.stderr.unref();
      return true;
    } catch (e) {
      st.lastError = String((e && e.message) || e).slice(0, 200);
      return false;
    }
  }

  async function waitHealth(totalMs) {
    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (await ping(healthUrl)) return true;
    }
    return false;
  }

  async function warm() {
    if (!prepareVoice) { needWarm = false; return false; }
    st.state = 'warming';
    const t0 = Date.now();
    try {
      const job = await prepareVoice(warmText);
      const id = job && job.job_id ? String(job.job_id) : '';
      if (id) { try { dropWav(id); } catch (e) {} }
      st.lastWarmAt = Date.now();
      st.lastWarmMs = st.lastWarmAt - t0;
      st.warmCount += 1;
      st.lastError = '';
      needWarm = false;
      warmKnown = true;
      st.state = 'warm';
      log('warm ok ' + st.lastWarmMs + 'ms');
      return true;
    } catch (e) {
      // 热身失败不重试：桥脚本没装、模型缺文件这类问题，每分钟撞一次也是白撞
      needWarm = false;
      warmKnown = false;
      st.lastError = String((e && e.message) || e).slice(0, 200);
      st.state = 'up';
      log('warm fail ' + st.lastError);
      return false;
    }
  }

  async function tick() {
    if (running) return snapshot();
    if (!enabled) { st.state = 'off'; return snapshot(); }
    if (!healthUrl) { st.state = 'off'; st.lastError = '没配探活地址'; return snapshot(); }
    running = true;
    try {
      st.lastCheckAt = Date.now();
      const ok = await ping(healthUrl);
      if (ok) {
        st.lastOkAt = Date.now();
        if (needWarm) await warm();
        else st.state = warmKnown ? 'warm' : 'up';
        return snapshot();
      }
      // 没在跑：先试着自己拉起来
      st.state = 'starting';
      needWarm = true;
      warmKnown = false;
      startLog = '';
      startCode = null;
      const launched = launchService();
      if (!launched && !prepareVoice) {
        st.state = 'down';
        st.lastError = startScript ? '服务没起，拉起脚本不在：' + startScript : '服务没起，也没配拉起脚本';
        return snapshot();
      }
      let up = launched ? await waitHealth(START_WAIT_MS) : false;
      if (up) {
        st.lastOkAt = Date.now();
        // 服务刚活：这时候模型八成还是冷的，顺手热一次
        await warm();
        return snapshot();
      }
      // 拉起脚本没顶用（脚本自己会报错，比如进程记录还在、端口被占），
      // 还有第二条路：TTS 桥脚本自己就会拉起服务，让它带着等。
      if (prepareVoice) {
        log('start script did not come up, falling back to warm path');
        const t0 = Date.now();
        const warmed = await warm();
        if (warmed) { st.lastOkAt = Date.now(); return snapshot(); }
        st.lastError = '服务没起来（' + Math.round((Date.now() - t0) / 1000) + ' 秒）：' + (st.lastError || '原因不明');
      } else {
        st.lastError = '拉起后 ' + Math.round(START_WAIT_MS / 1000) + ' 秒还没通';
      }
      if (startLog.trim()) st.lastError += ' · 拉起脚本说：' + startLog.trim().split('\n').slice(-3).join(' / ').slice(0, 300);
      else if (startCode !== null) st.lastError += ' · 拉起脚本退出码 ' + startCode + '，没说话';
      st.state = 'down';
      return snapshot();
    } finally {
      running = false;
    }
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
  }

  function start(opt) {
    stop();
    if (opt && Number(opt.intervalMs)) intervalMs = Math.max(MIN_INTERVAL_MS, Number(opt.intervalMs));
    if (!enabled || !healthUrl) { st.state = 'off'; return snapshot(); }
    // 启动后两秒半先探一次：让这一轮的第一句话就能赶上热着的服务
    firstTimer = setTimeout(() => { firstTimer = null; tick().catch(() => {}); }, 2500);
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    return snapshot();
  }

  function setEnabled(on) {
    enabled = on !== false;
    if (!enabled) { stop(); st.state = 'off'; return snapshot(); }
    if (!timer) start({ intervalMs });
    return snapshot();
  }

  function setIntervalMs(ms) {
    intervalMs = Math.max(MIN_INTERVAL_MS, Number(ms) || intervalMs);
    if (enabled && timer) start({ intervalMs });
    return snapshot();
  }

  // 她自己说过话：模型肯定是热的，别再白热一次
  function noteSay() {
    needWarm = false;
    warmKnown = true;
    if (enabled) st.state = 'warm';
    st.lastOkAt = Date.now();
  }

  return { start, stop, tick, warm, setEnabled, setIntervalMs, noteSay, status: snapshot };
}

module.exports = { createKeepAlive, ping, WARM_TEXT, MIN_INTERVAL_MS };
