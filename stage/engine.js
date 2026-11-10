// 舞台的动作引擎：指针跟随、呼吸、眨眼、口型、表情、动作。
// 手感参考鲸语 engine.mjs 的做法：所有参数都先算出一个绝对目标值，
// 再用「时间常数」平滑过去（1 - exp(-dt/tau)），而不是按帧做插值——
// 按帧插值在 150fps 上会快得发飘，换台机器又是另一个手感。
//
// 用法：const engine = window.createPetEngine(model)
//   engine.pointer({x,y})       归一化 -1..1，null 表示回中
//   engine.say(0..1)            口型开合
//   engine.emotion('脸红')      切表情
//   engine.motion('HandRaise')  播动作
(function () {
  // 幅度：角度是 ±18 度那档，身体少一点
  const PTR = { ax: 18, ay: 12, az: 10, body: 8, lean: 10, posX: 4 };
  const TAU_IDLE = 0.18;     // 跟手的时间常数，越小越"唰"
  const TAU_EYE = 0.02;      // 眼睛开合要快，不然眨眼糊成一团
  const BREATH_CYCLE = 4200;
  const BLINK_MS = 150;
  const clamp = (v) => Math.max(-1, Math.min(1, Number(v) || 0));
  const rand = (a, b) => a + Math.random() * (b - a);

  window.createPetEngine = function (model) {
    const im = model.internalModel;
    const core = im.coreModel;
    const st = {
      tx: 0, ty: 0, x: 0, y: 0,
      mouth: 0, mouthTarget: 0,
      nextBlink: 0, blinkAt: -1,
      last: performance.now(),
      t0: performance.now(),
    };
    const smooth = new Map();   // 参数 → 当前平滑值

    const has = (id) => { try { return core.getParameterIndex(id) >= 0; } catch (e) { return false; } };
    const set = (id, v) => { try { core.setParameterValueById(id, v); } catch (e) {} };
    const pick = (ids) => ids.find((id) => has(id)) || null;

    // 把某个参数朝目标平滑推进，返回当前值
    function ease(id, target, dt) {
      if (!id) return 0;
      const tau = id.indexOf('Eye') >= 0 && id.indexOf('Open') >= 0 ? TAU_EYE : TAU_IDLE;
      const prev = smooth.has(id) ? smooth.get(id) : target;
      const next = prev + (target - prev) * (1 - Math.exp(-dt / tau));
      smooth.set(id, next);
      set(id, next);
      return next;
    }

    const IDS = {
      ax: ['ParamAngleX', 'AngleX'],
      ay: ['ParamAngleY', 'AngleY'],
      az: ['ParamAngleZ', 'AngleZ'],
      bx: ['ParamBodyAngleX'],
      bz: ['ParamBodyAngleZ'],
      by: ['ParamBodyAngleY'],
      posX: ['PositionX'],
      ballX: ['ParamEyeBallX'],
      ballY: ['ParamEyeBallY'],
      breath: ['ParamBreath'],
      chest: ['ParamChestOpen'],
      eyeL: ['ParamEyeLOpen', 'ParamEyeOpen'],
      eyeR: ['ParamEyeROpen', 'ParamEyeOpen'],
      mouth: ['ParamMouthOpenY'],
    };
    const P = {};
    for (const k of Object.keys(IDS)) P[k] = pick(IDS[k]);

    im.on('beforeModelUpdate', () => {
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - st.last) / 1000));
      st.last = now;
      const t = now - st.t0;

      // 指针平滑（同样走时间常数）
      const k = 1 - Math.exp(-dt / TAU_IDLE);
      st.x += (st.tx - st.x) * k;
      st.y += (st.ty - st.y) * k;
      const x = clamp(st.x), y = clamp(st.y);

      // 极慢的待机摇摆，让静止时也有生命感
      const sway = Math.sin(t / 5200) * 2.4;

      // 正号：鼠标往右她往右（模型自己的左右就是屏幕左右）
      ease(P.ax, x * PTR.ax, dt);
      ease(P.ay, y * PTR.ay, dt);
      ease(P.az, x * PTR.az + sway, dt);
      ease(P.bx, x * PTR.body, dt);
      ease(P.bz, x * PTR.body * 0.6 + sway * 0.4, dt);
      ease(P.by, y * PTR.lean, dt);
      ease(P.posX, x * PTR.posX, dt);
      ease(P.ballX, x * 0.8, dt);
      ease(P.ballY, y * 0.6, dt);

      // 呼吸：慢慢起伏
      const br = 0.5 - 0.5 * Math.cos((t / BREATH_CYCLE) * Math.PI * 2);
      ease(P.breath, br, dt);
      if (P.chest) ease(P.chest, 0.25 + 0.3 * br, dt);

      // 眨眼
      if (st.nextBlink === 0) st.nextBlink = t + rand(2400, 5600);
      if (st.blinkAt < 0 && t >= st.nextBlink) st.blinkAt = t;
      let eye = 1;
      if (st.blinkAt >= 0) {
        const p = (t - st.blinkAt) / BLINK_MS;
        if (p >= 1) { st.blinkAt = -1; st.nextBlink = t + rand(2400, 5600); }
        else eye = Math.abs(1 - 2 * p);
      }
      if (P.eyeL) ease(P.eyeL, eye, dt);
      if (P.eyeR) ease(P.eyeR, eye, dt);

      // 口型
      st.mouth += (st.mouthTarget - st.mouth) * (1 - Math.exp(-dt / 0.05));
      if (P.mouth) set(P.mouth, st.mouth);
    });

    return {
      pointer(p) {
        if (!p) { st.tx = 0; st.ty = 0; return; }
        st.tx = clamp(p.x);
        st.ty = clamp(p.y);
      },
      say(v) { st.mouthTarget = Math.max(0, Math.min(1, Number(v) || 0)); },
      emotion(name) { try { model.expression(name); return true; } catch (e) { return false; } },
      motion(name) { try { model.motion(name); return true; } catch (e) { return false; } },
      state() {
        return {
          target: { x: st.tx, y: st.ty },
          current: { x: +st.x.toFixed(3), y: +st.y.toFixed(3) },
          mouth: +st.mouth.toFixed(3),
          blink: st.blinkAt >= 0 ? 'blinking' : Math.round(st.nextBlink - (performance.now() - st.t0)),
          params: Object.fromEntries(Object.entries(P).filter(([, id]) => id).map(([k, id]) => [k, id])),
        };
      },
      core,
    };
  };
})();
