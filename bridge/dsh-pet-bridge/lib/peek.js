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

// PowerShell 探针：抓前台窗口 + OCR，结果落 JSON，Node 读文件（避开 PS 5.1 的管道编码坑）
function probe(cfg) {
  return new Promise((resolve) => {
    const dir = cfg.peekTmpDir;
    try { mkdirSync(dir, { recursive: true }); } catch {}
    const json = join(dir, 'probe.json');
    try { if (existsSync(json)) rmSync(json); } catch {}
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', SCRIPT, '-JsonOut', json, '-MaxLines', String(cfg.peekMaxLines || 80),
      ], { windowsHide: true, stdio: 'ignore' });
    } catch (e) {
      return finish({ ok: false, error: 'spawn failed: ' + e.message });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: 'probe timeout' });
    }, cfg.peekTimeoutMs || 12000);
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

// 「这窗口我自己」的判定：主人在跟你聊天、或者桌宠窗口在前台时别凑热闹
function isSelf(proc, title) {
  const p = String(proc || '').toLowerCase();
  const t = String(title || '');
  if (/deepseek\s*harness|dsh\b/i.test(t)) return '主人在跟你说话';
  if (/whale-pet|桌宠|大肥鱼/i.test(t)) return '桌宠自己在前台';
  if (p === 'electron') return '桌宠自己在前台';
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

export function createPeek({ cfg, log, deliver, onStateChange }) {
  const dir = cfg.peekTmpDir || join(process.env.DSH_HOME || tmpdir(), 'tmp', 'pet-peek');
  cfg.peekTmpDir = dir;

  const st = {
    on: cfg.peek === true || cfg.peek === 'on',
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
  const baseInterval = () => Number(cfg.peekIntervalMs) || 30 * 60 * 1000;
  const scheduleNext = () => { st.nextAt = Date.now() + rand(baseInterval()); };

  function state() {
    return {
      on: st.on,
      intervalMs: baseInterval(),
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
      const p = await probe(cfg);
      if (!p.ok) {
        st.skipped++;
        st.lastSkip = p.error || 'probe failed';
        note('探针失败：' + (p.error || '?'));
        return { ok: false, skipped: 'probe-failed', why: '屏幕没抓到', error: p.error || '' };
      }
      st.lastTitle = `${p.proc || '?'}｜${clip(p.title, 40)}`;

      const self = isSelf(p.proc, p.title);
      if (self && !manual) { st.skipped++; st.lastSkip = self; note('跳过（' + self + '）'); return { ok: false, skipped: 'self', why: self + '，先不打扰' }; }
      if (self && manual) note('手动触发，放行 self 判定（' + self + '）');
      if (p.fullscreen) { st.skipped++; st.lastSkip = '全屏（大概在游戏或看片）'; note('跳过（全屏）'); return { ok: false, skipped: 'fullscreen', why: '全屏着，先不打扰' }; }

      const lines = Array.isArray(p.lines) ? p.lines.filter((x) => x && x.length >= 2) : [];
      const fp = createHash('sha1').update([p.proc, p.title, lines.slice(0, 12).join('|')].join('\n')).digest('hex');
      if (fp === st.fingerprint && Date.now() - st.lastAt < baseInterval() * 2) {
        st.skipped++; st.lastSkip = '画面没变'; note('跳过（画面跟上次一样）');
        return { ok: false, skipped: 'same', why: '画面跟上次一样，没新东西' };
      }


      const ocr = clip(lines.join(' / '), Number(cfg.peekMaxChars) || 260);
      const head = `（桌宠｜你刚刚自己瞄了眼主人的屏幕：${p.proc || '某个程序'}`
        + (p.title ? `，窗口是「${clip(p.title, 40)}」` : '')
        + '。';
      const body = ocr ? `屏幕上读到的字：${ocr}。）` : '（看不清上面的字。）';
      const tail = ' 这是你主动搭话，不是主人叫你——想接一句就接，不想接就给个表情。）';
      const text = head + body + tail;

      await deliver(text);
      st.fingerprint = fp;
      st.lastAt = Date.now();
      st.count++;
      st.lastSkip = '';
      note(`已投递 #${st.count}：${p.proc}｜${clip(p.title, 24)}（${lines.length} 行文字）`);
      return { ok: true, delivered: true, proc: p.proc, title: p.title, lines: lines.length };
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
    log(`peek timer started (interval=${baseInterval()}ms, quiet=${cfg.peekQuietFrom}~${cfg.peekQuietTo}, on=${st.on})`);
  }

  function setOn(on) {
    st.on = !!on;
    if (st.on) scheduleNext();
    log('peek switch -> ' + (st.on ? 'on' : 'off'));
    try { onStateChange && onStateChange(state()); } catch {}
    return st.on;
  }

  function stop() { if (ticker) { clearInterval(ticker); ticker = null; } }

  return { start, stop, run, state, setOn, get on() { return st.on; } };
}
