// peek.js — 桌宠「窥屏」：隔一会儿自己瞄一眼主人屏幕，然后在桌面主动说一句。
//
// 为什么是「前台窗口 + 本地 OCR」而不是把截图丢给模型：
//   1. 桌宠会话用的预设只有人设、没有工具，拿不到 read_image，图片塞进去等于白塞；
//   2. 走视觉模型要另开一条计费链路，主人的 token 很贵；
//   3. Windows 10 起自带 Windows.Media.Ocr，离线、免费、中英文都给，识别不出也只是退化成标题。
//   4. 只截前台窗口（不是整屏），别把桌面其它窗口的隐私一起带出去。
//
// 兜底口径：任何一步失败都只写日志 + 这轮跳过，不抛给主人，也不影响点触那条主链路。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 探针脚本跟着插件包走（dsh-pet-bridge/scripts/），这样插件被复制到 profiles 里也能找到自己那份
const SCRIPT = join(HERE, '..', 'scripts', 'peek-window.ps1');

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// PowerShell 探针：抓前台窗口 + OCR，结果落 JSON，Node 读文件（避开 PS 5.1 的管道编码坑）。
// 抽成通用是因为现在有两个用法：重探针（截图认字）和轻探针（只要进程名和全屏状态）。
function runScript(cfg, extraArgs, timeoutMs, name) {
  return new Promise((resolve) => {
    const dir = cfg.peekTmpDir;
    try { mkdirSync(dir, { recursive: true }); } catch {}
    const json = join(dir, name);
    try { if (existsSync(json)) rmSync(json); } catch {}
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT, '-JsonOut', json, ...extraArgs,
      ], { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      return finish({ ok: false, error: 'spawn failed: ' + e.message });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: 'probe timeout' });
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: 'probe error: ' + e.message }); });
    child.on('exit', () => {
      clearTimeout(timer);
      let data = null;
      try { data = JSON.parse(readFileSync(json, 'utf8')); } catch (e) { return finish({ ok: false, error: 'bad probe json' }); }
      // 截图用完就删：留在盘上没意义，还容易变成隐私垃圾
      if (data && data.shot) { try { rmSync(data.shot, { force: true }); } catch {} }
      finish(data || { ok: false, error: 'empty probe' });
    });
  });
}

function probe(cfg, opts = {}) {
  const args = [
    '-MaxLines', String(cfg.peekMaxLines || 80),
    '-Scale', String(Number(cfg.peekScale) || 2),   // 放大再认：中文小字 2x 明显比 1x 准
  ];
  // 装了 RapidOCR 就交给它（中文准得多），没装 ps1 自己回落系统 OCR
  if (cfg.peekOcrPython) args.push('-OcrPython', String(cfg.peekOcrPython));
  if (cfg.peekOcrScript) args.push('-OcrScript', String(cfg.peekOcrScript));
  // 钉死窗口：给了 target 就只瞄它（进程名或标题片段），找不到再退回常规挑法
  if (cfg.peekTarget) args.push('-Target', String(cfg.peekTarget));
  // 手动点的时候前台会被托盘菜单抢成桌宠窗口，让探针沿任务栏顺序重挑一个真实窗口
  if (opts.pickActive) args.push('-PickActive');
  return runScript(cfg, args, cfg.peekTimeoutMs || 12000, 'probe.json');
}

/**
 * 轻探针：只问「前台是谁、是不是全屏」，不截图、不认字、不写图片。
 * 几十毫秒跑完，可以几十秒问一次。它管的是事件，不是内容。
 */
function probeLight(cfg) {
  return runScript(cfg, ['-Light'], 4000, 'probe-light.json');
}

// 「这窗口我自己」的判定：主人在跟你聊天、或者桌宠窗口在前台时别凑热闹
// 两类「不该瞄」的窗口，处理不一样：
//   dsh = 主人在跟你说话。手动点的时候他就在这儿，放行；定时那一路放行没意义，跳过。
//   pet = 桌宠壳子自己（鲸语窗口）。任何时候都不该瞄——点托盘菜单也会把前台抢成它。
function selfKind(proc, title) {
  const p = String(proc || '').toLowerCase();
  const t = String(title || '');
  if (/whale-pet|桌宠|大肥鱼|鲸语|live2d/i.test(t)) return 'pet';
  if (p === 'electron') return 'pet';
  if (/deepseek\s*harness|dsh\b/i.test(t)) return 'dsh';
  return '';
}

function inQuietHours(cfg) {
  const now = new Date();
  const h = now.getHours();
  const from = Number(cfg.peekQuietFrom);
  const to = Number(cfg.peekQuietTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return false;
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

// 间隔的合法范围：一分钟到一天。再短就是拿探针刷自己的盘，再长等于关了。
// 界面上只给几档预设，但接口照收任意值，方便调参时直接砸数字。
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 24 * 3600 * 1000;
const clampInterval = (ms) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 30 * 60 * 1000;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(n)));
};

/**
 * 全屏 episode 的一拍。纯函数：吃一次采样，吐「要不要上报打完了一局」。
 *
 * 抽出来是因为真探针要起 PowerShell，测不了；这层逻辑反而是最容易写错的
 * ——切窗口闪一下算不算结束、打两分钟算不算一局，都得有断言钉着。
 *
 * @param {object} ep      episode 状态，会被就地改
 * @param {{fullscreen:boolean, title?:string, proc?:string, pet?:boolean}} sample
 * @param {number} now
 * @returns {{minutes:number, title:string, proc:string}|null}
 */
export function trackEpisode(ep, sample, now) {
  if (!sample || sample.pet) return null;

  if (sample.fullscreen) {
    if (!ep.active) { ep.active = true; ep.since = now; }
    ep.misses = 0;   // 又满屏了，刚才那一下「不像全屏」作废
    ep.title = sample.title || '';
    ep.proc = sample.proc || '';
    ep.lastSeenAt = now;
    return null;
  }

  if (!ep.active) return null;
  // 连续两次不是全屏才算真出来：切个窗口、弹个框都会闪一下
  ep.misses += 1;
  if (ep.misses < 2) return null;

  const minutes = Math.round((ep.lastSeenAt - ep.since) / 60000);
  const done = { minutes, title: ep.title, proc: ep.proc };
  ep.active = false;
  ep.misses = 0;
  ep.title = '';
  ep.proc = '';
  return minutes >= 5 ? done : null;
}

export function createPeek({ cfg, log, deliver, onStateChange, onScene, onGameEnd, intervalFactor }) {
  const dir = cfg.peekTmpDir || join(process.env.DSH_HOME || tmpdir(), 'tmp', 'pet-peek');
  cfg.peekTmpDir = dir;

  const st = {
    on: cfg.peek === true || cfg.peek === 'on',
    // 基准间隔。可以运行时改（托盘 / CLI / HTTP），不用重启；改完落 pet-bridge.json。
    intervalMs: clampInterval(cfg.peekIntervalMs),
    nextAt: 0,
    lastAt: 0,
    lastTryAt: 0,
    lastResult: '',
    lastSkip: '',
    lastTitle: '',
    count: 0,
    skipped: 0,
    busy: false,
    fingerprint: '',
  };

  const rand = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));   // ±20% 抖动：别像闹钟一样整点出现

  // ── 全屏 episode（2026-11-07）─────────────────────────────────────────
  // 全屏的时候重探针是瞎的：截图一片黑，投递也被挡掉。但「主人在打游戏」这个事实
  // 本身有用——退出那一刻她该有反应。所以另开一条轻探针，只问前台是谁、是不是全屏。
  //
  // 判定退出要连续两次不是全屏：切个窗口、弹个框都会闪一下，
  // 闪一次就宣布「打完了」会误报。
  const ep = { active: false, since: 0, title: '', proc: '', lastSeenAt: 0, misses: 0 };
  let lastLight = null;
  let lightTicker = null;
  let lightBusy = false;
  // 每次调度都现问一次倍率：情绪不同时她的主动程度不一样（冷战降频，黏人时加倍）。
  // 回调坏了就当 1，别因为情绪模块出问题把窥屏也带崩。
  const factor = () => {
    try {
      const f = Number(intervalFactor && intervalFactor());
      return Number.isFinite(f) && f > 0 ? Math.min(6, Math.max(0.2, f)) : 1;
    } catch { return 1; }
  };
  const baseInterval = () => st.intervalMs * factor();
  const scheduleNext = () => { st.nextAt = Date.now() + rand(baseInterval()); };

  function state() {
    return {
      on: st.on,
      intervalMs: baseInterval(),      // 生效值：基准 × 情绪倍率
      baseMs: st.intervalMs,           // 主人设定的基准，界面上拨的就是它
      factor: factor(),
      nextAt: st.nextAt ? new Date(st.nextAt).toISOString() : '',
      nextInSec: st.nextAt ? Math.max(0, Math.round((st.nextAt - Date.now()) / 1000)) : 0,
      lastAt: st.lastAt ? new Date(st.lastAt).toISOString() : '',
      lastTryAt: st.lastTryAt ? new Date(st.lastTryAt).toISOString() : '',
      lastResult: st.lastResult,
      lastSkip: st.lastSkip,
      lastTitle: st.lastTitle,
      count: st.count,
      skipped: st.skipped,
      quietHours: `${cfg.peekQuietFrom ?? '-'}~${cfg.peekQuietTo ?? '-'}`,
      // 轻探针看到的前台，以及正在进行的全屏 episode。
      // 全屏期间重探针是瞎的，想知道「主人在打游戏」只能看这两个字段。
      light: lastLight,
      episode: ep.active
        ? { since: new Date(ep.since).toISOString(), minutes: Math.round((Date.now() - ep.since) / 60000), proc: ep.proc, title: clip(ep.title, 40) }
        : null,
      tmpDir: dir,
    };
  }

  function note(msg) { st.lastResult = msg; log('peek: ' + msg); }

  async function run(reason) {
    // 手动触发（托盘「现在瞄一眼试试」/ /peek {"now":true}）是主人自己点的，等于当场授权：
    // 这时候别拿「主人在跟你说话」把自己挡住——他点的那一刻前台必然就是 DSH 窗口。
    const manual = reason === 'manual';
    if (st.busy) return { ok: false, skipped: 'busy', why: '上一轮还没跑完' };
    if (!st.on) return { ok: false, skipped: 'off', why: '窥屏开关是关着的' };
    if (!manual && inQuietHours(cfg)) { st.lastSkip = '静默时段'; return { ok: false, skipped: 'quiet-hours', why: '静默时段' }; }
    st.busy = true;
    st.lastTryAt = Date.now();
    try {
      const p = await probe(cfg, { pickActive: manual });
      if (!p.ok) {
        st.skipped++;
        st.lastSkip = p.error || 'probe failed';
        note('探针失败：' + (p.error || '?'));
        return { ok: false, skipped: 'probe-failed', why: '屏幕没抓到', error: p.error || '' };
      }
      st.lastTitle = `${p.proc || '?'}｜${clip(p.title, 40)}`;

      // 一探到就先记账：全屏、画面没变、静默时段都会在下面 return，但「主人在玩什么」
      // 这个事实跟要不要打扰他是两件事。只在投递成功前才记的话，全屏打游戏永远记不到，
      // 那她连生气的理由都攒不起来。
      // 回调挂了不算失败，情绪是附加的，不该影响窥屏本身。
      try { onScene && onScene(p); } catch (e) { log('peek: onScene failed: ' + e.message); }

      const kind = selfKind(p.proc, p.title);
      // 桌宠自己：不管手动还是定时，都不瞄自己（点托盘菜单会把前台抢成她）
      if (kind === 'pet') {
        st.skipped++; st.lastSkip = '桌宠自己在前台';
        note('跳过（瞄到桌宠自己的窗口了）');
        return { ok: false, skipped: 'self-pet', why: '瞄到我自己了，不算' };
      }
      if (kind === 'dsh' && !manual) {
        st.skipped++; st.lastSkip = '主人在跟你说话';
        note('跳过（主人在跟你说话）');
        return { ok: false, skipped: 'self-dsh', why: '主人正在跟你说话，先不打扰' };
      }
      if (kind === 'dsh' && manual) note('手动触发，放行「主人在跟你说话」');
      // 手动点了就照抓：全屏标签只用来拦定时那一路（全屏独占常抓出一片黑，抓了也白抓）
      if (p.fullscreen && !manual) { st.skipped++; st.lastSkip = '全屏（大概在游戏或看片）'; note('跳过（全屏）'); return { ok: false, skipped: 'fullscreen', why: '全屏着，先不打扰' }; }
      if (p.fullscreen && manual) note('手动触发，全屏也照抓');
      if (p.picked) note('前台是桌宠窗口，改瞄 ' + p.proc + '｜' + clip(p.title, 20));
      if (p.win || p.monitor) note(`窗口 ${p.win || '?'} / 显示器 ${p.monitor || '?'}`);

      const lines = Array.isArray(p.lines) ? p.lines.filter((x) => x && x.length >= 2) : [];
      // 去重 + 丢掉界面骨架词：OCR 会把「文件 / 编辑 / 查看 / 帮助」这类菜单项也认出来，
      // 它们对「主人在干什么」没信息量，反而把真正有用那几行挤出字数上限。
      const NOISE = /^(文件|编辑|查看|帮助|插入|格式|工具|窗口|关闭|最小化|最大化|新建|打开)$/;
      const seen = new Set();
      const picked = [];
      for (const raw of lines) {
        const t = String(raw).replace(/\s+/g, ' ').trim();
        const key = t.replace(/\s+/g, '');
        if (key.length < 2 || seen.has(key) || NOISE.test(key)) continue;
        seen.add(key);
        picked.push(t);
      }
      const fp = createHash('sha1').update([p.proc, p.title, picked.slice(0, 12).join('|')].join('\n')).digest('hex');
      if (fp === st.fingerprint && Date.now() - st.lastAt < baseInterval() * 2) {
        st.skipped++; st.lastSkip = '画面没变'; note('跳过（画面跟上次一样）');
        return { ok: false, skipped: 'same', why: '画面跟上次一样，没新东西' };
      }

      const ocr = clip(picked.join(' / '), Number(cfg.peekMaxChars) || 300);
      const head = `（桌宠｜你刚刚自己瞄了眼主人的屏幕：${p.proc || '某个程序'}`
        + (p.title ? `，窗口是「${clip(p.title, 40)}」` : '')
        + '。';
      const body = ocr ? `屏幕上认出来的字，可能有错字：${ocr}。）` : '（看不清上面的字。）';
      const tail = ' 这是你主动搭话，不是主人叫你——想接一句就接，不想接就给个表情。）';
      const text = head + body + tail;

      await deliver(text);
      st.fingerprint = fp;
      st.lastAt = Date.now();
      st.count++;
      st.lastSkip = '';
      note(`已投递 #${st.count}：${p.proc}｜${clip(p.title, 24)}（${picked.length} 行文字）`);
      return { ok: true, delivered: true, proc: p.proc, title: p.title, lines: picked.length };
    } catch (e) {
      st.skipped++;
      st.lastSkip = e.message;
      note('投递失败：' + e.message);
      return { ok: false, error: e.message };
    } finally {
      st.busy = false;
      scheduleNext();
      try { onStateChange && onStateChange(state()); } catch {}
    }
  }

  /**
   * 轻探针的一拍。只记事件，不投递、不认字。
   * 全屏开始就记时间，退出时算出打了多久，够久的才上报。
   */
  async function lightTick() {
    if (!st.on || lightBusy) return;
    lightBusy = true;
    try {
      const r = await probeLight(cfg);
      if (!r || !r.ok) return;
      const now = Date.now();
      lastLight = { at: now, proc: r.proc || '', title: r.title || '', fullscreen: r.fullscreen === true };
      const done = trackEpisode(ep, {
        fullscreen: r.fullscreen === true,
        title: r.title,
        proc: r.proc,
        // 桌宠自己在前台不算：点托盘菜单会把焦点抢成她
        pet: selfKind(r.proc, r.title) === 'pet',
      }, now);
      if (!done) return;
      log(`peek: 全屏结束，${done.minutes} 分钟，${done.proc}｜${clip(done.title, 30)}`);
      try { onGameEnd && onGameEnd(done); } catch (e) { log('peek: onGameEnd failed: ' + e.message); }
    } catch (e) {
      log('peek light failed: ' + e.message);
    } finally {
      lightBusy = false;
    }
  }

  // 定时器用「每 30 秒看一次到点没」而不是一次性 setTimeout：
  // 中途开关、改间隔都不用重建 timer，也不用记一堆句柄。
  let ticker = null;
  function start() {
    if (ticker) return;
    scheduleNext();
    ticker = setInterval(() => {
      if (!st.on) return;
      if (!st.nextAt || Date.now() >= st.nextAt) {
        st.nextAt = Date.now() + baseInterval();   // 先推后算，避免 run() 内部再排一次导致双触发
        run('timer').catch((e) => log('peek timer failed: ' + e.message));
      }
    }, 30000);
    if (ticker.unref) ticker.unref();
    // 轻探针单开一条快节拍：它便宜，跟重探针那个半小时的节奏没关系。
    // 关着窥屏就也关着它，一个开关管两条。
    const lightMs = Math.max(15000, Number(cfg.peekLightMs) || 45000);
    lightTicker = setInterval(() => { lightTick().catch(() => {}); }, lightMs);
    if (lightTicker.unref) lightTicker.unref();
    log(`peek timer started (interval=${baseInterval()}ms, quiet=${cfg.peekQuietFrom}~${cfg.peekQuietTo}, on=${st.on}, light=${lightMs}ms)`);
  }

  function setOn(on) {
    st.on = !!on;
    if (st.on) scheduleNext();
    log('peek switch -> ' + (st.on ? 'on' : 'off'));
    try { onStateChange && onStateChange(state()); } catch {}
    return st.on;
  }

  function stop() {
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (lightTicker) { clearInterval(lightTicker); lightTicker = null; }
  }

  /** 换基准间隔。立刻重排下一次，不用重启；返回真正生效的值。 */
  function setIntervalMs(ms) {
    st.intervalMs = clampInterval(ms);
    if (st.on) scheduleNext();
    log('peek interval -> ' + Math.round(st.intervalMs / 60000) + 'min');
    try { onStateChange && onStateChange(state()); } catch {}
    return st.intervalMs;
  }

  return { start, stop, run, state, setOn, setIntervalMs, get on() { return st.on; } };
}
