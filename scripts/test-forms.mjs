// stage/forms.js 的自检：node scripts/test-forms.mjs
//
// 盯两件事：
//   1. exp3 里只改 Clothes 的表情要认成「换装」，碰了 key* / LeanInput 的一个都不许认；
//   2. 一句话里的动作要拆对道：[鞋子][脸红][前倾] 三条同帧下发，
//      换装的进形态层、表情进表情层，谁都不许被顶掉。
import formsModule from '../stage/forms.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { formKinds, splitMoves } = formsModule;

let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '   → ' + extra : '')); }
};

// 造一个假模型目录：三份换装表情 + 两个普通表情
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forms-test-'));
const exp = path.join(dir, 'Exp3');
fs.mkdirSync(exp);
const write = (name, params) => fs.writeFileSync(path.join(exp, name + '.exp3.json'), JSON.stringify({ Type: 'Live2D Expression', Parameters: params }));
write('鞋子', [{ Id: 'Clothes4', Value: 1, Blend: 'Add' }]);
write('裙子切换', [{ Id: 'Clothes1', Value: -1, Blend: 'Add' }]);
write('体型2', [{ Id: 'Clothes2', Value: 1, Blend: 'Add' }]);
write('脸红', [{ Id: 'key7', Value: 1, Blend: 'Add' }]);
write('前倾', [{ Id: 'LeanInput', Value: -30, Blend: 'Add' }]);
// 一个「混着来」的：既改衣服又改眼睛，不算换装
write('半吊子', [{ Id: 'Clothes6', Value: 1, Blend: 'Add' }, { Id: 'key3', Value: 0, Blend: 'Add' }]);
// 坏文件不该把整张表弄挂
fs.writeFileSync(path.join(exp, '坏的.exp3.json'), '{ 不是 json');

try {
  console.log('归类：只改 Clothes 的才算换装');
  const kinds = formKinds(dir);
  ok(kinds.get('鞋子') === 'outfit', '鞋子 → 换装');
  ok(kinds.get('裙子切换') === 'outfit', '裙子切换 → 换装');
  ok(kinds.get('体型2') === 'body', '体型2 → 体型（要跟着对齐脚底）');
  ok(kinds.get('脸红') === undefined, '脸红不是换装');
  ok(kinds.get('前倾') === undefined, '前倾不是换装');
  ok(kinds.get('半吊子') === undefined, '混着改眼睛的不算换装');
  ok(kinds.has('坏的') === false, '坏文件跳过，不炸');
  ok(formKinds(path.join(dir, '没有这个目录')).size === 0, '目录不存在照样返回空表');

  const kindOf = (n) => kinds.get(n) || null;

  console.log('拆分：一句里三条标签各走各的道');
  {
    const moves = [
      { kind: 'expression', name: '鞋子', at: 0, duration: 2.6 },
      { kind: 'expression', name: '脸红', at: 0, duration: 2.6 },
      { kind: 'expression', name: '前倾', at: 0, duration: 2.6 },
    ];
    const r = splitMoves(moves, kindOf);
    ok(r.outfit.join(',') === '鞋子', '鞋子进形态层', r.outfit.join(','));
    ok(r.body.length === 0, '没有体型标签就不动体型');
    ok(r.exprs.map((e) => e.name).join(',') === '脸红,前倾', '脸红和前倾一起挂，谁都没被顶掉', r.exprs.map((e) => e.name).join(','));
    ok(r.exprs[0].ms === 2600, '没给时长按 2.6 秒算');
    ok(r.plain.length === 0, '没有别的动作');
  }
  {
    const moves = [
      { kind: 'expression', name: '体型2', at: 0, duration: 2.6 },
      { kind: 'gesture', name: 'point', at: 0 },
      { kind: 'nod', count: 2, at: 0 },
    ];
    const r = splitMoves(moves, kindOf);
    ok(r.body.join(',') === '体型2', '体型标签单独一摞');
    ok(r.plain.length === 2, '手势和点头留在排期里', String(r.plain.length));
  }
  {
    const moves = [
      { kind: 'expression', name: '鞋子', at: 0 },
      { kind: 'expression', name: '鞋子', at: 0 },
    ];
    const r = splitMoves(moves, kindOf);
    ok(r.outfit.length === 1, '同一句里重复的换装只挂一次', String(r.outfit.length));
  }
  {
    const moves = [{ kind: 'expression', name: '鞋子', at: 2, duration: 2.6 }];
    const r = splitMoves(moves, kindOf);
    ok(r.outfit.length === 0 && r.plain.length === 1, '带 at 的换装不进形态层，按排期走');
  }
  {
    const moves = [{ kind: 'expression', name: '爱心眼', at: 0, duration: 3 }];
    const r = splitMoves(moves, kindOf);
    ok(r.exprs.length === 1 && r.exprs[0].ms === 3000, '普通表情按自己的时长挂');
  }
  {
    ok(splitMoves(null, kindOf).exprs.length === 0, 'null 不炸');
    ok(splitMoves([{}, null], kindOf).plain.length === 0, '空动作不炸');
    ok(splitMoves([{ kind: 'expression', name: '鞋子' }], null).outfit.length === 0, '没有归类函数时全当普通动作');
  }

  console.log('真实模型：手上这套画能认出哪几个换装');
  const real = 'F:\\DaFeiYu\\tools\\jingyu\\model\\DeepSeek';
  if (fs.existsSync(real)) {
    const rk = formKinds(real);
    const body = [...rk].filter(([, v]) => v === 'body').map(([k]) => k).sort();
    const outfit = [...rk].filter(([, v]) => v === 'outfit').map(([k]) => k).sort();
    ok(body.length === 3, '三档体型都认出来了', body.join(','));
    ok(outfit.join(',') === '尾巴切换,裙子切换,胸衣,鞋子'.split(',').sort().join(','), '四件换装都认出来了', outfit.join(','));
    ok(!rk.has('脸红') && !rk.has('前倾') && !rk.has('眯眼'), '脸红/前倾/眯眼没被误认成换装');
  } else {
    console.log('  skip 没有本地模型目录，跳过真实模型那组');
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
