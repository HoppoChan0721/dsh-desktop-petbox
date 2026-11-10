// 舞台页面的桥。只做三件事：把主进程算好的指针送进来、把外部指令送进来。
const { ipcRenderer, contextBridge } = require('electron');

const cursorCbs = new Set();
ipcRenderer.on('stage:cursor', (_e, c) => { for (const fn of cursorCbs) { try { fn(c); } catch (e) {} } });

contextBridge.exposeInMainWorld('petStage', {
  onCursor(fn) { if (typeof fn === 'function') cursorCbs.add(fn); },
  onCommand(fn) {
    if (typeof fn !== 'function') return;
    ipcRenderer.on('stage:command', (_e, cmd) => { try { fn(cmd); } catch (e) {} });
  },
});
