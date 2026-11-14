// 设置面板的桥。只开四条：读状态、改尺寸、存配置、关面板。
// 面板是独立窗口，不碰舞台自己的 IPC 通道，免得两边互相串。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stagePanel', {
  state: () => ipcRenderer.invoke('panel:state'),
  size: (w, h) => ipcRenderer.invoke('panel:size', { w, h }),
  save: (patch) => ipcRenderer.invoke('panel:save', patch || {}),
  close: () => ipcRenderer.send('panel:close'),
});
