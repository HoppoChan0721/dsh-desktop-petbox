// 台词里「舞台说明」的剥离规则。跟桥那边 lib/cues.js 的 looksLikeDirection 是同一套。
import { stripDirections, looksLikeDirection, hasDirection } from '../stage/text.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
}
const eq = (name, got, want) => ok(name, got === want, { got, want });

// ---- 该剥的：纯中文、短、像舞台说明
eq('方括号舞台说明', stripDirections('[眼神闪烁] 领主血量掉好快'), '领主血量掉好快');
eq('全角方头括号', stripDirections('【小声】主人在忙'), '主人在忙');
eq('中间的说明也剥', stripDirections('主人，[顿了一下] 我在的'), '主人， 我在的');
eq('多个说明一起剥', stripDirections('[歪头][笑] 好呀'), '好呀');
eq('只有说明 → 保留原文（不能让气泡变空）', stripDirections('[眼神闪烁]'), '[眼神闪烁]');
eq('说明后面带标点', stripDirections('[轻轻]嗯，我知道了'), '嗯，我知道了');

// ---- 不该剥的：像内容 / 像指令 / 像链接
eq('数字引用', stripDirections('see [1] for details'), 'see [1] for details');
eq('英文方括号', stripDirections('array[0] 是第一个'), 'array[0] 是第一个');
eq('时间轴指令', stripDirections('[at:1.5] 好'), '[at:1.5] 好');
eq('act 指令', stripDirections('[act:{"kind":"nod"}] 好'), '[act:{"kind":"nod"}] 好');
eq('长中文句子不算说明', stripDirections('[这句子明显是个正常的长句不该被吃掉]'), '[这句子明显是个正常的长句不该被吃掉]');
eq('没括号就别动', stripDirections('主人回来啦'), '主人回来啦');
eq('空串', stripDirections(''), '');

// ---- 情绪词：桥那边认 [pout] 是情绪，不该念出来
eq('裸情绪词当说明剥掉', stripDirections('[pout] 主人只准夸我一个'), '主人只准夸我一个');
eq('大小写都认', stripDirections('[Pout] 嗯'), '嗯');
eq('不是情绪词的英文照旧留着', stripDirections('[foo] 嗯'), '[foo] 嗯');
ok('pout 算说明', looksLikeDirection('pout') === true);
ok('happy 算说明', looksLikeDirection('happy') === true);
ok('随便一个英文词不算', looksLikeDirection('whale') === false);

// ---- 判据本身
ok('纯中文短词算说明', looksLikeDirection('小声') === true);
ok('带英文不算', looksLikeDirection('img') === false);
ok('超长不算', looksLikeDirection('一二三四五六七八九十十一十二') === false);
ok('空不算', looksLikeDirection('  ') === false);

// ---- hasDirection 只说有没有，不改串
ok('有说明时报 true', hasDirection('[眼神闪烁] 来了') === true);
ok('只有内容报 false', hasDirection('数组 a[0]') === false);

console.log((fail ? 'FAIL' : 'ok') + ' ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
