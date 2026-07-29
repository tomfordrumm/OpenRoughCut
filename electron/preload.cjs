const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("roughcut", {
  runtimeStatus: (request) => ipcRenderer.invoke("runtime:status", request),
  installDependencies: (request) => ipcRenderer.invoke("runtime:install", request),
  cancelOperation: () => ipcRenderer.invoke("operation:cancel"),
  showLogs: () => ipcRenderer.invoke("diagnostics:show-logs"),
  chooseVideo: () => ipcRenderer.invoke("video:choose"),
  preparePreview: (request) => ipcRenderer.invoke("video:prepare-preview", request),
  listProxies: (request) => ipcRenderer.invoke("storage:list-proxies", request),
  deleteProxies: (request) => ipcRenderer.invoke("storage:delete-proxies", request),
  analyze: (request) => ipcRenderer.invoke("video:analyze", request),
  saveSession: (session) => ipcRenderer.invoke("session:save", session),
  autosaveSession: (session) => ipcRenderer.invoke("session:autosave", session),
  closeSession: (request) => ipcRenderer.invoke("session:close", request),
  recoverSession: () => ipcRenderer.invoke("session:recover"),
  loadSession: () => ipcRenderer.invoke("session:load"),
  finishSessionFlush: () => ipcRenderer.send("session:flush-complete"),
  onSessionFlushRequest: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("session:flush-request", handler);
    return () => ipcRenderer.removeListener("session:flush-request", handler);
  },
  exportProject: (request) => ipcRenderer.invoke("project:export", request),
  onProgress: (listener) => {
    const handler = (_event, update) => listener(update);
    ipcRenderer.on("operation:progress", handler);
    return () => ipcRenderer.removeListener("operation:progress", handler);
  },
});
