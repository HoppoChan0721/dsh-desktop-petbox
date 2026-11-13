// 回复钮 + 输入卡：桌宠里直接给主人打字，走同一座桥（dsh-pet-bridge）投进 DSH 会话。
//
// 为什么要有：她主动冒一句话出来，主人想说点什么，不该为此切到别处去。
//
// 两个模式：
//   跟随（默认） 她说完话钮冒出来一阵，气泡走了钮也跟着走
//   常驻        钮一直挂在腰侧，什么时候想打都行
//
// 这层 UI 不在模型剪影里，所以必须让交互层知道「这块也算热区」：
// 不然鼠标压上来时窗口判定穿透，钮点不着。interact.addHitTest 就是干这个的。
(function () {
  'use strict';

  const STYLE_ID = 'stage-reply-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#reply-btn{position:absolute;z-index:10001;width:30px;height:30px;border-radius:50%;',
      'box-sizing:border-box;display:flex;align-items:center;justify-content:center;cursor:pointer;',
      'background:rgba(255,255,255,.94);border:1px solid rgba(90,150,230,.55);',
      'box-shadow:0 3px 10px rgba(0,0,0,.16);opacity:0;pointer-events:none;transition:opacity .18s,transform .12s;',
      'transform:scale(.86)}',
      '#reply-btn.on{opacity:1;pointer-events:auto;transform:scale(1)}',
      '#reply-btn:hover{background:rgba(233,243,255,.98)}',
      '#reply-btn svg{width:16px;height:16px;display:block}',
      '#reply-card{position:absolute;z-index:10002;box-sizing:border-box;border-radius:11px;',
      'background:rgba(255,255,255,.97);box-shadow:0 8px 22px rgba(0,0,0,.22);padding:0 8px;',
      'display:none;align-items:center;gap:6px;font-family:system-ui,"Microsoft YaHei"}',
      '#reply-card.on{display:flex}',
      '#reply-card input{flex:1 1 auto;min-width:0;height:100%;box-sizing:border-box;border:0;outline:0;',
      'background:transparent;color:#2b3d3a;font:inherit;line-height:1.4}',
      '#reply-card input::placeholder{color:#9aa8b8}',
      '#reply-card button{flex:0 0 auto;font:inherit;font-size:12px;height:24px;padding:0 10px;border-radius:7px;',
      'cursor:pointer;border:1px solid rgba(90,150,230,.5);background:#fff;color:#2b3d3a}',
      '#reply-card button.send{background:#2a7fff;border-color:#2a7fff;color:#fff}',
      '#reply-card button.close{padding:0 7px;border-color:transparent;background:transparent;color:#8b98a8}',
      '#reply-card button:active{transform:translateY(1px)}',
    ].join('');
    document.head.appendChild(style);
  }

  const ICON = "<svg viewBox='0 0 24 24' fill='none' stroke='#2a7fff' stroke-width='2'"
    + " stroke-linecap='round' stroke-linejoin='round'><path d='M21 11.5a8.4 8.4 0 0 1-9 8.4'/>"
    + "<path d='M21 11.5A8.4 8.4 0 0 0 12.6 3 8.4 8.4 0 0 0 4 11.5c0 1.4.3 2.7.9 3.8L3 21l5.9-1.8'/>"
    + "<path d='M8.5 11.5h6M8.5 14.5h4'/></svg>";

  function createReply({ app, interaction }) {
    injectStyle();
    const btn = document.createElement('div');
    btn.id = 'reply-btn';
    btn.title = '回复她';
    btn.innerHTML = ICON;
    document.body.appendChild(btn);

    const card = document.createElement('div');
    card.id = 'reply-card';
    const ta = document.createElement('input');
    ta.type = 'text';
    ta.maxLength = 200;
    ta.placeholder = '跟她说一句…（回车发送）';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭（Esc）';
    const send = document.createElement('button');
    send.className = 'send';
    send.textContent = '发送';
    card.appendChild(ta);
    card.appendChild(closeBtn);
    card.appendChild(send);
    document.body.appendChild(card);

    let enabled = true;
    let always = false;
    let visibleUntil = 0;
    let cardOpen = false;
    let busy = false;
    let raf = 0;
    let pos = null;

    const W = () => app.screen.width || 531;
    const H = () => app.screen.height || 950;

    function anchor() {
      let a = null;
      try { a = interaction && interaction.headAnchor ? interaction.headAnchor() : null; } catch (e) { a = null; }
      return a || { x: W() / 2, y: H() * 0.14 };
    }

    // 脚边锚点：常驻时蹲在她脚下。压头顶那块的结果是「每次摸头都点到钮」，100% 误触。
    function footAnchor() {
      let a = null;
      try { a = interaction && interaction.footAnchor ? interaction.footAnchor() : null; } catch (e) { a = null; }
      return a || { x: W() * 0.7, y: H() * 0.9 };
    }

    // 两个模式两个位置，别用一个凑合：
    //   跟随（她说完话冒一下）→ 头顶右侧，离气泡近，顺手
    //   常驻（一直在）→ 脚底下面那条空白带子里，离脚往外挪一截（贴着脚点一下就是误触）
    function placeBtn() {
      const size = 30;
      let x; let y;
      if (always) {
        const a = footAnchor();
        // 空白带子 = 剪影脚底到窗口底边那一条（本机 1182 的窗口里约 60px），所有体型都对齐到同一条脚底线
        x = Math.max(6, Math.min(W() - size - 6, Math.round(a.x + W() * 0.16)));
        y = Math.max(6, Math.min(H() - size - 6, Math.round(Math.max(a.y + 8, H() - size - 8))));
      } else {
        const a = anchor();
        x = Math.max(6, Math.min(W() - size - 6, a.x + W() * 0.13));
        y = Math.max(6, Math.min(H() - size - 6, a.y + 6));
      }
      x = Math.round(x); y = Math.round(y);
      btn.style.left = x + 'px';
      btn.style.top = y + 'px';
      pos = { x, y, w: size, h: size };
    }

    // 输入卡：固定在**窗口最下方那条空白带子**里，横着摊开。
    // 以前是贴着钮往上弹，正好盖住裙子和小腿——要打字先挡自己，还容易点穿到模型。
    // 脚底以下本来就不画东西，所以这一条永远不覆盖模型；高度按剩下的空间给（窗口被拖矮也不会顶穿）。
    function placeCard() {
      const pad = 6;
      const a = footAnchor();
      const bandTop = Math.max(0, a.y);                      // 剪影脚底
      const bandH = Math.max(0, H() - bandTop - pad * 2);    // 底下能用的高度
      const h = Math.round(Math.max(26, Math.min(40, bandH)));
      const w = Math.max(220, Math.min(W() - 24, 560));
      const x = Math.round(Math.max(8, Math.min(W() - w - 8, (W() - w) / 2)));
      // 贴窗口底；万一那条带子太矮（窗口被拖得很扁），就往脚底下面挤一点，宁可靠着也不盖模型
      const y = Math.round(Math.max(bandTop + 1, H() - h - pad));
      card.style.width = w + 'px';
      card.style.height = h + 'px';
      card.style.left = x + 'px';
      card.style.top = y + 'px';
      ta.style.fontSize = Math.max(12, Math.min(15, Math.round(W() * 0.021))) + 'px';
    }

    function sync() {
      const want = enabled && (cardOpen || always || Date.now() < visibleUntil);
      // 卡开着的时候钮收起来：它俩都在窗口底部那条带子里，不收起会叠在一起
      btn.classList.toggle('on', want && !cardOpen);
      // 不再整窗吃鼠标（`setForceEat`）：卡已经在交互层的热区里了，鼠标压上去窗口自然不吃穿透。
      // 整窗吃鼠标的话，打字期间连模型以外的地方都点不到桌面（游戏/别的窗口全被挡住）。
    }

    function loop() {
      if (!enabled) { raf = 0; return; }
      placeBtn();
      if (cardOpen) placeCard();
      sync();
      raf = requestAnimationFrame(loop);
    }

    function start() { if (!raf && enabled) raf = requestAnimationFrame(loop); }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

    function open() {
      if (!enabled || cardOpen) return false;
      cardOpen = true;
      card.classList.add('on');
      placeBtn();
      placeCard();
      start();
      sync();
      try { ta.focus(); } catch (e) {}
      return true;
    }

    function close() {
      if (!cardOpen) return false;
      cardOpen = false;
      card.classList.remove('on');
      ta.value = '';
      busy = false;
      sync();
      return true;
    }

    function submit() {
      const text = String(ta.value || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text || busy) return false;
      busy = true;
      send.disabled = true;
      // 送出去以后就不等了：桥那边跑一轮要好一会儿，回话会自己回流成气泡
      window.petStage.reply(text);
      close();
      return true;
    }

    btn.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cardOpen) close();
      else open();
    });
    ta.addEventListener('keydown', (e) => {
      // 中文输入法选词时回车不能算发送
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      e.stopPropagation();
    });
    send.addEventListener('click', (e) => { e.stopPropagation(); submit(); });
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); close(); });
    card.addEventListener('mousedown', (e) => e.stopPropagation());

    // 热区：钮和卡都算，不然这两块会被判成透明区直接穿透
    if (interaction && interaction.addHitTest) {
      interaction.addHitTest((x, y) => {
        const inside = (el) => {
          if (!el || !el.classList.contains('on')) return false;
          const r = el.getBoundingClientRect();
          return x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;
        };
        return inside(btn) || inside(card);
      });
    }

    return {
      // 她说完一句话就把钮亮一会儿（气泡走了以后再多留 2.4 秒）
      flash(ms) {
        if (!enabled || always) return;
        visibleUntil = Date.now() + Math.max(2000, Number(ms) || 4000) + 2400;
        start();
        sync();
      },
      setEnabled(on, alwaysOn) {
        enabled = !!on;
        always = !!alwaysOn && enabled;
        if (!enabled) close();
        if (always) { start(); } else stop();
        sync();
        if (always) start();
      },
      open,
      close,
      submit,
      get open_() { return cardOpen; },
      get enabled() { return enabled; },
      get always() { return always; },
      get busy() { return busy; },
      get pos() { return pos; },
    };
  }

  window.createStageReply = createReply;
})();
