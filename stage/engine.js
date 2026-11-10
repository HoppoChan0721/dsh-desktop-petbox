// 舞台的动作引擎：指针跟随、俯身、呼吸、眨眼、口型、表情、动作。
//
// 关键设计：**一律用「加在模型当前值上」的方式写参数，不用绝对值覆盖。**
// 因为模型每帧会把自己的参数恢复成它自己算的值（动作、待机、物理都在里面），
// 我们从外面直接写绝对值，就会把它自己的动作全抹掉——表现就是动作管理器说在播、
// 画面上却一动不动。改成读一次当前值再加偏移，动作和我们的指针就能同时存在。
//
// 平滑用时间常数：offset += (target - offset) * (1 - exp(-dt/tau))，
// 按帧插值在 150fps 上会快得发飘，换台机器手感又不一样。
(function () {
  const PTR = { ax: 18, ay: 12, az: 10, body: 8, posX: 4 };
  const LEAN = { lean: 30, hip: 10, posY: 5, body2: 8 };
  const TAU_IDLE = 0.18;
  const TAU_EYE = 0.02;
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
    const offs = new Map();   // 参数 → 当前偏移量

    const has = (id) => { try { return core.getParameterIndex(id) >= 0; } catch (e) { return false; } };
    const get = (id) => { try { return core.getParameterValueById(id); } catch (e) { return 0; } };
    const set = (id, v) => { try { core.setParameterValueById(id, v); } catch (e) {} };
    const pick = (ids) => ids.find((id) => has(id)) || null;

    function tauOf(id) { return id && id.indexOf('Eye') >= 0 && id.indexOf('Open') >= 0 ? TAU_EYE : TAU_IDLE; }

    // 推进偏移量并返回；不写参数，写参数统一在最后一步
    function advance(id, target, dt) {
      if (!id) return 0;
      const prev = offs.has(id) ? offs.get(id) : 0;
      const next = prev + (target - prev) * (1 - Math.exp(-dt / tauOf(id)));
      offs.set(id, next);
      return next;
    }

    const IDS = {
      ax: ['ParamAngleX', 'AngleX'],
      ay: ['ParamAngleY', 'AngleY'],
      az: ['ParamAngleZ', 'AngleZ'],
      bx: ['ParamBodyAngleX'],
      bz: ['ParamBodyAngleZ'],
      posX: ['PositionX'],
      ballX: ['ParamEyeBallX'],
      ballY: ['ParamEyeBallY'],
      breath: ['ParamBreath'],
      chest: ['ParamChestOpen'],
      eyeL: ['ParamEyeLOpen', 'ParamEyeOpen'],
      eyeR: ['ParamEyeROpen', 'ParamEyeOpen'],
      mouth: ['ParamMouthOpenY'],
      lean: ['LeanInput'],
      hipX: ['HipAngleX'],
      posY: ['PositionY'],
      bodyY2: ['ParamBodyAngleY2'],
    };
    const P = {};
    for (const k of Object.keys(IDS)) P[k] = pick(IDS[k]);

    im.on('beforeModelUpdate', () => {
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - st.last) / 1000));
      st.last = now;
      const t = now - st.t0;

      const k = 1 - Math.exp(-dt / TAU_IDLE);
      st.x += (st.tx - st.x) * k;
      st.y += (st.ty - st.y) * k;
      const x = clamp(st.x), y = clamp(st.y);
      const sway = Math.sin(t / 5200) * 2.4;

      // 先把这一帧的偏移都算出来
      const plan = [];
      const push = (id, target) => { if (id) plan.push([id, advance(id, target, dt)]); };

      push(P.ax, x * PTR.ax);
      push(P.ay, y * PTR.ay);
      push(P.az, x * PTR.az + sway);
      push(P.bx, x * PTR.body);
      push(P.bz, x * PTR.body * 0.6 + sway * 0.4);
      push(P.posX, x * PTR.posX);
      push(P.ballX, x * 0.8);
      push(P.ballY, y * 0.6);

      // 俯身：指针在下方时前倾探下去，在上方时轻轻后仰
      const down = Math.max(0, -y), up = Math.max(0, y);
      push(P.lean, -LEAN.lean * down + 8 * up);
      push(P.hipX, -LEAN.hip * down);
      push(P.posY, -LEAN.posY * down + 2 * up);
      push(P.bodyY2, -LEAN.body2 * down);

      // 呼吸
      const br = 0.5 - 0.5 * Math.cos((t / BREATH_CYCLE) * Math.PI * 2);
      push(P.breath, br * 2 - 1);          // 呼吸参数多是 -1..1，偏移量取负一半到正一半
      if (P.chest) push(P.chest, br * 0.3);

      // 眨眼：偏移量是「闭眼程度」的负数
      if (st.nextBlink === 0) st.nextBlink = t + rand(2400, 5600);
      if (st.blinkAt < 0 && t >= st.nextBlink) st.blinkAt = t;
      let eyeClose = 0;
      if (st.blinkAt >= 0) {
        const p = (t - st.blinkAt) / BLINK_MS;
        if (p >= 1) { st.blinkAt = -1; st.nextBlink = t + rand(2400, 5600); }
        else eyeClose = 1 - Math.abs(1 - 2 * p);
      }
      if (P.eyeL) push(P.eyeL, -eyeClose);
      if (P.eyeR) push(P.eyeR, -eyeClose);

      // 口型
      st.mouth += (st.mouthTarget - st.mouth) * (1 - Math.exp(-dt / 0.05));

      // 最后一次性写：读当前值（模型这帧算出来的）+ 偏移
      for (const [id, off] of plan) {
        if (Math.abs(off) < 1e-4) continue;
        set(id, get(id) + off);
      }
      if (P.mouth) set(P.mouth, get(P.mouth) + st.mouth);
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
          params: Object.fromEntries(Object.entries(P).filter(([, id]) => id)),
        };
      },
      core,
    };
  };
})();
