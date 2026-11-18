const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clonelane", {
	call: (name, input) => ipcRenderer.invoke("clonelane", name, input),
});
