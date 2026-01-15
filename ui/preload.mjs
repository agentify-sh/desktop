import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agentify', {
  tabsList: async () => await ipcRenderer.invoke('agentify:tabs:list'),
  tabCreate: async ({ key, name, show } = {}) => await ipcRenderer.invoke('agentify:tabs:create', { key, name, show }),
  tabClose: async (tabId) => await ipcRenderer.invoke('agentify:tabs:close', { tabId }),
  tabShow: async (tabId) => await ipcRenderer.invoke('agentify:tabs:show', { tabId }),
  tabHide: async (tabId) => await ipcRenderer.invoke('agentify:tabs:hide', { tabId }),
  configGet: async () => await ipcRenderer.invoke('agentify:config:get'),
  configSet: async (cfg) => await ipcRenderer.invoke('agentify:config:set', cfg),
  openStateDir: async () => await ipcRenderer.invoke('agentify:state:open')
});

