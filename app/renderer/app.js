"use strict";

/* claude-deck — renderer.
 *
 * Diferenca de fundo para a versao WezTerm: aqui nao ha polling. O main
 * empurra "deck:sessions" quando algo muda (e 1x/s para o contador de parado),
 * e "deck:data" so da sessao que esta na tela. O xterm e uma VIEW: a verdade
 * mora no espelho headless do main, e por isso recarregar a janela nao perde
 * nada. */

const $ = (id) => document.getElementById(id);

const rail = $("rail");
const railList = $("railList");
const railEmpty = $("railEmpty");
const stage = $("stage");
const head = $("head");
const headDot = $("headDot");
const headTitle = $("headTitle");
const headChip = $("headChip");
const headBadge = $("headBadge");
const headCwd = $("headCwd");
const headKill = $("headKill");
const nothing = $("nothing");
const termWrap = $("termWrap");
const bar = $("bar");
const barState = $("barState");
const barHint = $("barHint");
const stamp = $("stamp");
const ctx = $("ctx");

const newBtn = $("newBtn"), newForm = $("newForm"), newCwd = $("newCwd");
const newGroup = $("newGroup"), newGo = $("newGo"), newCancel = $("newCancel");
const newMsg = $("newMsg"), newPick = $("newPick"), dirs = $("dirs");
const groupBtn = $("groupBtn"), groupForm = $("groupForm"), groupName = $("groupName");
const swatches = $("swatches"), groupGo = $("groupGo"), groupCancel = $("groupCancel"), groupMsg = $("groupMsg");

let sessions = [];            // vindas do main
let state = { groups: [], members: {}, palette: [] };
let current = null;           // sessao na tela
let anexado = null;           // id realmente anexado ao stream (nem sempre = current)
let attaching = null;         // id em processo de attach
let queued = [];              // chunks que chegaram durante o attach
let gfColor = null;
let gfEdit = null;            // grupo em edicao (null = criando)
let dragId = null;
let railHold = false;         // congela a reordenacao enquanto o ponteiro esta no menu

const LABEL = {
  idle: "concluído", busy: "trabalhando", menu: "precisa de você",
  shell: "iniciando…", closed: "encerrada",
};

/** "precisa de voce" vem ANTES do glyph: uma sessao parada num pedido de
 *  permissao tem glyph de parada, mas nao concluiu nada. */
function eff(s) {
  if (s.status === "closed") return "closed";
  return s.menu ? "menu" : s.status;
}

const groupById = (id) => state.groups.find((g) => g.id === id) || null;
const groupOf = (id) => state.members[id] || "";

// ------------------------------------------------------------------ xterm

const term = new window.Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  scrollback: 5000,
  fontSize: 13,
  fontFamily: '"JetBrainsMono Nerd Font", "Cascadia Mono", Consolas, monospace',
  theme: {
    background: "#171a21", foreground: "#d7dce5", cursor: "#d7dce5",
    selectionBackground: "#2f4a6d", black: "#0f1115", brightBlack: "#5a6372",
  },
});
const fitAddon = new window.FitAddon.FitAddon();
term.loadAddon(fitAddon);
try {
  const u11 = new window.Unicode11Addon.Unicode11Addon();
  term.loadAddon(u11);
  term.unicode.activeVersion = "11";
} catch (e) {
  console.warn("unicode11 indisponível:", e.message);
}
term.open($("term"));
// Exposto para o autoteste: com o renderer WebGL o texto vai para um canvas e
// o .xterm-rows do DOM fica vazio - so pelo buffer da para conferir o que a
// sessao de fato mostrou na tela.
window.__term = term;
try {
  term.loadAddon(new window.WebglAddon.WebglAddon());
} catch (e) {
  console.warn("WebGL indisponível, usando o renderer DOM:", e.message);
}

/**
 * Cola no terminal.
 *
 * Nem `deck.write(cru)` nem `term.paste()` servem, e os dois foram medidos
 * contra o TUI real:
 *
 *   A) marcadores de paste com \r dentro .... ENVIOU o prompt
 *   B) texto cru com \n ..................... quebrou linha, nao enviou
 *   C) marcadores de paste com \n dentro .... quebrou linha, nao enviou  ✓
 *
 * O Claude liga bracketed paste (`bracketedPasteMode: true`), mas trata o \r
 * de dentro dos marcadores como "enviar" mesmo assim. E texto do clipboard do
 * Windows vem cheio de \r\n - era por isso que um paste de varias linhas
 * submetia a primeira linha como prompt.
 *
 * `term.paste()` tambem nao serve: ele normaliza \n para \r, que e a
 * convencao de terminal, e cai no caso (A).
 *
 * Entao: quebras viram \n, e os marcadores entram so se o modo estiver ligado.
 */
function colar() {
  window.deck
    .readClipboard()
    .then((t) => {
      if (!t || !current) return;
      const corpo = t.replace(/\r\n|\r|\n/g, "\n");
      const brk = term.modes && term.modes.bracketedPasteMode;
      window.deck.write(current, brk ? "\x1b[200~" + corpo + "\x1b[201~" : corpo);
    })
    .catch(() => {});
}

// O teclado do terminal vence o do app, com tres excecoes. Ctrl+C tem dois
// significados: com selecao copia, sem selecao interrompe (e precisa chegar
// ao Claude como ^C).
term.attachCustomKeyEventHandler((e) => {
  if (e.type !== "keydown") return true;

  // Shift+Enter = quebra de linha, como na caixa de texto da versao web.
  // O xterm manda \r para Shift+Enter, e \r e "enviar".
  //
  // A sequencia foi medida, nao lembrada: das cinco candidatas testadas
  // contra o TUI real, \x1b\r engoliu a primeira linha, \x1b[13;2u e
  // \x1b[27;2;13~ foram ignorados (as duas linhas coladas numa so), e \n e
  // \\ + \r funcionaram. \n vence por nao deixar barra na tela.
  if (e.code === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (current) window.deck.write(current, "\n");
    return false;
  }

  const ctrl = e.ctrlKey && !e.altKey;
  if (!ctrl) return true;

  if (e.code === "KeyC" && !e.shiftKey && term.hasSelection()) {
    window.deck.writeClipboard(term.getSelection());
    e.preventDefault();
    return false;
  }
  if (e.code === "KeyC" && e.shiftKey) {
    if (term.hasSelection()) window.deck.writeClipboard(term.getSelection());
    e.preventDefault();
    return false;
  }
  // Um caminho so para colar. Sem o preventDefault, o paste nativo tambem
  // chegaria ao textarea do xterm e o texto entraria duas vezes.
  if (e.code === "KeyV") {
    e.preventDefault();
    colar();
    return false;
  }
  return true;
});

// Escutado no #term, nao no document: no document uma selecao velha do
// terminal sequestraria o Ctrl+C dos campos do formulario.
$("term").addEventListener("copy", (e) => {
  if (!term.hasSelection()) return;
  e.clipboardData.setData("text/plain", term.getSelection());
  e.preventDefault();
});

// Nao existe listener de "paste" no document de proposito. Havia um, e ele
// sequestrava os campos: colar uma pasta no "+ sessão" mandava o caminho para
// o PTY da sessão aberta e deixava o campo vazio. O textarea do xterm ja
// trata o paste sozinho.

term.onData((d) => { if (current) window.deck.write(current, d); });

let fitTimer = null;
function scheduleFit() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(doFit, 70);
}
function doFit() {
  if (!current || termWrap.hidden) return;
  try { fitAddon.fit(); } catch (e) { return; }
  window.deck.resize(current, term.cols, term.rows);
}
new ResizeObserver(scheduleFit).observe(termWrap);
window.addEventListener("resize", scheduleFit);

// -------------------------------------------------------------- abrir uma

async function openSession(id) {
  const s = sessions.find((x) => x.id === id);
  if (!s) return;
  if (s.status === "closed") { selectClosed(s); return; }
  if (current === id) { term.focus(); return; }

  const anterior = current;
  current = id;
  attaching = id;
  queued = [];
  term.reset();
  nothing.hidden = true;
  termWrap.hidden = false;
  head.hidden = false;
  bar.hidden = false;

  if (anterior) window.deck.detach(anterior).catch(() => {});

  let r;
  try {
    r = await window.deck.attach(id);
  } catch (e) {
    attaching = null;
    anexado = null;
    showNothing("não foi possível abrir: " + e.message);
    return;
  }
  if (current !== id) return; // o usuario trocou de sessao no meio
  term.write(r.snapshot);
  attaching = null;
  anexado = id;
  for (const c of queued) term.write(c);
  queued = [];
  doFit();
  term.focus();
  paint();
}

function selectClosed(s) {
  if (current) window.deck.detach(current).catch(() => {});
  current = s.id;
  anexado = null;
  attaching = null;
  queued = [];
  termWrap.hidden = true;
  head.hidden = false;
  bar.hidden = false;
  nothing.hidden = false;
  nothing.innerHTML =
    '<h2>sessão encerrada</h2><p>Esta sessão não está rodando. <b>Retomar</b> abre o Claude de novo ' +
    'na mesma pasta com <code>--resume</code> e o mesmo id, então o histórico volta.</p>' +
    '<p><button id="resumeBtn">retomar</button></p>';
  const b = $("resumeBtn");
  if (b) b.onclick = () => resume(s.id);
  paint();
}

function showNothing(msg) {
  current = null;
  anexado = null;
  termWrap.hidden = true;
  head.hidden = true;
  bar.hidden = true;
  nothing.hidden = false;
  nothing.innerHTML = msg
    ? "<h2>" + esc(msg) + "</h2>"
    : '<h2>nenhuma sessão aberta</h2><p>Use <b>+ sessão</b> para abrir o Claude numa pasta. ' +
      'O terminal é este app: a sessão nasce aqui dentro e morre com ele — dá para retomar depois.</p>';
  paint();
}

/**
 * Tamanho que o terminal TERIA no palco. Passado ja no spawn para a sessao
 * nascer no tamanho certo: redimensionar depois faz o TUI limpar a tela para
 * redesenhar, e isso aparece como um piscar na abertura.
 */
function dimsDoPalco() {
  const antes = termWrap.hidden;
  if (antes) { termWrap.hidden = false; nothing.hidden = true; }
  let d = null;
  try { d = fitAddon.proposeDimensions(); } catch (e) { d = null; }
  if (antes && !d) { termWrap.hidden = true; nothing.hidden = false; }
  return d && d.cols && d.rows ? d : { cols: undefined, rows: undefined };
}

async function resume(id) {
  try {
    const d = dimsDoPalco();
    const m = await window.deck.resume(id, d.cols, d.rows);
    current = null;
    await openSession(m.id);
  } catch (e) {
    showNothing("não deu para retomar: " + e.message);
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------------ pintar

function paint() {
  paintHead();
  paintRail();
  const vivas = sessions.filter((s) => s.status !== "closed").length;
  stamp.textContent = vivas ? vivas + (vivas === 1 ? " sessão" : " sessões") : "";
}

function paintHead() {
  const s = sessions.find((x) => x.id === current);
  if (!s) { head.hidden = true; bar.hidden = true; return; }
  const st = eff(s);
  head.hidden = false;
  stage.className = "stage " + st;
  headDot.className = "dot";
  headTitle.textContent = s.label || s.title || "sessão";
  headBadge.textContent = LABEL[st] || st;
  headCwd.textContent = s.cwd || "";
  headCwd.title = s.cwd || "";
  const g = groupById(groupOf(s.id));
  headChip.hidden = !g;
  if (g) { headChip.textContent = g.name; headChip.style.background = g.color; }
  headKill.hidden = s.status === "closed";

  bar.hidden = false;
  bar.className = "bar" + (s.menu ? " alert" : "");
  barState.textContent =
    st === "idle" ? "parado " + s.quietFor + "s" :
    st === "busy" ? "trabalhando" :
    st === "menu" ? "diálogo aberto — responda aqui mesmo, o Enter confirma a opção marcada" :
    st === "closed" ? "encerrada" : "iniciando";
  barHint.textContent = s.status === "closed" ? "" : s.cols + "×" + s.rows;
}

function sortSessions(list) {
  const ord = { menu: 0, idle: 1, busy: 2, shell: 3, closed: 4 };
  return list.slice().sort((a, b) => {
    const d = (ord[eff(a)] ?? 9) - (ord[eff(b)] ?? 9);
    if (d) return d;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

/**
 * @param {boolean} force ignora o railHold. O congelamento existe para a ordem
 * automatica (por estado) nao fugir debaixo do clique enquanto o ponteiro esta
 * sobre o menu - mas o drop de um arraste acontece exatamente ali. Mudanca de
 * grupo e gesto do usuario: aplica sempre.
 */
function paintRail(force) {
  if (!force && railHold && railList.childElementCount) return;
  railList.textContent = "";
  railEmpty.hidden = sessions.length > 0;

  const ordered = sortSessions(sessions);
  const secoes = new Map();

  const sectionFor = (gid) => {
    if (secoes.has(gid)) return secoes.get(gid);
    const g = gid ? groupById(gid) : null;
    const wrap = document.createElement("div");
    wrap.className = "group";
    let body;
    if (g) {
      const h = document.createElement("div");
      h.className = "group-head";
      h.style.setProperty("--gc", g.color);
      h.innerHTML =
        '<span class="group-caret">' + (g.collapsed ? "▶" : "▼") + "</span>" +
        '<span class="group-name"></span><span class="group-count"></span>';
      h.querySelector(".group-name").textContent = g.name;
      h.onclick = () => { g.collapsed = !g.collapsed; saveGroups(); };
      h.oncontextmenu = (e) => { e.preventDefault(); groupMenu(e, g); };
      h.ondragover = (e) => { e.preventDefault(); h.classList.add("drop"); };
      h.ondragleave = () => h.classList.remove("drop");
      h.ondrop = (e) => { e.preventDefault(); h.classList.remove("drop"); drop(g.id); };
      wrap.appendChild(h);
      body = document.createElement("div");
      body.className = "group-body";
      body.hidden = !!g.collapsed;
      wrap.appendChild(body);
      wrap._head = h;
    } else {
      body = document.createElement("div");
      body.className = "group-body";
      if (state.groups.length) {
        const h = document.createElement("div");
        h.className = "group-head";
        h.innerHTML = '<span class="group-caret"></span><span class="group-name">sem grupo</span>';
        h.ondragover = (e) => { e.preventDefault(); h.classList.add("drop"); };
        h.ondragleave = () => h.classList.remove("drop");
        h.ondrop = (e) => { e.preventDefault(); h.classList.remove("drop"); drop(""); };
        wrap.appendChild(h);
      }
      wrap.appendChild(body);
    }
    railList.appendChild(wrap);
    const sec = { wrap, body, counts: {} };
    secoes.set(gid, sec);
    return sec;
  };

  // ordem das secoes: grupos na ordem criada, "sem grupo" por ultimo
  if (state.groups.length) for (const g of state.groups) sectionFor(g.id);

  for (const s of ordered) {
    const gid = state.groups.length ? groupOf(s.id) : "";
    const sec = sectionFor(gid);
    const st = eff(s);
    sec.counts[st] = (sec.counts[st] || 0) + 1;

    const it = document.createElement("div");
    it.className = "rail-item " + st + (s.id === current ? " on" : "");
    it.setAttribute("role", "button");
    it.tabIndex = 0;
    it.draggable = true;
    it.dataset.id = s.id;
    it.innerHTML =
      '<div class="rail-top"><span class="dot"></span><span class="rail-name"></span></div>' +
      '<div class="rail-state"></div>';
    it.querySelector(".rail-name").textContent = s.label || s.title || "sessão";
    it.querySelector(".rail-state").textContent =
      st === "idle" ? "parado " + s.quietFor + "s" : LABEL[st] || st;
    it.title = s.cwd || "";
    it.onclick = () => openSession(s.id);
    it.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSession(s.id); }
      if (e.key === "Delete") { e.preventDefault(); askKill(s); }
    };
    it.oncontextmenu = (e) => { e.preventDefault(); sessionMenu(e, s); };
    it.ondragstart = (ev) => { dragId = s.id; it.classList.add("dragging"); ev.dataTransfer.effectAllowed = "move"; };
    it.ondragend = () => { dragId = null; it.classList.remove("dragging"); };
    sec.body.appendChild(it);
  }

  // mesmo colapsado, o cabecalho mostra os pontos por estado: colapsar nunca
  // pode esconder uma sessao que esta esperando por voce
  for (const [gid, sec] of secoes) {
    if (!gid || !sec.wrap._head) continue;
    const c = sec.wrap._head.querySelector(".group-count");
    if (!c) continue;
    c.textContent = "";
    for (const st of ["menu", "idle", "busy", "shell", "closed"]) {
      if (!sec.counts[st]) continue;
      const i = document.createElement("i");
      i.style.background = getComputedStyle(document.documentElement).getPropertyValue(
        st === "closed" ? "--closed" : "--" + st
      );
      c.appendChild(i);
      c.appendChild(document.createTextNode(String(sec.counts[st])));
    }
  }

  // alvo "sem grupo" reaparece durante o arraste, mesmo vazio
  if (dragId && state.groups.length && !secoes.has("")) sectionFor("");
}

rail.addEventListener("pointerenter", () => { railHold = true; });
rail.addEventListener("pointerleave", () => { railHold = false; paintRail(); });

function drop(gid) {
  if (!dragId) return;
  const id = dragId;
  dragId = null;
  // mudanca de pai e gesto do usuario: aplica na hora, ignorando o railHold,
  // senao a sessao so entraria no grupo quando o mouse saisse do menu
  window.deck.setMember(id, gid).then((st) => { state = st; paintRail(true); });
}

// ----------------------------------------------------------- menu contexto

function closeCtx() { ctx.hidden = true; ctx.textContent = ""; }
window.addEventListener("wheel", closeCtx, true);
rail.addEventListener("scroll", closeCtx);
document.addEventListener("pointerdown", (e) => { if (!ctx.contains(e.target)) closeCtx(); }, true);
window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !ctx.hidden) closeCtx(); });

function showCtx(e, items) {
  ctx.textContent = "";
  for (const it of items) {
    if (it.sep) { const d = document.createElement("div"); d.className = "sep"; ctx.appendChild(d); continue; }
    if (it.lab) { const d = document.createElement("div"); d.className = "lab"; d.textContent = it.lab; ctx.appendChild(d); continue; }
    const b = document.createElement("button");
    b.className = "ci" + (it.danger ? " danger" : "");
    if (it.color) {
      const sw = document.createElement("span");
      sw.className = "sw";
      sw.style.background = it.color;
      b.appendChild(sw);
    }
    const t = document.createElement("span");
    t.className = "txt";
    t.textContent = it.text;
    b.appendChild(t);
    b.onclick = () => { closeCtx(); it.go(); };
    ctx.appendChild(b);
  }
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(e.clientX, window.innerWidth - r.width - 8) + "px";
  ctx.style.top = Math.min(e.clientY, window.innerHeight - r.height - 8) + "px";
}

function sessionMenu(e, s) {
  const items = [];
  if (s.status === "closed") {
    items.push({ text: "retomar sessão", go: () => resume(s.id) });
    items.push({ sep: true });
    items.push({ text: "esquecer do histórico", danger: true, go: () => askForget(s) });
  } else {
    if (state.groups.length) {
      items.push({ lab: "mover para" });
      for (const g of state.groups) {
        if (groupOf(s.id) === g.id) continue;
        items.push({ text: g.name, color: g.color, go: () => window.deck.setMember(s.id, g.id).then((st) => { state = st; paintRail(true); }) });
      }
      if (groupOf(s.id)) items.push({ text: "sem grupo", go: () => window.deck.setMember(s.id, "").then((st) => { state = st; paintRail(true); }) });
    }
    items.push({ text: "novo grupo…", go: () => openGroupForm(null, s.id) });
    items.push({ sep: true });
    items.push({ text: "encerrar sessão", danger: true, go: () => askKill(s) });
  }
  showCtx(e, items);
}

function groupMenu(e, g) {
  const items = [{ text: "renomear / mudar cor", go: () => openGroupForm(g, null) }, { lab: "cor" }];
  for (const c of state.palette) {
    items.push({ text: c === g.color ? "atual" : " ", color: c, go: () => { g.color = c; saveGroups(); } });
  }
  items.push({ sep: true });
  items.push({
    text: "excluir grupo",
    danger: true,
    go: () => {
      // excluir um grupo nunca encerra sessao: elas voltam para "sem grupo"
      state.groups = state.groups.filter((x) => x.id !== g.id);
      for (const k of Object.keys(state.members)) if (state.members[k] === g.id) delete state.members[k];
      saveGroups();
    },
  });
  showCtx(e, items);
}

function askKill(s) {
  const trab = s.status === "busy" ? "\n\nEla está TRABALHANDO agora — vai ser interrompida no meio." : "";
  if (!confirm(`Encerrar a sessão “${s.label || s.title}”?${trab}\n\nO histórico fica salvo: dá para retomar depois.`)) return;
  window.deck.kill(s.id, false).then(() => { if (current === s.id) showNothing(); });
}

function askForget(s) {
  if (!confirm(`Esquecer “${s.label || s.title}” do histórico?\n\nEla some da lista. A conversa em si continua no Claude.`)) return;
  window.deck.kill(s.id, true).then(() => { if (current === s.id) showNothing(); });
}

// ------------------------------------------------------------------ grupos

function saveGroups() {
  window.deck.saveGroups(state.groups, state.members).then((st) => { state = st; paintRail(true); });
}

const newGroupId = () => {
  let n = 1;
  while (state.groups.some((g) => g.id === "g" + n)) n++;
  return "g" + n;
};

function openGroupForm(g, pendingSession) {
  gfEdit = g;
  groupForm.pendingSession = pendingSession || null;
  groupForm.hidden = false;
  newForm.hidden = true;
  groupMsg.textContent = "";
  groupName.value = g ? g.name : "";
  gfColor = g ? g.color : state.palette[state.groups.length % state.palette.length];
  swatches.textContent = "";
  for (const c of state.palette) {
    const b = document.createElement("button");
    b.style.background = c;
    b.className = c === gfColor ? "on" : "";
    b.onclick = () => { gfColor = c; [...swatches.children].forEach((x, i) => x.className = state.palette[i] === c ? "on" : ""); };
    swatches.appendChild(b);
  }
  groupName.focus();
}

groupBtn.onclick = () => (groupForm.hidden ? openGroupForm(null, null) : (groupForm.hidden = true));
groupCancel.onclick = () => { groupForm.hidden = true; };
groupGo.onclick = () => {
  const nome = groupName.value.trim().slice(0, 32);
  if (!nome) { groupMsg.textContent = "dê um nome ao grupo"; groupMsg.className = "new-msg err"; return; }
  if (gfEdit) { gfEdit.name = nome; gfEdit.color = gfColor; }
  else {
    const g = { id: newGroupId(), name: nome, color: gfColor, collapsed: false };
    state.groups.push(g);
    if (groupForm.pendingSession) state.members[groupForm.pendingSession] = g.id;
  }
  groupForm.hidden = true;
  saveGroups();
};
groupName.onkeydown = (e) => {
  if (e.key === "Enter") { e.preventDefault(); groupGo.click(); }
  if (e.key === "Escape") { e.preventDefault(); groupForm.hidden = true; }
};

// ------------------------------------------------------------ nova sessao

function fillDirs() {
  dirs.textContent = "";
  const vistos = new Set();
  for (const s of sessions) {
    if (!s.cwd || vistos.has(s.cwd)) continue;
    vistos.add(s.cwd);
    const o = document.createElement("option");
    o.value = s.cwd;
    dirs.appendChild(o);
  }
  newGroup.textContent = "";
  const o0 = document.createElement("option");
  o0.value = "";
  o0.textContent = state.groups.length ? "— sem grupo —" : "— nenhum grupo criado —";
  newGroup.appendChild(o0);
  for (const g of state.groups) {
    const o = document.createElement("option");
    o.value = g.id;
    o.textContent = g.name;
    newGroup.appendChild(o);
  }
  const atual = sessions.find((s) => s.id === current);
  if (atual) {
    newCwd.value = atual.cwd || "";
    newGroup.value = groupOf(atual.id) || "";
  }
}

newBtn.onclick = () => {
  if (!newForm.hidden) { newForm.hidden = true; return; }
  groupForm.hidden = true;
  newForm.hidden = false;
  newMsg.textContent = "";
  newMsg.className = "new-msg";
  fillDirs();
  newCwd.focus();
  newCwd.select();
};
newCancel.onclick = () => { newForm.hidden = true; };
newPick.onclick = async () => {
  const p = await window.deck.pickFolder(newCwd.value || undefined);
  if (p) newCwd.value = p;
};
newGo.onclick = async () => {
  const cwd = newCwd.value.trim();
  if (!cwd) { newMsg.textContent = "informe a pasta"; newMsg.className = "new-msg err"; return; }
  newGo.disabled = true;
  newMsg.textContent = "abrindo…";
  newMsg.className = "new-msg";
  try {
    const d = dimsDoPalco();
    const m = await window.deck.spawn(cwd, newGroup.value || "", d.cols, d.rows);
    newForm.hidden = true;
    await openSession(m.id);
  } catch (e) {
    newMsg.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "");
    newMsg.className = "new-msg err";
  } finally {
    newGo.disabled = false;
  }
};
newCwd.onkeydown = (e) => {
  if (e.key === "Enter") { e.preventDefault(); newGo.click(); }
  if (e.key === "Escape") { e.preventDefault(); newForm.hidden = true; }
};

headKill.onclick = () => {
  const s = sessions.find((x) => x.id === current);
  if (s) askKill(s);
};

// ------------------------------------------------------------------ eventos

window.deck.onData(({ id, chunk }) => {
  if (id !== current) return;
  if (attaching === id) { queued.push(chunk); return; }
  term.write(chunk);
});

window.deck.onSessions((list) => {
  sessions = list;
  if (current && !sessions.some((s) => s.id === current)) {
    showNothing();
    return;
  }
  // Auto-reparo. O main esquece a inscricao de uma sessao quando ela morre;
  // se ela voltar (um resume disparado por qualquer caminho), o renderer
  // continuaria com `current` apontando para ela e a tela congelada no
  // ultimo quadro de antes - sem erro nenhum, o que e o pior tipo de bug.
  // Aqui ele percebe a divergencia e reanexa.
  const s = sessions.find((x) => x.id === current);
  if (s && s.status !== "closed" && anexado !== current && attaching !== current) {
    const id = current;
    current = null;
    openSession(id);
    return;
  }
  paint();
});

window.deck.onState((st) => { state = st; paintRail(); });

window.deck.onExit(({ id }) => {
  if (id === current) {
    const s = sessions.find((x) => x.id === id);
    if (s) selectClosed({ ...s, status: "closed" });
    else showNothing();
  }
});

// ------------------------------------------------------------------- boot

(async function boot() {
  const b = await window.deck.bootstrap();
  state = b.state;
  sessions = b.sessions;
  if (!b.claudeAvailable) {
    showNothing("claude.exe não foi encontrado no PATH");
  } else {
    const viva = sessions.find((s) => s.status !== "closed");
    if (viva) await openSession(viva.id);
    else showNothing();
  }
  paint();
})();

console.info("renderer pronto: xterm " + (window.Terminal ? "ok" : "AUSENTE") +
  ", fit " + (window.FitAddon ? "ok" : "AUSENTE") +
  ", webgl " + (window.WebglAddon ? "ok" : "AUSENTE") +
  ", unicode11 " + (window.Unicode11Addon ? "ok" : "AUSENTE") +
  ", ponte " + (window.deck ? "ok" : "AUSENTE"));
window.addEventListener("error", (e) => console.error("erro: " + e.message + " @" + e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => console.error("promise rejeitada: " + (e.reason && e.reason.message || e.reason)));

// Diagnostico do autoteste: qual sessao o renderer acha que esta mostrando.
window.__diag = () => ({ current, anexado, attaching, enfileirados: queued.length });
