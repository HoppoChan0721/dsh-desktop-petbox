'use strict';
// 台词里的方括号有两种：
//   1. 写给舞台看的指令（[emotion:shy]、[歪头]、[脸红]）——桥那边编译成动作，并且已经从台词里剥掉了
//   2. 认不出来的「舞台说明」（[眼神闪烁]、[小声]、【开心】）——原来原样留在气泡里，TTS 还会一字一字念出来
//
// 第二类才是麻烦：主人看到气泡里挂着「[眼神闪烁]」，耳朵里还听见它。这一层就管这个：
// 只剥「一看就是舞台说明」的括号，绝不动像内容的括号（[1]、[a](url)、[at:1.5]、[act:{...}]）。
// 判据故意保守：纯中文/中文标点、字数短、没有 ASCII 字母数字和冒号。
//
// 同一套规则在桥里也有一份（bridge/dsh-pet-bridge/lib/cues.js），两边都剥是为了
// 「旧桥 + 新舞台」这种混搭组合也不会漏出括号。
const DIRECTION_MAX = 12;
// ASCII 字母数字和这些符号一出现就说明它更像内容/指令/链接，不像舞台说明
const CONTENTY = /[A-Za-z0-9@#$%^&*_=+<>{}|\\/:：]/;

function looksLikeDirection(inner) {
  const s = String(inner == null ? '' : inner).trim();
  if (!s) return false;
  if (s.length > DIRECTION_MAX) return false;
  if (CONTENTY.test(s)) return false;
  if (/[[\]【】]/.test(s)) return false;
  return true;
}

// 剥掉舞台说明型的括号；剥完空了就把原文还回去（宁可留括号，也不能让气泡变成空的）
function stripDirections(text) {
  const src = String(text == null ? '' : text);
  if (!src) return src;
  let removed = 0;
  const out = src
    .replace(/\[([^[\]]{1,40})\]/g, (m, inner) => {
      if (!looksLikeDirection(inner)) return m;
      removed++;
      return ' ';
    })
    .replace(/【([^【】]{1,40})】/g, (m, inner) => {
      if (!looksLikeDirection(inner)) return m;
      removed++;
      return ' ';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^\s+|\s+$/g, '');
  if (!removed) return src;
  if (!out) return src;
  return out;
}

// 只想问「这段里有没有舞台说明」时用，不动原串
function hasDirection(text) {
  const src = String(text == null ? '' : text);
  if (!src) return false;
  return /\[([^[\]]{1,40})\]|【([^【】]{1,40})】/.test(src)
    && stripDirections(src) !== src;
}

module.exports = { stripDirections, looksLikeDirection, hasDirection, DIRECTION_MAX };
