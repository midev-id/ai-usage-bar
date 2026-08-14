const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aiUsageBar', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  launchCodexBar: () => ipcRenderer.invoke('launch-codexbar'),
  verifyArtifact: () => ipcRenderer.invoke('verify-artifact'),
  openFolder: () => ipcRenderer.invoke('open-folder'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  resizeWindow: (width, height, expanding) => ipcRenderer.invoke('resize-window', { width, height, expanding }),
  dragPillStart: () => ipcRenderer.send('pill-drag-start'),
  dragPillMove: (dx, dy) => ipcRenderer.send('pill-drag-move', { dx, dy }),
  dragPillEnd: () => ipcRenderer.send('pill-drag-end'),
  quit: () => ipcRenderer.send('quit'),
  onStatusUpdated: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('status-updated', listener);
    return () => ipcRenderer.removeListener('status-updated', listener);
  },
});
