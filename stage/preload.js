// 舞台页面的桥：主进程算好的指针送进来、外部指令送进来，页面这边把穿透/拖动/点击报上去。
const { ipcRenderer, contextBridge } = require('electron');

const cursorCbs = new Set();
ipcRenderer.on('stage:cursor', (_e, c) => { for (const fn of cursorCbs) { try { fn(c); } catch (e) {} } });

contextBridge.exposeInMainWorld('petStage', {
  onCursor(fn) { if (typeof fn === 'function') cursorCbs.add(fn); },
  onCommand(fn) {
    if (typeof fn !== 'function') return;
    ipcRenderer.on('stage:command', (_e, cmd) => { try { fn(cmd); } catch (e) {} });
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
