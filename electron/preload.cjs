const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('journalPro', {
  platform: process.platform,
  versions: process.versions,
  getControlStatus: () => ipcRenderer.invoke('control:get-status'),
});
