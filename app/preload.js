"use strict";

// Unica ponte entre o renderer e o main. O ipcRenderer cru nunca e exposto:
// com ele, qualquer script na pagina poderia chamar qualquer canal. Aqui a
// superficie e fechada - estas funcoes e mais nada.

const { contextBridge, ipcRenderer } = require("electron");

const on = (canal) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(canal, h);
  return () => ipcRenderer.removeListener(canal, h);
};

contextBridge.exposeInMainWorld("deck", {
  bootstrap: () => ipcRenderer.invoke("deck:bootstrap"),

  spawn: (cwd, groupId, cols, rows) => ipcRenderer.invoke("deck:spawn", { cwd, groupId, cols, rows }),
  resume: (id, cols, rows) => ipcRenderer.invoke("deck:resume", { id, cols, rows }),
  kill: (id, forget) => ipcRenderer.invoke("deck:kill", { id, forget }),

  attach: (id) => ipcRenderer.invoke("deck:attach", { id }),
  detach: (id) => ipcRenderer.invoke("deck:detach", { id }),
  write: (id, data) => ipcRenderer.invoke("deck:write", { id, data }),
  resize: (id, cols, rows) => ipcRenderer.invoke("deck:resize", { id, cols, rows }),

  saveGroups: (groups, members) => ipcRenderer.invoke("deck:groups", { groups, members }),
  setMember: (id, groupId) => ipcRenderer.invoke("deck:member", { id, groupId }),

  readClipboard: () => ipcRenderer.invoke("deck:clipboard:read"),
  writeClipboard: (text) => ipcRenderer.invoke("deck:clipboard:write", { text }),

  pickFolder: (start) => ipcRenderer.invoke("deck:pickFolder", { start }),
  openExternal: (url) => ipcRenderer.invoke("deck:openExternal", { url }),

  onData: on("deck:data"),
  onSessions: on("deck:sessions"),
  onState: on("deck:state"),
  onExit: on("deck:exit"),
});
