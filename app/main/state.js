"use strict";

const fs = require("fs");
const path = require("path");

// Estado que nao vem do terminal: grupos tematicos, e o catalogo de sessoes
// conhecidas (para o --resume). Portado do server.js, com uma mudanca de fundo.
//
// Na versao WezTerm a chave de membro era o pane-id, que reinicia junto com o
// GUI - por isso existia a "chave de instancia" (WEZTERM_UNIX_SOCKET): se o
// socket mudasse, os membros caiam, senao um pane novo herdaria o grupo de um
// morto. Aqui a chave e o session-id do proprio Claude, um UUID que o app gera
// no spawn e reusa no --resume. Ele nunca colide, entao a chave de instancia
// deixa de existir e a participacao em grupo sobrevive a reiniciar o app - que
// e exatamente o desejado, ja que a sessao tambem sobrevive, via resume.

const PALETTE = ["#4ea8de", "#5c6fd8", "#8b7ff0", "#c05ad1", "#2bb3a3", "#d9693f"];
const MAX_GROUPS = 24;
const MAX_NAME = 32;
const MAX_SESSIONS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanName(s) {
  return String(s == null ? "" : s)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, MAX_NAME);
}

/**
 * Toda entrada passa por aqui: o que vem do renderer e o que vem do disco - o
 * arquivo pode ter sido editado a mao, e um grupo invalido quebraria a tela.
 */
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
    if (!UUID_RE.test(k)) continue;
    const gid = String(src[k] == null ? "" : src[k]);
    if (ids.has(gid)) members[k] = gid; // membro orfao nao entra
  }

  const sessions = [];
  const seen = new Set();
  const rawS = raw && Array.isArray(raw.sessions) ? raw.sessions : [];
  for (const s of rawS) {
    if (sessions.length >= MAX_SESSIONS) break;
    if (!s || typeof s !== "object") continue;
    const id = String(s.id == null ? "" : s.id);
    if (!UUID_RE.test(id) || seen.has(id)) continue;
    const cwd = typeof s.cwd === "string" ? s.cwd : "";
    if (!cwd) continue;
    seen.add(id);
    sessions.push({
      id,
      cwd,
      label: cleanName(s.label),
      createdAt: Number.isFinite(s.createdAt) ? s.createdAt : Date.now(),
      closedAt: Number.isFinite(s.closedAt) ? s.closedAt : null,
    });
  }

  return { version: 2, groups, members, sessions };
}

class Store {
  constructor(file) {
    this.file = file;
    this.state = { version: 2, groups: [], members: {}, sessions: [] };
  }

  load() {
    let bruto = null;
    try {
      bruto = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      bruto = null; // primeira execucao
    }
    let raw = null;
    if (bruto !== null) {
      // O Notepad e o Out-File -Encoding utf8 do PowerShell 5.1 gravam BOM, e
      // JSON.parse estoura com BOM: sem isso, abrir o arquivo para espiar
      // apagaria todos os grupos em silencio.
      try {
        raw = JSON.parse(bruto.replace(/^﻿/, ""));
      } catch (e) {
        console.warn(`[state] ${this.file} ilegivel (${e.message}) - comecando vazio`);
      }
    }
    this.state = normalizeState(raw);
    return this.state;
  }

  // tmp + rename: um crash no meio do write nao deixa um JSON pela metade
  save(onde) {
    const tmp = this.file + ".tmp";
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      console.warn(`[state] nao foi possivel gravar ${this.file} (${onde}): ${e.message}`);
      return false;
    }
  }

  replaceGroups(raw) {
    const next = normalizeState({
      groups: raw && raw.groups,
      members: raw && raw.members,
      sessions: this.state.sessions,
    });
    this.state = next;
    this.save("grupos");
    return this.publicState();
  }

  rememberSession({ id, cwd, label }) {
    const i = this.state.sessions.findIndex((s) => s.id === id);
    if (i >= 0) {
      this.state.sessions[i].cwd = cwd || this.state.sessions[i].cwd;
      if (label) this.state.sessions[i].label = cleanName(label);
      this.state.sessions[i].closedAt = null;
    } else {
      this.state.sessions.unshift({
        id,
        cwd,
        label: cleanName(label),
        createdAt: Date.now(),
        closedAt: null,
      });
      if (this.state.sessions.length > MAX_SESSIONS) this.state.sessions.length = MAX_SESSIONS;
    }
    this.save("sessao");
  }

  closeSession(id, { forget } = {}) {
    if (forget) {
      this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
      delete this.state.members[id];
    } else {
      const s = this.state.sessions.find((x) => x.id === id);
      if (s) s.closedAt = Date.now();
    }
    this.save("fechar sessao");
  }

  setMember(id, gid) {
    if (!UUID_RE.test(id)) return this.publicState();
    if (gid && this.state.groups.some((g) => g.id === gid)) this.state.members[id] = gid;
    else delete this.state.members[id];
    this.save("membro");
    return this.publicState();
  }

  // Grupo de sessao que o app nao conhece mais sai do arquivo. Roda contra a
  // lista crua (vivas + historico), nunca contra o que esta filtrado na tela.
  prune(idsConhecidos) {
    let mudou = false;
    for (const k of Object.keys(this.state.members)) {
      if (!idsConhecidos.has(k)) {
        delete this.state.members[k];
        mudou = true;
      }
    }
    if (mudou) this.save("poda");
  }

  publicState() {
    return {
      groups: this.state.groups,
      members: this.state.members,
      sessions: this.state.sessions,
      palette: PALETTE,
    };
  }
}

module.exports = { Store, normalizeState, cleanName, PALETTE, MAX_NAME, UUID_RE };
