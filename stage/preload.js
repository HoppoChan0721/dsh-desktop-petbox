// 舞台页面的桥：主进程算好的指针送进来、外部指令送进来，页面这边把穿透/拖动/点击报上去。
const { ipcRenderer, contextBridge } = require('electron');

const cursorCbs = new Set();
ipcRenderer.on('stage:cursor', (_e, c) => { for (const fn of cursorCbs) { try { fn(c); } catch (e) {} } });

// 页面一载入主进程就会推配置（音量、回复钮开关）。重载的时候 stage.js 还在加载模型，
// 监听注册得晚，这几条就丢了——表现是「改了帧率重载一下，回复钮常驻又没了」。
// 没人在听就先攒着，谁注册了监听立刻交出去。
const cmdCbs = new Set();
const cmdQueue = [];
ipcRenderer.on('stage:command', (_e, cmd) => {
  if (!cmdCbs.size) { if (cmdQueue.length < 64) cmdQueue.push(cmd); return; }
  for (const fn of cmdCbs) { try { fn(cmd); } catch (e) {} }
});

contextBridge.exposeInMainWorld('petStage', {
  onCursor(fn) { if (typeof fn === 'function') cursorCbs.add(fn); },
  onCommand(fn) {
    if (typeof fn !== 'function') return;
    cmdCbs.add(fn);
    while (cmdQueue.length) {
      const cmd = cmdQueue.shift();
      try { fn(cmd); } catch (e) {}
    }
    // 挂好了就跟主进程打个招呼：让它把配置再推一遍，别指望 did-finish-load 那一枪
    try { ipcRenderer.send('stage:ready'); } catch (e) {}
  },
  // 穿透：true = 这一格不吃鼠标，点击穿到底下。forward 由主进程开，保证 mousemove 还能收到。
  ignore(v) { ipcRenderer.send('stage:ignore', !!v); },
  dragStart() { ipcRenderer.send('stage:drag-start'); },
  dragEnd() { ipcRenderer.send('stage:drag-end'); },
  wheel(dir) { ipcRenderer.send('stage:wheel', dir > 0 ? 1 : -1); },
  tap(payload) { ipcRenderer.send('stage:tap', payload); },
  // 剪影标定出来的头顶位置（相对窗口的比例）：主进程拿它当绕圈判定的圆心
  head(h) { ipcRenderer.send('stage:head', h); },
  // 右键她：弹托盘那套菜单（托盘图标被系统藏起来时也能改设置）
  menu() { ipcRenderer.send('stage:menu'); },
  // 主人打字回她：走同一座桥（dsh-pet-bridge）投进 DSH 会话
  reply(text) { ipcRenderer.send('stage:reply', String(text || '')); },
});
