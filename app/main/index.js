"use strict";

const path = require("path");
const { app, BrowserWindow, ipcMain, Menu, dialog, shell, clipboard } = require("electron");

const { SessionManager } = require("./sessions");
const { Store } = require("./state");

const store = new Store(path.join(app.getPath("userData"), "deck-state.json"));
const manager = new SessionManager();

/** @type {BrowserWindow|null} */
let win = null;

// Sessoes cujo stream o renderer esta mostrando. Todas as sessoes continuam
// sendo espelhadas no main (e dai que sai o status no menu lateral), mas so
// a que esta na tela tem os bytes empurrados pelo IPC.
const attached = new Set();

let quitting = false;
let emSelftest = false;

// ---------------------------------------------------------------- janela

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: "#0f1115",
    title: "claude-deck",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // Sem isso, um erro no renderer e invisivel: nao ha terminal do outro lado.
  win.webContents.on("console-message", (ev) => {
    const onde = ev.sourceId ? ` (${String(ev.sourceId).split(/[\\/]/).pop()}:${ev.lineNumber})` : "";
    console.log(`[renderer ${ev.level}] ${ev.message}${onde}`);
  });
  win.webContents.on("render-process-gone", (e, d) => {
    console.error("[renderer morreu]", JSON.stringify(d));
  });
  win.webContents.on("preload-error", (e, p, err) => {
    console.error("[preload]", p, err && err.message);
  });
  win.webContents.on("did-fail-load", (e, code, desc) => {
    console.error("[load falhou]", code, desc);
  });

  // Links do terminal abrem no navegador do sistema, nunca dentro da janela:
  // uma navegacao aqui trocaria a UI do app por uma pagina arbitraria.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    openExternal(url);
  });

  // A confirmacao fica no "close" da janela, NAO no before-quit.
  //
  // No before-quit ela chegava tarde demais: ao clicar no X a janela ja tinha
  // sido destruida, o window-all-closed ja tinha chamado app.quit(), e so
  // entao o dialogo aparecia. Cancelar deixava o app vivo com zero janelas -
  // invisivel, sem jeito de voltar no Windows, e com todas as sessoes ainda
  // rodando em auto mode. Era justamente o orfao que a confirmacao existe
  // para evitar.
  win.on("close", (e) => {
    if (quitting) return;
    const n = manager.sessions.size;
    if (!n) return;
    if (!confirmClose(n, manager.busyCount())) {
      e.preventDefault();
      return;
    }
    quitting = true;
    manager.killAll();
  });

  win.on("closed", () => {
    win = null;
  });
}

/** Trocavel pelo autoteste: ver main/selftest.js. */
let confirmClose = (n, busy) =>
  dialog.showMessageBoxSync(win || undefined, {
    type: busy ? "warning" : "question",
    buttons: ["Fechar mesmo assim", "Cancelar"],
    defaultId: 1,
    cancelId: 1,
    title: "Fechar o claude-deck",
    message: busy > 0 ? `${busy} de ${n} sessão(ões) está(ão) trabalhando agora.` : `${n} sessão(ões) aberta(s).`,
    detail:
      "Fechar o app encerra todas as sessões. Você pode retomá-las depois pelo " +
      "botão “retomar”, que usa o --resume com o mesmo id.",
  }) === 0;

function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") shell.openExternal(url);
  } catch (e) {
    /* url invalida: ignora */
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------- estado

function knownIds() {
  const ids = new Set(manager.sessions.keys());
  for (const s of store.state.sessions) ids.add(s.id);
  return ids;
}

/** Sessoes vivas + as fechadas que ainda dao para retomar com --resume. */
function sessionList() {
  const vivas = manager.list();
  const vivosIds = new Set(vivas.map((s) => s.id));
  const hist = store.state.sessions
    .filter((s) => !vivosIds.has(s.id))
    .map((s) => ({
      id: s.id,
      cwd: s.cwd,
      title: s.label || "sessão encerrada",
      label: s.label || "sessão encerrada",
      glyph: "",
      status: "closed",
      menu: false,
      exited: true,
      exitCode: null,
      cols: 0,
      rows: 0,
      quietFor: 0,
      createdAt: s.createdAt,
      closedAt: s.closedAt,
    }));
  return [...vivas, ...hist];
}

function pushMeta() {
  send("deck:sessions", sessionList());
}

function pushState() {
  send("deck:state", store.publicState());
}

// ---------------------------------------------------------- eventos do mgr

manager.on("data", (id, chunk) => {
  if (attached.has(id)) send("deck:data", { id, chunk });
});

// O glyph do spinner troca varias vezes por segundo enquanto a sessao
// trabalha, e cada troca emite "meta". Gravar o catalogo em todas elas seria
// um tmp+rename sincrono por frame - so grava quando o LABEL muda de fato.
const labelGravado = new Map();

manager.on("meta", (id) => {
  const s = manager.get(id);
  if (s && s.label && s.status !== "shell" && labelGravado.get(id) !== s.label) {
    labelGravado.set(id, s.label);
    store.rememberSession({ id, cwd: s.cwd, label: s.label });
  }
  pushMeta();
});

manager.on("exit", (id, code) => {
  console.log(`[sessao ${id.slice(0, 8)}] saiu com codigo ${code}`);
  attached.delete(id);
  labelGravado.delete(id);
  manager.remove(id);
  store.closeSession(id);
  send("deck:exit", { id, code });
  pushMeta();
});

// quietFor ("parado Xs") so avanca com o relogio: precisa de um tick proprio.
setInterval(() => {
  if (manager.sessions.size) pushMeta();
}, 1000);

// ------------------------------------------------------------------- IPC

ipcMain.handle("deck:bootstrap", () => ({
  state: store.publicState(),
  sessions: sessionList(),
  claudeAvailable: manager.available,
  claudePath: manager.claudePath,
  stateFile: store.file,
}));

ipcMain.handle("deck:spawn", (e, { cwd, groupId, cols, rows } = {}) => {
  const s = manager.spawn({ cwd: String(cwd || ""), cols, rows });
  store.rememberSession({ id: s.id, cwd: s.cwd, label: "" });
  if (groupId) store.setMember(s.id, String(groupId));
  pushState();
  pushMeta();
  return s.meta();
});

ipcMain.handle("deck:resume", (e, { id, cols, rows } = {}) => {
  const known = store.state.sessions.find((s) => s.id === id);
  if (!known) throw new Error("sessão desconhecida");
  const s = manager.spawn({ cwd: known.cwd, id: known.id, resume: true, cols, rows });
  store.rememberSession({ id: s.id, cwd: s.cwd, label: known.label });
  pushMeta();
  return s.meta();
});

/**
 * Snapshot + inscricao no MESMO handler sincrono (sem await no meio), para que
 * nenhum byte caia entre os dois. O flush antes do snapshot evita o oposto:
 * bytes ja absorvidos pelo espelho serem reentregues depois e duplicarem.
 */
ipcMain.handle("deck:attach", (e, { id } = {}) => {
  const s = manager.get(id);
  if (!s) throw new Error("sessão não está aberta");
  s.flush();
  const snapshot = s.snapshot();
  attached.add(id);
  return { snapshot, meta: s.meta() };
});

ipcMain.handle("deck:detach", (e, { id } = {}) => {
  attached.delete(id);
  return true;
});

ipcMain.handle("deck:write", (e, { id, data } = {}) => {
  const s = manager.get(id);
  if (!s) return false;
  return s.write(String(data == null ? "" : data));
});

ipcMain.handle("deck:resize", (e, { id, cols, rows } = {}) => {
  const s = manager.get(id);
  if (!s) return false;
  s.resize(cols, rows);
  return true;
});

ipcMain.handle("deck:kill", (e, { id, forget } = {}) => {
  const s = manager.get(id);
  if (s) {
    attached.delete(id);
    manager.remove(id);
  }
  store.closeSession(id, { forget: !!forget });
  pushState();
  pushMeta();
  return true;
});

ipcMain.handle("deck:groups", (e, { groups, members } = {}) => {
  const st = store.replaceGroups({ groups, members });
  pushState();
  return st;
});

ipcMain.handle("deck:member", (e, { id, groupId } = {}) => {
  const st = store.setMember(String(id || ""), groupId ? String(groupId) : "");
  pushState();
  return st;
});

ipcMain.handle("deck:pickFolder", async (e, { start } = {}) => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, {
    title: "pasta do projeto",
    defaultPath: start || app.getPath("home"),
    properties: ["openDirectory"],
  });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// Clipboard pelo Electron, nao pela API web: num renderer sandboxed servido
// de file://, navigator.clipboard.readText() depende de permissao e de foco e
// falha calado. Aqui e uma chamada direta, sempre disponivel.
ipcMain.handle("deck:clipboard:read", () => clipboard.readText());
ipcMain.handle("deck:clipboard:write", (e, { text } = {}) => {
  clipboard.writeText(String(text == null ? "" : text));
  return true;
});

ipcMain.handle("deck:openExternal", (e, { url } = {}) => {
  openExternal(String(url || ""));
  return true;
});

// ------------------------------------------------------------ ciclo de vida

// Uma instancia so. Duas compartilhariam o mesmo deck-state.json: a segunda
// mostraria as sessoes VIVAS da primeira como "encerrada", e o botao retomar
// rodaria --resume num id que ainda esta rodando do outro lado.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.whenReady().then(() => {
  // O menu default do Electron sequestra teclas que pertencem ao terminal -
  // Ctrl+R recarregaria a janela no meio de uma sessao, por exemplo.
  Menu.setApplicationMenu(null);

  store.load();
  store.prune(knownIds());
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  const i = process.argv.indexOf("--selftest");
  if (i >= 0 && win) {
    emSelftest = true;
    const cwd = process.argv[i + 1] || process.cwd();
    win.webContents.once("did-finish-load", async () => {
      const falhas = await require("./selftest").run(win, manager, store, cwd, {
        setConfirmClose: (fn) => { confirmClose = fn; },
      });
      quitting = true;
      manager.killAll();
      app.exit(falhas ? 1 : 0);
    });
  }
});

app.on("window-all-closed", () => {
  // No autoteste a janela e fechada de proposito no meio da bateria; sair
  // aqui mataria o processo antes de o relatorio ser impresso.
  if (emSelftest) return;
  app.quit();
});

// Rede de seguranca para os caminhos que nao passam pelo X da janela
// (app.quit() de outro lugar, logoff do Windows).
app.on("before-quit", (e) => {
  if (quitting) return;
  if (!manager.sessions.size) return;
  if (!confirmClose(manager.sessions.size, manager.busyCount())) {
    e.preventDefault();
    return;
  }
  quitting = true;
  manager.killAll();
});

app.on("quit", () => {
  manager.killAll();
});
