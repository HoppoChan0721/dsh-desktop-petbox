// stage/mood.js 的自检：node scripts/test-mood.mjs
//
// 心情表是「看得见的情绪」这一层唯一的翻译器，数值错一位主人就看不出区别。
// 这里盯：七种心情齐全、强度只放大偏离量、未知心情退回恬静、表情名跟模型对得上。
import moodModule from '../stage/mood.js';

const { MOODS, plan, names, DEFAULT_INTENSITY, FALLBACK } = moodModule;

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   → ' + extra : '')); }
};

// 模型里真实存在的表情（/state 的 expressions）
const REAL = new Set(['体型1', '体型2', '体型默认', '兔牙', '前倾', '加载', '单片眼镜', '圈圈眼', '尾巴切换',
  '屑屑眼', '流冷汗', '流泪', '爱心眼', '眯眼', '胸衣', '脸红', '裙子切换', '钢盆', '鞋子', '食指伸出',
  '食指收起', '黑框眼镜', '黑脸', '＞＜']);

console.log('心情表');
{
  const want = ['恬静', '开心', '害羞', '撒娇', '担心', '认真', '困'];
  const have = names();
  ok(want.every((n) => have.includes(n)), '七种心情齐全', have.join('/'));
  ok(have.length === 7, '不多不少', String(have.length));
  for (const n of have) {
    const t = moodModule.MOODS[n];
    ok(typeof t.holdMs === 'number' && t.holdMs >= 4000, `保持时长合理：${n}`, String(t.holdMs));
    ok(typeof t.sway === 'number' && t.sway > 0, `摆动倍数有效：${n}`);
    if (t.expression) ok(REAL.has(t.expression), `表情存在：${n} → ${t.expression}`);
  }
}

console.log('强度换算');
{
  const zero = plan('撒娇', 0);
  ok(Math.abs(zero.sway - 1) < 1e-9, '强度 0 → 摆动回到 1 倍', String(zero.sway));
  ok(zero.lean === 0 && zero.tilt === 0, '强度 0 → 不带重心偏置');
  const full = plan('撒娇', 1);
  ok(Math.abs(full.sway - MOODS['撒娇'].sway) < 1e-9, '强度 1 → 表里的原值');
  ok(full.lean === MOODS['撒娇'].lean, '强度 1 → 原重心偏置');
  const half = plan('撒娇', 0.5);
  ok(half.sway > 1 && half.sway < full.sway, '强度 0.5 落在中间', String(half.sway));
  ok(plan('撒娇', 5).sway === full.sway, '强度超过 1 被夹住');
  ok(plan('撒娇', -3).sway === zero.sway, '负强度被夹到 0');
  ok(plan('撒娇', null).sway === plan('撒娇', DEFAULT_INTENSITY).sway, '没给强度用默认值');
  ok(plan('撒娇', undefined).sway === plan('撒娇', DEFAULT_INTENSITY).sway, 'undefined 也用默认值');
  ok(plan('困', 1).expressionMs > plan('困', 0.2).expressionMs, '强度越高表情挂得越久');
  ok(plan('困', 1).holdMs > plan('困', 0.2).holdMs, '强度越高摆动偏置撑得越久');
}
{
  const r = plan('不存在的心情', 0.8);
  ok(r.name === FALLBACK, '未知心情退回恬静', r.name);
  ok(r.known === false, 'known 标记 false');
  ok(r.expression === null && r.sway === 1, '恬静：不换表情、摆动不变');
  ok(plan('害羞', 0.8).known === true, '已知心情 known=true');
}
{
  // 认真/困 更安静，开心/撒娇 更晃——这是「看得出来心情变了」的关键
  const quiet = [plan('认真', 1).sway, plan('困', 1).sway];
  const loud = [plan('开心', 1).sway, plan('撒娇', 1).sway];
  ok(quiet.every((v) => v < 0.8), '认真/困 明显更稳', quiet.join(','));
  ok(loud.every((v) => v > 1.1), '开心/撒娇 明显更晃', loud.join(','));
  ok(plan('害羞', 1).lean > 0, '害羞会往回收一点');
  ok(plan('担心', 1).lean < 0, '担心会缩');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
