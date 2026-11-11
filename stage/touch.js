'use strict';
// 点触账本 + 亲密度 + 分区语气池。
//
// 外壳那套的规则照搬过来，但拆成「纯函数 + 一个记账对象」两层：
//   decide() 不碰文件、不碰时间，可以直接在 node 里测；
//   createTouchBook() 负责落盘（touch.jsonl 流水、touch-stats.json 统计）。
//
// 为什么要记账：
//   1. 亲密度涨了更耐摸（同部位连击阈值从 3 下抬到 4~5 下才翻脸）
//   2. 隔很久没摸，第一下会一惊一乍
//   3. 今天已经被摸很多下，第一下就黏人
// 全都只影响本地反应，不联网。
const fs = require('node:fs');
const path = require('node:path');

// 每个部位的表情用模型自带的那几个，台词一律语气词：
// 语气词是个开口，什么回复都能往下接；写死了后面那条真回复就接不上。
const ZONES = {
  hair: { emotion: '眯眼', lines: ['嘿嘿…', '欸…', '嗯…'] },
  head: { emotion: '眯眼', lines: ['唔…', '嘿嘿…', '嗯…'] },
  neck: { emotion: '＞＜', lines: ['呜…', '唔…', '呀…'] },
  chest: { emotion: '脸红', lines: ['诶…', '呀…', '唔…'] },
  waist: { emotion: '脸红', lines: ['唔…', '哈…', '呃…'] },
  skirt: { emotion: '＞＜', lines: ['哼…', '呃…', '唔…'] },
  leg: { emotion: '＞＜', lines: ['呃…', '哼…', '呜…'] },
  foot: { emotion: '流冷汗', lines: ['呀…', '啊…', '诶…'] },
  body: { emotion: null, lines: ['嗯…', '唔…', '呃…'] },
};

const MANY = {
  head: ['呃…', '唔…'],
  chest: ['呀…', '哼…'],
  skirt: ['哼…', '呃…'],
  leg: ['哼…', '唔…'],
  default: ['呃…', '哼…'],
};
const MISS = ['呀…', '诶…', '唔…'];
const CLINGY = ['嘿嘿…', '嗯…', '唔…'];

const MANY_EMOTION = '＞＜';
const MISS_EMOTION = '流冷汗';
const CLINGY_EMOTION = '脸红';

const TIERS = [1, 40, 150, 450, 1200, 3000];
const DEDUPE_MS = 220;      // 双击只算一下
const CHAIN_MS = 1600;      // 同一个部位这个时间内再摸算连击
const LEDGER_MAX = 256 * 1024;
const KEEP_DAYS = 60;

function dayKey(d) {
  const t = d || new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

function affinityLevel(total) {
  let lv = 0;
  for (const t of TIERS) if (total >= t) lv++;
  return lv;
}

function poolPick(pool, rand) {
  const r = typeof rand === 'function' ? rand() : Math.random();
  const i = Math.min(pool.length - 1, Math.max(0, Math.floor(r * pool.length)));
  return pool[i];
}

// 一次点触该给什么反应。纯函数：count 是「同部位连击到第几下」。
function decide(opts) {
  const o = opts || {};
  const zone = ZONES[o.zone] ? o.zone : 'body';
  const z = ZONES[zone];
  const count = Math.max(1, Math.round(Number(o.count) || 1));
  const aff = o.aff || {};
  const level = Number(aff.level) || 0;
  const manyAt = level >= 6 ? 5 : level >= 4 ? 4 : 3;
  const many = count >= manyAt;
  // 第二下只换表情不出声：连点不会把气泡刷屏
  if (count === 2 && !many) return { zone, emotion: z.emotion, text: '', many: false, tone: 'quiet' };
  let tone = null;
  if (count === 1) {
    const gap = aff.gapHours === null || aff.gapHours === undefined ? null : Number(aff.gapHours);
    if (gap !== null && gap >= 6) tone = 'miss';
    else if (Number(aff.today) >= 15) tone = 'clingy';
  }
  const pool = many ? (MANY[zone] || MANY.default)
    : tone === 'miss' ? MISS
      : tone === 'clingy' ? CLINGY
        : z.lines;
  const emotion = many ? MANY_EMOTION
    : tone === 'miss' ? MISS_EMOTION
      : tone === 'clingy' ? CLINGY_EMOTION
        : z.emotion;
  return { zone, emotion, text: poolPick(pool, o.rand), many, tone };
}

function freshStats() {
  return { total: 0, zoneTotal: {}, days: {}, lastTouchAt: 0, firstAt: 0 };
}

function loadStats(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const j = JSON.parse(raw) || {};
    return { ...freshStats(), ...j };
  } catch (e) { return freshStats(); }
}

// streak：连着几天摸过。今天还没摸不算断（i>0 才允许中断）
function infoOf(stats, now) {
  const t = now || Date.now();
  const today = (stats.days[dayKey(new Date(t))] || { n: 0 }).n;
  const fav = Object.entries(stats.zoneTotal).sort((a, b) => b[1] - a[1])[0];
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    const k = dayKey(new Date(t - i * 86400000));
    const d = stats.days[k];
    if (d && d.n > 0) streak++;
    else if (i > 0) break;
  }
  const gapH = stats.lastTouchAt ? (t - stats.lastTouchAt) / 3600000 : null;
  return {
    level: affinityLevel(stats.total),
    total: stats.total,
    today,
    streak,
    favorite: fav ? fav[0] : '',
    favoriteN: fav ? fav[1] : 0,
    gapHours: gapH === null ? null : Math.round(gapH * 10) / 10,
    lastTouchAt: stats.lastTouchAt || null,
    firstTouchAt: stats.firstAt || null,
  };
}

function createTouchBook(opts) {
  const o = opts || {};
  const dir = o.dir;
  const now = o.now || (() => Date.now());
  const rand = o.rand;
  const ledgerFile = path.join(dir, 'touch.jsonl');
  const statsFile = path.join(dir, 'touch-stats.json');
  let stats = loadStats(statsFile);
  let seq = 0;                      // 每次启动从 1 数，跟外壳那套一致
  let lastTap = 0;
  let chain = { zone: '', count: 0, at: 0 };

  function saveStats() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statsFile, JSON.stringify(stats));
    } catch (e) {}
  }

  // 一条一行，超过 256KB 轮转一份，避免无限长
  function appendLedger(ev) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      let size = 0;
      try { size = fs.statSync(ledgerFile).size; } catch (e) {}
      if (size > LEDGER_MAX) { try { fs.renameSync(ledgerFile, ledgerFile + '.1'); } catch (e) {} }
      fs.appendFileSync(ledgerFile, JSON.stringify(ev) + '\n');
    } catch (e) {}
  }

  function record(payload) {
    const t = now();
    if (payload === false) return null;                       // 交互关掉的显式空操作
    if (t - lastTap < DEDUPE_MS) return null;
    lastTap = t;
    const p = payload || {};
    const zone = ZONES[p.zone] ? p.zone : 'body';
    if (chain.zone === zone && t - chain.at < CHAIN_MS) chain.count++;
    else { chain = { zone, count: 1, at: t }; }
    chain.at = t;

    const before = infoOf(stats, t);
    const ev = {
      ts: new Date(t).toISOString(),
      seq: ++seq,
      zone,
      nx: Number.isFinite(Number(p.nx)) ? Number(p.nx) : null,
      ny: Number.isFinite(Number(p.ny)) ? Number(p.ny) : null,
      calibrated: !!p.calibrated,
    };
    appendLedger(ev);

    const k = dayKey(new Date(t));
    const d = stats.days[k] || (stats.days[k] = { n: 0, zones: {} });
    d.n++;
    d.zones[zone] = (d.zones[zone] || 0) + 1;
    stats.total++;
    stats.zoneTotal[zone] = (stats.zoneTotal[zone] || 0) + 1;
    stats.lastTouchAt = t;
    if (!stats.firstAt) stats.firstAt = t;
    const keys = Object.keys(stats.days).sort();
    while (keys.length > KEEP_DAYS) delete stats.days[keys.shift()];
    saveStats();

    const aff = { ...infoOf(stats, t), gapHours: before.gapHours };
    const reaction = decide({ zone, count: chain.count, aff, rand });
    return { ev, reaction, aff, count: chain.count };
  }

  return {
    record,
    info: () => infoOf(stats, now()),
    ledgerFile,
    statsFile,
    get stats() { return stats; },
  };
}

module.exports = {
  ZONES,
  MANY,
  MISS,
  CLINGY,
  TIERS,
  DEDUPE_MS,
  CHAIN_MS,
  dayKey,
  affinityLevel,
  decide,
  infoOf,
  createTouchBook,
};
