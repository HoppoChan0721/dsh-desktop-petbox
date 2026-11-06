// 外置调参：别人拉下仓库想改她的脾气，不该去改代码。
//
//   node --test test/mood-profile.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PROFILE, mergeProfile, isValidProfile } from '../lib/mood/profile.js';
import { createMood } from '../lib/mood/index.js';

const T0 = 1700000000000;

function tmpJson(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'moodp-'));
  const file = join(dir, 'profile.json');
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
  return { file, dir };
}

test('不写 patch 就原样用默认表', () => {
  assert.equal(mergeProfile(DEFAULT_PROFILE, null), DEFAULT_PROFILE);
  assert.equal(mergeProfile(DEFAULT_PROFILE, {}).emotions, DEFAULT_PROFILE.emotions);
});

test('改一条规则的金额，别的都留着', () => {
  const merged = mergeProfile(DEFAULT_PROFILE, {
    rules: DEFAULT_PROFILE.rules.map((r) => (r.id === 'idle-away' ? { ...r, delta: 0.2 } : r)),
  });
  const rule = merged.rules.find((r) => r.id === 'idle-away');
  assert.equal(rule.delta, 0.2);
  assert.equal(merged.rules.length, DEFAULT_PROFILE.rules.length);
});

test('加一种情绪，不用把别的情绪重写一遍', () => {
  const merged = mergeProfile(DEFAULT_PROFILE, {
    emotions: { jealous: { halfLife: 24, polarity: -1, drives: ['tone'], label: '吃醋' } },
  });
  assert.ok(merged.emotions.jealous, '新情绪要在');
  assert.ok(merged.emotions.joy, '老情绪也得在');
  assert.equal(merged.emotions.joy.halfLife, DEFAULT_PROFILE.emotions.joy.halfLife);
});

test('数组是整体替换，不拼接', () => {
  const merged = mergeProfile(DEFAULT_PROFILE, { tiers: [{ name: 'calm' }, { name: 'cold' }] });
  assert.equal(merged.tiers.length, 2);
});

test('值是 null 就删掉原来的键', () => {
  const merged = mergeProfile(DEFAULT_PROFILE, { emotions: { worried: null } });
  assert.equal('worried' in merged.emotions, false);
});

test('合出来的表要有最低限度的完整性', () => {
  assert.equal(isValidProfile(DEFAULT_PROFILE), true);
  // 空对象是「不覆盖」，合出来还是完整的；要测删空得用 null
  assert.equal(isValidProfile(mergeProfile(DEFAULT_PROFILE, { emotions: {} })), true);
  assert.equal(isValidProfile(mergeProfile(DEFAULT_PROFILE, { emotions: null })), false);
  assert.equal(isValidProfile(mergeProfile(DEFAULT_PROFILE, { tiers: [] })), false);
  assert.equal(isValidProfile(null), false);
});

test('门面能把外置表读进来', () => {
  const { file, dir } = tmpJson({ emotions: { joy: { label: '雀跃' } } });
  try {
    const mood = createMood({ file: '', profileFile: file, log: () => {}, now: () => T0 });
    assert.equal(mood.profile.emotions.joy.label, '雀跃');
    assert.equal(mood.profile.emotions.joy.halfLife, DEFAULT_PROFILE.emotions.joy.halfLife, '没写的字段沿用默认');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('外置表写坏了就用默认，不抛错', () => {
  const { file, dir } = tmpJson('{ 坏掉的 json');
  try {
    const seen = [];
    const mood = createMood({ file: '', profileFile: file, log: (m) => seen.push(m), now: () => T0 });
    assert.equal(mood.profile.emotions.joy.label, DEFAULT_PROFILE.emotions.joy.label);
    assert.ok(seen.some((m) => m.includes('unreadable')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('外置表把情绪删空了也退回默认', () => {
  const { file, dir } = tmpJson({ emotions: null });
  try {
    const seen = [];
    const mood = createMood({ file: '', profileFile: file, log: (m) => seen.push(m), now: () => T0 });
    assert.ok(Object.keys(mood.profile.emotions).length > 0);
    assert.ok(seen.some((m) => m.includes('unusable')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
