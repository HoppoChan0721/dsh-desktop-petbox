// 系统输入空闲采样器：Windows 上问一次「键鼠多久没动了」。
//
// 为什么需要它：情绪账本里的「多久没人理」原来按墙钟算，睡八小时等于八小时没人理，
// 一觉醒来情绪一次性崩掉。要分清「人不在」和「人在但没碰她」，唯一可靠的判据是
// 系统输入空闲时长——打游戏四小时不理她算冷落，睡了八小时不算。
//
// 采样很轻：一个短命 PowerShell 进程问一次 GetLastInputInfo。默认 90 秒一次，
// 睡和醒都以分钟计，精度够用，也不占 CPU。
//
// 拿不到就如实返回 -1，调用方按「不知道」处理，绝不假装有人在。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'input-idle.ps1');

/**
 * @param {object} [opts]
 * @param {number} [opts.intervalMs] 采样间隔，默认 90 秒
 * @param {(msg: string) => void} [opts.log]
 * @param {Function} [opts.spawnFn] 测试用注入
 */
export function createInputProbe({ intervalMs = 90 * 1000, log = () => {}, spawnFn = spawn } = {}) {
  let idleMs = -1;
  let sampledAt = 0;
  let timer = null;
  let running = false;
  let stopped = false;

  function sample() {
    if (running || stopped) return;
    running = true;
    let child;
    try {
      child = spawnFn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch (e) {
      running = false;
      log('input-probe: spawn failed: ' + (e && e.message));
      return;
    }
    let out = '';
    const killTimer = setTimeout(() => {
      try { child.kill(); } catch {}
    }, 10000);
    if (child.stdout) {
      child.stdout.on('data', (d) => {
        if (out.length < 4096) out += d;
      });
    }
    const done = () => {
      clearTimeout(killTimer);
      running = false;
      const m = /"idleMs"\s*:\s*(-?\d+)/.exec(out);
      if (m) {
        const v = Number(m[1]);
        if (Number.isFinite(v) && v >= 0) {
          idleMs = v;
          sampledAt = Date.now();
        }
      }
    };
    child.on('error', (e) => {
      log('input-probe: ' + (e && e.message));
      done();
    });
    child.on('close', done);
  }

  return {
    start() {
      if (timer || stopped) return;
      sample();
      timer = setInterval(sample, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** @returns {{idleMs: number, sampledAt: number}} sampledAt 为 0 表示还没采到过 */
    current() {
      return { idleMs, sampledAt };
    },
    sample,
  };
}
