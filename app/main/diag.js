"use strict";

/* Instrumentacao de travamento. INERTE por padrao: sem DECK_DIAG=1 nada aqui
 * roda, nem a sonda, nem o embrulho dos handlers.
 *
 *   $env:DECK_DIAG="1"; $env:DECK_DIAG_LOG="$env:TEMP\deck-diag.log"
 *   npx electron . --disable-background-timer-throttling `
 *     --disable-renderer-backgrounding --disable-backgrounding-occluded-windows
 *
 * Por que um ARQUIVO e nao o stdout: o electron.exe e binario de subsistema
 * GUI no Windows, entao o que o main imprime NAO chega a um shell que
 * redireciona a saida. Medido - foi assim que a primeira tentativa de coletar
 * numeros voltou vazia.
 *
 * As tres flags de linha de comando evitam um falso positivo real: com a janela
 * em segundo plano o Chromium estrangula os timers e a sonda do renderer
 * acusa ~900ms de atraso a cada segundo, que nao e travamento nenhum.
 *
 * COMO LER O LOG
 *   "main event-loop atrasou Nms" com N perto de 5000 -> e o congelamento de
 *     verdade (o Windows marca "Nao esta respondendo" por volta dos 5s).
 *   A linha "main  <passo> = Nms" logo ACIMA dela diz qual passo segurou o
 *     thread. Se nao houver passo nenhum atribuido, o bloqueio esta em codigo
 *     nativo (ConPTY, antivirus interceptando a criacao do processo) ou no
 *     proprio Chromium - nao neste repositorio.
 */

const fs = require("fs");

const ligado = process.env.DECK_DIAG === "1";
const arquivo = process.env.DECK_DIAG_LOG || "";

let fd = null;
if (ligado && arquivo) {
  try {
    fd = fs.openSync(arquivo, "a");
  } catch (e) {
    console.warn("[diag] nao consegui abrir " + arquivo + ": " + e.message);
  }
}

const hora = () => new Date().toISOString().slice(11, 23);

function log(origem, msg) {
  if (!ligado) return;
  const linha = `${hora()} ${origem.padEnd(8)} ${msg}`;
  if (fd !== null) {
    try { fs.writeSync(fd, linha + "\r\n"); } catch (e) { /* disco cheio: segue */ }
  }
  console.log("[diag] " + linha);
}

/**
 * Cronometra um trecho SINCRONO e devolve o que ele devolveu. O nome aparece no
 * log junto do tempo, e e ele que transforma "a janela congelou" em "congelou
 * no passo X".
 */
function passo(nome, fn) {
  if (!ligado) return fn();
  const t0 = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms >= 5) log("main", `  ${nome} = ${ms.toFixed(1)}ms`);
  }
}

/**
 * Sonda de atraso do event loop do main. Um timer de 100ms que mede quanto
 * ALEM dos 100ms ele demorou a ser chamado: esse excesso e exatamente o tempo
 * em que o thread esteve preso e a janela nao bombeou mensagens.
 */
function iniciarSonda() {
  if (!ligado) return;
  let esperado = Date.now() + 100;
  const tick = () => {
    const atraso = Date.now() - esperado;
    if (atraso >= 50) log("main", `event-loop atrasou ${atraso}ms`);
    esperado = Date.now() + 100;
    setTimeout(tick, 100);
  };
  setTimeout(tick, 100);
  log("main", "sonda ligada (pid " + process.pid + ")");
}

/**
 * Embrulha ipcMain.handle para cronometrar TODO handler de uma vez, inclusive
 * os que forem acrescentados depois. O corpo do handler continua rodando de
 * forma sincrona ate o primeiro await dele - o que preserva a garantia do
 * deck:attach (snapshot e inscricao sem nada no meio).
 */
function embrulharIpc(ipcMain) {
  if (!ligado) return;
  const original = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (canal, fn) =>
    original(canal, async (ev, arg) => {
      const t0 = process.hrtime.bigint();
      try {
        return await fn(ev, arg);
      } finally {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms >= 5) log("main", `${canal} = ${ms.toFixed(1)}ms`);
      }
    });
}

module.exports = { ligado, log, passo, iniciarSonda, embrulharIpc };
