"use strict";

const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");
const { Unicode11Addon } = require("@xterm/addon-unicode11");

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

/**
 * Abre o PTY pedindo o ConPTY que vem no pacote do node-pty, e nao o do
 * Windows.
 *
 * E ESTA a correcao do "apago com backspace e a letra continua na tela".
 *
 * O ConPTY nao repassa os bytes do Claude: ele redesenha num buffer de console
 * do Windows e re-serializa o que ficou la. Quem decide quantas celulas um
 * glyph ocupa, portanto, e o ConPTY - e o do Win10 19045 usa uma tabela velha.
 * Medido: ⚡ ⏳ ✅ valem 1 celula para ele, enquanto o Bun.stringWidth (o
 * claude.exe e binario Bun) diz 2. Quando o TUI manda apagar a coluna 12, o
 * ConPTY do SO acha que a linha acabou na 11, NAO APAGA NADA e so acrescenta um
 * espaco no fim: o caractere da ponta sobrevive. Como o estrago acontece dentro
 * do buffer do ConPTY, antes de qualquer xterm, nenhum ajuste no renderer
 * alcanca isso.
 *
 * O node-pty traz um ConPTY proprio e bem mais novo em
 * third_party/conpty/1.23.251008001 (o mesmo arquivo que vai para
 * prebuilds/win32-x64/conpty - conferido por sha256), e esse concorda celula a
 * celula com o Bun.stringWidth e com o Unicode 11 dos dois xterm deste app.
 * Opcao documentada em node_modules/node-pty/typings/node-pty.d.ts:104 e
 * repassada em lib/windowsTerminal.js:51.
 *
 * O node-pty marca a opcao como EXPERIMENTAL e ela muda os caminhos de
 * kill/exit/conout - por isso o fallback: se a dll do pacote sumir (um build
 * empacotado que nao copie third_party, por exemplo), a sessao ainda nasce, com
 * o bug de largura de volta mas aberta, que e melhor que uma sessao que nao
 * abre. Para desligar a opcao de proposito: CLAUDE_DECK_CONPTY=windows.
 */
function abrirPty(claudePath, args, opts) {
  const doPacote =
    process.platform === "win32" && process.env.CLAUDE_DECK_CONPTY !== "windows";
  if (!doPacote) return pty.spawn(claudePath, args, opts);
  try {
    return pty.spawn(claudePath, args, { ...opts, useConptyDll: true });
  } catch (e) {
    console.warn(
      "[pty] ConPTY do pacote indisponivel (" + e.message + "): usando o do Windows"
    );
    return pty.spawn(claudePath, args, opts);
  }
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

    // Mesma tabela de largura do xterm do renderer, que roda em Unicode 11.
    // Tres camadas contam celulas neste app - o ConPTY (que redesenha num
    // buffer de console do Windows e re-serializa), o espelho e a view - e as
    // tres TEM que concordar. Medido com ConPTY de verdade:
    //
    //   glyph           ConPTY do SO   ConPTY da dll   xterm v6   xterm v11
    //   ⚡ ⏳ ✅                1              2             1          2
    //   🚀                     2              2             1          2
    //   ✳ ◐ ❯ │ Nerd Font      1              1             1          1
    //
    // So existe uma combinacao sem divergencia nenhuma: ConPTY da dll +
    // Unicode 11 nos dois xterm. Por isso esta linha anda junto com o
    // `useConptyDll` do abrirPty() - uma sem a outra nao resolve.
    try {
      this.term.loadAddon(new Unicode11Addon());
      this.term.unicode.activeVersion = "11";
    } catch (e) {
      /* sem o addon o espelho fica em v6: divergente, mas nao fatal */
    }

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
    this.pty = abrirPty(claudePath, args, {
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
    this.lastChange = Date.now();
    // O write do xterm NAO e imediato: ele enfileira e parseia num tick
    // seguinte. O chunk so pode entrar em _pending DEPOIS de o espelho ter
    // parseado, senao abre um buraco por onde o byte some de vez:
    //
    //   deck:attach chama flush() - o chunk sai da fila e, como o id ainda
    //   nao esta em `attached`, vai para o vazio - e logo depois snapshot(),
    //   que serializa so o que JA foi parseado, ou seja, sem o chunk.
    //
    // O byte nao entra no snapshot nem no stream. Medido: um chunk que apagava
    // uma linha se perdia assim, e a linha velha ficava na tela da view para
    // sempre - o TUI acha que ja apagou aquilo e nunca mais repinta.
    this.term.write(d, () => {
      this._pending.push(d);
      if (!this._flushTimer) this._flushTimer = setTimeout(() => this._flush(), FLUSH_MS);
    });
    if (this._menuTimer) clearTimeout(this._menuTimer);
    this._menuTimer = setTimeout(() => this._recheckMenu(), MENU_DEBOUNCE_MS);
  }

  /**
   * Esvazia a fila agora. Usado antes de tirar um snapshot para um renderer
   * que esta anexando: tudo que esta em _pending ja foi parseado pelo espelho
   * (ver _onData) e portanto JA esta dentro do snapshot - se continuasse na
   * fila seria entregue depois dele e apareceria duas vezes na tela.
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
