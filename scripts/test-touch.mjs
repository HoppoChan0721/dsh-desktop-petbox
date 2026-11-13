// stage/touch.js 的自检：node scripts/test-touch.mjs
//
// 点触反应是纯函数，可以脱离 Electron 直接喂数据。
// 这里盯的是几件容易悄悄坏掉的事：
//   1. 第二下只换表情不出声（连点不刷气泡）
//   2. 连击到第几下翻脸，跟亲密度挂钩（Lv.4 / Lv.6 更耐摸）
//   3. 隔久没摸、今天被摸太多这两种语境只作用于第一下
//   4. 账本真的落盘、双击不重复记、统计对得上
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import touchModule from '../stage/touch.js';

const { ZONES, ZONE_LABEL, MANY, MISS, CLINGY, decide, affinityLevel, dayKey, infoOf, createTouchBook, TIERS } = touchModule;

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   → ' + extra : '')); }
};

console.log('decide：部位表情与语气词');
{
  const r = decide({ zone: 'head', count: 1, aff: { level: 0, today: 0, gapHours: 1 }, rand: () => 0 });
  ok(r.zone === 'head', 'zone 原样返回');
  ok(r.emotion === ZONES.head.emotion, '部位默认表情', r.emotion);
  ok(ZONES.head.lines.includes(r.text), '台词取自该部位池', r.text);
  ok(r.tone === null && r.many === false, '第一下没有语境、不算翻脸');
}
{
  const r = decide({ zone: 'head', count: 2, aff: { level: 0, today: 3, gapHours: 1 } });
  ok(r.text === '', '第二下不出声（只换表情）');
  ok(r.emotion === ZONES.head.emotion, '第二下表情不变');
  ok(r.tone === 'quiet', 'tone 标记 quiet', r.tone);
}
{
  const r = decide({ zone: 'head', count: 3, aff: { level: 0, today: 3, gapHours: 1 }, rand: () => 0.99 });
  ok(r.many === true, 'Lv.0 第三下翻脸');
  ok(MANY.head.includes(r.text), '翻脸台词走 MANY 池', r.text);
  ok(r.emotion === '＞＜', '翻脸表情');
}
{
  const r = decide({ zone: 'head', count: 3, aff: { level: 4, today: 3, gapHours: 1 } });
  ok(r.many === false, 'Lv.4 第三下还不翻脸');
  const r4 = decide({ zone: 'head', count: 4, aff: { level: 4, today: 3, gapHours: 1 } });
  ok(r4.many === true, 'Lv.4 第四下翻脸');
  const r5 = decide({ zone: 'head', count: 4, aff: { level: 6, today: 3, gapHours: 1 } });
  ok(r5.many === false, 'Lv.6 第四下还不翻脸');
  const r6 = decide({ zone: 'head', count: 5, aff: { level: 6, today: 3, gapHours: 1 } });
  ok(r6.many === true, 'Lv.6 第五下翻脸');
}
{
  const r = decide({ zone: 'chest', count: 1, aff: { level: 2, today: 2, gapHours: 7.5 }, rand: () => 0 });
  ok(r.tone === 'miss', '隔 6 小时以上：一惊一乍', r.tone);
  ok(MISS.includes(r.text), '走 MISS 池', r.text);
  ok(r.emotion === '流冷汗', '一惊一乍表情');
}
{
  const r = decide({ zone: 'chest', count: 1, aff: { level: 2, today: 16, gapHours: 0.2 }, rand: () => 0 });
  ok(r.tone === 'clingy', '今天被摸 15 下以上：黏人', r.tone);
  ok(CLINGY.includes(r.text), '走 CLINGY 池', r.text);
  ok(r.emotion === '脸红', '黏人表情');
}
{
  const r = decide({ zone: 'chest', count: 2, aff: { level: 2, today: 16, gapHours: 9 } });
  ok(r.tone === 'quiet', '语境只作用于第一下', r.tone);
  const many = decide({ zone: 'chest', count: 3, aff: { level: 2, today: 16, gapHours: 9 } });
  ok(many.tone === null && many.many, '翻脸优先于语境');
}
{
  const r = decide({ zone: 'necklace', count: 1, aff: {} });
  ok(r.zone === 'body', '未知部位退回 body');
  ok(typeof r.text === 'string' && r.text.length > 0, 'body 也有台词', r.text);
  const a = decide({ zone: 'leg', count: 1, aff: {}, rand: () => 0 });
  const b = decide({ zone: 'leg', count: 1, aff: {}, rand: () => 0.999 });
  ok(a.text === ZONES.leg.lines[0] && b.text === ZONES.leg.lines[ZONES.leg.lines.length - 1], 'rand 落到池子两端');
}
{
  // 真部件判定把部位切细了：新加的这几个各有各的台词池，也各有一个中文名给桥用
  for (const z of ['ear', 'tail', 'hand', 'arm']) {
    ok(!!ZONES[z] && !!ZONE_LABEL[z], `新部位可用：${z}`, z);
    const r = decide({ zone: z, count: 1, aff: {}, rand: () => 0 });
    ok(r.zone === z && r.emotion === ZONES[z].emotion, `走自己的池子：${z}`, r.zone);
  }
  ok(Object.keys(ZONE_LABEL).length >= Object.keys(ZONES).length, '每个部位都有中文名');
}
{
  for (const z of Object.keys(ZONES)) {
    const r = decide({ zone: z, count: 1, aff: {} });
    ok(!!r.text && r.text.length <= 6, `池子可用：${z}`);
  }
}

console.log('亲密度数值');
{
  ok(affinityLevel(0) === 0, '0 下是 Lv.0');
  ok(affinityLevel(TIERS[0]) === 1, '第 1 下升 Lv.1');
  ok(affinityLevel(TIERS[TIERS.length - 1]) === TIERS.length, '满档 Lv.' + TIERS.length);
  ok(affinityLevel(99999) === TIERS.length, '再多也不越界');
  const k = dayKey(new Date(2026, 10, 11, 9, 5));
  ok(k === '2026-11-11', 'dayKey 补零', k);
}

console.log('记账');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-touch-'));
  let t = new Date(2026, 10, 11, 12, 0, 0).getTime();
  const book = createTouchBook({ dir, now: () => t, rand: () => 0 });
  const a = book.record({ zone: 'head', nx: 0.5, ny: 0.1, calibrated: true });
  ok(!!a && a.ev.seq === 1, '第一笔记下了');
  ok(a.ev.zone === 'head' && a.ev.calibrated === true, '流水字段完整');
  ok(book.stats.total === 1, 'total 累加');
  const dup = book.record({ zone: 'head' });
  ok(dup === null, '220ms 内的第二下不算');
  t += 500;
  const b = book.record({ zone: 'head' });
  ok(!!b && b.count === 2, '隔 500ms 同部位算连击第 2 下', b && b.count);
  ok(b.reaction.text === '', '连击第 2 下不出声');
  t += 500;
  const c = book.record({ zone: 'head' });
  ok(c.count === 3 && c.reaction.many === true, '第 3 下翻脸', c.count);
  t += 5000;
  const d = book.record({ zone: 'leg' });
  ok(d.count === 1, '过了 1.6 秒连击断掉', d.count);
  ok(d.ev.seq === 4, 'seq 连续', d.ev.seq);

  const led = fs.readFileSync(path.join(dir, 'touch.jsonl'), 'utf8').split('\n').filter(Boolean);
  ok(led.length === 4, '流水一行一条', String(led.length));
  const first = JSON.parse(led[0]);
  ok(first.ts === '2026-11-11T04:00:00.000Z', 'ts 是 ISO（本地 12 点 = UTC 4 点）', first.ts);
  const st = JSON.parse(fs.readFileSync(path.join(dir, 'touch-stats.json'), 'utf8'));
  ok(st.total === 4 && st.zoneTotal.head === 3 && st.zoneTotal.leg === 1, '统计按部位累计');
  ok(st.days['2026-11-11'].n === 4, '按天累计');

  const info = book.info();
  ok(info.level === 1, '4 下已经是 Lv.1', String(info.level));
  ok(info.today === 4 && info.streak === 1, '今天 4 下、连 1 天', `${info.today}/${info.streak}`);
  ok(info.favorite === 'head' && info.favoriteN === 3, '最爱被摸的部位');
  ok(typeof info.gapHours === 'number' && info.gapHours === 0, '间隔按毫秒算出来');
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // 重启后统计不能清零：同一份文件重新加载继续累加
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-touch-'));
  let t = new Date(2026, 10, 11, 12, 0, 0).getTime();
  const one = createTouchBook({ dir, now: () => t });
  one.record({ zone: 'hair' });
  const two = createTouchBook({ dir, now: () => t + 60000 });
  ok(two.stats.total === 1, '重启读回旧账', String(two.stats.total));
  two.record({ zone: 'hair' });
  ok(two.stats.total === 2, '继续往上加');
  fs.rmSync(dir, { recursive: true, force: true });
}
{
  // streak：昨天摸过、今天没摸，算连；昨天没摸就断
  const stats = { total: 5, zoneTotal: { head: 5 }, days: {}, lastTouchAt: 0, firstAt: 0 };
  stats.days[dayKey(new Date(2026, 10, 10))] = { n: 2, zones: {} };
  stats.days[dayKey(new Date(2026, 10, 9))] = { n: 1, zones: {} };
  const info = infoOf(stats, new Date(2026, 10, 11, 9, 0, 0).getTime());
  ok(info.streak === 2, '今天还没摸不断签', String(info.streak));
  stats.days[dayKey(new Date(2026, 10, 7))] = { n: 3, zones: {} };
  const info2 = infoOf(stats, new Date(2026, 10, 11, 9, 0, 0).getTime());
  ok(info2.streak === 2, '中间断了就不再往前数', String(info2.streak));
  const info3 = infoOf(stats, new Date(2026, 10, 12, 9, 0, 0).getTime());
  ok(info3.streak === 0, '隔天没摸就断', String(info3.streak));
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
