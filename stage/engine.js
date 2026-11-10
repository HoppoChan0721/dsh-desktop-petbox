// 舞台的动作引擎：待机、指针跟随、眼球、口型、表情。
// 挂在自己页面里，参数归自己，不用跟任何人的引擎抢——这正是自建舞台的意义。
//
// 用法：const engine = window.createPetEngine(model)
//   engine.pointer({x,y})  归一化 -1..1，null 表示回中
//   engine.say(0..1)       口型开合
//   engine.emotion('脸红') 切表情
//   engine.motion('HandRaise') 播动作
(function () {
  const PTR = { x: 18, y: 12, z: 14, lean: 26, px: 4 };
  const SMOOTH = 0.16;
  const clamp = (v) => Math.max(-1, Math.min(1, Number(v) || 0));

  window.createPetEngine = function (model) {
    const im = model.internalModel;
    const core = im.coreModel;
    const st = { tx: 0, ty: 0, x: 0, y: 0, mouth: 0, mouthTarget: 0 };

    const has = (id) => { try { return core.getParameterIndex(id) >= 0; } catch (e) { return false; } };
    const get = (id) => { try { return core.getParameterValueById(id); } catch (e) { return 0; } };
    const set = (id, v) => { try { core.setParameterValueById(id, v); } catch (e) {} };
    // 在自己原来的值上叠一点，保留一部分待机动作，不然会显得僵
    const add = (id, v, keep) => { if (has(id)) set(id, get(id) * keep + v); };
    // 这个模型的参数用的是 Cubism 标准名（ParamAngleX 这类），鲸语那边写的 AngleX 是它自己映射表里的叫法，
    // 所以这里按真名写，同时保留旧名做兜底。
    const addAny = (ids, v, keep) => { for (const id of ids) { if (has(id)) { add(id, v, keep); return true; } } return false; };

    // 写参数要赶在核心 update 之前、别人算完之后，这个事件就是那个位置
    im.on('beforeModelUpdate', () => {
      st.x += (st.tx - st.x) * SMOOTH;
      st.y += (st.ty - st.y) * SMOOTH;
      const x = clamp(st.x), y = clamp(st.y);

      addAny(['ParamAngleX', 'AngleX'], -x * PTR.x, 0.35);
      addAny(['ParamAngleY', 'AngleY'], y * PTR.y, 0.35);
      addAny(['ParamAngleZ', 'AngleZ'], -x * PTR.z, 0.3);
      // 身体：前后探身靠 BodyAngleY，左右压身靠 BodyAngleZ
      addAny(['ParamBodyAngleY', 'LeanInput'], y * PTR.lean * 0.4, 0.2);
      addAny(['ParamBodyAngleZ'], -x * 8, 0.3);
      addAny(['ParamBodyAngleX'], -x * 6, 0.3);
      addAny(['PositionX'], x * PTR.px, 0.3);

      if (has('ParamEyeBallX')) set('ParamEyeBallX', clamp(x * 0.8));
      if (has('ParamEyeBallY')) set('ParamEyeBallY', clamp(y * 0.6));

      st.mouth += (st.mouthTarget - st.mouth) * 0.35;
      if (st.mouth > 0.005) {
        // 嘴型分左右，模型里可能是 ParamMouthOpenY，也可能是 MouthOpenY
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
      state() { return { target: { x: st.tx, y: st.ty }, current: { x: +st.x.toFixed(3), y: +st.y.toFixed(3) }, mouth: +st.mouth.toFixed(3) }; },
      core,
    };
  };
})();
