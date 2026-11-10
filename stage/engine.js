// 舞台的动作引擎：指针跟随、呼吸、眨眼、口型、表情、动作。
// 挂在自己页面里，参数归自己，不用跟任何人的引擎抢——这正是自建舞台的意义。
//
// 用法：const engine = window.createPetEngine(model)
//   engine.pointer({x,y})       归一化 -1..1，null 表示回中
//   engine.say(0..1)            口型开合
//   engine.emotion('脸红')      切表情
//   engine.motion('HandRaise')  播动作
(function () {
  const PTR = { x: 18, y: 12, z: 14, lean: 26, px: 4 };
  const SMOOTH = 0.16;
  const BREATH_CYCLE = 4200;
  const BLINK_MS = 130;
  const clamp = (v) => Math.max(-1, Math.min(1, Number(v) || 0));
  const rand = (a, b) => a + Math.random() * (b - a);

  window.createPetEngine = function (model) {
    const im = model.internalModel;
    const core = im.coreModel;
    const st = {
      tx: 0, ty: 0, x: 0, y: 0,
      mouth: 0, mouthTarget: 0,
      nextBlink: 0, blinkAt: -1,
      t0: performance.now(),
    };

    const has = (id) => { try { return core.getParameterIndex(id) >= 0; } catch (e) { return false; } };
    const get = (id) => { try { return core.getParameterValueById(id); } catch (e) { return 0; } };
    const set = (id, v) => { try { core.setParameterValueById(id, v); } catch (e) {} };
    // 在原值上叠一点，保留一部分它自己的动画
    const add = (id, v, keep) => { if (has(id)) set(id, get(id) * keep + v); };
    // 这个模型用的是 Cubism 标准名（ParamAngleX 这类）。鲸语那边写的 AngleX 是它自己映射表的叫法，
    // 所以这里按真名写，旧名只做兜底。
    const addAny = (ids, v, keep) => { for (const id of ids) { if (has(id)) { add(id, v, keep); return true; } } return false; };

    // 模型自带的 Idle 只动极少数参数，看上去像静态图。呼吸、眨眼、摇摆干脆自己算。
    function idleTick() {
      const t = performance.now() - st.t0;
      const br = 0.5 + 0.5 * Math.sin((t / BREATH_CYCLE) * Math.PI * 2);
      if (has('ParamBreath')) set('ParamBreath', br);
      if (has('ParamChestOpen')) set('ParamChestOpen', 0.3 + 0.3 * br);

      if (st.nextBlink === 0) st.nextBlink = t + rand(2200, 5200);
      if (st.blinkAt < 0 && t >= st.nextBlink) st.blinkAt = t;
      let eye = 1;
      if (st.blinkAt >= 0) {
        const p = (t - st.blinkAt) / BLINK_MS;
        if (p >= 1) { st.blinkAt = -1; st.nextBlink = t + rand(2200, 5200); }
        else eye = Math.abs(1 - 2 * p);
      }
      for (const id of ['ParamEyeLOpen', 'ParamEyeROpen', 'ParamEyeOpen']) set(id, eye);
    }

    // 写参数要赶在核心 update 之前：这个事件正好在那个位置
    im.on('beforeModelUpdate', () => {
      idleTick();
      st.x += (st.tx - st.x) * SMOOTH;
      st.y += (st.ty - st.y) * SMOOTH;
      const x = clamp(st.x), y = clamp(st.y);
      const sway = Math.sin((performance.now() - st.t0) / 5200) * 3.2;

      addAny(['ParamAngleX', 'AngleX'], -x * PTR.x, 0.72);
      addAny(['ParamAngleY', 'AngleY'], y * PTR.y, 0.72);
      addAny(['ParamAngleZ', 'AngleZ'], -x * PTR.z + sway, 0.66);
      addAny(['ParamBodyAngleY', 'LeanInput'], y * PTR.lean * 0.4, 0.2);
      addAny(['ParamBodyAngleZ'], -x * 8 + sway * 0.35, 0.3);
      addAny(['ParamBodyAngleX'], -x * 6, 0.3);
      addAny(['PositionX'], x * PTR.px, 0.3);

      if (has('ParamEyeBallX')) set('ParamEyeBallX', clamp(x * 0.8));
      if (has('ParamEyeBallY')) set('ParamEyeBallY', clamp(y * 0.6));

      st.mouth += (st.mouthTarget - st.mouth) * 0.35;
      if (st.mouth > 0.005) {
        set('ParamMouthOpenY', st.mouth);
        if (has('MouthOpenY')) set('MouthOpenY', st.mouth);
      }
    });

    return {
      pointer(p) {
        if (!p) { st.tx = 0; st.ty = 0; return; }
        st.tx = clamp(p.x);
        st.ty = clamp(p.y);
      },
      say(v) { st.mouthTarget = Math.max(0, Math.min(1, Number(v) || 0)); },
      emotion(name) {
        try { model.expression(name); return true; } catch (e) { return false; }
      },
      motion(name) {
        try { model.motion(name); return true; } catch (e) { return false; }
      },
      state() {
        return {
          target: { x: st.tx, y: st.ty },
          current: { x: +st.x.toFixed(3), y: +st.y.toFixed(3) },
          mouth: +st.mouth.toFixed(3),
          blink: st.blinkAt >= 0 ? 'blinking' : Math.round(st.nextBlink - (performance.now() - st.t0)),
        };
      },
      core,
    };
  };
})();
