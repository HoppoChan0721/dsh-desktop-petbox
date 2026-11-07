// 「哄好」和「彻底重来」的自检。
//
// 这两件事以前是同一件：菜单写着哄好，实际把整本账洗了，连亲近度一起归零。
// 现在分开了，这里钉住区别：
//   · 哄好只清负面，亲近和好心情留着，没说完的一阵话掐掉
//   · 彻底重来才全清，但清之前留备份，能捞回来
//   · 没备份的时候恢复要如实失败，不能装作成功

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { createMood } from '../lib/mood/index.js';

const T0 = 1700000000000;
const hour = (n) => n * 3600000;
const DIR = join(import.meta.dirname, '.tmp-calm');

after(() => { rmSync(DIR, { recursive: true, force: true }); });

test('哄好只清负面，亲近留着', () => {
  let t = T0;
  const m = createMood({ file: '', log: () => {}, now: () => t });
  m.speech('在的', t);                       // 亲近 +0.06，开心 +0.4
  const bond = m.snapshot(t).values.bond;
  assert.ok(bond > 0.05);

  // 六小时没人理，委屈攒起来
  t += hour(6);
  m.tick(t);
  assert.ok(m.snapshot(t).values.upset > 0.1, '先得有点负面，不然这条测了个寂寞');

  const r = m.calm(t);
  assert.ok(r.cleared.includes('upset'), '要说清清了哪些');

  const snap = m.snapshot(t);
  assert.equal(snap.values.upset, 0);
  assert.equal(snap.values.anger, 0);
  assert.equal(snap.tier, 'calm', '档位该从冷战或不痛快回到平静');
  assert.ok(Math.abs(snap.values.bond - bond) < 0.01, '亲近度是攒出来的，不该被哄一下抹掉');
});

test('哄好了就不再接着念', () => {
  const t = T0;
  const m = createMood({ file: '', log: () => {}, now: () => t });
  m.markUrge({ window: 'sulky-nudge', step: 0, nextStepAt: t + 180000 }, t);
  assert.ok(m.state(t).urge.burst, '先说清她正说在一阵中间');

  m.calm(t + 1000);
  assert.equal(m.state(t + 1000).urge.burst, null, '哄好了还念第三句，那不是人');
});

test('彻底重来会留备份，而且能恢复', () => {
  const file = join(DIR, 'backup.json');
  const m = createMood({ file, log: () => {}, now: () => T0 });
  m.speech('在的', T0);
  const bond = m.snapshot(T0).values.bond;
  assert.ok(bond > 0.05);

  const r = m.resetAll(T0 + 1000);
  assert.ok(r.backup && r.backup.endsWith('.bak'), '清之前要先存一份');
  assert.equal(existsSync(r.backup), true, '备份真的落到盘上了');
  assert.equal(m.snapshot(T0 + 1000).values.bond, 0, '彻底重来连关系一起归零');
  assert.equal(m.hasBackup(), true);

  const back = m.restoreBackup(T0 + 2000);
  assert.equal(back.ok, true);
  assert.ok(m.snapshot(T0 + 2000).values.bond > bond * 0.9, '亲近度捞回来了');
});

test('没有备份时恢复如实失败，不装作成功', () => {
  const m = createMood({ file: join(DIR, 'nothing.json'), log: () => {}, now: () => T0 });
  const r = m.restoreBackup(T0);
  assert.equal(r.ok, false);
  assert.ok(r.error, '要给出原因');
});

test('状态里带一个 backup 字段，托盘靠它决定显不显示恢复', () => {
  const m = createMood({ file: join(DIR, 'flag.json'), log: () => {}, now: () => T0 });
  assert.equal(m.state(T0).backup, false, '还没清过，没有备份');
  m.resetAll(T0 + 1000);
  assert.equal(m.state(T0 + 1000).backup, true, '清过之后该有');
});
