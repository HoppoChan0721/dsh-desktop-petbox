// 舞台的交互层：穿透、拖动、滚轮缩放、点她。
//
// 判定思路跟外壳那套不一样，这里全部基于**模型自己的剪影**：
//   启动后扫一遍画布 alpha，量出剪影包围盒和每一行的左右边界，之后所有坐标都换算成剪影里的比例。
//   窗口拉大、缩放、换装、换模型都不用手工重标，因为比例是相对剪影的。
//
// 分区不写死一堆绝对数值：脖子用「头下方最窄的那一行」自动找，其余部位按脖子到下摆之间按比例切。
//
// 穿透：鼠标压在透明像素上 → 窗口不吃鼠标（点击穿透到底下）；压在她身上 → 窗口吃鼠标。
//       判断错了也没事，最多多穿一格，不会挡住主人点东西。
// 拖动：Alt + 左键按住在哪都能拖，拖动期间强制吃鼠标，否则 mouseup 收不到、停不下来。
(function () {
  'use strict';

  const ALPHA_MIN = 12;
  const bridge = window.petStage;

  // 悬停在她身上时的光标：一个蓝色软点 + 白描边，热点在正中。比手型光标柔和，也不抢她。
  const PET_CURSOR_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32'>"
    + "<circle cx='16' cy='16' r='10' fill='#5aa9ff' fill-opacity='0.28'/>"
    + "<circle cx='16' cy='16' r='5.5' fill='#2a7fff' fill-opacity='0.95' stroke='#ffffff' stroke-width='2'/></svg>";
  const PET_CURSOR = 'url("data:image/svg+xml;utf8,' + encodeURIComponent(PET_CURSOR_SVG) + '") 16 16, pointer';

  // 点中某个部位之后的**本地**动作：只点头摇头，表情交给主进程统一决定。
  // 理由：表情要按语境覆盖（黏人 / 隔久没摸 / 连击翻脸），那些数只有主进程手里有；
  // 两边同时改表情会互相打，看起来就是表情闪一下又回去。
  const REACTION = {
    hair: { move: 'nod' },
    head: { move: 'shake' },
    neck: { move: 'shake' },
    chest: { move: 'nod' },
    waist: { move: 'nod' },
    skirt: { move: 'shake' },
    leg: { move: 'nod' },
    foot: { move: 'nod' },
    body: { move: 'nod' },
  };

  function createInteraction({ app, model, engine }) {
    const canvas = app.view;
    let gl = null;
    try { gl = canvas.getContext('webgl2') || canvas.getContext('webgl'); } catch (e) { gl = null; }
    const pixel = new Uint8Array(4);
    let alphaOk = !!gl;
    let ignored = null;
    let dragging = false;
    let interactive = true;
    let smart = true;
    let profile = null;
    let lastHit = { x: -9999, y: -9999, at: 0, over: false };

    // ---- 画布 alpha ---------------------------------------------------------
    function alphaAt(clientX, clientY) {
      if (!alphaOk) return 0;
      const r = canvas.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return 0;
      const px = Math.round(((clientX - r.left) / r.width) * canvas.width);
      const py = Math.round(((clientY - r.top) / r.height) * canvas.height);
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return 0;
      try {
        gl.readPixels(px, canvas.height - 1 - py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      } catch (e) { alphaOk = false; return 0; }
      return pixel[3];
    }

    function sendIgnore(v) {
      if (v === ignored) return;
      ignored = v;
      if (bridge && bridge.ignore) bridge.ignore(v);
    }

    // 额外热区：回复钮、输入卡这类「不在模型剪影里的 UI」。
    // 不加这个，鼠标压上去照样判穿透，钮点不着。
    const hitTests = [];
    let forceEat = false;
    function extraHit(clientX, clientY) {
      for (const fn of hitTests) {
        try { if (fn(clientX, clientY)) return true; } catch (e) {}
      }
      return false;
    }

    function overModel(clientX, clientY) {
      return alphaAt(clientX, clientY) > ALPHA_MIN;
    }

    // 鼠标移动时决定这一格吃不吃鼠标，顺便换光标。
    // 手快的时候按位置缓存，别每像素都 readPixels，那是同步读显存，太快会掉帧。
    let overNow = null;
    function applyCursor(over) {
      const on = !!interactive && !!over && !dragging;
      if (on !== overNow) {
        overNow = on;
        document.documentElement.style.cursor = on ? PET_CURSOR : 'default';
      }
      if (!interactive) { sendIgnore(true); return; }
      if (dragging) { sendIgnore(false); return; }
      if (forceEat) { sendIgnore(false); return; }
      // 关掉智能穿透 = 整块窗口都吃鼠标（连透明处也吃）。
      // 给「就想让她挡在那儿、别点穿到底下」的人留的开关。
      if (!smart) { sendIgnore(false); return; }
      sendIgnore(!over);
    }

    window.addEventListener('mousemove', (e) => {
      if (dragging) { sendIgnore(false); return; }
      if (forceEat) { sendIgnore(false); return; }
      if (!smart) { applyCursor(false); return; }
      const now = performance.now();
      const same = Math.abs(e.clientX - lastHit.x) < 3 && Math.abs(e.clientY - lastHit.y) < 3;
      if (same && now - lastHit.at < 120) { applyCursor(lastHit.over); return; }
      if (now - lastHit.at < 16) { applyCursor(lastHit.over); return; }
      const over = overModel(e.clientX, e.clientY) || extraHit(e.clientX, e.clientY);
      lastHit = { x: e.clientX, y: e.clientY, at: now, over };
      applyCursor(over);
    }, true);

    window.addEventListener('mouseleave', () => { if (!dragging) sendIgnore(true); });

    // ---- 剪影标定 -----------------------------------------------------------
    function scanProfile() {
      if (!alphaOk) return null;
      const W = canvas.width;
      const H = canvas.height;
      if (W < 8 || H < 8) return null;
      const step = Math.max(1, Math.ceil(H / 192));
      const rowBuf = new Uint8Array(W * 4);
      const rows = [];
      for (let yy = 0; yy < H; yy += step) {
        try { gl.readPixels(0, H - 1 - yy, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, rowBuf); } catch (e) { return null; }
        let l = -1;
        let r = -1;
        for (let x = 0; x < W; x++) if (rowBuf[x * 4 + 3] > ALPHA_MIN) { l = x; break; }
        if (l < 0) continue;
        for (let x = W - 1; x >= 0; x--) if (rowBuf[x * 4 + 3] > ALPHA_MIN) { r = x; break; }
        rows.push({ y: yy / Math.max(1, H - 1), l: l / Math.max(1, W - 1), r: r / Math.max(1, W - 1), w: (r - l) / Math.max(1, W - 1) });
      }
      if (rows.length < 6) return null;
      let left = 1;
      let right = 0;
      for (const row of rows) { if (row.l < left) left = row.l; if (row.r > right) right = row.r; }
      const bbox = { top: rows[0].y, bottom: rows[rows.length - 1].y, left, right };
      const h = Math.max(1e-4, bbox.bottom - bbox.top);
      // 脖子 = 头下方那一段里最窄的一行。不写死百分比的唯一办法。
      let neck = null;
      for (const row of rows) {
        const rel = (row.y - bbox.top) / h;
        if (rel < 0.10 || rel > 0.42) continue;
        if (!neck || row.w < neck.w) neck = row;
      }
      const anchors = { neck: neck ? (neck.y - bbox.top) / h : 0.2 };
      return { bbox, rows, anchors, at: Date.now(), canvasH: H };
    }

    function ensureProfile() {
      if (!profile) profile = scanProfile();
      return profile;
    }

    // 只扫一次不够：窗口尺寸、缩放、换装都会让剪影变。标定失败就退化成「整块都算身上」。
    // 同一次拖动会连着调好几次，必须**只留一个定时器**：以前每次都新起一个，拖动时
    // 十几个扫描排队执行（每个都要同步 readPixels 整张画布），看起来就是卡 + 闪。
    let scanTimer = null;
    function resetProfile(delay) {
      profile = null;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        scanTimer = null;
        profile = scanProfile();
        reportHead();
      }, delay === undefined ? 600 : delay);
    }
    window.__stageZones = () => {
      const p = ensureProfile();
      if (!p) return null;
      return { bbox: p.bbox, anchors: p.anchors, rows: p.rows.length, headSample: p.rows.slice(0, 10) };
    };
    window.__stageZonesReset = resetProfile;

    // 点击坐标 → 剪影比例；落在剪影外面就返回 null
    function toSilhouette(clientX, clientY) {
      const p = ensureProfile();
      const r = canvas.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return null;
      const cx = (clientX - r.left) / r.width;
      const cy = (clientY - r.top) / r.height;
      if (!p) return { mx: cx, my: cy, calibrated: false };
      const bh = Math.max(1e-4, p.bbox.bottom - p.bbox.top);
      const bw = Math.max(1e-4, p.bbox.right - p.bbox.left);
      return { mx: (cx - p.bbox.left) / bw, my: (cy - p.bbox.top) / bh, calibrated: true };
    }

    // 剪影里的纵向比例 → 部位。以自动找出来的脖子为基准往下切，不依赖固定数值。
    function zoneOf(my, mx, p) {
      if (!p) return 'body';
      const neck = p.anchors.neck;
      if (my < neck * 0.28) return 'hair';
      if (my < neck * 0.92) return 'head';
      if (my < neck * 1.12) return 'neck';
      if (my < neck + (1 - neck) * 0.22) return 'chest';
      if (my < neck + (1 - neck) * 0.36) return 'waist';
      if (my < neck + (1 - neck) * 0.72) return 'skirt';
      if (my < 0.95) return 'leg';
      return 'foot';
    }

    // ---- 点她 --------------------------------------------------------------
    function tap(clientX, clientY) {
      if (!interactive) return null;
      if (!(overModel(clientX, clientY))) return null;
      const at = toSilhouette(clientX, clientY);
      if (!at) return null;
      const zone = zoneOf(at.my, at.mx, profile);
      const round = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
      const payload = { nx: round(at.mx), ny: round(at.my), zone, calibrated: !!at.calibrated, at: Date.now() };
      react(zone);
      if (bridge && bridge.tap) bridge.tap(payload);
      return payload;
    }

    function react(zone) {
      const r = REACTION[zone] || REACTION.body;
      if (r.move === 'nod') engine.nod();
      else if (r.move === 'shake') engine.shake();
    }

    window.addEventListener('click', (e) => {
      if (dragging || e.altKey) return;
      tap(e.clientX, e.clientY);
    }, true);

    // 右键她 → 弹菜单（隐藏 / 开关 / 尺寸 / 退出都在里面）
    window.addEventListener('contextmenu', (e) => {
      if (dragging || !overModel(e.clientX, e.clientY)) return;
      e.preventDefault();
      if (bridge && bridge.menu) bridge.menu();
    }, true);

    // ---- 拖动 --------------------------------------------------------------
    window.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !e.altKey) return;
      dragging = true;
      lastHit = { x: -9999, y: -9999, at: 0, over: false };
      sendIgnore(false); // 拖动期间必须一直吃鼠标
      e.preventDefault();
      if (bridge && bridge.dragStart) bridge.dragStart();
    }, true);

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      if (bridge && bridge.dragEnd) bridge.dragEnd();
    }, true);

    window.addEventListener('blur', () => {
      if (!dragging) return;
      dragging = false;
      if (bridge && bridge.dragEnd) bridge.dragEnd();
    });

    // ---- Ctrl + 滚轮微调大小 ------------------------------------------------
    window.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (bridge && bridge.wheel) bridge.wheel(e.deltaY > 0 ? -1 : 1);
      resetProfile(700);
    }, { passive: false });

    window.addEventListener('resize', () => resetProfile(700));

    // 起来的时候先定一次；canvas 尺寸稳定后再补两次
    setTimeout(() => resetProfile(0), 1200);
    setTimeout(() => { sendIgnore(true); }, 0);

    // 头顶的屏幕坐标：气泡要贴在这上面。
    // 不能用「剪影最上面 12% 里最宽的那一行」——那往往是头发最蓬的地方，比头顶低一大截；
    // 也不能用包围盒中心——这套模型尾巴往右伸得远，盒子中心会偏到她右侧去。
    // 正确做法：y 取剪影最顶那一行，x 取「顶下 3%」那一行的左右中点，那一行已经很靠近头顶中心了。
    function headAnchor() {
      const W = canvas.clientWidth || canvas.width;
      const H = canvas.clientHeight || canvas.height;
      const p = ensureProfile();
      if (!p || !p.rows || !p.rows.length) return { x: W / 2, y: H * 0.14 };
      const span = Math.max(1e-4, p.bbox.bottom - p.bbox.top);
      const goal = p.bbox.top + span * 0.03;
      let row = p.rows[0];
      let bestD = Infinity;
      for (const r of p.rows) {
        const d = Math.abs(r.y - goal);
        if (d < bestD) { bestD = d; row = r; }
      }
      return { x: ((row.l + row.r) / 2) * W, y: p.bbox.top * H };
    }

    // 脚边锚点：常驻回复钮蹲在她脚边，不压在身上——压头顶那块的结果是每次摸头都点到钮。
    // y 取剪影最低点往上抬一点点（抬多少跟窗口高度成比例，缩放后还是「脚背上一点点」），
    // x 取那一行的右沿再往外挪一点；右沿已经贴到窗边就退回窗口 70% 处（跟老外壳同一套相对量）。
    function footAnchor() {
      const W = canvas.clientWidth || canvas.width;
      const H = canvas.clientHeight || canvas.height;
      const p = ensureProfile();
      if (!p || !p.rows || !p.rows.length) return { x: W * 0.7, y: H * 0.9 };
      const y = Math.max(6, Math.min(H - 36, p.bbox.bottom * H - Math.max(10, H * 0.014)));
      // 钮是 30px 高，取钮中心那一行看右沿，才不会贴到脚趾缝里
      const targetN = Math.min(1, (y + 15) / Math.max(1, H));
      let row = p.rows[p.rows.length - 1];
      let bestD = Infinity;
      for (const r of p.rows) {
        const d = Math.abs(r.y - targetN);
        if (d < bestD) { bestD = d; row = r; }
      }
      const beside = row.r * W + 10;
      return { x: beside < W - 34 ? beside : W * 0.7, y };
    }

    // 阶段气泡的出生点（跟着外壳那套）：在上半身轮廓里随机挑一行，再在这一行里随机横坐标。
    // 四分之三落在这一行的外侧两段（头发边 / 肩 / 手臂），四分之一整行随机——
    // 这样正脸不会被泡糊住，又确实是「上半身哪儿都可能冒」。
    const TICK_BAND_TOP = 0.06;
    const TICK_BAND_BOTTOM = 0.46;
    function tickSpot() {
      const W = canvas.clientWidth || canvas.width;
      const H = canvas.clientHeight || canvas.height;
      const p = ensureProfile();
      if (!p || !p.rows || !p.rows.length) {
        return { x: W * (0.32 + Math.random() * 0.36), y: H * (0.16 + Math.random() * 0.2) };
      }
      const span = Math.max(1e-4, p.bbox.bottom - p.bbox.top);
      // 注意：bbox 和 rows[].y 都是**归一化比例**（0~1），别再除一次窗口高度
      const yn = p.bbox.top + span * (TICK_BAND_TOP + Math.random() * (TICK_BAND_BOTTOM - TICK_BAND_TOP));
      let best = p.rows[0];
      let bestD = Infinity;
      for (const r of p.rows) {
        const d = Math.abs(r.y - yn);
        if (d < bestD) { bestD = d; best = r; }
      }
      if (best && best.r > best.l + 0.01) {
        const s = best.r - best.l;
        let t;
        if (Math.random() < 0.25) t = 0.14 + Math.random() * 0.72;
        else t = Math.random() < 0.5 ? 0.04 + Math.random() * 0.28 : 0.68 + Math.random() * 0.28;
        return { x: (best.l + s * t) * W, y: yn * H };
      }
      // 这一行几乎没扫到东西（头顶边缘 / 侧脸）：退到剪影中线附近，别扔到窗外
      const mid = ((p.bbox.left || 0) + (p.bbox.right || 1)) / 2;
      return { x: mid * W + (Math.random() - 0.5) * Math.max(40, (p.bbox.right - p.bbox.left) * W * 0.5), y: yn * H };
    }

    // 把头顶报给主进程：绕圈判定要用「真实的头」当圆心，不能用窗口中心。
    // 报的是窗口比例（画布铺满窗口），主进程按窗口像素换算，窗口缩放拖动都不用重报。
    function reportHead() {
      const p = ensureProfile();
      if (!p || !bridge || !bridge.head) return;
      const W = canvas.clientWidth || canvas.width;
      const H = canvas.clientHeight || canvas.height;
      if (W < 8 || H < 8) return;
      const a = headAnchor();
      bridge.head({
        x: +(a.x / W).toFixed(4),
        top: +p.bbox.top.toFixed(4),
        span: +(p.bbox.bottom - p.bbox.top).toFixed(4),
      });
    }

    return {
      tap,
      get ignored() { return ignored; },
      addHitTest(fn) { if (typeof fn === 'function') hitTests.push(fn); },
      // 输入卡开着的时候整窗吃鼠标：不然点文本框那一瞬间窗口穿透，卡就点了没反应
      setForceEat(on) {
        forceEat = !!on;
        if (forceEat) sendIgnore(false);
        else { lastHit = { x: -9999, y: -9999, at: 0, over: false }; }
      },
      setInteractive(on) {
        interactive = !!on;
        overNow = null;
        document.documentElement.style.cursor = 'default';
        applyCursor(false);
      },
      // 智能穿透开关：false = 整块窗口都吃鼠标（透明处也吃），点不到底下
      setSmart(on) {
        smart = on !== false;
        overNow = null;
        lastHit = { x: -9999, y: -9999, at: 0, over: false };
        if (!smart) { document.documentElement.style.cursor = 'default'; sendIgnore(false); }
        else applyCursor(false);
        return smart;
      },
      get smart() { return smart; },
      alphaAt,
      headAnchor,
      footAnchor,
      tickSpot,
      reportHead,
      resetProfile,
    };
  }

  window.createStageInteraction = createInteraction;
})();
