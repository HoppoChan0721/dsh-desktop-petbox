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
    // 不用 resizeTo: window：它每收到一次 resize 就重建缓冲区，拖滑杆时一秒能来几十次，
    // 透明窗上看起来就是疯狂闪。自己按 ~25fps 节流改尺寸，停手再补最后一次。
    resizeTo: undefined,
    // 自己的页面，穿透判定要读 canvas 的 alpha，开了就不用绕
    preserveDrawingBuffer: true,
  });
  document.getElementById('stage').appendChild(app.view);
  app.renderer.resize(Math.max(2, window.innerWidth), Math.max(2, window.innerHeight));
  window.__stageApp = app;

  // 锁 60 帧不是省性能，是手感（`pixi.ticker.maxFPS = 60`）——
  // 高刷屏跑满 144Hz 时同一套物理参数每帧积分步长变小，头发摆动看着发死，没有那种软的感觉。
  // 想放开就 ?fps=0（不限）或 ?fps=90。
  {
    const raw = qs.get('fps');
    const tf = raw === null ? 60 : Number(raw);
    const cap = Number.isFinite(tf) && tf >= 0 ? tf : 60;
    app.ticker.maxFPS = cap;
    // 模型不是挂在 app.ticker 上的：pixi-live2d-display 的 autoUpdate 用的是 PIXI.Ticker.shared，
    // 所以两个都要锁，只锁 app 那个等于只限了渲染、没人管模型更新（实测还是 160+ 帧）。
    try { if (PIXI.Ticker && PIXI.Ticker.shared) PIXI.Ticker.shared.maxFPS = cap; } catch (e) {}
  }

  function fit(model) {
    // 用 app.screen 而不是 renderer.width/resolution：screen 是 PIXI 自己算出来的逻辑尺寸，
    // 在它自己的 resize 事件里读到的已经是新值。之前读 renderer 的尺寸，赶在 PIXI 更新之前拿到的是
    // 上一次的旧值，窗口一变，模型的底部锚点就掉到窗口外面，脚和鞋子被截掉一截。
    const W = app.screen.width;
    const H = app.screen.height;
    const box = model.getLocalBounds();
    if (!box || box.width < 1 || box.height < 1 || W < 2 || H < 2) return null;
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

    const engine = window.createPetEngine(model, {
      baseUrl: new URL('.', modelUrl).href,
      sway: Number(qs.get('sway')) || undefined,
      // 整身摇摆（渲染层绕脚底转）：?tilt=0 关掉，?tiltPeriod=7 一个来回几秒
      swayTilt: qs.get('tilt') === null ? undefined : Number(qs.get('tilt')),
      swayTiltPeriod: Number(qs.get('tiltPeriod')) || undefined,
    });

    // 关键接线，两个时机缺一不可：
    //
    // 1. updateNaturalMovements —— 这是模型算自然摆动的地方，夹在「动作算完」和「物理开始算」之间。
    //    把驱动挂在这里，指针位置这一帧就能被物理读到，跟手才不会慢半拍。
    //
    // 2. update 本体的末尾 —— pixi-live2d-display 在 update 收尾时会 loadParameters()，
    //    把参数还原成动作算完时保存的那份。第 1 步写进去的值会被整片抹掉，
    //    于是补写一遍，值才真的留到渲染。
    const internal = model.internalModel;

    // 这三样交给我们自己：眨眼（engine.applyBlink）、呼吸（engine.applyIdle 写 ParamBreath）、
    // 视线（engine.applyGaze 写 ParamEyeBallX/Y）。不关掉的话它们每帧还会各写一遍，
    // 参数最后谁赢看顺序，表现就是眼睛「黏」在鼠标上、眨眼节奏怪。
    // 官方那套被动画摘干净之后就是这样处理的（eyeBlink/breath/updateFocus 全摘掉）。
    internal.eyeBlink = undefined;
    internal.breath = undefined;
    internal.updateFocus = () => {};

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

    // 套一层容器：整身摇摆转这层，模型自己的 pivot/position 一点不动（动了 Live2D 会画不出来）
    const swayGroup = new PIXI.Container();
    app.stage.addChild(swayGroup);
    swayGroup.addChild(model);
    const fitInfo = fit(model);

    const interaction = window.createStageInteraction({ app, model, engine });
    // 整身摇摆绕「她自己剪影的脚底」转：窗口底边当支点的话，小体型会像踩钟摆一样漂
    engine.setSwayTarget(swayGroup);
    engine.setSwayPivot(() => interaction.feetAnchor());
    const bubble = window.createStageBubble({ app, interaction });
    // 音量：先看 URL（主进程开局就会带上），缺了就让 voice 自己用默认值 0.6。
    // 千万别写 Number(qs.get('volume'))——qs.get 给 null 时 Number(null) 是 0，直接全静音。
    const volRaw = qs.get('volume');
    const voice = window.createStageVoice({ engine, volume: volRaw === null ? null : Number(volRaw) });
    const reply = window.createStageReply ? window.createStageReply({ app, interaction }) : null;

    window.__stageModel = model;
    window.__stageCore = internal.coreModel;
    window.__petEngine = engine;
    window.__stageInteraction = interaction;
    window.__stageBubble = bubble;
    window.__stageVoice = voice;
    window.__stageReply = reply;
    // 调试：一对窗口坐标 → 算成哪个部位、命中的是哪根 part（/hit 走这条）
    window.__stageHit = (x, y) => { try { return interaction.inspectHit(x, y); } catch (e) { return { error: String(e && e.message || e) }; } };
    window.__stageInspect = (ids) => {
      const out = {};
      const core = internal.coreModel;
      for (const id of (ids || ['AngleX', 'AngleY', 'AngleZ', 'LeanInput', 'PositionX', 'ParamBreath', 'ParamEyeLOpen'])) {
        try { out[id] = +core.getParameterValueById(id).toFixed(3); } catch (e) { out[id] = null; }
      }
      return out;
    };

    // ---- 体型预设：换完把脚底对齐到标准身高的那条基线 ----------------------
    // 三档体型是同一张画里的三种身材，剪影高度差得很多（标准占满窗口、小号只有三分之一）。
    // 只改 Clothes2 不动位置的话，她一缩就整只飘到窗口上半截，看着像浮在半空。
    // 所以开局先按标准身材记一条「脚底基线」（归一化 0~1），换体型后把模型整体上下挪，
    // 让新剪影的底边落回那条线上。只动 model.position.y，绝不动 pivot——动 pivot 会让 Live2D 画不出来。
    window.__stageFeetBaseline = 0;
    window.__stageBody = [];
    window.__stageBodyOffset = 0;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    async function scanSilhouette(waitMs) {
      try { window.__stageZonesReset(0); } catch (e) { return null; }
      await wait(waitMs === undefined ? 140 : waitMs);
      try {
        const z = window.__stageZones();
        return z && z.bbox ? z.bbox : null;
      } catch (e) { return null; }
    }
    // 基线只在「还是标准身材」的时候才准：拍早了是空白帧，拿它当基线后面全错
    async function captureBaseline() {
      for (let i = 0; i < 8; i++) {
        if (i) await wait(150);
        const bbox = await scanSilhouette(i ? 90 : 20);
        if (bbox && bbox.bottom - bbox.top > 0.4) { window.__stageFeetBaseline = bbox.bottom; break; }
      }
      return window.__stageFeetBaseline;
    }
    let bodySeq = 0;
    async function applyBody(names, align) {
      const seq = ++bodySeq;
      const list = (Array.isArray(names) ? names : (names ? [names] : [])).map(String).filter(Boolean);
      window.__stageBody = list;
      const res = engine.setForm(list) || {};
      if (!align || !list.length) return { ...res, aligned: null };
      await wait(420);                       // 等表情参数真写进 core 再量，不然量到的是上一档
      const bbox = await scanSilhouette(120);
      const H = app.screen.height;
      if (!bbox || seq !== bodySeq) return { ...res, aligned: null };   // 量到一半又被换了一档，这一枪作废
      const base = window.__stageFeetBaseline;
      // 没有基线（换的模型不是这套画）就当场把当前这档当基线，至少别乱飘
      if (!base) { window.__stageFeetBaseline = bbox.bottom; return { ...res, aligned: null }; }
      // 走两遍：第一遍按量到的差值挪，挪完再量一次收掉残差（整身摇摆有零点几度，
      // 量出来的底边会跟着晃一两像素）
      let bottom = bbox.bottom;
      let y = H;   // 偏移要累加：量到的是「窗口里的绝对位置」，直接按 H+差值算会把上一遍挪的又抹掉
      for (let pass = 0; pass < 2; pass++) {
        if (seq !== bodySeq) return { ...res, aligned: null };   // 又被换了一档，这一枪作废
        const delta = (base - bottom) * H;
        y += delta;
        model.position.y = y;
        if (Math.abs(delta) < 4 || pass === 1) break;
        await wait(180);
        const again = await scanSilhouette(110);
        if (seq !== bodySeq) return { ...res, aligned: null };
        if (!again) break;
        bottom = again.bottom;
      }
      window.__stageBodyOffset = Math.round(model.position.y - H);   // 记的是真的挪了多少，不是算出来的
      try { interaction.resetProfile(150); } catch (e) {}   // 位置变了，脚底/头顶锚点要重扫
      return { ...res, aligned: { base: +base.toFixed(4), bottom: +bottom.toFixed(4), y: Math.round(model.position.y) } };
    }
    window.__stageApplyBody = applyBody;
    // 基线要先有：页面重新载入时主进程会立刻推一次体型，那一枪来得比模型画完还早
    await captureBaseline();

    // 指针和指令都来自主进程：桌宠大半时间穿透，页面收不到 mousemove
    if (window.petStage) {
      window.petStage.onCursor((c) => {
        if (window.__freeze || window.__lockPointer) return;
        engine.pointer(c || null);
      });
      window.petStage.onCommand((cmd) => {
        if (!cmd || !cmd.type) return;
        if (cmd.type === 'motion') engine.motion(cmd.name, { hold: !!cmd.hold }).catch((e) => err('动作失败：' + ((e && e.message) || e)));
        else if (cmd.type === 'emotion') engine.emotion(cmd.name, cmd.ms);
        else if (cmd.type === 'say') {
          // ms 给了就按它停留，reveal 给了就按它摊平逐字速度（有语音时 = 音频时长）
          bubble.say(cmd.text, cmd.ms, cmd.reveal);
          if (reply) reply.flash(cmd.ms);
          if (!cmd.voice) {
            const chars = String(cmd.text || '').length;
            engine.talk(cmd.ms || Math.max(1200, Math.min(9000, chars * 180)));
          }
        } else if (cmd.type === 'tick') bubble.tick(cmd.text, cmd.ms);
        else if (cmd.type === 'reply-set') { if (reply) reply.setEnabled(cmd.on !== false, !!cmd.always); }
        else if (cmd.type === 'reply-open') {
          if (reply) {
            if (cmd.open) reply.open();
            else reply.close();
          }
        } else if (cmd.type === 'nod') engine.nod();
        else if (cmd.type === 'shake') engine.shake();
        else if (cmd.type === 'tilt') engine.tilt(cmd.direction);
        else if (cmd.type === 'look') engine.look(cmd.direction, cmd.ms);
        else if (cmd.type === 'blink') engine.blink(cmd.side);
        else if (cmd.type === 'smile') engine.smile();
        else if (cmd.type === 'talk') engine.talk(cmd.ms);
        else if (cmd.type === 'sway-tilt') engine.setSwayTilt(cmd.value, cmd.period);
        else if (cmd.type === 'form') applyBody(cmd.names || cmd.name, !!cmd.align);
        // 部件名表（partId → cdi3 里的中文名）：点触要按真部件分区，主进程读好推过来
        else if (cmd.type === 'parts') interaction.setParts(cmd.names || null);
        else if (cmd.type === 'voice') {
          voice.play(cmd.url).catch(() => {});
        } else if (cmd.type === 'voice-stop') voice.stop();
        else if (cmd.type === 'volume') voice.setVolume(cmd.value);
        else if (cmd.type === 'outfit-reset') {
          const ids = engine.resetOutfit();
          bubble.tick('衣服复原了', 2200);
          window.__lastOutfitReset = ids;
          // 复原服装会把所有 Clothes 参数摁回默认，Clothes2 就是体型——主人挑过的那档要重新挂回去
          if (window.__stageBody && window.__stageBody.length) applyBody(window.__stageBody, true);
        }
        else if (cmd.type === 'error') err(cmd.text);
        else if (cmd.type === 'wait') bubble.wait(cmd.ms);
        else if (cmd.type === 'bubble-hide') bubble.hide();
        else if (cmd.type === 'zones-reset') interaction.resetProfile(150);   // 尺寸一变就重标剪影
        else if (cmd.type === 'pointer') { window.__lockPointer = !!cmd.lock; engine.pointer(cmd.value || null); }
        else if (cmd.type === 'stop') engine.stopMotion();
        else if (cmd.type === 'tap') engine.nod();
        else if (cmd.type === 'interactive') interaction.setInteractive(cmd.value !== false);
        else if (cmd.type === 'smart') interaction.setSmart(cmd.value !== false);
        else if (cmd.type === 'mood') {
          engine.setMood(cmd.plan || null);
          if (cmd.plan && cmd.plan.gesture === 'nod') engine.nod();
          else if (cmd.plan && cmd.plan.gesture === 'shake') engine.shake();
        }
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
    // 帧率：舞台锁 60。看 /state 里的 stats.fps 就知道有没有跑对。
    // 注意 FPS 是「屏幕刷新率」不是「模型每秒更新几次」：模型走 Ticker.shared 的节流，
    // 实际更新频率看 /state 里 frames 的增量（锁 60 时约 50~60 次/秒）。
    window.__stageStats = () => ({ rawRafFps: Math.round(PIXI.Ticker.shared.FPS), maxFps: PIXI.Ticker.shared.maxFPS, size: { w: app.screen.width, h: app.screen.height } });
    document.title = '棉花糖 · ' + (groups.motions || []).join('/');

    // ---- 窗口尺寸：节流 + 停手补最后一帧 ------------------------------------
    // 拖尺寸滑杆时 resize 事件一秒来几十次。每来一次就 resize 缓冲区 + 重算 fit + 重扫剪影，
    // 透明窗上看起来就是闪；而且重扫是同步读整张画布（几十万像素），越拖越卡。
    // 所以：尺寸按 ~25fps 跟上，剪影只在停手 200ms 后扫一次，头的位置也那时候才报。
    let resizeDue = 0;
    let rebodyTimer = 0;
    let resizeTimer = null;
    let lastW = app.screen.width;
    let lastH = app.screen.height;
    const applyResize = () => {
      const W = Math.max(2, window.innerWidth);
      const H = Math.max(2, window.innerHeight);
      if (W === lastW && H === lastH) return false;
      lastW = W;
      lastH = H;
      try { app.renderer.resize(W, H); } catch (e) { return false; }
      try { fit(model); } catch (e) {}
      // fit 会把模型重新摁回窗口底边：挑过体型的话得把脚底基线补回去，不然拖一下尺寸她就掉下去。
      // 拖动时 resize 一秒来几十次，扫描要同步读整张画布，所以等停手再扫一次，别每次 resize 都扫
      clearTimeout(rebodyTimer);
      rebodyTimer = setTimeout(() => {
        if (window.__stageBody && window.__stageBody.length) applyBody(window.__stageBody, true).catch(() => {});
      }, 260);
      return true;
    };
    window.addEventListener('resize', () => {
      const now = performance.now();
      // 距离上一帧太近就等等，最后一次由下面的定时器兜住（不然松手那一刻会停在中间尺寸）
      if (now - resizeDue < 40) {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeDue = performance.now();
          if (applyResize()) {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { try { interaction.resetProfile(60); } catch (e) {} }, 200);
          }
        }, 40);
        return;
      }
      resizeDue = now;
      const changed = applyResize();
      clearTimeout(resizeTimer);
      // 停手之后再重标剪影（同步扫像素，拖动期间绝不做）
      resizeTimer = setTimeout(() => { try { interaction.resetProfile(60); } catch (e) {} }, changed ? 200 : 60);
    });
  })().catch((e) => err('模型加载失败：' + ((e && e.message) || e)));
})();
