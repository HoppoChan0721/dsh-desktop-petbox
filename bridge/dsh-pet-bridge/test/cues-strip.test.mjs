// 台词里的方括号：认得的当指令演，认得的是「舞台说明」就剥掉，认得像内容的（[1]、[at:1.5]）原样留着。
// 背景：主人 2026-11-11 看到气泡里挂着「[眼神闪烁]」，TTS 还把它念出来了。
import test from 'node:test';
import assert from 'node:assert';
import { parseCues, looksLikeDirection } from '../lib/cues.js';

test('认不出的中文舞台说明被剥掉', () => {
  const r = parseCues('[眼神闪烁] 领主血量掉好快，主人操作越来越熟练了');
  assert.equal(r.text, '领主血量掉好快，主人操作越来越熟练了');
  assert.deepEqual(r.moves, []);
  assert.ok(r.notes.some((n) => n.includes('[眼神闪烁]')));
});

test('全角方头括号一样剥', () => {
  const r = parseCues('【小声】主人在忙');
  assert.equal(r.text, '主人在忙');
});

test('认得的夸奖还是当指令', () => {
  const r = parseCues('[脸红] 好啊');
  assert.equal(r.text, '好啊');
  assert.equal(r.moves.length, 1);
  assert.equal(r.moves[0].kind, 'expression');
  assert.equal(r.moves[0].name, '脸红');
});

test('裸动词现在也认：点头 / 歪头 / nod / tilt', () => {
  assert.equal(parseCues('[点头] 好呀').moves[0].kind, 'nod');
  assert.equal(parseCues('[歪头] 好呀').moves[0].kind, 'tilt');
  assert.equal(parseCues('[nod] 好呀').moves[0].kind, 'nod');
  assert.equal(parseCues('[tilt] 好呀').moves[0].kind, 'tilt');
  assert.equal(parseCues('[点头] 好呀').text, '好呀');
});

test('裸情绪词也认：[pout] 是情绪，不是留在台词里的括号', () => {
  const r = parseCues('[pout][tilt:right]粉丝有安娜好看吗 主人只准夸我一个');
  assert.equal(r.text, '粉丝有安娜好看吗 主人只准夸我一个');
  assert.equal(r.emotion, 'pout');
  assert.equal(r.moves.length, 1);
  assert.equal(r.moves[0].kind, 'tilt');
  assert.equal(r.moves[0].direction, 'right');
});

test('情绪词大小写不敏感，拼错的原样留着', () => {
  assert.equal(parseCues('[POUT] 嗯').emotion, 'pout');
  assert.equal(parseCues('[shy] 嗯').emotion, 'shy');
  assert.equal(parseCues('[pouty] 嗯').emotion, null);
  assert.equal(parseCues('[pouty] 嗯').text, '[pouty] 嗯');
});

test('像内容/像指令的括号绝不吞', () => {
  assert.equal(parseCues('see [1] for details').text, 'see [1] for details');
  assert.equal(parseCues('[at:1.5] 好').text, '好');          // 时间轴被消费掉
  assert.equal(parseCues('array[0] 是第一个').text, 'array[0] 是第一个');
});

test('整句只有说明时把原文留着，不产出空气泡', () => {
  const r = parseCues('[图片]');
  assert.equal(r.text, '[图片]');
  assert.deepEqual(r.notes, []);
});

test('判据本身', () => {
  assert.equal(looksLikeDirection('小声'), true);
  assert.equal(looksLikeDirection('img'), false);
  assert.equal(looksLikeDirection('这就是一个特别特别长的中文句子'), false);
  assert.equal(looksLikeDirection('  '), false);
});
