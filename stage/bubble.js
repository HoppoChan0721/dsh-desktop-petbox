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
      get visible() { return visible; },
      get text() { return el.textContent || ''; },
    };
  }

  window.createStageBubble = createBubble;
})();
