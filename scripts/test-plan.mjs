// stage/plan.js 的自检：node scripts/test-plan.mjs
//
// 桥砸过来的 plan 只有一部分能演。认错的代价是「看起来演了其实没演」，
// 所以这里盯两件事：该认的都认了，认不出的老实进 skipped。
import planModule from '../stage/plan.js';

const { toCommands, GESTURE_MOTION } = planModule;

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   → ' + extra : '')); }
};

console.log('单步映射');
{
  const r = toCommands({ title: 't', actions: [{ kind: 'expression', name: '脸红', duration: 3 }] });
  ok(r.commands.length === 1 && r.commands[0].type === 'emotion', '表情 → emotion 指令');
  ok(r.commands[0].name === '脸红' && r.commands[0].ms === 3000, '名字和时长都对');
  ok(r.applied[0] === 'expression:脸红', 'applied 记账');
  ok(r.title === 't', 'title 透传');
}
{
  const r = toCommands({ actions: [{ kind: 'expression', name: '眯眼' }] });
  ok(r.commands[0].ms === 2600, '没给时长就用 2.6 秒');
}
{
  const r = toCommands({ actions: [{ kind: 'motion', name: 'HandRaise', hold: true }] });
  ok(r.commands[0].type === 'motion' && r.commands[0].hold === true, '动作 → motion，hold 保留');
}
{
  const r = toCommands({ actions: [
    { kind: 'gesture', name: 'hand_on_chest' },
    { kind: 'gesture', name: 'point' },
    { kind: 'gesture', name: 'grass' },
  ] });
  ok(r.commands.map((c) => c.name).join(',') === 'HandRaise,FingerShow,GrassOn', '手势映射到模型动作', r.commands.map((c) => c.name).join(','));
  ok(Object.keys(GESTURE_MOTION).length === 3, '映射表就三条');
}
{
  const r = toCommands({ actions: [{ kind: 'gesture', name: 'nod' }, { kind: 'gesture', name: 'shake' }] });
  ok(r.commands[0].type === 'nod' && r.commands[1].type === 'shake', '点头/摇头走冲量指令');
}
{
  const r = toCommands({ actions: [{ kind: 'pose', values: { AngleX: 4 } }, { kind: 'trajectory', frames: [] }] });
  ok(r.commands.length === 0, 'pose/trajectory 不硬演');
  ok(r.skipped.length === 2, '但都记进 skipped', r.skipped.join(','));
  ok(r.skipped[0].indexOf('pose') === 0, 'skipped 带类型名', r.skipped[0]);
}
{
  const r = toCommands({ actions: [{ kind: 'expression' }, { kind: 'motion' }, { kind: 'gesture', name: 'wave' }, {}, null] });
  ok(r.commands.length === 0, '缺名字的一个都不发');
  ok(r.skipped.length === 3, '缺名字的也记下来', r.skipped.join(','));
}
{
  const r = toCommands({});
  ok(r.commands.length === 0 && r.skipped.length === 0, '空 plan 不炸');
  ok(toCommands(null).commands.length === 0, 'null 不炸');
  ok(toCommands({ actions: 'nope' }).commands.length === 0, 'actions 不是数组也不炸');
}
{
  const r = toCommands({ actions: [
    { kind: 'expression', name: '爱心眼', duration: 2 },
    { kind: 'gesture', name: 'point' },
    { kind: 'trajectory', frames: [] },
  ] });
  ok(r.commands.length === 2, '混着来：能演的照演');
  ok(r.skipped.length === 1 && r.skipped[0].indexOf('trajectory') === 0, '演不了的那条单独列出');
  ok(r.applied.length === 2, 'applied 只算真发出去的');
}

console.log('语义动作（台词里 [点头] [歪头] [看一眼] 这些）');
{
  const r = toCommands({ actions: [
    { kind: 'nod', count: 2 },
    { kind: 'shake_head', count: 2 },
    { kind: 'tilt', direction: 'left', duration: 1.8 },
    { kind: 'look', direction: 'up', duration: 1.2 },
    { kind: 'blink', side: 'both' },
    { kind: 'smile' },
    { kind: 'talk', duration: 2.4 },
  ] });
  ok(r.commands.map((c) => c.type).join(',') === 'nod,shake,tilt,look,blink,smile,talk', '七种语义动作都能翻', r.commands.map((c) => c.type).join(','));
  ok(r.commands[2].direction === 'left', '歪头方向保留');
  ok(r.commands[3].direction === 'up', '看的方向保留');
  ok(r.commands[2].ms === 1800, '歪头时长按秒换算成毫秒');
  ok(r.skipped.length === 0, '一个都没被跳过');
}
{
  const r = toCommands({ actions: [{ kind: 'look', direction: 'somewhere' }] });
  ok(r.commands[0].direction === 'center', '认不出的方向退回 center');
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
