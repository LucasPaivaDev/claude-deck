"use strict";

const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");

const { classify, detectMenu } = require("./classify");

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;
const SCROLLBACK = 5000;

// Coalescencia de saida: o TUI do Claude emite frames de synchronized output
// em rajada. Mandar cada chunk como uma mensagem de IPC propria inunda o
// renderer sem ganho visual nenhum - 16ms junta a rajada num quadro so.
const FLUSH_MS = 16;

// O menu so e recalculado depois que a tela para de mudar: durante o streaming
// de uma resposta o buffer muda dezenas de vezes por segundo, e varrer 15
// linhas a cada chunk e desperdicio.
const MENU_DEBOUNCE_MS = 180;

const clamp = (v, lo, hi, padrao) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : padrao;
};

/**
 * Variaveis que o Claude Code injeta nos processos que ELE abre, para marcar
 * "voce e uma sessao filha". Se o claude-deck for aberto de dentro de uma
 * sessao Claude - o que, para este app, e ate provavel - ele as herda e as
 * repassa para as sessoes que cria. O efeito e silencioso e grave:
 *
 *   "Transcript saving is off - inherited CLAUDE_CODE_CHILD_SESSION marker"
 *
 * Sem transcript nao ha o que retomar, e o --resume responde "No conversation
 * found with session ID". Foi exatamente assim que o resume quebrou no teste.
 *
 * As sessoes criadas aqui sao de topo, nao filhas de nada: estes marcadores
 * caem. CLAUDE_EFFORT e ANTHROPIC_* ficam - sao preferencia e credencial do
 * usuario, nao marca de sessao.
 */
const ENV_DE_SESSAO = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PID",
];

function envLimpo(extra) {
  const env = { ...process.env };
  for (const k of ENV_DE_SESSAO) delete env[k];
  return { ...env, ...extra };
}

/** Acha o executavel do claude sem depender do shell resolver o PATH. */
function resolveClaude() {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  if (process.platform === "win32") {
    dirs.unshift(path.join(process.env.USERPROFILE || "", ".local", "bin"));
  }
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, "claude" + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch (e) {
        /* proximo */
      }
    }
  }
  return null;
}

class Session extends EventEmitter {
  /**
   * @param {{id:string, cwd:string, resume:boolean, claudePath:string}} opts
   */
  constructor({ id, cwd, resume, claudePath, cols, rows }) {
    super();
    this.id = id;
    this.cwd = cwd;
    this.createdAt = Date.now();
    this.lastChange = Date.now();
    this.exited = false;
    this.exitCode = null;

    this.title = "claude";
    this.status = "shell"; // vira idle/busy assim que o primeiro OSC chegar
    this.glyph = "";
    this.label = "claude";
    this.menu = false;

    // Nascer ja no tamanho da janela evita um redimensionamento logo apos o
    // spawn - e o TUI responde a ele limpando a tela para redesenhar, o que
    // aparece como um piscar na abertura de toda sessao.
    this.cols = clamp(cols, 20, 500, DEFAULT_COLS);
    this.rows = clamp(rows, 5, 200, DEFAULT_ROWS);

    // Espelho headless: a FONTE DA VERDADE do app. O xterm do renderer e so
    // uma view, e pode nem existir. E daqui que saem titulo, deteccao de menu
    // e o snapshot que um renderer recem-aberto recebe - por isso um reload
    // da janela nao perde nada.
    this.term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);

    // Titulo vem do OSC 0/2 que o proprio Claude emite. Medido em ConPTY:
    // "claude" -> "✳ Claude Code" -> "◐ ..." -> "✳ <assunto>". E evento, nao
    // polling: o status muda no instante em que a sessao muda.
    this.term.onTitleChange((t) => {
      // Spawnamos o claude.exe direto, sem shell no meio, justamente para que
      // nenhum outro processo sobrescreva o titulo (o PowerShell fazia isso).
      this.title = t;
      const c = classify(t);
      const mudou = c.status !== this.status || c.label !== this.label || c.glyph !== this.glyph;
      this.status = c.status;
      this.glyph = c.glyph;
      this.label = c.label || this.label;
      if (mudou) this.emit("meta");
    });

    const args = resume ? ["--resume", id] : ["--session-id", id];
    this.pty = pty.spawn(claudePath, args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      cwd,
      env: envLimpo({
        // Marca a sessao para os hooks do Claude Code (a "camada 2" que a
        // versao WezTerm nao conseguia construir por falta desse mapeamento).
        CLAUDE_DECK_SESSION: id,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      }),
    });

    this._pending = [];
    this._flushTimer = null;
    this._menuTimer = null;

    this.pty.onData((d) => this._onData(d));
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this._flush();
      this.emit("exit", exitCode);
    });
  }

  _onData(d) {
    this.term.write(d);
    this.lastChange = Date.now();
    this._pending.push(d);
    if (!this._flushTimer) this._flushTimer = setTimeout(() => this._flush(), FLUSH_MS);
    if (this._menuTimer) clearTimeout(this._menuTimer);
    this._menuTimer = setTimeout(() => this._recheckMenu(), MENU_DEBOUNCE_MS);
  }

  /**
   * Esvazia a fila agora. Usado antes de tirar um snapshot para um renderer
   * que esta anexando: o term ja absorveu os bytes pendentes (o write e
   * imediato), entao se eles continuassem na fila seriam entregues DEPOIS do
   * snapshot e apareceriam duas vezes na tela.
   */
  flush() {
    this._flush();
  }

  _flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (!this._pending.length) return;
    const chunk = this._pending.join("");
    this._pending.length = 0;
    this.emit("data", chunk);
  }

  _recheckMenu() {
    const menu = detectMenu(this.viewportLines());
    if (menu !== this.menu) {
      this.menu = menu;
      this.emit("meta");
    }
  }

  /** As linhas visiveis do espelho, sem atributos - para a guarda de menu. */
  viewportLines() {
    const buf = this.term.buffer.active;
    const out = [];
    const top = buf.baseY;
    for (let y = top; y < top + this.rows; y++) {
      const line = buf.getLine(y);
      out.push(line ? line.translateToString(true).replace(/\s+$/, "") : "");
    }
    return out;
  }

  /**
   * Snapshot para um renderer que esta anexando. Devolvido junto com a
   * inscricao no stream, no MESMO handler sincrono, para nenhum byte cair no
   * intervalo entre os dois.
   */
  snapshot() {
    return this.serializer.serialize({ scrollback: 1200 });
  }

  write(data) {
    if (this.exited) return false;
    this.pty.write(data);
    return true;
  }

  resize(cols, rows) {
    const c = Math.max(20, Math.min(500, Math.floor(cols) || DEFAULT_COLS));
    const r = Math.max(5, Math.min(200, Math.floor(rows) || DEFAULT_ROWS));
    if (c === this.cols && r === this.rows) return;
    this.cols = c;
    this.rows = r;
    // O espelho redimensiona em lockstep com o PTY, senao a deteccao de menu
    // passaria a ler um viewport de tamanho diferente do real.
    this.term.resize(c, r);
    if (!this.exited) {
      try {
        this.pty.resize(c, r);
      } catch (e) {
        /* pty pode ter morrido entre o teste e a chamada */
      }
    }
  }

  kill() {
    if (this.exited) return;
    try {
      this.pty.kill();
    } catch (e) {
      /* ja morreu */
    }
  }

  meta() {
    return {
      id: this.id,
      cwd: this.cwd,
      title: this.title,
      label: this.label,
      glyph: this.glyph,
      status: this.status,
      menu: this.menu,
      exited: this.exited,
      exitCode: this.exitCode,
      cols: this.cols,
      rows: this.rows,
      quietFor: Math.round((Date.now() - this.lastChange) / 1000),
      createdAt: this.createdAt,
    };
  }

  dispose() {
    if (this._flushTimer) clearTimeout(this._flushTimer);
    if (this._menuTimer) clearTimeout(this._menuTimer);
    this.kill();
    try {
      this.term.dispose();
    } catch (e) {
      /* ok */
    }
    this.removeAllListeners();
  }
}

class SessionManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    this.claudePath = resolveClaude();
  }

  get available() {
    return !!this.claudePath;
  }

  spawn({ cwd, id, resume, cols, rows }) {
    if (!this.claudePath) throw new Error("claude.exe nao encontrado no PATH");
    const real = path.resolve(cwd);
    if (!path.isAbsolute(real)) throw new Error("a pasta precisa ser um caminho absoluto");
    let st;
    try {
      st = fs.statSync(real);
    } catch (e) {
      throw new Error("pasta nao encontrada: " + real);
    }
    if (!st.isDirectory()) throw new Error("nao e uma pasta: " + real);

    const sid = id || crypto.randomUUID();
    if (this.sessions.has(sid)) throw new Error("essa sessao ja esta aberta");

    const s = new Session({
      id: sid, cwd: real, resume: !!resume, claudePath: this.claudePath, cols, rows,
    });
    this.sessions.set(sid, s);
    s.on("data", (chunk) => this.emit("data", sid, chunk));
    s.on("meta", () => this.emit("meta", sid));
    s.on("exit", (code) => {
      this.emit("exit", sid, code);
    });
    this.emit("meta", sid);
    return s;
  }

  get(id) {
    return this.sessions.get(id);
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.dispose();
    this.sessions.delete(id);
    return true;
  }

  list() {
    return [...this.sessions.values()].map((s) => s.meta());
  }

  busyCount() {
    return [...this.sessions.values()].filter((s) => s.status === "busy").length;
  }

  killAll() {
    for (const s of this.sessions.values()) s.dispose();
    this.sessions.clear();
  }
}

module.exports = { SessionManager, Session, resolveClaude, envLimpo, ENV_DE_SESSAO };
