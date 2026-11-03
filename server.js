// claude-deck - painel paralelo das sessoes Claude rodando no WezTerm.
// Sem dependencias: usa o CLI do WezTerm como fonte de verdade.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fileURLToPath } = require("url");
const { execFile, spawn } = require("child_process");

// Qualquer site aberto no navegador alcanca 127.0.0.1. Como escrever num pane
// equivale a digitar na sessao, as rotas de acao exigem token e Host local.
const TOKEN = crypto.randomBytes(16).toString("hex");

const PORT = Number(process.env.DECK_PORT || 7788);
const TAIL = Number(process.env.DECK_TAIL || 18); // linhas uteis mostradas por pane
const FULL_TAIL = Number(process.env.DECK_FULL_TAIL || 200); // idem, no pane aberto em tela cheia
const SELF = process.env.WEZTERM_PANE; // pane do proprio deck, fica fora da lista

// So o ✳ foi observado como estado parado. Os demais glyphs (◐◑◒◓, ✽, ...)
// sao frames de spinner, entao qualquer outro glyph conta como trabalhando.
const IDLE_GLYPHS = new Set(["✳"]);

// ---------------------------------------------------------------------------
// Grupos: a unica coisa que o wezterm cli NAO sabe
//
// Agrupar sessoes por tema e informacao do usuario, nao do terminal. Fica num
// arquivo ao lado do server.js, nao no localStorage: todo restart do server.js
// derruba a pagina, e o navegador nao distingue "deck reiniciou" de "WezTerm
// reiniciou" - alem de localhost e 127.0.0.1 serem origens separadas, cada uma
// com o seu proprio localStorage.
//
// O pane-id nao e identidade estavel: ele sobe dentro de uma instancia do
// WezTerm e nunca se repete, mas reinicia junto com o GUI. Por isso o arquivo
// guarda tambem o socket (que traz o pid do GUI em gui-sock-<pid>): quando a
// instancia muda, os GRUPOS ficam e os MEMBROS caem, senao um pane novo
// herdaria o grupo de um morto.
// ---------------------------------------------------------------------------
const STATE_FILE = path.join(__dirname, "deck-state.json");
const INSTANCE = process.env.WEZTERM_UNIX_SOCKET || "";

// Cores de grupo. Nenhuma pode ser confundida com as de estado (idle #5ad17f,
// busy #e0b254, menu #e86a8c, shell #5a6372) - o grupo diz "sobre o que", o
// estado diz "precisa de mim?", e os dois aparecem no mesmo card.
const PALETTE = ["#4ea8de", "#5c6fd8", "#8b7ff0", "#c05ad1", "#2bb3a3", "#d9693f"];
const MAX_GROUPS = 24;
const MAX_NAME = 32;

let state = { version: 1, instance: INSTANCE, groups: [], members: {} };

function cleanName(s) {
  return String(s == null ? "" : s).replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, MAX_NAME);
}

// Tudo que vem da pagina passa por aqui. O arquivo em disco tambem: ele pode ter
// sido editado na mao, e um grupo invalido quebraria a pagina toda.
function normalizeState(raw) {
  const groups = [];
  const ids = new Set();
  const list = raw && Array.isArray(raw.groups) ? raw.groups : [];
  for (const g of list) {
    if (groups.length >= MAX_GROUPS) break;
    if (!g || typeof g !== "object") continue;
    const id = String(g.id == null ? "" : g.id);
    if (!/^g[0-9a-z]{1,20}$/.test(id) || ids.has(id)) continue;
    const name = cleanName(g.name);
    if (!name) continue;
    ids.add(id);
    groups.push({
      id,
      name,
      color: PALETTE.indexOf(g.color) >= 0 ? g.color : PALETTE[groups.length % PALETTE.length],
      collapsed: !!g.collapsed,
    });
  }
  const members = {};
  const src = raw && raw.members && typeof raw.members === "object" ? raw.members : {};
  for (const k of Object.keys(src)) {
    if (!/^\d+$/.test(k)) continue; // chave e pane-id
    const gid = String(src[k] == null ? "" : src[k]);
    if (ids.has(gid)) members[k] = gid; // membro orfao nao entra
  }
  return { version: 1, instance: INSTANCE, groups, members };
}

// tmp + rename: um Ctrl+C no meio do write deixaria um JSON pela metade
function saveState() {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

function trySave(onde) {
  try {
    saveState();
    return true;
  } catch (e) {
    console.warn(`nao foi possivel gravar ${STATE_FILE} (${onde}): ${e.message}`);
    return false;
  }
}

function loadState() {
  let bruto = null;
  try { bruto = fs.readFileSync(STATE_FILE, "utf8"); } catch (e) { bruto = null; } // 1a execucao: nao existe
  let raw = null;
  if (bruto !== null) {
    // Notepad e o Out-File do PowerShell 5.1 gravam BOM, e JSON.parse estoura
    // com BOM - sem isso, uma edicao a mao apagaria todos os grupos em silencio
    try { raw = JSON.parse(bruto.replace(/^﻿/, "")); }
    catch (e) { console.warn(`${STATE_FILE} ilegivel (${e.message}) - comecando sem grupos`); }
  }
  const mesmaInstancia = !!INSTANCE && raw && raw.instance === INSTANCE;
  state = normalizeState(raw);
  if (!mesmaInstancia) {
    state.members = {};
    if (raw) trySave("troca de instancia"); // regrava com o socket atual
  }
}

// Panes mortos saem do arquivo. Roda contra a lista CRUA do wezterm, nunca
// contra o que a pagina mostra: podar pelo que esta na tela apagaria o grupo de
// todo pane de shell no instante em que o filtro "so sessoes Claude" ligasse.
function pruneMembers(idsVivos) {
  let mudou = false;
  for (const k of Object.keys(state.members)) {
    if (!idsVivos.has(k)) { delete state.members[k]; mudou = true; }
  }
  if (mudou) trySave("poda");
}

function publicState() {
  return { groups: state.groups, members: state.members, palette: PALETTE };
}

function wezterm(args) {
  return new Promise((resolve, reject) => {
    execFile("wezterm.exe", ["cli", ...args], { encoding: "utf8", maxBuffer: 8 << 20 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// Texto vai por stdin: no Windows isso evita quoting, acento e multiline quebrados.
function wezStdin(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn("wezterm.exe", ["cli", ...args]);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `exit ${code}`))));
    p.stdin.end(input, "utf8");
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Um ESC ou um fim-de-paste colado encerraria o bracketed paste e viraria tecla.
function sanitize(text) {
  return String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

async function sendToPane(pane, text, submit) {
  const clean = sanitize(text);
  if (clean) await wezStdin(["send-text", "--pane-id", pane], clean);
  if (submit) {
    await sleep(150); // Enter junto do paste corre o risco de virar parte dele
    await wezStdin(["send-text", "--pane-id", pane, "--no-paste"], "\r");
  }
}

// o cli list devolve o cwd como URL (file:///D:/...); nem todo pane tem um
function toPath(u) {
  try { return u ? fileURLToPath(u) : ""; } catch (e) { return ""; }
}

function listPanes() {
  return wezterm(["list", "--format", "json"]).then((out) => JSON.parse(out));
}

function classify(title) {
  const glyph = [...title.trim()][0] || "";
  if (IDLE_GLYPHS.has(glyph)) return { status: "idle", glyph, label: title.slice(glyph.length).trim() };
  if (glyph && glyph.codePointAt(0) > 0x2000) return { status: "busy", glyph, label: title.slice(glyph.length).trim() };
  return { status: "shell", glyph: "", label: title.trim() };
}

// O rodape de um pane do Claude e so moldura: caixa do prompt, statusline e footer.
// Corta a partir da primeira borda cheia que aparece na regiao final.
function stripChrome(lines) {
  for (let i = Math.max(0, lines.length - 14); i < lines.length; i++) {
    if (/^[─━]{10,}/.test(lines[i])) return lines.slice(0, i);
  }
  return lines;
}

// Quando ha dialogo aberto, o Claude ja tem uma opcao pre-selecionada e o Enter
// confirma ELA - o texto enviado seria engolido e o default aprovado.
// "^\s+❯" = opcao de menu (indentada). O ❯ da caixa de input fica na coluna 0.
const MENU_RE = /(Enter to confirm|Esc to cancel|❯\s*\d+\.\s|^\s+❯\s)/;

function detectMenu(lines) {
  // aparar o branco do fim do viewport antes: senao slice(-15) pega so vazio
  return trimBlank(lines).slice(-15).some((l) => MENU_RE.test(l));
}

function trimBlank(lines) {
  const out = lines.slice();
  while (out.length && !out[out.length - 1]) out.pop();
  while (out.length && !out[0]) out.shift();
  return out;
}

function readPane(text, keep) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const menu = detectMenu(lines);
  // com menu aberto o corte de moldura esconderia justamente as opcoes
  const body = trimBlank(menu ? lines : stripChrome(lines));
  // "seen" e sempre a mesma janela, independente de quanto foi lido: e dela que
  // sai o lastSeen, senao abrir a tela cheia de um pane zeraria o "parado Xs".
  return { menu, tail: body.slice(-keep).join("\n"), seen: body.slice(-TAIL).join("\n") };
}

async function paneHasMenu(pane) {
  const raw = await wezterm(["get-text", "--pane-id", String(pane), "--start-line", "0"]);
  return detectMenu(raw.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")));
}

// memoria curta: quando o conteudo de um pane mudou pela ultima vez
const lastSeen = new Map();

// full = id do pane aberto em tela cheia (ou null): so ele e lido fundo.
async function snapshot(full) {
  const panes = await listPanes();
  const now = Date.now();
  pruneMembers(new Set(panes.map((p) => String(p.pane_id))));
  const cards = await Promise.all(
    panes
      .filter((p) => String(p.pane_id) !== String(SELF))
      .map(async (p) => {
        const meta = classify(p.title || "");
        const keep = String(p.pane_id) === full ? FULL_TAIL : TAIL;
        let tail = "";
        let seen = "";
        let menu = false;
        try {
          const raw = await wezterm(["get-text", "--pane-id", String(p.pane_id), "--start-line", String(-keep)]);
          ({ menu, tail, seen } = readPane(raw, keep));
        } catch (e) {
          tail = seen = `(nao foi possivel ler o pane: ${e.message})`;
        }
        const prev = lastSeen.get(p.pane_id);
        if (!prev || prev.tail !== seen) lastSeen.set(p.pane_id, { tail: seen, at: now });
        return {
          paneId: p.pane_id,
          tabId: p.tab_id,
          windowId: p.window_id,
          title: meta.label || `pane ${p.pane_id}`,
          glyph: meta.glyph,
          status: meta.status,
          menu,
          group: state.members[String(p.pane_id)] || "",
          quietFor: Math.round((now - lastSeen.get(p.pane_id).at) / 1000),
          cols: p.size && p.size.cols,
          cwd: toPath(p.cwd),
          tail,
        };
      })
  );
  // ociosos primeiro: sao os que precisam de voce
  const rank = { idle: 0, busy: 1, shell: 2 };
  cards.sort((a, b) => rank[a.status] - rank[b.status] || a.paneId - b.paneId);
  return cards;
}

const INDEX = path.join(__dirname, "public", "index.html");

// Host valido corta DNS rebinding (site externo resolvendo um dominio para 127.0.0.1).
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      chunks.push(c);
      size += c.length;
      if (size > 1 << 20) req.destroy();
    });
    req.on("end", () => {
      // concatenar como Buffer: juntar como string partiria char multi-byte na borda do chunk
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error("body invalido")); }
    });
    req.on("error", reject);
  });
}

function json(res, data, code) {
  res.writeHead(code || 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function texto(res, code, msg) {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(msg);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host)) return texto(res, 403, "host nao permitido");

    if (url.pathname.startsWith("/api/")) {
      // header customizado: obriga preflight CORS, que uma pagina externa nao passa
      if (req.headers["x-deck-token"] !== TOKEN) {
        return texto(res, 401, "token invalido - recarregue o painel");
      }
    }

    if (url.pathname === "/api/panes") {
      // ?full=N pede esse pane com mais linhas; os outros continuam no TAIL
      const f = url.searchParams.get("full") || "";
      const data = await snapshot(/^\d+$/.test(f) && f !== String(SELF) ? f : null);
      return json(res, data);
    }

    if (url.pathname === "/api/groups") {
      if (req.method === "GET") return json(res, publicState());
      if (req.method !== "POST") return texto(res, 405, "use GET ou POST");
      // a pagina manda o estado inteiro; o servidor normaliza e devolve o que gravou
      state = normalizeState(await readBody(req));
      if (!trySave("gravacao de grupos")) return texto(res, 500, "nao foi possivel gravar deck-state.json");
      return json(res, publicState());
    }

    if (url.pathname === "/api/kill") {
      if (req.method !== "POST") return texto(res, 405, "use POST");
      const body = await readBody(req);
      const pane = String(body.pane == null ? "" : body.pane);
      if (!/^\d+$/.test(pane)) return texto(res, 400, "pane invalido");
      // matar o proprio pane mataria o servidor que esta respondendo
      if (pane === String(SELF)) return texto(res, 400, "esse e o pane do proprio deck");
      const panes = await listPanes();
      if (!panes.some((p) => String(p.pane_id) === pane)) return texto(res, 404, "pane nao existe mais");
      await wezterm(["kill-pane", "--pane-id", pane]);
      lastSeen.delete(Number(pane));
      if (state.members[pane]) { delete state.members[pane]; trySave("kill"); }
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname === "/api/spawn") {
      if (req.method !== "POST") return texto(res, 405, "use POST");
      const body = await readBody(req);
      const cwd = String(body.cwd || "");
      // exigir caminho absoluto tambem impede que um valor comecando com "-"
      // chegue ao wezterm como flag
      let ok = path.isAbsolute(cwd);
      try { ok = ok && fs.statSync(cwd).isDirectory(); } catch (e) { ok = false; }
      if (!ok) return texto(res, 400, "pasta invalida (precisa ser um diretorio existente): " + cwd);
      // programa fixo, espelhando o default_prog do wezterm.lua: o pedido escolhe
      // a pasta, nunca o que roda. -NoExit deixa o shell vivo se o claude sair.
      const out = await wezterm(["spawn", "--cwd", cwd, "--", "powershell.exe", "-NoExit", "-Command", "claude"]);
      const spawned = out.trim();
      if (!/^\d+$/.test(spawned)) {
        return texto(res, 502, "wezterm nao devolveu um pane: " + spawned.slice(0, 120));
      }
      return json(res, { paneId: Number(spawned) });
    }

    if (url.pathname === "/api/focus" || url.pathname === "/api/send") {
      if (req.method !== "POST") return texto(res, 405, "use POST");
      const body = await readBody(req);
      const pane = String(body.pane == null ? "" : body.pane);
      if (!/^\d+$/.test(pane)) return texto(res, 400, "pane invalido");

      if (url.pathname === "/api/focus") {
        await wezterm(["activate-pane", "--pane-id", pane]);
      } else if (body.key === "esc") {
        await wezStdin(["send-text", "--pane-id", pane, "--no-paste"], "\u001b");
      } else {
        // leitura fresca: o snapshot do painel pode estar 1,5s atrasado
        if (body.submit !== false && (await paneHasMenu(pane))) {
          return texto(res, 409, "menu aberto nesse pane — o Enter confirmaria a opção selecionada. Responda no WezTerm (⤢) ou use Esc.");
        }
        await sendToPane(pane, body.text || "", body.submit !== false);
      }
      res.writeHead(204);
      return res.end();
    }

    const html = fs.readFileSync(INDEX, "utf8").replace("__DECK_TOKEN__", TOKEN);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(html);
  } catch (e) {
    texto(res, 500, String(e.message || e));
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`porta ${PORT} ja esta em uso - feche o outro deck ou rode com DECK_PORT=7790 node server.js`);
    process.exit(1);
  }
  throw e;
});

loadState();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`claude-deck em http://localhost:${PORT}  (pane proprio: ${SELF == null ? "nao detectado" : SELF})`);
  console.log(`grupos: ${state.groups.length} em ${STATE_FILE}`);
  if (!process.env.WEZTERM_UNIX_SOCKET) {
    console.warn("AVISO: WEZTERM_UNIX_SOCKET ausente - rode o deck a partir de um pane do WezTerm.");
  }
});
