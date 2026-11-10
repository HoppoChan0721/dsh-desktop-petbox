// 自建舞台的渲染层。
//
// 职责只有三件：把模型正确画在透明窗里、把驱动层挂到模型的更新链上、把主进程送来的指针和指令转交过去。
// 参数怎么算全在 engine.js 里，这里不碰任何一个参数。
(function () {
  const err = (msg) => { const el = document.getElementById('err'); if (el) el.textContent = String(msg || ''); };
  window.addEventListener('error', (e) => err('脚本错误：' + (e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => err('未处理异常：' + ((e.reason && e.reason.message) || e.reason)));

  const qs = new URLSearchParams(location.search);
  const modelFile = qs.get('model') || '';
  const modelUrl = 'pet://stage/model/' + encodeURIComponent(modelFile);
  const RES = Number(qs.get('res')) > 0 ? Number(qs.get('res')) : Math.min(2, window.devicePixelRatio || 1);
  const AA = qs.get('aa') !== '0';

  const app = new PIXI.Application({
    backgroundAlpha: 0,
    antialias: AA,
    resolution: RES,
    autoDensity: true,
    resizeTo: window,
    // 自己的页面，穿透判定要读 canvas 的 alpha，开了就不用绕
    preserveDrawingBuffer: true,
  });
  document.getElementById('stage').appendChild(app.view);
  window.__stageApp = app;

  function fit(model) {
    const W = app.renderer.width / app.renderer.resolution;
    const H = app.renderer.height / app.renderer.resolution;
    const box = model.getLocalBounds();
    const scale = Math.min(W / box.width, H / box.height) * 0.98;
    model.scale.set(scale);
    model.anchor.set(0.5, 1);
    model.position.set(W / 2, H);
    return { W, H, scale };
  }

  (async () => {
    if (!modelFile) { err('没有指定模型文件'); return; }

    // 必须先把模型的时钟接到 PIXI 的 ticker 上：不接的话 update 收到的 dt 一直是 0，
    // 动作时间不前进、呼吸不走、只有物理在动，看上去就像一张会甩尾巴的静态图。
    PIXI.live2d.Live2DModel.registerTicker(PIXI.Ticker);

    const model = await PIXI.live2d.Live2DModel.from(modelUrl, {
      autoInteract: false,
      autoUpdate: true,
      // 故意给个模型里不存在的组名：待机由我们自己驱动，不要让它再叠一层自带动作
      idleMotionGroup: 'petStageManual',
    });

    // 遮罩缓冲默认 256×256，还要被几十个遮罩上下文瓜分，放大到整屏后边缘就糊成毛边，
    // 表现是鼻尖、蓝色叠加层这些被裁出来的地方发黑发脏。提到 2048 边缘就干净。
    (function boostClippingMask() {
      let tries = 0;
      const step = () => {
        const cm = model.internalModel && model.internalModel.renderer && model.internalModel.renderer._clippingManager;
        if (cm && typeof cm.setClippingMaskBufferSize === 'function') {
          if (cm.getClippingMaskBufferSize() < 2048) {
            cm.setClippingMaskBufferSize(2048);
            cm._maskTexture = null;
            cm._colorBuffer = null;
            cm._currentFrameNo = 0;
          }
          return;
        }
        if (tries++ < 180) requestAnimationFrame(step);
      };
      step();
    })();

    const engine = window.createPetEngine(model, { baseUrl: new URL('.', modelUrl).href });

    // 关键接线，两个时机缺一不可：
    //
    // 1. updateNaturalMovements —— 这是模型算自然摆动的地方，夹在「动作算完」和「物理开始算」之间。
    //    把驱动挂在这里，指针位置这一帧就能被物理读到，跟手才不会慢半拍。
    //
    // 2. update 本体的末尾 —— pixi-live2d-display 在 update 收尾时会 loadParameters()，
    //    把参数还原成动作算完时保存的那份。第 1 步写进去的值会被整片抹掉，
    //    于是补写一遍，值才真的留到渲染。
    const internal = model.internalModel;
    let lastStamp = performance.now();
    internal.updateNaturalMovements = function () {
      const now = performance.now();
      let dt = now - lastStamp;
      lastStamp = now;
      if (!(dt > 0)) return;
      if (dt > 100) dt = 100;
      if (window.__freeze) return;
      engine.tick(dt);
    };
    const baseUpdate = internal.update.bind(internal);
    internal.update = function (dt, now) {
      baseUpdate(dt, now);
      if (window.__freeze) return;
      engine.reassert();
    };

    app.stage.addChild(model);
    const fitInfo = fit(model);

    window.__stageModel = model;
    window.__stageCore = internal.coreModel;
    window.__petEngine = engine;
    window.__stageInspect = (ids) => {
      const out = {};
      const core = internal.coreModel;
      for (const id of (ids || ['AngleX', 'AngleY', 'AngleZ', 'LeanInput', 'PositionX', 'ParamBreath', 'ParamEyeLOpen'])) {
        try { out[id] = +core.getParameterValueById(id).toFixed(3); } catch (e) { out[id] = null; }
      }
      return out;
    };

    // 指针和指令都来自主进程：桌宠大半时间穿透，页面收不到 mousemove
    if (window.petStage) {
      window.petStage.onCursor((c) => {
        if (window.__freeze || window.__lockPointer) return;
        engine.pointer(c || null);
      });
      window.petStage.onCommand((cmd) => {
        if (!cmd || !cmd.type) return;
        if (cmd.type === 'motion') engine.motion(cmd.name).catch((e) => err('动作失败：' + ((e && e.message) || e)));
        else if (cmd.type === 'emotion') engine.emotion(cmd.name);
        else if (cmd.type === 'talk' || cmd.type === 'say') engine.talk(cmd.ms);
        else if (cmd.type === 'pointer') { window.__lockPointer = !!cmd.lock; engine.pointer(cmd.value || null); }
        else if (cmd.type === 'stop') engine.stopMotion();
      });
    }

    const groups = (() => {
      try {
        const s = internal.settings;
        return {
          motions: Object.keys((s.motions) || {}),
          expressions: (s.expressions || []).map((e) => e.Name || e.name),
        };
      } catch (e) { return { motions: [], expressions: [], error: String(e) }; }
    })();
    window.__stageInfo = { modelFile, fit: fitInfo, ...groups, engine: engine.state() };
    document.title = '鲸鱼舞台 · ' + (groups.motions || []).join('/');

    window.addEventListener('resize', () => { try { fit(model); } catch (e) {} });
  })().catch((e) => err('模型加载失败：' + ((e && e.message) || e)));
})();
