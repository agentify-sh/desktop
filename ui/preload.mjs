import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agentifyDesktop', {
  getState: () => ipcRenderer.invoke('agentify:getState'),
  getSettings: () => ipcRenderer.invoke('agentify:getSettings'),
  setSettings: (args) => ipcRenderer.invoke('agentify:setSettings', args || {}),
  getOrchestrators: () => ipcRenderer.invoke('agentify:getOrchestrators'),
  startOrchestrator: (args) => ipcRenderer.invoke('agentify:startOrchestrator', args || {}),
  stopOrchestrator: (args) => ipcRenderer.invoke('agentify:stopOrchestrator', args || {}),
  setWorkspaceForKey: (args) => ipcRenderer.invoke('agentify:setWorkspaceForKey', args || {}),
  getWorkspaceForKey: (args) => ipcRenderer.invoke('agentify:getWorkspaceForKey', args || {}),
  createTab: (args) => ipcRenderer.invoke('agentify:createTab', args || {}),
  showTab: (args) => ipcRenderer.invoke('agentify:showTab', args || {}),
  hideTab: (args) => ipcRenderer.invoke('agentify:hideTab', args || {}),
  closeTab: (args) => ipcRenderer.invoke('agentify:closeTab', args || {}),
  openStateDir: () => ipcRenderer.invoke('agentify:openStateDir'),
  onTabsChanged: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('agentify:tabsChanged', () => cb());
  }
});
