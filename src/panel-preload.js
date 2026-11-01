// 面板桥：尺寸读写 + 配置读写，别的什么都不给
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petSize', {
  get: () => ipcRenderer.invoke('size:get'),
  preview: (w, h) => ipcRenderer.send('size:preview', { w, h }),
  commit: (w, h) => ipcRenderer.send('size:commit', { w, h }),
  close: () => ipcRenderer.send('size:close'),
  onChanged: (cb) => ipcRenderer.on('size:changed', (_e, s) => cb(s)),
});

contextBridge.exposeInMainWorld('petCfg', {
  get: () => ipcRenderer.invoke('cfg:get'),
  save: (patch) => ipcRenderer.invoke('cfg:save', patch),
  pick: (kind) => ipcRenderer.invoke('cfg:pick', kind),
  restart: () => ipcRenderer.invoke('cfg:restart'),
});
