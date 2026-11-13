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
    ear: { move: 'shake' },
    neck: { move: 'shake' },
    chest: { move: 'nod' },
    waist: { move: 'nod' },
    skirt: { move: 'shake' },
    leg: { move: 'nod' },
    tail: { move: 'shake' },
    hand: { move: 'nod' },
    arm: { move: 'nod' },
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
        // 顺手记下这一行的每一段：头发、尾巴、手这些「伸出去的」跟身子在这一行里是分开的几段，
        // 只记左右边界的话，侧面头发会被当成胸口、尾巴会被当成腿。
        const segs = [];
        let open = -1;
        for (let x = l; x < W; x++) {
          const on = rowBuf[x * 4 + 3] > ALPHA_MIN;
          if (on && open < 0) open = x;
          else if (!on && open >= 0) { segs.push([open / Math.max(1, W - 1), (x - 1) / Math.max(1, W - 1)]); open = -1; }
        }
        if (open >= 0) segs.push([open / Math.max(1, W - 1), 1]);
        for (let x = W - 1; x >= 0; x--) if (rowBuf[x * 4 + 3] > ALPHA_MIN) { r = x; break; }
        rows.push({ y: yy / Math.max(1, H - 1), l: l / Math.max(1, W - 1), r: r / Math.max(1, W - 1), w: (r - l) / Math.max(1, W - 1), segs });
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
      // 身体中线：取头顶那几行的中点。头是对称的，比整块包围盒（被尾巴拉偏）靠谱。
      const topRows = rows.filter((row) => row.y < bbox.top + h * 0.15);
      anchors.center = topRows.length
        ? topRows.reduce((acc, row) => acc + (row.l + row.r) / 2, 0) / topRows.length
        : 0.5;
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
    function bandZone(my, p) {
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

    // 部位 = 纵向那条带子 + 横向这一截是不是「伸出去的」。
    // 侧面头发和尾巴在剪影里是单独几段，跟身子分开：离身体中线远、又不宽的那一段，
    // 上半身算头发、下半身算尾巴。这样点侧发不会再报胸口，点尾巴也不会再报腿。
    // 不分左右、不猜手臂：这两样要真部件才分得准，先只修最刺眼的那两类误判。
    function zoneOf(my, mx, p) {
      if (!p) return 'body';
      const band = bandZone(my, p);
      if (!p.rows || !p.rows.length) return band;
      const center = Number.isFinite(p.anchors.center) ? p.anchors.center : 0.5;
      let row = p.rows[0];
      let best = Infinity;
      for (const r of p.rows) {
        const dd = Math.abs(r.y - my);
        if (dd < best) { best = dd; row = r; }
      }
      const segs = row.segs;
      if (!segs || !segs.length) return band;
      // mx 是「剪影包围盒里的比例」，segs 是画布绝对比例，先换算到同一套坐标再比
      const bw = Math.max(1e-4, p.bbox.right - p.bbox.left);
      const ax = p.bbox.left + mx * bw;
      // 身体中线附近一律按带子算：那里不管剪影怎么分叉，都是她的身子。
      // 没有这条，裙摆中间那种地方偶尔会被判成尾巴（上下几行分叉的位置不一样）。
      if (Math.abs(ax - center) < 0.10) return band;
      // 只看最近那一行不够：头发往下垂、尾巴往回勾的地方，那一行常常跟身子连成一片，
      // 上下挪两三行才又分开。所以看一个小窗口，只要附近有一行能证明它是「伸出去的」就算。
      let off = 0;
      let wide = 1;
      let found = false;
      for (const r of p.rows) {
        if (Math.abs(r.y - my) > 0.025) continue;
        const ss = r.segs || [];
        let seg = null;
        for (const s of ss) {
          if (ax >= s[0] - 0.012 && ax <= s[1] + 0.012) { seg = s; break; }
        }
        if (!seg) continue;
        const w = seg[1] - seg[0];
        if (w >= 0.3) continue;                   // 这一行整块身子连着，看不出什么
        const o = Math.abs((seg[0] + seg[1]) / 2 - center);
        if (o > off) { off = o; wide = w; found = true; }
      }
      if (found && off > 0.12) return my < 0.52 ? 'hair' : 'tail';
      return band;
    }

    // ---- 真部件级点触 -------------------------------------------------------
    //
    // 剪影比例分区只能到「腰／裙摆／腿」这种粗档：长裙压着腰、尾巴从腿前面绕过去，
    // 点上去报的部位就是错的（点腰说她被摸胸，点尾巴说她被摸腿，都是这个原因）。
    // 这里改成问模型自己：每个 drawable 的顶点、它挂在哪根 part 下都能从 Cubism 读出来，
    // 点落在哪些三角形里就算命中哪些，取画在最上面那一层（drawOrder 最大），
    // 头发／尾巴挡住的部位自然不算数。开销只在松手那一下，只算不渲染。
    //
    // partId → 中文名来自模型目录里的 *.cdi3.json，由主进程读出来推过来（没推就退化成 partId）。
    // 换模型不用改代码：名字对不上就直接落回剪影分区，不会点不动。
    let partNames = null;
    function setParts(map) {
      partNames = map && typeof map === 'object' ? map : null;
      return !!partNames;
    }

    // Cubism 的 canvas 坐标原点在画布中心、y 朝上；PIXI 那边是左上角、y 朝下。
    // toModelPosition 给的是模型原始像素坐标，按 canvas/original 的比例缩一下再挪到中心。
    // 整体摇摆、体型偏移、窗口缩放都已经在 worldTransform 里，所以这里不用再补。
    function coreFrame() {
      try {
        const im = model.internalModel;
        const core = im && im.coreModel;
        const d = core && core._model && core._model.drawables;
        if (!d || !d.count) return null;
        const cw = core.getCanvasWidth();
        const ch = core.getCanvasHeight();
        const ow = im.originalWidth || im.width || 0;
        const oh = im.originalHeight || im.height || 0;
        if (!(cw > 0 && ch > 0 && ow > 0 && oh > 0)) return null;
        return { core, d, cx: cw / 2, cy: ch / 2, sx: cw / ow, sy: ch / oh };
      } catch (e) { return null; }
    }

    // ---- 点触算哪个部件：直接问渲染管线 --------------------------------------
    //
    // 只看几何靠不住：这套模型 715 个 drawable 里，腿和鞋是 Cubism 的「蒙皮」网格，
    // 核心给出的顶点只是绑定姿势，跟屏幕上实际画在哪不是一回事；尾巴、头发又是一整块大网格罩一片。
    // 结果就是点腿报成尾巴、点腰报成胸——主人说的正是这一类。
    //
    // 所以改成让 GL 自己回答：drawable 按渲染顺序从下往上排好，二分找
    // 「至少画到第几层，这个像素才不透明」，那一层就是点在最上面的东西。
    // 715 层 → 10 次渲染，每次几毫秒，只在松手那一下算；判完立刻把完整画面渲回去，
    // 全在同一个任务里做完，屏幕上看不到中间那些帧，也不会闪。
    let maskSet = null;   // 哪些 drawable 被别的图层当遮罩源用
    function pickDrawable(clientX, clientY) {
      const f = coreFrame();
      if (!f || !gl) return -1;
      if (alphaAt(clientX, clientY) <= ALPHA_MIN) return -1;   // 本来点在透明处
      const d = f.d;
      if (!maskSet) {
        maskSet = new Uint8Array(d.count);
        for (let i = 0; i < d.count; i++) {
          const ms = d.masks && d.masks[i];
          if (!ms) continue;
          for (let k = 0; k < ms.length; k++) maskSet[ms[k]] = 1;
        }
      }
      // 遮罩源不能藏：Cubism 的裁剪是「先把遮罩源画进遮罩缓冲」，藏了遮罩源，
      // 被它裁的图层整片消失，二分就会一路找到别人身上。所以只在「不是遮罩源」的图层里二分。
      // 藏的时候连遮罩源一起藏：留着它们就不会变透明（这套模型的遮罩源本身就是主画面那一层），
      // 二分永远走不到底。代价是被遮罩的图层会跟着遮罩源一起消失，但那是往下掉的，
      // 不影响「最上面这一层是谁」。
      const order = [];
      for (let i = 0; i < d.count; i++) order.push(i);
      // renderOrders 才是真正的绘制顺序（drawOrders 这套模型全是 500，没法用）。
      // 而且 Cubism 里**数值小的画在前面**：脸 408 压着后脑勺 430，尾巴 39 压着腿。
      // 所以降序排：order[0] = 最前面那一层。
      order.sort((a, b) => (Number(d.renderOrders[b]) || 0) - (Number(d.renderOrders[a]) || 0));
      const saved = new Array(d.count);
      for (let i = 0; i < d.count; i++) saved[i] = d.opacities[i];
      // 二分的是「从最前面往后藏掉几层」：藏着藏着这个像素变透明了，
      // 那刚好藏掉的那一层就是点在最前面的东西。
      const n = order.length;
      const apply = (k) => {
        for (let j = 0; j < n; j++) {
          const i = order[j];
          d.opacities[i] = j < k ? 0 : saved[i];
        }
      };
      let lo = 1;
      let hi = n;
      let hidden = 0;                 // 最少藏几层才会变透明
      try {
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          apply(mid);
          app.renderer.render(app.stage);
          if (alphaAt(clientX, clientY) > ALPHA_MIN) lo = mid + 1;
          else { hidden = mid; hi = mid - 1; }
        }
      } catch (e) { hidden = 0; } finally {
        for (let i = 0; i < d.count; i++) d.opacities[i] = saved[i];
        try { app.renderer.render(app.stage); } catch (e) {}
      }
      return hidden ? order[hidden - 1] : -1;
    }

    // 点 → 部件。返回 null = 没命中（交给剪影分区兜底）
    function partAt(clientX, clientY) {
      const f = coreFrame();
      if (!f) return null;
      const best = pickDrawable(clientX, clientY);
      if (best < 0) return null;
      const d = f.d;
      const partIndex = d.parentPartIndices[best];
      const partId = (f.core._partIds && f.core._partIds[partIndex]) || '';
      const name = (partNames && (partNames[partId] || partNames[partIndex])) || partId || '';
      return { name, partId, partIndex, drawable: best };
    }

    // 部件中文名 → 分区。顺序有讲究：先长词（手臂要排在手指前面），裙子整块都算裙摆。
    const PART_ZONE = [
      [/耳朵/, 'ear'],
      [/手臂|大臂|袖子/, 'arm'],
      [/^手$|手(?!臂)/, 'hand'],
      [/尾巴/, 'tail'],
      [/脖子/, 'neck'],
      [/胸|领子/, 'chest'],
      [/腰/, 'waist'],
      [/裙/, 'skirt'],
      [/呆毛|前发|侧发|后发|后脑勺|头发|发饰/, 'hair'],
      [/腿|脚|鞋|袜/, 'leg'],
      [/头|脸|眼|眉|嘴|鼻|五官|口内|牙/, 'head'],
    ];
    // 腿这块 part 从上到下一整块（袜子、脚踝、鞋都画在里面），蒙皮网格拿不到顶点位置，
    // 所以不再按 part 自己的包围盒切，而是看这一点在**整只剪影**里有多靠下：
    // 最后 7% 算脚。脱了鞋点脚背就是丝足，点小腿还是小腿。
    const FOOT_BAND = 0.07;

    function zoneOfPart(hit, my) {
      if (!hit || !hit.name) return '';
      for (const [re, zone] of PART_ZONE) {
        if (!re.test(hit.name)) continue;
        if (zone === 'leg' && Number.isFinite(my) && my > 1 - FOOT_BAND) return 'foot';
        return zone;
      }
      return '';
    }

    // 调试用：给一对坐标，返回它算成哪个部位、命中的是哪根 part
    function inspectHit(clientX, clientY) {
      const hit = partAt(clientX, clientY);
      const at = toSilhouette(clientX, clientY);
      const band = at ? zoneOf(at.my, at.mx, profile) : 'body';
      const zone = zoneOfPart(hit, at ? at.my : NaN) || band;
      // 横向那一步到底是哪一截、离中线多远，配分区阈值时要看这个
      let segInfo = null;
      if (at && profile && profile.rows && profile.rows.length) {
        let row = profile.rows[0];
        let best = Infinity;
        for (const r of profile.rows) { const dd = Math.abs(r.y - at.my); if (dd < best) { best = dd; row = r; } }
        const bw = Math.max(1e-4, profile.bbox.right - profile.bbox.left);
        const ax = profile.bbox.left + at.mx * bw;
        segInfo = { y: +row.y.toFixed(3), ax: +ax.toFixed(3), segs: row.segs, center: +(profile.anchors.center || 0).toFixed(3) };
      }
      return { zone, band, seg: segInfo, part: hit ? hit.name : '', partId: hit ? hit.partId : '', drawable: hit ? hit.drawable : -1, calibrated: at ? !!at.calibrated : false, names: partNames ? Object.keys(partNames).length : 0 };
    }

    // ---- 点她 --------------------------------------------------------------
    function tap(clientX, clientY) {
      if (!interactive) return null;
      if (!(overModel(clientX, clientY))) return null;
      const at = toSilhouette(clientX, clientY);
      if (!at) return null;
      // 默认还是按剪影分区（稳）。部件级判定能用，但这套模型是重蒙皮 + 重遮罩的，
      // 拿不准的地方比拿得准的多，所以先用 window.__stagePartZones = true 单独开着试，
      // 用 /hit?x=&y= 能同时看到「真部件」和「剪影分区」两个结果。
      let hit = null;
      let zone = zoneOf(at.my, at.mx, profile);
      if (window.__stagePartZones) {
        hit = partAt(clientX, clientY);
        zone = zoneOfPart(hit, at.my) || zone;
      }
      const round = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
      const payload = {
        nx: round(at.mx), ny: round(at.my), zone, calibrated: !!at.calibrated, at: Date.now(),
        part: hit ? hit.name : '', partId: hit ? hit.partId : '',
      };
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
    // 剪影的脚底中心：整身摇摆的支点用它，不能用窗口底边（小体型会「漂」）
    function feetAnchor() {
      const W = canvas.clientWidth || canvas.width;
      const H = canvas.clientHeight || canvas.height;
      const p = ensureProfile();
      if (!p || !p.rows || !p.rows.length) return { x: W / 2, y: H };
      // 最低几行的中点平均：最后一行常常只有鞋跟一小块，单取一个点会偏
      const tail = p.rows.slice(-3);
      let x = 0;
      for (const r of tail) x += (r.l + r.r) / 2;
      return { x: (x / tail.length) * W, y: p.bbox.bottom * H };
    }

    // 模型整身会绕脚底轻晃（engine.applyWholeSway），但剪影是标定那一刻扫下来的：
    // 头已经跟着转过去一点点，气泡还贴在旧位置，看着就是「泡和头分家」。
    // 按当前倾角把点绕着**脚底支点**转回来。
    function swayCompensate(pt, W, H) {
      const deg = engine && Number.isFinite(engine.swayAngle) ? engine.swayAngle : 0;
      if (!deg) return pt;
      const a = deg * Math.PI / 180;
      const pivot = feetAnchor();
      const px = pivot.x;
      const py = pivot.y;
      const dx = pt.x - px;
      const dy = pt.y - py;
      return { x: px + dx * Math.cos(a) - dy * Math.sin(a), y: py + dx * Math.sin(a) + dy * Math.cos(a) };
    }

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
      return swayCompensate({ x: ((row.l + row.r) / 2) * W, y: p.bbox.top * H }, W, H);
    }

    // 脚边锚点：常驻回复钮蹲在她脚边，不压在身上——压头顶那块的结果是每次摸头都点到钮。
    // y 取剪影最低点往上抬一点点（抬多少跟窗口高度成比例，缩放后还是「脚那块」），
    // x 取那一行的右沿再往外让开一段（主人说贴脚太近，让开尺度跟窗口宽度成比例）；
    // 右沿已经贴到窗边就退回窗口 74% 处。
    function footAnchor() {
      const W = canvas.clientWidth || canvas.width;
      const H = canvas.clientHeight || canvas.height;
      const p = ensureProfile();
      if (!p || !p.rows || !p.rows.length) return { x: W * 0.74, y: H * 0.92 };
      const y = Math.max(6, Math.min(H - 36, p.bbox.bottom * H - Math.max(6, H * 0.008)));
      // 钮是 30px 高，取钮中心那一行看右沿，才不会贴到脚趾缝里
      const targetN = Math.min(1, (y + 15) / Math.max(1, H));
      let row = p.rows[p.rows.length - 1];
      let bestD = Infinity;
      for (const r of p.rows) {
        const d = Math.abs(r.y - targetN);
        if (d < bestD) { bestD = d; row = r; }
      }
      const gap = Math.max(30, W * 0.07);
      const beside = row.r * W + gap;
      return { x: beside < W - 34 ? beside : Math.max(W * 0.74, W - 44), y };
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
      setParts,
      inspectHit,
      headAnchor,
      footAnchor,
      feetAnchor,
      tickSpot,
      reportHead,
      resetProfile,
    };
  }

  window.createStageInteraction = createInteraction;
})();
