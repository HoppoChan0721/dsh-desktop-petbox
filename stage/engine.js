// 舞台的参数驱动层。
//
// 一条原则：**所有参数写入只从这里出去**。模型自带的 updateNaturalMovements 会被整个换掉，
// 每帧从零算一套目标值，再按时间常数追上当前值，最后一次性写进 Cubism 参数。
// 动作、指针、呼吸、眨眼、说话共用一个出口，谁也别想覆盖谁——之前「动作管理器说在播但画面不动」
// 和「俯身没反应」都是因为几个地方各写各的，后写的把先写的拍死。
//
// 参数名用模型自己的语义名（AngleX / LeanInput / PositionX…），范围、默认值现场从 core 读，
// 不写死数值。写死过一次，写错名字白折腾好几天。
//
// 思路参考鲸语（Jingyu Live2D Agent）公开文档里描述的驱动顺序，代码是自己写的。
(function () {
  'use strict';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smooth = (t) => t * t * (3 - 2 * t);
  const num = (v, dflt) => (Number.isFinite(v) ? v : dflt);

  // ---- motion3.json 曲线求值 --------------------------------------------------
  // Segments 布局：[t0, v0, <kind, ...pts>, <kind, ...pts>, ...]
  //   kind 0 线性：<t, v>   1 贝塞尔：<c1t, c1v, c2t, c2v, t, v>
  //   kind 2 台阶：<t, v>   3 反台阶：<t, v>
  const bez = (a, b, c, d, t) => (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d;

  function sampleCurve(seg, t) {
    if (!seg || seg.length < 2) return 0;
    if (t <= seg[0]) return seg[1];
    let pt = seg[0];
    let pv = seg[1];
    let i = 2;
    while (i < seg.length) {
      const kind = seg[i++];
      let nt;
      let nv;
      if (kind === 1) {
        const c1t = seg[i++]; const c1v = seg[i++];
        const c2t = seg[i++]; const c2v = seg[i++];
        nt = seg[i++]; nv = seg[i++];
        if (t <= nt) {
          let lo = 0;
          let hi = 1;
          for (let k = 0; k < 20; k++) {
            const u = (lo + hi) / 2;
            if (bez(pt, c1t, c2t, nt, u) < t) lo = u; else hi = u;
          }
          return bez(pv, c1v, c2v, nv, (lo + hi) / 2);
        }
      } else if (kind === 0) {
        nt = seg[i++]; nv = seg[i++];
        if (t <= nt) return pv + (nv - pv) * ((t - pt) / Math.max(1e-8, nt - pt));
      } else if (kind === 2) {
        nt = seg[i++]; nv = seg[i++];
        if (t <= nt) return pv;
      } else if (kind === 3) {
        nt = seg[i++]; nv = seg[i++];
        if (t <= nt) return nv;
      } else {
        return pv;
      }
      pt = nt; pv = nv;
    }
    return pv;
  }

  // ---- 这个模型的语义驱动参数 --------------------------------------------------
  // 名字取自模型自己的参数表。哪些真的存在，构造时逐个问 core，不存在的直接记进 missing。
  const SEMANTIC = [
    'AngleX', 'AngleY', 'AngleZ', 'PositionX', 'PositionY', 'PositionZ', 'LeanInput',
    // 身体角：模型的裙摆/蕾丝/缎带物理（PhysicsSetting122~124 等）就是吃这三个量的。
    // 待机摆动只写头角时，头发会动但裙子纹丝不动，看着就没「活的」感。
    'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
    'ParamEyeBallX', 'ParamEyeBallY', 'ParamEyeLOpen', 'ParamEyeROpen',
    'ParamMouthForm', 'ParamMouthOpenY', 'JawOpen', 'ParamBreath',
    'EyeSmile', 'MouthSmile_L', 'MouthSmile_R',
    'ParamBrowLY', 'ParamBrowRY', 'BrowInnerUp',
    'CheeckPuff', 'Mouthpucker', 'MouthFunnel', 'MouthX',
    'MouthPressLipOpen', 'MouthPuckerWiden',
    'REyeSquint', 'LEyeSquint', 'TongueOut',
    'NoseNeer', 'MouthRollUpper', 'MouthRollLower',
  ];

  // 幅度没有单位，全是参数刻度。数字来自反复试到顺眼的程度，别凭感觉改。
  const TUNE = {
    headX: 18,      // 左右转头
    headY: 12,      // 抬头低头
    headZ: 14,      // 侧倾
    lean: 26,       // 前后探身，负值是往下弯
    posX: 4,        // 上身左右平移
    posY: 2,        // 上身上下
    breathAmp: 0.24,
    breathBase: 0.42,
    breathHz: 1.45,
    swayX: 1.15,
    swayY: 0.7,
    swayZ: 0.6,
    swayPosX: 0.5,
    swayPosZ: 0.35,
    // 身体角摆动：裙子/蕾丝/缎带的物理吃这三个量，不给它，只有头发在动
    swayBodyX: 1.5,
    swayBodyZ: 1.1,
    // 待机摆动放大倍数：头发/裙摆的物理全靠这点输入在动，摆太小整只看着「死」。
    // 1.0 = 最初那套很小的摆手感；1.6 = 现在默认（比鲸语那套节律摇摆 8/7 还收敛）。
    // 想现场比一比：启动加 --sway=1 或 --sway=2.4，或者托盘「舞台 ▸ 待机摆动」。
    swayScale: 1.6,
    tauIdle: 0.16,  // 待机归位：慢慢缓过去，不要「啪」地弹回
    tauActing: 0.055, // 演动作 / 跟指针：跟手
    tauEye: 0.016,  // 眼睛开合单独走快通道，否则眨眼糊成一片
    blinkHold: 0.15,
    expressionMs: 2600, // 表情挂多久后自动归位
  };

  class PetEngine {
    constructor(model, opts) {
      const options = opts || {};
      this.model = model;
      this.internal = model.internalModel;
      this.core = this.internal.coreModel;
      this.baseUrl = options.baseUrl || '';
      this.info = new Map();
      this.missing = [];
      this.managed = new Set();
      this.current = new Map();
      this.motionCache = new Map();
      this.clock = 0;
      this.frames = 0;
      this.writeErrors = 0;

      this.job = null;
      this.elapsed = 0;
      this.jobName = '';
      this.motionEyes = false;

      this.pointerInput = { x: 0, y: 0 };
      this.gaze = { x: 0, y: 0 };
      this.idle = true;
      this.swayScale = Number(options.sway) > 0 ? Number(options.sway) : TUNE.swayScale;

      this.mouth = 0;
      this.mouthTarget = 0;
      this.mouthUntil = 0;
      this.voiceLevel = 0;
      this.voiceUntil = 0;
      this.impulse = null;
      this.emotionTimer = null;
      this.emotionName = '';

      this.blinkNext = 2.0;
      this.blinkFrom = -1;
      this.blinkDur = TUNE.blinkHold;

      // 换装是状态不是动作：演完要留在原地，不能一格一格归位穿回去
      this.hold = new Set(['Clothes1', 'Clothes2', 'Clothes3', 'Clothes4', 'Clothes5', 'Clothes6', 'Clothes7', 'Clothes8']);

      this.register(SEMANTIC);
      // key1..key13 是表情专用通道，交给模型自己的表情管理器，驱动层绝对不许碰。
      // 碰过一次：每帧写回默认值 0，等于每帧把表情擦掉，脸红看不出来。

      this.idleMotion = null;
      this.ready = this.loadIdle().catch(() => null);
    }

    // 登记参数：范围内、默认值都从 core 现场读
    register(ids) {
      for (const id of ids) {
        if (!id || this.info.has(id)) continue;
        let idx = -1;
        try { idx = this.core.getParameterIndex(id); } catch (e) { idx = -1; }
        if (typeof idx !== 'number' || idx < 0) { if (this.missing.indexOf(id) < 0) this.missing.push(id); continue; }
        let min = -1;
        let max = 1;
        let def = 0;
        try {
          min = num(this.core.getParameterMinimumValue(idx), -1);
          max = num(this.core.getParameterMaximumValue(idx), 1);
          def = num(this.core.getParameterDefaultValue(idx), 0);
        } catch (e) {}
        this.info.set(id, { id, min, max, default: def });
        this.managed.add(id);
      }
    }

    has(id) { return this.info.has(id); }

    // ---- 动作文件 -------------------------------------------------------------
    motionGroup(name) {
      let groups = {};
      try { groups = (this.internal.settings && this.internal.settings.motions) || {}; } catch (e) { groups = {}; }
      if (!name) return null;
      if (groups[name]) return { key: name, list: groups[name] };
      const lower = String(name).toLowerCase();
      for (const key of Object.keys(groups)) {
        if (key.toLowerCase() === lower) return { key, list: groups[key] };
      }
      return null;
    }

    async fetchMotion(file) {
      if (this.motionCache.has(file)) return this.motionCache.get(file);
      const url = new URL(file, this.baseUrl || location.href).href;
      const res = await fetch(url);
      if (!res.ok) throw new Error('动作文件读不到：' + file + ' ' + res.status);
      const json = await res.json();
      this.motionCache.set(file, json);
      return json;
    }

    static toCurves(json, register) {
      const curves = [];
      for (const c of (json.Curves || [])) {
        if (c.Target !== 'Parameter' || !c.Id) continue;
        register([c.Id]);
        curves.push({ id: c.Id, segments: c.Segments || [] });
      }
      const duration = Math.max(0.1, num(json.Meta && json.Meta.Duration, 1));
      const eyes = curves.some((c) => c.id === 'ParamEyeLOpen' || c.id === 'ParamEyeROpen');
      return { curves, duration, eyes };
    }

    async loadIdle() {
      const group = this.motionGroup('Idle') || this.motionGroup('idle');
      if (!group || !group.list || !group.list.length) return null;
      const file = group.list[0].File || group.list[0].file;
      if (!file) return null;
      const json = await this.fetchMotion(file);
      const { curves, duration } = PetEngine.toCurves(json, (ids) => this.register(ids));
      this.idleMotion = { curves, duration };
      return this.idleMotion;
    }

    // ---- 对外 ---------------------------------------------------------------
    pointer(p) {
      if (!p) {
        // 不跟指针了（人走开 / 发晕 / 生气期间）：身体回正，**眼睛也要回正**。
        // 以前只清 pointerInput 不清 gaze，结果身子回正了眼睛还黏在鼠标上。
        this.pointerInput = null;
        this.gaze = { x: 0, y: 0 };
        return;
      }
      this.pointerInput = { x: clamp(num(p.x, 0), -1, 1), y: clamp(num(p.y, 0), -1, 1) };
      this.gaze = this.pointerInput;
    }

    async motion(name, opts) {
      const group = this.motionGroup(name);
      if (!group || !group.list || !group.list.length) throw new Error('没有这个动作：' + name);
      const file = group.list[0].File || group.list[0].file;
      const json = await this.fetchMotion(file);
      const { curves, duration, eyes } = PetEngine.toCurves(json, (ids) => this.register(ids));
      // hold：演完停在最后一帧，不自己归位（举手是状态，得等主人那口气消了再放下来）
      this.job = { curves, duration, file, eyes, hold: !!(opts && opts.hold) };
      this.elapsed = 0;
      this.jobName = group.key;
      return { name: group.key, duration, curves: curves.length, hold: this.job.hold };
    }

    stopMotion() { this.job = null; this.elapsed = 0; this.jobName = ''; return true; }

    talk(ms) {
      const span = num(ms, 0) > 0 ? num(ms, 0) : 1400;
      this.mouthUntil = this.clock + span / 1000;
      return true;
    }

    // 语音包络：由 voice.js 每帧喂进来，值是 0..1，ms 是这一格的存活时间。
    // 有语音在放的时候口型听它的，没语音才用上面那个合成张合。
    setVoice(level, ms) {
      this.voiceLevel = clamp(num(level, 0), 0, 1);
      this.voiceUntil = this.clock + Math.max(0.05, (num(ms, 0) || 60) / 1000);
      return true;
    }

    // 一次性的小幅冲量，用一个衰减正弦推某个参数再放掉。
    // 点头、摇头、被戳一下的那种「缩」都是它，不需要额外的动作文件。
    react(id, amp, ms, cycles) {
      if (!this.info.has(id)) return false;
      this.impulse = {
        id,
        amp,
        dur: Math.max(0.08, (num(ms, 0) || 430) / 1000),
        t0: this.clock,
        cycles: num(cycles, 0) || 1,
      };
      return true;
    }

    nod() { return this.react('AngleY', -9, 430, 1); }

    shake() { return this.react('AngleX', 8, 460, 1.5); }

    // 表情不会自己回去：模型挂上就一直挂着。所以演完记得主动 reset，
    // 不然点她一次，脸红能挂到天荒地老。
    emotion(name, ms) {
      const mgr = this.internal && this.internal.motionManager && this.internal.motionManager.expressionManager;
      if (!mgr) return false;
      clearTimeout(this.emotionTimer);
      try {
        if (!name) {
          mgr.resetExpression();
          this.emotionName = '';
          return true;
        }
        this.model.expression(name);
        this.emotionName = name;
        const span = num(ms, 0) > 0 ? num(ms, 0) : TUNE.expressionMs;
        this.emotionTimer = setTimeout(() => {
          try { mgr.resetExpression(); } catch (e) {}
          this.emotionName = '';
        }, span);
        return true;
      } catch (e) { return false; }
    }

    // ---- 每帧 ---------------------------------------------------------------
    tick(dtMs) {
      const dt = clamp(num(dtMs, 0) / 1000, 0, 0.1);
      if (dt <= 0) return;
      this.clock += dt;
      this.frames++;
      if (this.job) {
        this.elapsed += dt;
        if (this.elapsed >= this.job.duration) {
          if (this.job.hold) this.elapsed = this.job.duration;   // 停在最后一帧，等人家发话
          else { this.job = null; this.elapsed = 0; this.jobName = ''; }
        }
      }
      const target = this.buildTarget();
      this.commit(target, dt);
    }

    // 每帧从零算目标值。目标表填完，等于「这一帧她应该长什么样」。
    buildTarget() {
      const target = new Map();
      for (const id of this.managed) {
        const p = this.info.get(id);
        if (!p) continue;
        // 换装参数的目标值取「当前值」：等于原地不动
        target.set(id, this.hold.has(id) && this.current.has(id) ? this.current.get(id) : p.default);
      }
      const ctx = { target, set: (id, v) => { if (Number.isFinite(v)) target.set(id, v); } };
      this.applyIdle(ctx);
      this.applyPointer(ctx);
      this.applyImpulse(ctx, target);
      this.applyGaze(ctx);
      this.applyMouth(ctx);
      this.applyMotion(ctx, target);
      this.applyBlink(ctx, target);
      return target;
    }

    // 一次性冲量：叠在指针之上，动作层再叠在它之上（演动作时动作说了算）
    applyImpulse({ set }, target) {
      const im = this.impulse;
      if (!im) return;
      const t = (this.clock - im.t0) / im.dur;
      if (t >= 1) { this.impulse = null; return; }
      if (!this.info.has(im.id)) { this.impulse = null; return; }
      const v = im.amp * Math.sin(t * Math.PI * im.cycles) * (1 - t);
      set(im.id, num(target.get(im.id), 0) + v);
    }

    applyIdle({ set }) {
      if (!this.idle) return;
      const phase = this.clock;
      const k = this.swayScale;
      set('ParamBreath', TUNE.breathBase + TUNE.breathAmp * Math.sin(phase * TUNE.breathHz));
      set('AngleX', TUNE.swayX * k * Math.sin(phase * 0.55));
      set('AngleY', TUNE.swayY * k * Math.sin(phase * 0.72 + 0.4));
      set('AngleZ', TUNE.swayZ * k * Math.sin(phase * 0.48));
      set('PositionX', TUNE.swayPosX * k * Math.sin(phase * 0.55 - 0.2));
      set('PositionZ', TUNE.swayPosZ * k * Math.sin(phase * 0.48 - 0.25));
      // 身体角：裙摆、蕾丝、缎带的物理链就是吃它。频率比头慢一点，看起来像重心在挪
      set('ParamBodyAngleX', TUNE.swayBodyX * k * Math.sin(phase * 0.42 + 0.9));
      set('ParamBodyAngleZ', TUNE.swayBodyZ * k * Math.sin(phase * 0.36 - 0.4));
      const idle = this.idleMotion;
      if (idle && idle.curves.length) {
        const t = idle.duration > 0 ? phase % idle.duration : 0;
        for (const c of idle.curves) set(c.id, sampleCurve(c.segments, t));
      }
    }

    // 指针往下 → LeanInput 负 → 身子往前下方探，腿和盆骨由作者物理跟着弯
    applyPointer({ set, target }) {
      const p = this.pointerInput;
      if (!p) return;
      const add = (id, v, keep) => {
        if (!this.info.has(id)) return;
        set(id, num(target.get(id), 0) * (keep === undefined ? 0.35 : keep) + v);
      };
      add('AngleX', p.x * TUNE.headX);
      add('AngleY', p.y * TUNE.headY);
      add('AngleZ', p.x * TUNE.headZ, 0.3);
      add('LeanInput', p.y * TUNE.lean, 0.2);
      add('PositionX', p.x * TUNE.posX, 0.3);
    }

    applyGaze({ set }) {
      const g = this.gaze;
      if (!g) return;
      set('ParamEyeBallX', g.x * 0.5);
      set('ParamEyeBallY', g.y * 0.4);
    }

    applyMouth({ set }) {
      if (this.voiceUntil > this.clock) {
        // 有语音：口型照着包络走，跟得快一点，不然会拖成一片
        this.mouth += (this.voiceLevel - this.mouth) * 0.5;
        if (this.mouth > 0.002) set('ParamMouthOpenY', this.mouth);
        return;
      }
      if (this.clock < this.mouthUntil) {
        // 没有语音时的口型：不追求音素，只要张合有节奏就够
        const w = Math.sin(this.clock * 17) * 0.5 + 0.5;
        this.mouthTarget = 0.18 + w * 0.5;
      } else {
        this.mouthTarget = 0;
      }
      this.mouth += (this.mouthTarget - this.mouth) * 0.25;
      if (this.mouth > 0.002) set('ParamMouthOpenY', this.mouth);
    }

    applyMotion(ctx, target) {
      const job = this.job;
      if (!job) { this.motionEyes = false; return; }
      const t = Math.min(this.elapsed, job.duration);
      for (const c of job.curves) {
        if (!this.info.has(c.id)) continue;
        ctx.set(c.id, sampleCurve(c.segments, t));
      }
      this.motionEyes = job.eyes;
    }

    applyBlink({ set }) {
      if (!this.idle) return;
      if (this.job && this.motionEyes) return; // 动作自己在管眼睛，别插一脚
      if (this.clock >= this.blinkNext && this.blinkFrom < 0) this.blinkFrom = this.clock;
      let open = 1;
      if (this.blinkFrom >= 0) {
        const k = (this.clock - this.blinkFrom) / this.blinkDur;
        if (k >= 1) {
          this.blinkFrom = -1;
          this.blinkNext = this.clock + 2.4 + Math.random() * 3.2;
        } else {
          // 前 40% 闭，后 60% 开，中间不悬停
          open = k < 0.4 ? 1 - smooth(k / 0.4) : smooth((k - 0.4) / 0.6);
        }
      }
      set('ParamEyeLOpen', open);
      set('ParamEyeROpen', open);
    }

    commit(target, dt) {
      const tauBase = this.job ? TUNE.tauActing : TUNE.tauIdle;
      for (const [id, v] of target) {
        const p = this.info.get(id);
        if (!p) continue;
        const prev = this.current.has(id) ? this.current.get(id) : p.default;
        const tau = id.indexOf('Eye') >= 0 && id.indexOf('Open') >= 0 ? TUNE.tauEye : tauBase;
        let next = prev + (v - prev) * (1 - Math.exp(-dt / tau));
        if (!Number.isFinite(next)) next = p.default;
        next = clamp(next, p.min, p.max);
        this.current.set(id, next);
        try { this.core.setParameterValueById(id, next); } catch (e) { this.writeErrors++; }
      }
    }

    // pixi-live2d-display 每帧在 update 结尾会 loadParameters()，把参数还原成「动作算完时保存的值」。
    // 所以光在 update 中间写没用，一帧之末会被抹掉。模型归位之后必须再补一遍，值才留得住。
    reassert() {
      for (const [id, v] of this.current) {
        try { this.core.setParameterValueById(id, v); } catch (e) { this.writeErrors++; }
      }
    }

    state() {
      return {
        clock: +this.clock.toFixed(2),
        frames: this.frames,
        idle: this.idle,
        motion: this.jobName || null,
        motionCurves: this.job ? this.job.curves.map((c) => c.id) : [],
        elapsed: +this.elapsed.toFixed(2),
        duration: this.job ? this.job.duration : 0,
        pointer: this.pointerInput,
        eye: { x: +num(this.gaze && this.gaze.x, 0).toFixed(3), y: +num(this.gaze && this.gaze.y, 0).toFixed(3) },
        emotion: this.emotionName || null,
        managed: this.managed.size,
        missing: this.missing.slice(0, 40),
        idleCurves: this.idleMotion ? this.idleMotion.curves.length : 0,
        writeErrors: this.writeErrors,
        sway: this.swayScale,
      };
    }
  }

  window.createPetEngine = (model, opts) => new PetEngine(model, opts);
  window.PetEngineSample = sampleCurve;
})();
