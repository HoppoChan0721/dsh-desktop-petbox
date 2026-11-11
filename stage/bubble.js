// 气泡层：她说话时头顶冒一个泡，逐字出水，过一会儿自己淡掉。
//
// 气泡贴着她的头顶而不是窗口某个角：位置每帧从剪影标定里算，所以她呼吸、探身、被缩放的时候
// 泡也跟着走。位置错开一截就会显得像挂在窗口上的便签，不像她在说话。
//
// 泡本身 pointer-events:none，绝不挡点击——不然想摸她脸会点出一个泡。
(function () {
  'use strict';

  const STYLE_ID = 'stage-bubble-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#bubble-layer{position:absolute;inset:0;pointer-events:none;z-index:9999;overflow:hidden}',
      '#bubble{position:absolute;left:50%;top:20%;transform:translate(-50%,-100%);',
      'max-width:78%;box-sizing:border-box;padding:9px 12px;border-radius:12px;',
      'background:rgba(255,255,255,.93);color:#2b3d3a;',
      'box-shadow:0 6px 18px rgba(0,0,0,.18);white-space:pre-wrap;word-break:break-word;',
      'opacity:0;transition:opacity .22s;font-family:system-ui,"Microsoft YaHei";line-height:1.5;',
      '}',
      '#bubble.on{opacity:1}',
      '#bubble::after{content:"";position:absolute;left:50%;bottom:-6px;width:12px;height:12px;',
      'margin-left:-6px;background:rgba(255,255,255,.93);transform:rotate(45deg);border-radius:2px}',
      '#bubble .dot{display:inline-block;width:5px;height:5px;margin:0 2px;border-radius:50%;',
      'background:#2b3d3a;opacity:.3;animation:stageDot 1.1s infinite}',
      '#bubble .dot:nth-child(2){animation-delay:.15s}',
      '#bubble .dot:nth-child(3){animation-delay:.3s}',
      '@keyframes stageDot{0%,60%,100%{opacity:.25;transform:translateY(0)}30%{opacity:1;transform:translateY(-2px)}}',
      // 阶段气泡：圆滚滚的泡，从上半身任意位置冒出来，边往上飘边左右晃。几颗一起，各自 2~4 秒飘完消失。
      // 外框 .tick-puff 只做位移（左右摆 + 上浮），.tick 是泡本体（圆/椭圆）。
      // 这套是外壳那边原样搬过来的：主人点名的就是这个手感。
      // 高光点和中心亮斑在外壳那边就去掉了——泡小字多时高光正好压在顶部那行字上，看着像字被糊掉一块。
      '.tick-puff{position:absolute;left:0;top:0;pointer-events:none;z-index:9998;will-change:transform,opacity}',
      '.tick{position:relative;display:flex;align-items:center;justify-content:center;border-radius:50%;overflow:hidden;box-sizing:border-box;',
      'background:linear-gradient(158deg,rgba(246,252,255,.92),rgba(228,244,255,.86) 48%,rgba(172,212,242,.78) 100%);',
      'color:#1c3550;font:13px/1.22 system-ui,"Microsoft YaHei";pointer-events:none;',
      'box-shadow:0 5px 14px rgba(26,74,128,.16),inset 0 0 0 1.5px rgba(255,255,255,.7),inset 0 -9px 16px rgba(140,190,235,.22)}',
      '.tick-txt{display:flex;align-items:center;justify-content:center;text-align:center;overflow:hidden;',
      'word-break:break-word;overflow-wrap:anywhere;white-space:pre-line}',
    ].join('');
    document.head.appendChild(style);
  }

  // 段间空行压成一个换行：一整行空的太松散。只影响显示。
  function compact(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  function createBubble({ app, interaction }) {
    injectStyle();
    const layer = document.createElement('div');
    layer.id = 'bubble-layer';
    document.body.appendChild(layer);
    const el = document.createElement('div');
    el.id = 'bubble';
    layer.appendChild(el);

    let typeTimer = null;
    let hideTimer = null;
    let rafId = 0;
    let visible = false;

    // 字号跟窗口走：窗口小的时候 22px 会顶掉半个身子
    function fontPx() {
      const W = app.screen.width || 531;
      return Math.max(12, Math.min(22, Math.round(W * 0.032)));
    }

    function place() {
      if (!visible) return;
      el.style.fontSize = fontPx() + 'px';
      let anchor = null;
      try { anchor = interaction && interaction.headAnchor ? interaction.headAnchor() : null; } catch (e) { anchor = null; }
      const W = app.screen.width || 531;
      const H = app.screen.height || 950;
      const x = anchor ? anchor.x : W / 2;
      const y = anchor ? anchor.y : H * 0.14;
      el.style.left = Math.round(Math.max(8, Math.min(W - 8, x))) + 'px';
      // 泡底边留一点空隙压在头顶上方，别糊到头发上
      el.style.top = Math.round(Math.max(28, y - 10)) + 'px';
    }

    function loop() {
      if (!visible) { rafId = 0; return; }
      place();
      rafId = requestAnimationFrame(loop);
    }

    function show() {
      visible = true;
      el.classList.add('on');
      place();
      if (!rafId) rafId = requestAnimationFrame(loop);
    }

    function hide() {
      clearTimeout(typeTimer);
      clearTimeout(hideTimer);
      visible = false;
      el.classList.remove('on');
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    }

    // 逐字出水：默认每 30ms 一个字符；给了 reveal（毫秒）就按整句摊平，
    // 有语音的时候用音频时长来定，字和声音才对得上。
    function type(text, hold, reveal) {
      clearTimeout(typeTimer);
      clearTimeout(hideTimer);
      el.textContent = '';
      show();
      const n = Math.max(1, text.length);
      const gap = Number(reveal) > 0
        ? Math.max(18, Math.min(140, Math.round(Number(reveal) / n)))
        : 30;
      let i = 0;
      const tick = () => {
        i++;
        el.textContent = text.slice(0, i);
        place();
        if (i < text.length) {
          typeTimer = setTimeout(tick, gap);
        } else {
          hideTimer = setTimeout(hide, hold);
        }
      };
      typeTimer = setTimeout(tick, 16);
    }

    // ---- 阶段气泡 -----------------------------------------------------------
    // 一颗泡 = 外框 .tick-puff 只负责飘（上浮 + 左右摆 + 微转）+ 泡本体 .tick（圆/椭圆）。
    // 出生点不是固定位置：在上半身轮廓里随机挑一行、再在这一行里随机横坐标，
    // 四分之三落在这一行的外侧两段（头发边 / 肩 / 手臂），这样正脸不会被泡糊住。
    // 泡的大小跟着字数走，短句是小圆泡，长一点摊成椭圆（横竖比最多 1.45，别摊成条）。
    const MAX_TICKS = 5;
    const ticks = [];

    function tick(text, ms) {
      const full = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!full) return null;
      const life = Math.max(2000, Math.min(4000, Number(ms) || 3000));   // 单颗 2~4 秒
      const W = app.screen.width || 531;
      const H = app.screen.height || 950;
      const nchar = full.length;

      const hh = Math.round(Math.max(54, Math.min(80, 52 + nchar * 1.6)));
      const aspect = Math.min(1.45, 1 + Math.max(0, nchar - 9) * 0.022);
      const ww = Math.round(hh * aspect);

      const puff = document.createElement('div');
      puff.className = 'tick-puff';
      const el = document.createElement('div');
      el.className = 'tick';
      el.style.width = ww + 'px';
      el.style.height = hh + 'px';
      const txt = document.createElement('div');
      txt.className = 'tick-txt';
      // 文字框取内接矩形（0.71 倍），贴在椭圆上也不会被圆角切掉笔画
      const boxW = Math.round(ww * 0.71);
      const boxH = Math.round(hh * 0.71);
      txt.style.width = boxW + 'px';
      txt.style.height = boxH + 'px';
      // 短中文短语手动对半分两行，不然在圆泡里会被挤成 3+1 个字
      let shown = full;
      if (nchar >= 4 && nchar <= 10 && !/[\sA-Za-z0-9]/.test(full)) {
        const cut = Math.ceil(nchar / 2);
        shown = full.slice(0, cut) + '\n' + full.slice(cut);
      }
      txt.textContent = shown;
      el.appendChild(txt);
      puff.appendChild(el);
      layer.appendChild(puff);

      // 字号自适应：泡小字多就往下缩，13 → 9px
      let fs = 13;
      txt.style.fontSize = fs + 'px';
      while (fs > 9 && txt.scrollHeight > boxH + 1) { fs -= 1; txt.style.fontSize = fs + 'px'; }

      // 出生点：有剪影就用剪影（上半身外侧两段），没有就退回上半身中间那片
      let spot = null;
      try { spot = interaction && interaction.tickSpot ? interaction.tickSpot() : null; } catch (e) { spot = null; }
      if (!spot) spot = { x: W * (0.32 + Math.random() * 0.36), y: H * (0.16 + Math.random() * 0.2) };

      // 跟已经在飘的泡别叠在一起：位置随机抽，抽到挤了就重抽，最多试 7 次
      const overlaps = (l, t) => {
        for (const p of ticks) {
          const q = p.getBoundingClientRect();
          if (l + ww + 6 < q.left || l > q.right + 6) continue;
          if (t + hh + 6 < q.top || t > q.bottom + 6) continue;
          return true;
        }
        return false;
      };
      let left = 0;
      let top = 0;
      for (let k = 0; k < 7; k++) {
        left = Math.max(2, Math.min(W - ww - 2, Math.round(spot.x - ww / 2)));
        top = Math.max(2, Math.min(H - hh - 2, Math.round(spot.y - hh / 2)));
        if (!overlaps(left, top)) break;
        try { spot = interaction && interaction.tickSpot ? interaction.tickSpot() : spot; } catch (e) {}
      }
      puff.style.left = left + 'px';
      puff.style.top = top + 'px';

      // 飘升距离：够到顶部还剩 4px 就行，别飞出窗外
      const rise = Math.round(Math.min(72 + Math.random() * 62, Math.max(28, top - 4)));
      // 整体漂移：八成往外飘（离开身体中线），这样正脸不容易被几颗泡糊住
      const bodyX = W / 2;
      const outward = spot.x >= bodyX ? 1 : -1;
      const dir = Math.random() < 0.8 ? outward : (Math.random() < 0.5 ? -1 : 1);
      const drift = dir * (12 + Math.random() * 24);
      const amp = 7 + Math.random() * 10;         // 左右抖动幅度
      const freq = 0.8 + Math.random() * 0.9;     // 一趟晃几个来回
      const phase = Math.random() * Math.PI * 2;
      const steps = Math.max(20, Math.min(34, Math.round(life / 130)));
      const frames = [];
      for (let i = 0; i <= steps; i++) {
        const p = i / steps;
        const ramp = Math.min(1, p * 1.8);                       // 刚冒出来先别晃，站稳了再摆
        const sw = Math.sin(phase + p * Math.PI * 2 * freq) * ramp;
        const x = drift * p + amp * sw;
        const y = -rise * (0.3 * p + 0.7 * p * p);               // 越飘越快，像真气泡
        const rot = sw * 4.2;
        const o = p < 0.07 ? p / 0.07 : (p < 0.6 ? 1 : Math.max(0, (1 - p) / 0.4));
        const s = p < 0.14 ? 0.6 + (p / 0.14) * 0.48 : (p < 0.26 ? 1.08 - ((p - 0.14) / 0.12) * 0.08 : 1);
        frames.push({
          offset: +p.toFixed(3),
          opacity: +o.toFixed(3),
          transform: 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0) rotate(' + rot.toFixed(2) + 'deg) scale(' + s.toFixed(3) + ')',
        });
      }

      let anim = null;
      const drop = () => {
        try { puff.remove(); } catch (e) {}
        const i = ticks.indexOf(puff);
        if (i >= 0) ticks.splice(i, 1);
      };
      try {
        anim = puff.animate(frames, { duration: life, easing: 'linear', fill: 'forwards' });
        anim.onfinish = drop;
        anim.oncancel = drop;
      } catch (e) {
        // 老内核没有 WAAPI 就退化成定时消失，别让一颗泡卡在屏幕上
        setTimeout(drop, life);
      }
      ticks.push(puff);
      while (ticks.length > MAX_TICKS) {
        const old = ticks.shift();
        if (old) { try { old.remove(); } catch (e) {} }
      }
      return { text: full, ms: life, w: ww, h: hh, fs, count: ticks.length };
    }

    return {
      say(text, ms, reveal) {
        const t = compact(text).slice(0, 300);
        if (!t) return false;
        const hold = Number(ms) > 0 ? Number(ms) : Math.max(2200, Math.min(9000, t.length * 130));
        type(t, hold, reveal);
        return true;
      },
      // 等待态：三个点在那儿跳，自己不说话
      wait(ms) {
        clearTimeout(typeTimer);
        clearTimeout(hideTimer);
        el.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
        show();
        hideTimer = setTimeout(hide, Number(ms) > 0 ? Number(ms) : 20000);
        return true;
      },
      hide,
      place,
      tick,
      get visible() { return visible; },
      get text() { return el.textContent || ''; },
      get ticks() { return ticks.length; },
    };
  }

  window.createStageBubble = createBubble;
})();
