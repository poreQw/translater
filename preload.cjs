const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopAPI", Object.freeze({
  translate: (request) => ipcRenderer.invoke("baidu:translate", request)
}));
