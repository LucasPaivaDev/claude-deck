"use strict";
// Smoke test do nucleo, sem Electron e sem UI. Roda com: node main/_smoke.js
const { SessionManager, resolveClaude } = require("./sessions");
const { classify, detectMenu } = require("./classify");
const { normalizeState } = require("./state");

const log = (...a) => console.log(...a);
let falhas = 0;
const ok = (cond, msg) => {
  log((cond ? "  OK   " : "  FALHA") + "  " + msg);
  if (!cond) falhas++;
};

log("== classify ==");
ok(classify("\u2733 Resposta simples OK").status === "idle", "✳ -> idle");
ok(classify("\u25d0 Claude Code").status === "busy", "◐ -> busy");
ok(classify("\u25d1 Claude Code").status === "busy", "◑ -> busy");
ok(classify("claude").status === "shell", "sem glyph -> shell");
ok(classify("\u2733 Resposta simples OK").label === "Resposta simples OK", "label sem o glyph");

log("== detectMenu (dialogo real medido no spike) ==");
const dialogo = [
  "  Teach auto mode about your environment?",
  "",
  "  Auto mode works better when it knows your environment.",
  "",
  "  \u276f 1. Yes",
  "    2. Not now",
  "    3. Don't show again",
  "",
  "  Enter to confirm \u00b7 Esc to cancel",
];
ok(detectMenu(dialogo) === true, "dialogo do auto mode e detectado");
ok(detectMenu(["> digitando normal", "\u276f texto na coluna 0"]) === false, "caixa de input nao e menu");

log("== normalizeState ==");
const u = "11111111-2222-3333-4444-555555555555";
const n = normalizeState({
  groups: [{ id: "g1", name: "  incidentes  ", color: "#4ea8de" }, { id: "BAD", name: "x" }],
  members: { [u]: "g1", "99": "g1", [u.replace("1111", "9999")]: "gZ" },
  sessions: [{ id: u, cwd: "D:\\x" }],
});
ok(n.groups.length === 1 && n.groups[0].name === "incidentes", "grupo valido normalizado, id ruim descartado");
ok(Object.keys(n.members).length === 1 && n.members[u] === "g1", "membro por uuid; pane-id antigo e grupo orfao fora");
ok(n.sessions.length === 1, "sessao com cwd entra no catalogo");

log("== resolveClaude ==");
const cp = resolveClaude();
ok(!!cp, "claude encontrado: " + cp);

if (process.argv.includes("--live")) {
  log("== sessao ao vivo ==");
  const mgr = new SessionManager();
  const cwd = process.argv[process.argv.indexOf("--live") + 1] || process.cwd();
  const s = mgr.spawn({ cwd });
  log("  id:", s.id);
  const vistos = [];
  s.on("meta", () => vistos.push(s.status + " / " + s.label));
  let bytes = 0;
  s.on("data", (c) => { bytes += c.length; });

  setTimeout(() => {
    log("  apos 12s -> status:", s.status, "| label:", JSON.stringify(s.label), "| bytes:", bytes);
    ok(bytes > 0, "PTY emitiu dados");
    ok(s.status === "idle" || s.status === "busy", "status veio do titulo (nao ficou shell)");
    const snap = s.snapshot();
    ok(snap.length > 0, "snapshot serializado: " + snap.length + " chars");
    ok(/\u001b\[/.test(snap), "snapshot preserva escapes (cor)");
    log("  transicoes:", JSON.stringify([...new Set(vistos)].slice(0, 8)));
    s.resize(100, 30);
    ok(s.cols === 100 && s.rows === 30, "resize aplicado no pty e no espelho");
    mgr.killAll();
    setTimeout(() => {
      log(falhas ? `\n${falhas} FALHA(S)` : "\nTUDO OK");
      process.exit(falhas ? 1 : 0);
    }, 1200);
  }, 12000);
} else {
  log(falhas ? `\n${falhas} FALHA(S)` : "\nTUDO OK (use --live <pasta> para testar uma sessao real)");
  process.exit(falhas ? 1 : 0);
}
