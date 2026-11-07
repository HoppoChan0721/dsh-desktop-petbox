'use strict';
// 口型轨迹的「帧表」单独拎出来，因为它有两条舞台硬约束，踩一次就是整句话没口型：
//   1. 关键帧 time 必须落在 0.15 .. duration-0.15 之间（越界舞台直接 400，说话计划会被连拒）；
//   2. duration 必须在 0.2 .. 20 之间。
// 2026-11-07 就是帧排到 duration-0.2 越了界，说话计划被连拒 8 次，别人听着就是「没口型」。
// 时间轴约定：声音在计划的 0.15s 处开始播（MOUTH_LEAD），所以帧也从 0.15 起，走到 0.15+声音长度。

const MOUTH_LEAD = 0.15;

function mouthFrames(ms, env) {
  const aud = Math.min(19.5, Math.max(0.4, (Number(ms) || 400) / 1000));   // 声音本身多长（秒）
  const dur = Math.min(19.9, aud + 0.4);            // 计划时长留 0.4s 余量，别撞 20 的上限
  const cap = +(dur - 0.16).toFixed(2);             // 最后一帧的上限（给四舍五入留 0.01 的缝）
  const frames = [];
  if (Array.isArray(env) && env.length >= 2) {
    const n = Math.min(58, env.length);
    const step = aud / (n - 1);
    for (let i = 0; i < n; i++) {
      const t = Math.min(cap, +(MOUTH_LEAD + i * step).toFixed(2));
      frames.push({ time: t, values: { ParamMouthOpenY: Math.max(0.05, Math.min(1, Number(env[i]) || 0)) } });
    }
  } else {
    // 没包络（TTS 没给或解码失败）：匀速开合兜底，至少嘴在动
    const end = Math.min(cap, MOUTH_LEAD + aud);
    for (let t = MOUTH_LEAD, k = 0; t <= end && frames.length < 58; t += 0.12, k++) {
      frames.push({ time: +t.toFixed(2), values: { ParamMouthOpenY: k % 2 === 0 ? 0.95 : 0.1 } });
    }
  }
  return { dur, frames, lead: MOUTH_LEAD, aud };
}

module.exports = { mouthFrames, MOUTH_LEAD };
