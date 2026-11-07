'use strict';
// Alt + 拖动的一帧。为什么单独一个文件：跨屏 / 高 DPI 下「越拖越大、还在闪」全是这里的数学，
// 而本地双屏同缩放 @100% 根本复现不出来（反馈的原话是「别人那儿一拖就变大」）。所以把这段
// 抽成纯函数，用 scripts/test-pet.mjs 在假显示器上钉死，别再靠肉眼验。
//
// 三条规矩：
//   1. 冻结的是**物理像素尺寸**：跨到 150% 的屏上，DIP 宽高要按比例缩小，看起来才一样大；
//   2. 位置只认「上一帧 → 这一帧」的增量，**不回读** getBounds —— 系统还没落实上一帧时读回来是
//      旧值，基于旧值再加增量会多走一截（实测拖 -300 走了 -367，还带竖着漂）；
//   3. 同一块屏内不碰尺寸，只有缩放比变了才改宽高（改尺寸 = 重排重绘 = 闪）。

const MIN_W = 240, MAX_W = 1600, MIN_H = 360, MAX_H = 2000;

function clampSize(w, h) {
  return [Math.max(MIN_W, Math.min(MAX_W, Math.round(w))), Math.max(MIN_H, Math.min(MAX_H, Math.round(h)))];
}

// bounds: {x,y,width,height}；cursor: {x,y}；scale: 当前屏缩放
function createDragState(bounds, cursor, scale) {
  const s = Number(scale) || 1;
  return {
    vx: bounds.x, vy: bounds.y,
    w: bounds.width, h: bounds.height,
    physW: Math.round(bounds.width * s),
    physH: Math.round(bounds.height * s),
    scale: s,
    last: { x: cursor.x, y: cursor.y },
    moved: false,
  };
}

// 返回这一帧要 setBounds 的矩形；没动就返回 null。
// scaleAt(x, y) 由调用方注入（主进程用 screen.getDisplayNearestPoint），测试里给假的。
function dragFrame(st, cursor, scaleAt) {
  const dx = cursor.x - st.last.x;
  const dy = cursor.y - st.last.y;
  if (!dx && !dy) return null;
  st.last = { x: cursor.x, y: cursor.y };
  st.vx += dx;
  st.vy += dy;
  st.moved = true;
  const sf = Number(scaleAt ? scaleAt(st.vx + st.w / 2, st.vy + st.h / 2) : st.scale) || st.scale;
  if (sf !== st.scale) {
    st.scale = sf;
    const [w, h] = clampSize(st.physW / sf, st.physH / sf);
    st.w = w; st.h = h;
  }
  return { x: Math.round(st.vx), y: Math.round(st.vy), width: st.w, height: st.h };
}

module.exports = { createDragState, dragFrame, clampSize };
