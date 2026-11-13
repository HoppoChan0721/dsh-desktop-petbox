'use strict';
// 换装标签的归类：一句话里的 [鞋子] [裙子切换] [体型2] 和 [脸红] [前倾] 不是一回事。
//
//   换装（形态）——exp3 里只动 ClothesN。穿上就留在身上，是**状态**：
//     · 不该演完 2.6 秒自己撤
//     · 不该被同一句里的别的表情顶掉
//     · 体型那几档还要连脚底一起对齐（剪影高度差很多）
//   临时表情——脸红 / 眯眼 / 前倾 这些改 key* / LeanInput 的，演一会儿就该收。
//
// 以前它们全走表情层，而表情层当时只有一个槽位：`[鞋子][脸红][前倾]` 三条同帧下发，
// 后一条把前一条顶掉，只剩最后一个在演，看着就是「前面那个标签没生效」。
// 这里负责把两种分开，纯函数 + 只读模型目录，node 里能直接测。
const fs = require('node:fs');
const path = require('node:path');

const CLOTHES_PARAM = /^Clothes\d+$/;
// 改到 Clothes2 的是体型（换了要重新对齐脚底），其余是衣服/配饰（叠加就行）
const BODY_PARAM = 'Clothes2';

/**
 * 扫模型目录里的 exp3，挑出「只改 ClothesN」的那些表情。
 * @param {string} modelDir 模型目录
 * @returns {Map<string, 'body'|'outfit'>} 表情名 → 形态种类
 */
function formKinds(modelDir) {
  const map = new Map();
  if (!modelDir) return map;
  const dirs = [path.join(modelDir, 'Exp3'), path.join(modelDir, 'exp3'), modelDir];
  const seen = new Set();
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d); } catch (e) { continue; }
    for (const f of files) {
      if (!/\.exp3\.json$/i.test(f)) continue;
      const name = f.replace(/\.exp3\.json$/i, '');
      if (seen.has(name)) continue;
      seen.add(name);
      let j = null;
      try { j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { continue; }
      const ps = ((j && j.Parameters) || []).filter((p) => p && p.Id);
      if (!ps.length) continue;
      // 只要碰了一个非 Clothes 参数，那就是临时表情，不是换装
      if (!ps.every((p) => CLOTHES_PARAM.test(p.Id))) continue;
      map.set(name, ps.some((p) => p.Id === BODY_PARAM) ? 'body' : 'outfit');
    }
  }
  return map;
}

/**
 * 把一条 /say 的动作列表拆成三摞。
 * @param {object[]} moves 桥编译出来的动作（每条带 kind / name / at / duration）
 * @param {(name:string)=>('body'|'outfit'|null)} kindOf 查表函数
 * @returns {{body:string[], outfit:string[], exprs:{name:string,ms:number}[], plain:object[]}}
 *   body / outfit 去重且保持书写顺序；exprs 是同帧要一起挂的表情；plain 是其余按 at 排期的动作。
 *   带 at 偏移（[at:2][鞋子]）的换装不进形态层——那种是「等会儿再穿」，留给普通排期。
 */
function splitMoves(moves, kindOf) {
  const out = { body: [], outfit: [], exprs: [], plain: [] };
  const kind = typeof kindOf === 'function' ? kindOf : () => null;
  for (const a of Array.isArray(moves) ? moves : []) {
    if (!a || !a.kind) continue;
    const delayed = (Number(a.at) || 0) > 0.03;
    if (a.kind === 'expression' && a.name && !delayed) {
      const k = kind(a.name);
      if (k === 'body' || k === 'outfit') {
        if (out[k].indexOf(String(a.name)) < 0) out[k].push(String(a.name));
        continue;
      }
      out.exprs.push({ name: String(a.name), ms: Math.round((Number(a.duration) || 2.6) * 1000) });
      continue;
    }
    out.plain.push(a);
  }
  return out;
}

module.exports = { CLOTHES_PARAM, BODY_PARAM, formKinds, splitMoves };
