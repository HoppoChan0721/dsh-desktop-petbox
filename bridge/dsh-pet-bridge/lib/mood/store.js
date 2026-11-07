// 情绪状态的落盘 —— 原子写 + 版本迁移 + 坏文件自愈。
//
// 一条铁律：状态文件坏掉不能让插件起不来。读到坏 JSON 就重置成空账本并记一行日志，
// 情绪丢了是小，桥挂了是大。
//
// 版本迁移：文件里带 schemaVersion。版本不认识时先试迁移函数，迁移失败就重置。
// 以后改结构，只需要往 MIGRATIONS 里加一条，别去改 load 的流程。

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createState, tick } from './engine.js';
import { SCHEMA_VERSION } from './profile.js';

// 从版本 N 升到 N+1 的函数。目前只有 1，留着给别人加。
const MIGRATIONS = {
  // 1: (state) => ({ ...state, schemaVersion: 2, ... })
};

/** 把旧结构搬到当前版本。搬不动返回 null。 */
function migrate(raw) {
  let state = raw;
  let guard = 0;
  while (state && state.schemaVersion !== SCHEMA_VERSION && guard++ < 20) {
    const fn = MIGRATIONS[state.schemaVersion];
    if (typeof fn !== 'function') return null;
    try {
      state = fn(state);
    } catch {
      return null;
    }
  }
  return state && state.schemaVersion === SCHEMA_VERSION ? state : null;
}

/**
 * @param {object} opts
 * @param {string} opts.file        状态文件绝对路径，留空 = 不落盘，只在内存里
 * @param {object} opts.profile     情绪定义表
 * @param {(msg: string) => void} [opts.log]
 */
export function createStore({ file, profile, log = () => {} }) {
  function blank(now) {
    return createState(profile, now);
  }

  /** 读状态。文件不存在、坏掉、版本不认识 → 都给一份干净的空账本。 */
  function load(now = Date.now()) {
    if (!file) return blank(now);
    let raw;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      if (e && e.code !== 'ENOENT') log('mood: state unreadable, starting fresh: ' + e.message);
      return blank(now);
    }
    const state = migrate(raw);
    if (!state) {
      log('mood: unknown schemaVersion ' + (raw && raw.schemaVersion) + ', starting fresh');
      return blank(now);
    }
    // 补上 profile 里新增、但旧文件里没有的情绪名
    for (const name of Object.keys(profile.emotions)) {
      if (!state.emotions[name]) state.emotions[name] = { value: 0, at: now };
    }
    // 老状态文件里没有这两样，读的时候补齐，别让升级过的桥去读旧文件就崩
    if (!Array.isArray(state.moments)) state.moments = [];
    if (!state.urges || typeof state.urges !== 'object') state.urges = {};
    return state;
  }

  /** 原子写：先写临时文件再 rename，半截文件永远不会被读到。 */
  function save(state) {
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify(state), 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      log('mood: save failed: ' + (e && e.message));
    }
  }

  /** 清空。给「彻底重来」和调试用。真要清之前先调 backup。 */
  function reset(now = Date.now()) {
    const fresh = blank(now);
    save(fresh);
    return fresh;
  }

  /**
   * 把现在的账本另存一份。给「彻底重来」用——点错了还能捞回来。
   * 只留最近一份，不做历史版本：这不是备份系统，是后悔药。
   */
  function backup() {
    if (!file) return '';
    const bak = file + '.bak';
    try {
      writeFileSync(bak, readFileSync(file, 'utf8'), 'utf8');
      return bak;
    } catch (e) {
      log('mood: backup failed: ' + (e && e.message));
      return '';
    }
  }

  /** 有没有可恢复的备份。 */
  function hasBackup() {
    if (!file) return false;
    try { return existsSync(file + '.bak'); } catch { return false; }
  }

  /** 从备份恢复。版本不认识就当没有，别把一份坏数据写回去。 */
  function restore() {
    if (!file) return { ok: false, error: 'no file' };
    const bak = file + '.bak';
    try {
      const state = migrate(JSON.parse(readFileSync(bak, 'utf8')));
      if (!state) return { ok: false, error: '备份版本不认识' };
      for (const name of Object.keys(profile.emotions)) {
        if (!state.emotions[name]) state.emotions[name] = { value: 0, at: 0 };
      }
      if (!Array.isArray(state.moments)) state.moments = [];
      if (!state.urges || typeof state.urges !== 'object') state.urges = {};
      save(state);
      return { ok: true, state };
    } catch (e) {
      return { ok: false, error: e.message || '备份读不出来' };
    }
  }

  /**
   * 读出来顺手结算一次衰减并存回去。
   * 重启后第一次读走这条，等于把停机那段时间的衰减补上。
   */
  function open(now = Date.now()) {
    const state = tick(load(now), profile, now);
    save(state);
    return state;
  }

  return { load, save, reset, open, backup, hasBackup, restore, get file() { return file; } };
}
