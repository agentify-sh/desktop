const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentifyDesktop', {
  getState: () => ipcRenderer.invoke('agentify:getState'),
  getSettings: () => ipcRenderer.invoke('agentify:getSettings'),
  setSettings: (args) => ipcRenderer.invoke('agentify:setSettings', args || {}),
  createTab: (args) => ipcRenderer.invoke('agentify:createTab', args || {}),
  showTab: (args) => ipcRenderer.invoke('agentify:showTab', args || {}),
  hideTab: (args) => ipcRenderer.invoke('agentify:hideTab', args || {}),
  closeTab: (args) => ipcRenderer.invoke('agentify:closeTab', args || {}),
  stopQuery: (args) => ipcRenderer.invoke('agentify:stopQuery', args || {}),
  openStateDir: () => ipcRenderer.invoke('agentify:openStateDir'),
  openArtifactsDir: () => ipcRenderer.invoke('agentify:openArtifactsDir'),
  openWatchFolder: (args) => ipcRenderer.invoke('agentify:openWatchFolder', args || {}),
  listWatchFolders: () => ipcRenderer.invoke('agentify:listWatchFolders'),
  addWatchFolder: (args) => ipcRenderer.invoke('agentify:addWatchFolder', args || {}),
  removeWatchFolder: (args) => ipcRenderer.invoke('agentify:removeWatchFolder', args || {}),
  pickWatchFolder: () => ipcRenderer.invoke('agentify:pickWatchFolder'),
  scanWatchFolders: () => ipcRenderer.invoke('agentify:scanWatchFolders'),
  onTabsChanged: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = () => cb();
    ipcRenderer.on('agentify:tabsChanged', handler);
    return () => {
      try {
        ipcRenderer.removeListener('agentify:tabsChanged', handler);
      } catch {}
    };
  }
});
