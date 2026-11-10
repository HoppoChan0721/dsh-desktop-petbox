// 自建舞台的渲染层。目标很小：把模型正确画在透明窗里，能眨眼、能待机、能被外部拧参数。
// 刻意不做动作编排——那是下一步的事，先把画面站住。
(function () {
  const err = (msg) => { const el = document.getElementById('err'); if (el) el.textContent = String(msg || ''); };
  window.addEventListener('error', (e) => err('脚本错误：' + (e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => err('未处理异常：' + ((e.reason && e.reason.message) || e.reason)));

  const modelFile = new URLSearchParams(location.search).get('model') || '';
  const modelUrl = 'pet://stage/model/' + encodeURIComponent(modelFile);

  const app = new PIXI.Application({
    backgroundAlpha: 0,
    antialias: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
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
    const model = await PIXI.live2d.Live2DModel.from(modelUrl, {
      autoInteract: false,
      autoUpdate: true,
      idleMotionGroup: 'Idle',
    });
    app.stage.addChild(model);
    const fitInfo = fit(model);
    window.__stageModel = model;
    window.__stageCore = model.internalModel && model.internalModel.coreModel;

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

