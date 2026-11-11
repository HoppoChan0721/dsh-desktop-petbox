// 语音：放 wav，顺手把它的音量包络取出来喂给口型。
//
// 为什么要自己取包络：模型只有一个「嘴张开」参数，跟音频对齐靠的是每一帧告诉引擎「现在有多响」。
// 直接按音节猜节奏会明显对不上，取 RMS 包络最省事也最准。
//
// 包络在页面里算，不在主进程算：AudioContext 本来就要解码一次，顺手把样点扫一遍，
// 省掉一个 wav 解析器的来回。
(function () {
  'use strict';

  const ENV_RATE = 60; // 每秒取 60 格包络，跟渲染帧率一个量级就够
  const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

  function createVoice({ engine, volume }) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return { play: async () => false, stop() {}, setVolume() {}, get volume() { return 0; }, get playing() { return false; } };

    let ctx = null;
    let gain = null;
    let source = null;
    let rafId = 0;
    let env = null;
    let startedAt = 0;
    let lastUrl = '';
    // 音量走一个 GainNode，不碰包络：口型大小跟音量无关，
    // 调小只是「她说话轻了」，嘴型还是照着原本的响度张，看着才不别扭。
    let level = volume === undefined || volume === null ? 0.6 : clamp01(volume);

    function ensureCtx() {
      if (!ctx) ctx = new Ctx();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }

    function ensureGain(c) {
      if (!gain) {
        gain = c.createGain();
        gain.gain.value = level;
        gain.connect(c.destination);
      }
      return gain;
    }

    function setVolume(v) {
      level = clamp01(v);
      if (gain) {
        // 小步平滑：直接赋值在播的时候会有一下「咔」
        try { gain.gain.setTargetAtTime(level, ctx.currentTime, 0.02); } catch (e) { gain.gain.value = level; }
      }
      return level;
    }

    function finish() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      source = null;
      env = null;
      engine.setVoice(0, 60);
    }

    function stop() {
      if (source) { try { source.stop(); } catch (e) {} }
      finish();
    }

    // 每 1/60 秒一个 RMS，再归一化到 0..1。乘 1.6 是给普通人声留的余量：
    // 不抬一下的话，正常说话的口型只有一半大，看着像没张嘴。
    function buildEnvelope(audio) {
      const ch = audio.getChannelData(0);
      const win = Math.max(1, Math.floor(audio.sampleRate / ENV_RATE));
      const n = Math.max(1, Math.ceil(ch.length / win));
      const out = new Float32Array(n);
      let peak = 1e-4;
      for (let i = 0; i < n; i++) {
        const from = i * win;
        const to = Math.min(ch.length, from + win);
        let sum = 0;
        for (let j = from; j < to; j++) sum += ch[j] * ch[j];
        const rms = Math.sqrt(sum / Math.max(1, to - from));
        out[i] = rms;
        if (rms > peak) peak = rms;
      }
      for (let i = 0; i < n; i++) out[i] = Math.min(1, (out[i] / peak) * 1.6);
      return out;
    }

    async function play(url) {
      if (!url) return false;
      try {
        stop();
        const c = ensureCtx();
        const res = await fetch(url);
        if (!res.ok) throw new Error('wav 读不到：' + res.status);
        const raw = await res.arrayBuffer();
        const audio = await c.decodeAudioData(raw);
        env = buildEnvelope(audio);
        source = c.createBufferSource();
        source.buffer = audio;
        source.connect(ensureGain(c));
        const t0 = c.currentTime + 0.02;
        source.start(t0);
        startedAt = performance.now();
        lastUrl = url;
        const from = t0;
        const loop = () => {
          const t = c.currentTime - from;
          if (t < 0) { rafId = requestAnimationFrame(loop); return; }
          const idx = Math.floor(t * ENV_RATE);
          if (!env || idx >= env.length) { finish(); return; }
          engine.setVoice(env[idx], Math.round(1000 / ENV_RATE) + 20);
          rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);
        return true;
      } catch (e) {
        finish();
        return false;
      }
    }

    return {
      play,
      stop,
      setVolume,
      get volume() { return level; },
      get playing() { return !!source; },
      get url() { return lastUrl; },
      get since() { return startedAt ? performance.now() - startedAt : 0; },
    };
  }

  window.createStageVoice = createVoice;
})();
