// 自建舞台的渲染层。目标很小：把模型正确画在透明窗里，能眨眼、能待机、能被外部拧参数。
// 刻意不做动作编排——那是下一步的事，先把画面站住。
(function () {
  const err = (msg) => { const el = document.getElementById('err'); if (el) el.textContent = String(msg || ''); };
  window.addEventListener('error', (e) => err('脚本错误：' + (e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => err('未处理异常：' + ((e.reason && e.reason.message) || e.reason)));

  const modelFile = new URLSearchParams(location.search).get('model') || '';
  const modelUrl = 'pet://stage/model/' + encodeURIComponent(modelFile);

  const qs = new URLSearchParams(location.search);
  const RES = Number(qs.get('res')) > 0 ? Number(qs.get('res')) : Math.min(2, window.devicePixelRatio || 1);
  const AA = qs.get('aa') !== '0';
  const app = new PIXI.Application({
    backgroundAlpha: 0,
    antialias: AA,
    resolution: RES,
    autoDensity: true,
    resizeTo: window,
    // 自己的页面，直接开：穿透判定要读 canvas 的 alpha，开了就不用像别人那样绕
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
      idleMotionGroup: 'idle',
    });
    app.stage.addChild(model);

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

    const fitInfo = fit(model);
    window.__stageModel = model;
    window.__stageCore = model.internalModel && model.internalModel.coreModel;
    window.__petEngine = window.createPetEngine(model);

    // 指针和指令都来自主进程：桌宠大半时间穿透，页面收不到 mousemove
    if (window.petStage) {
      window.petStage.onCursor((c) => { if (!window.__freeze) window.__petEngine.pointer(c); });
      window.petStage.onCommand((cmd) => {
        if (!cmd || !cmd.type) return;
        if (cmd.type === 'say') window.__petEngine.say(cmd.mouth);
        else if (cmd.type === 'emotion') window.__petEngine.emotion(cmd.name);
        else if (cmd.type === 'motion') window.__petEngine.motion(cmd.name);
        else if (cmd.type === 'pointer') window.__petEngine.pointer(cmd.value || null);
      });
    }

    const groups = (() => {
      try {
        const s = model.internalModel.settings;
        return {
          motions: Object.keys((s.motions) || {}),
          expressions: (s.expressions || []).map((e) => e.Name || e.name),
        };
      } catch (e) { return { motions: [], expressions: [], error: String(e) }; }
    })();
    window.__stageInfo = { modelFile, fit: fitInfo, ...groups };
    document.title = '鲸鱼舞台 · ' + (groups.motions || []).join('/');

    window.addEventListener('resize', () => { try { fit(model); } catch (e) {} });
  })().catch((e) => err('模型加载失败：' + ((e && e.message) || e)));
})();

