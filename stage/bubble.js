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
      // 阶段气泡：小圆泡，从肩线冒出来往上飘。跟正文气泡分开，
      // 正文是「她在说话」，这个是「进度/状态」，不该抢同一块地方。
      '.tick{position:absolute;z-index:9998;box-sizing:border-box;padding:4px 9px;border-radius:14px;',
      'max-width:62%;background:rgba(255,255,255,.9);color:#33534e;box-shadow:0 3px 10px rgba(0,0,0,.14);',
      'font-family:system-ui,"Microsoft YaHei";line-height:1.35;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;pointer-events:none;will-change:transform,opacity}',
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
    // 一颗泡 = 自己飘上去 + 淡出，2~4 秒。同时最多 4 颗，多了直接顶掉最老的。
    // 位置按剪影算：肩膀那条线（头顶往下 22% 的跨度），偏出去那侧，
    // 这样正脸不会被几颗泡糊住。
    const MAX_TICKS = 4;
    const ticks = [];

    function tick(text, ms) {
      const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!t) return null;
      const life = Math.max(2000, Math.min(4000, Number(ms) || 3000));
      const W = app.screen.width || 531;
      const H = app.screen.height || 950;
      let a = null;
      try { a = interaction && interaction.headAnchor ? interaction.headAnchor() : null; } catch (e) { a = null; }
      const cx = a ? a.x : W / 2;
      const cy = a ? Math.min(H - 40, a.y + H * 0.22) : H * 0.3;
      const side = Math.random() < 0.5 ? -1 : 1;
      const offX = side * (W * 0.1 + Math.random() * W * 0.12);

      const el = document.createElement('div');
      el.className = 'tick';
      el.textContent = t;
      el.style.fontSize = Math.max(11, Math.min(16, Math.round(W * 0.024))) + 'px';
      layer.appendChild(el);
      const left = Math.round(Math.max(4, Math.min(W - 40, cx + offX)));
      const top = Math.round(Math.max(4, Math.min(H - 30, cy)));
      el.style.left = left + 'px';
      el.style.top = top + 'px';

      const rise = 46 + Math.random() * 54;
      const drift = side * (10 + Math.random() * 18);
      const frames = [];
      const steps = 18;
      for (let i = 0; i <= steps; i++) {
        const p = i / steps;
        const o = p < 0.08 ? p / 0.08 : (p < 0.62 ? 1 : Math.max(0, (1 - p) / 0.38));
        const x = drift * p + Math.sin(p * Math.PI * 2.2) * 5;
        const y = -rise * (0.35 * p + 0.65 * p * p);
        frames.push({ opacity: +o.toFixed(3), transform: 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)' });
      }
      let anim = null;
      const drop = () => {
        try { el.remove(); } catch (e) {}
        const i = ticks.indexOf(el);
        if (i >= 0) ticks.splice(i, 1);
      };
      try {
        anim = el.animate(frames, { duration: life, easing: 'linear', fill: 'forwards' });
        anim.onfinish = drop;
        anim.oncancel = drop;
      } catch (e) {
        // 老内核没有 WAAPI 就退化成定时消失，别让一颗泡卡在屏幕上
        setTimeout(drop, life);
      }
      ticks.push(el);
      while (ticks.length > MAX_TICKS) {
        const old = ticks.shift();
        if (old) { try { old.remove(); } catch (e) {} }
      }
      return { text: t, ms: life, count: ticks.length };
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
