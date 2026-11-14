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
// 驱动顺序是照公开的 Live2D 参数/物理约定自己写的，不依赖任何第三方舞台工程。
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
    swayX: 3.2,
    swayY: 1.6,
    swayZ: 2.2,
    swayPosX: 1.2,
    swayPosZ: 0.8,
    // 身体角摆动：裙子/蕾丝/缎带的物理吃这三个量，不给它，只有头发在动
    swayBodyX: 4.0,
    swayBodyZ: 3.0,
    // 待机摆动放大倍数：头发/裙摆的物理全靠这点输入在动，摆太小整只看着「死」。
    // 1.0 = 最初那套很小的摆手感；1.6 = 现在默认（头发和裙摆晃得看得见，又不至于甩）。
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
      this.moodState = null;   // { name, at, ms, sway, lean, tilt }，由 setMood 写入

      // 整身摇摆：渲染层把整个模型绕脚底转多少度、多久一个来回。
      // 0 = 关掉（想对比老外壳的「定住感」就把这个调 0）；没传参数就用 0.8 度。
      const seedTilt = options.swayTilt === undefined || options.swayTilt === null ? NaN : Number(options.swayTilt);
      this.swayTiltDeg = Number.isFinite(seedTilt) ? Math.min(4, Math.max(0, seedTilt)) : 0.8;
      this.swayTiltPeriod = Number(options.swayTiltPeriod) > 0.5 ? Number(options.swayTiltPeriod) : 7;
      this.swayAngle = 0;      // 当前这一帧的倾角（度），气泡 / 回复钮要拿它补坐标

      // 个体差异（只有同台的副实例会开）：主人那只必须一个模子刻出来的稳定，
      // 但桌上站三四只的时候，如果都用同一份待机曲线、同一个相位，看起来就是一群机器人同步摇头。
      // 开了之后：待机曲线相位错开、幅度各不相同、呼吸快慢不同、整身摇摆错拍，
      // 外加自己会随手眨眼/歪头/看旁边/换个表情。
      this.persona = null;
      this.personaNext = 0;        // 下一次小动作倒计时（秒）
      this.personaExprNext = 0;    // 下一次换表情倒计时（秒）
      this.personaCurveScale = new Map();
      this.personaExprPool = [];

      this.mouth = 0;
      this.mouthTarget = 0;
      this.mouthUntil = 0;
      this.voiceLevel = 0;
      this.voiceUntil = 0;
      this.impulse = null;
      this.lookState = null;   // 「看一眼」的保持状态（见 look / applyLook）
      this.emotionTimer = null;
      this.emotionName = '';
      // 表情层是一张表，不是单个槽位：一句里写 [脸红][前倾] 该一起挂着。
      // 以前只有一个 expr，后一条会把前一条顶掉，看着就是「前面那个标签没生效」。
      // 每项：{ name, params:[{id,value,blend}], at, until, loaded }
      this.exprs = [];
      this.formParams = [];     // 形态（换装）合成出来的参数：体型 + 裙子/鞋子/尾巴 叠起来
      this.formNames = [];
      this.exprCache = new Map();

      this.blinkNext = 2.0;
      this.blinkFrom = -1;
      this.blinkDur = TUNE.blinkHold;

      // 换装是状态不是动作：演完要留在原地，不能一格一格归位穿回去
      this.hold = new Set(['Clothes1', 'Clothes2', 'Clothes3', 'Clothes4', 'Clothes5', 'Clothes6', 'Clothes7', 'Clothes8']);

      this.register(SEMANTIC);
      // 换装参数先登记上（模型里没有的会被 register 忽略）：这样「复原服装」不用等
      // 某个换装表情被点过才生效，也不会被驱动层写回默认值——它们在 this.hold 里。
      this.register(['Clothes1', 'Clothes2', 'Clothes3', 'Clothes4', 'Clothes5', 'Clothes6', 'Clothes7', 'Clothes8']);
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

    // 整身摇摆的现场调节（设置面板 / 控制口 / 命令行都走这里）
    setSwayTilt(deg, period) {
      const d = Number(deg);
      this.swayTiltDeg = Number.isFinite(d) ? Math.min(4, Math.max(0, d)) : 0;
      const p = Number(period);
      if (Number.isFinite(p) && p > 0.5) this.swayTiltPeriod = p;
      if (!(this.swayTiltDeg > 0)) {
        this.swayAngle = 0;
        try { this.model.rotation = 0; } catch (e) {}
      }
      return { tilt: this.swayTiltDeg, period: this.swayTiltPeriod };
    }

    shake() { return this.react('AngleX', 8, 460, 1.5); }

    // 语义动作：桥那边的 [歪头] [看一眼] [眨眼] [笑一下] 没有动作文件，全用参数冲量演。
    // 幅度刻意小——台词配的动作是「配合说话」，不是表演杂技。
    tilt(dir) { return this.react('AngleZ', dir === 'left' ? 11 : -11, 900, 1); }

    // 「看一眼」不能用冲量演。冲量是 sin 一个完整周期：转过去、再自己转回来，
    // 看着就是「刚转一半就被拽回去」——两只站一起时导演每两三秒发一次，特别明显。
    // 改成保持型：快速转过去、停住、最后 0.4 秒慢慢回正，像真的看了一眼再收回视线。
    look(dir, ms) {
      const span = Math.max(0.3, (Number(ms) || 0) / 1000 || 1.8);
      const dx = dir === 'left' ? 9 : dir === 'right' ? -9 : 0;
      const dy = dir === 'up' ? -7 : dir === 'down' ? 7 : dir === 'center' ? -3 : 0;
      this.lookState = { at: this.clock, ms: span, dx, dy };
      return { dir, ms: Math.round(span * 1000) };
    }

    // 看的方向也走叠加层：不覆盖头部摆动，只在它上面加一个偏移
    applyLook({ set, target }) {
      const s = this.lookState;
      if (!s) return;
      const t = this.clock - s.at;
      if (t >= s.ms) { this.lookState = null; return; }
      // 0.18 秒转过去，剩下的保持，最后 0.4 秒回正
      const inK = Math.min(1, t / 0.18);
      const outK = Math.min(1, Math.max(0, (s.ms - t) / 0.4));
      const w = Math.min(inK, outK);
      if (s.dx) set('AngleX', num(target.get('AngleX'), 0) + s.dx * w);
      if (s.dy) set('AngleY', num(target.get('AngleY'), 0) + s.dy * w);
    }

    blink() { return this.react('ParamEyeLOpen', -1, 190, 1); }

    // 笑一下：嘴角是 ParamMouthForm，抿嘴笑走这个；EyeSmile 有就一起抬
    smile() {
      const a = this.react('ParamMouthForm', 0.7, 1200, 1);
      return a;
    }

    // 一键复原服装：换装是「状态」不是动作——裙子切换、鞋子、胸衣这些表情只有「变成」没有「变回」，
    // 穿上之后自己下不来，只能把八个 Clothes 参数摁回各自默认档。
    // 必须同时改 this.current，不然下一帧 commit 会拿旧值平滑回去（看着像没反应）。
    resetOutfit() {
      const done = [];
      for (const [id, p] of this.info) {
        if (!/^Clothes\d+$/.test(id)) continue;
        const d = Number.isFinite(p.default) ? p.default : 0;
        this.current.set(id, d);
        try { this.core.setParameterValueById(id, d); } catch (e) { this.writeErrors++; }
        done.push(id);
      }
      // 换装靠表情通道写进来的，表情不撤下一帧又会被写回去
      try { this.emotion('', 0); } catch (e) {}
      return done;
    }

    // 表情不会自己回去：模型挂上就一直挂着。所以演完记得主动 reset，
    // 不然点她一次，脸红能挂到天荒地老。
    //
    // ⚠️ 2026-11-11 实测：这个 vendor 构建里 `model.expression(name)` 只把表情设成 currentExpression，
    // 每帧都**没有**人把表达式的参数值写进 coreModel（ExpressionManager.update 没被调）。
    // 结果就是表情看着完全没反应——爱心眼不红、眯眼不眯、换装也穿不上。
    // 所以这里自己把 exp3 的参数解析出来，每帧按 blend 叠上去（applyExpression）。
    // 换一个表情：整层换掉（点触反应、心情走这条，新反应不该和上一条叠着）
    emotion(name, ms) {
      clearTimeout(this.emotionTimer);
      this.emotionName = '';
      this.exprs = [];
      if (!name) return true;
      return this.addExpression(name, ms);
    }

    // 往表情层再加一个，不清掉正在演的（一句台词里写了好几个表情时用）
    addExpression(name, ms) {
      const key = String(name || '').trim();
      if (!key) return false;
      const span = num(ms, 0) > 0 ? num(ms, 0) : TUNE.expressionMs;
      const item = { name: key, params: [], at: this.clock, until: this.clock + span / 1000, loaded: false };
      this.exprs.push(item);
      this.emotionName = key;
      this.loadExpression(key).then((params) => {
        // 加载完之前可能已经到期/被换掉了，别把旧的盖上去
        if (!params || this.exprs.indexOf(item) < 0) return;
        item.params = params;
        item.loaded = true;
      }).catch(() => {});
      return true;
    }

    // 一次挂一排表情，各带自己的时长
    emotionList(list) {
      clearTimeout(this.emotionTimer);
      this.emotionName = '';
      this.exprs = [];
      for (const it of list || []) {
        if (!it) continue;
        if (typeof it === 'string') this.addExpression(it, 0);
        else if (it.name) this.addExpression(it.name, it.ms);
      }
      return this.exprs.map((e) => e.name);
    }

    // exp3 里的参数表：{Id, Value, Blend}。Blend 有三种：Add / Multiply / Overwrite
    async loadExpression(name) {
      const defs = (this.internal && this.internal.settings && this.internal.settings.expressions) || [];
      const def = defs.find((d) => (d.Name || d.name) === name);
      const file = def && (def.File || def.file);
      if (!file) return null;
      if (!this.exprCache) this.exprCache = new Map();
      if (this.exprCache.has(file)) return this.exprCache.get(file);
      const url = new URL(file, this.baseUrl || location.href).href;
      const res = await fetch(url);
      if (!res.ok) return null;
      const json = await res.json();
      const params = [];
      for (const p of (json.Parameters || [])) {
        if (!p || !p.Id) continue;
        params.push({ id: p.Id, value: num(p.Value, 0), blend: String(p.Blend || 'Add') });
      }
      this.register(params.map((p) => p.id));
      this.exprCache.set(file, params);
      return params;
    }

    // 表情叠在最后一层：待机/指针/动作都写完，再由它盖上去，
    // 这样「眯眼」「脸红」不会被驱动层每帧擦掉。
    // 形态（换装）：这个模型把「体型1 / 体型2 / 体型默认 / 裙子切换 / 鞋子 / 胸衣 / 尾巴切换」
    // 都做成表情文件，各自改几个 ClothesN 参数。换装是**状态**不是动作：穿上就留在身上，
    // 也不该被同一句里的脸红/前倾顶掉，所以它不进表情层，走这条叠加的形态层。
    setForm(names) {
      const list = (Array.isArray(names) ? names : [names]).map(String).filter(Boolean);
      this.formNames = list;
      this.formParams = [];
      const merged = new Map();
      let pending = list.length;
      if (!pending) { this.formLayer = null; return { form: [], params: 0 }; }
      const done = () => {
        // 后写的覆盖先写的：同一件衣服被两份表情都改，以列表里靠后的为准
        for (const [id, p] of merged) this.formParams.push(p);
        this.formLayer = { names: list, at: this.clock };
        return { form: list, params: this.formParams.length };
      };
      for (const name of list) {
        this.loadExpression(name).then((params) => {
          for (const p of params || []) merged.set(p.id, p);
        }).catch(() => {}).finally(() => {
          if (--pending === 0) done();
        });
      }
      return { form: list, params: 0, queued: true };
    }

    applyForm({ set }) {
      if (!this.formParams || !this.formParams.length) return;
      for (const p of this.formParams) {
        if (!this.info.has(p.id)) continue;
        // 基准一律取参数默认值，不能取「当前值」：换装参数在 hold 集合里，
        // 当前值是上一帧自己写进去的结果，再叠一次就是每帧累加，最后一路顶到上限。
        const base = this.info.get(p.id).default;
        let v = base + p.value;
        if (p.blend === 'Multiply') v = base * p.value;
        else if (p.blend === 'Overwrite') v = p.value;
        set(p.id, v);
      }
    }

    applyExpression({ set }, target) {
      if (!this.exprs || !this.exprs.length) return;
      const keep = [];
      for (const ex of this.exprs) {
        if (this.clock >= ex.until) continue;          // 到期就撤
        keep.push(ex);
        if (!ex.params || !ex.params.length) continue;
        const life = this.clock - ex.at;
        const left = ex.until - this.clock;
        const w = Math.min(1, life / 0.15) * Math.min(1, Math.max(0, left / 0.2));
        if (w <= 0) continue;
        for (const p of ex.params) {
          if (!this.info.has(p.id)) continue;
          const cur = num(target.get(p.id), this.info.get(p.id).default);
          let v = cur + p.value * w;                       // Add
          if (p.blend === 'Multiply') v = cur * (1 + (p.value - 1) * w);
          else if (p.blend === 'Overwrite') v = cur + (p.value - cur) * w;
          set(p.id, v);
        }
      }
      if (keep.length !== this.exprs.length) {
        this.exprs = keep;
        if (!keep.length) this.emotionName = '';
        else if (this.emotionName && !keep.some((e) => e.name === this.emotionName)) this.emotionName = keep[keep.length - 1].name;
      }
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
      this.tickPersona(dt);
      this.applyWholeSway();
    }

    // ---- 整身摇摆（渲染层）----------------------------------------------------
    // 舞台这边转「包着模型的容器」，不动 canvas/DOM，也不动 model 自己的 pivot——
    // 直接改 model.pivot / position 会把 Live2D 的绘制整坏（实测整个模型从窗口里消失）。
    //
    // ⚠️ 支点必须是**她自己剪影的脚底**，不是窗口底边：窗口高度是固定的，小体型站上去时脚离窗口底边
    // 还有一段距离，拿窗口底边当支点转，整个人就像踩在钟摆上「漂移」。容器 pivot 设在脚底，
    // 旋转就完全等价于绕自己的脚转，跟身高无关。
    setSwayTarget(obj) { this.swayTarget = obj || null; return !!this.swayTarget; }

    setSwayPivot(fn) { this.swayPivotFn = typeof fn === 'function' ? fn : null; return !!this.swayPivotFn; }

    applyWholeSway() {
      const amp = Number(this.swayTiltDeg);
      const target = this.swayTarget || this.model;
      if (!target) return;
      const angleRad = () => (this.swayAngle * Math.PI) / 180;
      if (!(amp > 0)) {
        if (this.swayAngle) { try { target.rotation = 0; } catch (e) {} this.swayAngle = 0; }
        return;
      }
      const period = Number(this.swayTiltPeriod) > 0.5 ? Number(this.swayTiltPeriod) : 7;
      const w = (Math.PI * 2) / period;
      // 用 sin 而不是三角波：两头自然减速，看着像重心在挪，不像被谁推着晃
      // 相位也带个体偏移：几只并排站的时候，错开摇摆的节拍才不会像连在一根轴上
      this.swayAngle = amp * Math.sin((this.clock + (this.persona ? this.persona.swayPhase : 0)) * w);
      let feet = null;
      try { feet = this.swayPivotFn ? this.swayPivotFn() : null; } catch (err) { feet = null; }
      try {
        if (this.swayTarget && feet && Number.isFinite(feet.x) && Number.isFinite(feet.y)) {
          // 容器的坐标空间就是舞台坐标：把 pivot 和 position 都设到脚底，绕脚底转
          this.swayTarget.pivot.set(feet.x, feet.y);
          this.swayTarget.position.set(feet.x, feet.y);
        }
        target.rotation = angleRad();
      } catch (e) {}
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
      this.applyLook({ set: ctx.set, target });   // 看一眼：叠在摆动和指针之上，不打断它们
      this.applyImpulse(ctx, target);
      this.applyGaze(ctx);
      this.applyMouth(ctx);
      this.applyMotion(ctx, target);
      this.applyBlink(ctx, target);
      this.applyForm(ctx, target);   // 形态叠在最后：换装是「状态」，压过其它层
      this.applyExpression(ctx, target);
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

    // 心情偏置的信封：进来 0.8 秒淡入、末尾 1.5 秒淡出，中间恒定。
    // 不这么做的话心情一变，摆动幅度会「啪」地跳一下，像卡了一帧。
    moodEnv() {
      const md = this.moodState;
      if (!md) return null;
      const t = this.clock - md.at;
      if (md.ms > 0 && t >= md.ms) { this.moodState = null; return null; }
      const inK = Math.min(1, Math.max(0, t / 0.8));
      const outK = md.ms > 0 ? Math.min(1, Math.max(0, (md.ms - t) / 1.5)) : 1;
      return { w: inK * outK, sway: md.sway, lean: md.lean, tilt: md.tilt };
    }

    setMood(p) {
      const o = p || {};
      this.moodState = {
        name: o.name || '',
        at: this.clock,
        ms: Math.max(0, Number(o.holdMs) || 0),
        sway: Number(o.sway) > 0 ? Number(o.sway) : 1,
        lean: Number(o.lean) || 0,
        tilt: Number(o.tilt) || 0,
      };
      // 表情不在这里写：它归表达式管理器，主进程会另外推一条 emotion，用它的时长
      return this.moodState;
    }

    applyIdle({ set }) {
      if (!this.idle) return;
      const pe = this.persona;
      // 个体差异只影响相位/幅度，不影响主人那只（persona 为 null 时全是 0/1）
      const phase = this.clock + (pe ? pe.idlePhase : 0);
      const env = this.moodEnv();
      const k = this.swayScale * (pe ? pe.swayScale : 1) * (env ? 1 + (env.sway - 1) * env.w : 1);
      const breathHz = TUNE.breathHz * (pe ? pe.breathHz : 1);
      const breathAmp = TUNE.breathAmp * (pe ? pe.breathAmp : 1);
      set('ParamBreath', TUNE.breathBase + breathAmp * Math.sin(phase * breathHz));
      // 摆动频率都提到 4~7 秒一个来回：以前是 11~17 秒一轮，慢到看不出「在晃」，
      // 再加上幅度只有 1~3 度，主人试了两次都说「没生效」。
      set('AngleX', TUNE.swayX * k * Math.sin(phase * 1.1));
      set('AngleY', TUNE.swayY * k * Math.sin(phase * 1.3 + 0.4));
      set('AngleZ', TUNE.swayZ * k * Math.sin(phase * 0.9) + (env ? env.tilt * env.w : 0));
      set('PositionX', TUNE.swayPosX * k * Math.sin(phase * 1.1 - 0.2));
      set('PositionZ', TUNE.swayPosZ * k * Math.sin(phase * 0.9 - 0.25));
      // 身体角：裙摆、蕾丝、缎带的物理链就是吃它。频率比头略慢，看起来像重心在挪
      set('ParamBodyAngleX', TUNE.swayBodyX * k * Math.sin(phase * 1.05 + 0.9));
      set('ParamBodyAngleZ', TUNE.swayBodyZ * k * Math.sin(phase * 0.85 - 0.4));
      // 心情的重心偏置：认真会往前压、担心会缩一下
      if (env && env.lean) set('LeanInput', env.lean * env.w);
      const idle = this.idleMotion;
      if (idle && idle.curves.length) {
        const t = idle.duration > 0 ? phase % idle.duration : 0;
        for (const c of idle.curves) {
          // 每条曲线的幅度也各给一个固定倍率：同一份待机动作在她身上做大一半、在另一只身上收一点，
          // 站在一起就不像放录像了（倍率按参数 id 缓存，别每帧重掷，会抖）
          let sc = 1;
          if (pe) {
            sc = this.personaCurveScale.get(c.id);
            if (sc === undefined) { sc = pe.curveScale[0] + Math.random() * (pe.curveScale[1] - pe.curveScale[0]); this.personaCurveScale.set(c.id, sc); }
          }
          set(c.id, sampleCurve(c.segments, t) * sc);
        }
      }
    }

    // ---- 个体差异（同台的副实例用）-------------------------------------------
    // opts: { expressions: [...], idlePhase, swayScale, breathHz, breathAmp, curveScale:[lo,hi],
    //         actionGap:[lo,hi], exprGap:[lo,hi], swayPhase }
    setPersona(opts) {
      const o = opts || {};
      const rnd = (a, b) => a + Math.random() * (b - a);
      const gap = (v, d) => (Array.isArray(v) && v.length === 2 && v[0] > 0 && v[1] > v[0] ? v : d);
      this.persona = {
        idlePhase: Number.isFinite(Number(o.idlePhase)) ? Number(o.idlePhase) : rnd(0, 6.5),
        swayScale: Number.isFinite(Number(o.swayScale)) ? Number(o.swayScale) : rnd(0.62, 1.32),
        breathHz: Number.isFinite(Number(o.breathHz)) ? Number(o.breathHz) : rnd(0.85, 1.2),
        breathAmp: Number.isFinite(Number(o.breathAmp)) ? Number(o.breathAmp) : rnd(0.82, 1.22),
        curveScale: gap(o.curveScale, [0.78, 1.18]),
        actionGap: gap(o.actionGap, [rnd(3.5, 6.5), rnd(8, 15)]),
        exprGap: gap(o.exprGap, [rnd(9, 16), rnd(20, 38)]),
        swayPhase: Number.isFinite(Number(o.swayPhase)) ? Number(o.swayPhase) : rnd(0, 7),
      };
      this.personaCurveScale.clear();
      this.personaExprPool = Array.isArray(o.expressions) ? o.expressions.filter(Boolean).slice() : [];
      this.personaNext = rnd(1.5, 4);
      this.personaExprNext = rnd(4, 12);
      return this.persona;
    }

    // 自己找点事做：眨眼、歪头、看旁边、偶尔点头，再偶尔换个表情。
    // 间隔用各自随机出来的，不是固定节拍——固定节拍就是「一群机器人」的来源。
    tickPersona(dt) {
      const pe = this.persona;
      if (!pe) return;
      this.personaNext -= dt;
      this.personaExprNext -= dt;
      if (this.personaNext <= 0) {
        this.personaNext = pe.actionGap[0] + Math.random() * (pe.actionGap[1] - pe.actionGap[0]);
        const pick = Math.random();
        if (pick < 0.34) this.blink();
        else if (pick < 0.56) this.tilt(Math.random() < 0.5 ? 'left' : 'right');
        else if (pick < 0.74) {
          const dirs = ['left', 'right', 'up', 'down'];
          this.look(dirs[Math.floor(Math.random() * dirs.length)], 1200 + Math.random() * 1200);
        } else if (pick < 0.88) this.nod();
        else this.smile();
      }
      if (this.personaExprNext <= 0) {
        this.personaExprNext = pe.exprGap[0] + Math.random() * (pe.exprGap[1] - pe.exprGap[0]);
        const pool = this.personaExprPool;
        if (pool.length) this.emotion(pool[Math.floor(Math.random() * pool.length)], 2000 + Math.random() * 1400);
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
        expressions: (this.exprs || []).map((e) => e.name),
        managed: this.managed.size,
        missing: this.missing.slice(0, 40),
        idleCurves: this.idleMotion ? this.idleMotion.curves.length : 0,
        writeErrors: this.writeErrors,
        sway: this.swayScale,
        swayTilt: +Number(this.swayTiltDeg).toFixed(2),
        swayAngle: +Number(this.swayAngle).toFixed(3),
        mood: this.moodState ? this.moodState.name : null,
        // 个体差异（只有同台副实例有）：排查「几只看起来还是同步」时看这几个数
        persona: this.persona ? {
          idlePhase: +this.persona.idlePhase.toFixed(2),
          swayScale: +this.persona.swayScale.toFixed(2),
          breathHz: +this.persona.breathHz.toFixed(2),
          swayPhase: +this.persona.swayPhase.toFixed(2),
          pool: this.personaExprPool.length,
        } : null,
      };
    }
  }

  window.createPetEngine = (model, opts) => new PetEngine(model, opts);
  window.PetEngineSample = sampleCurve;
})();
