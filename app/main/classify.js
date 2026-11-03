"use strict";

// Classificacao de estado de sessao.
//
// Portado do server.js da versao WezTerm, com uma diferenca de fundo: la o
// titulo vinha de `wezterm cli list` a cada 1,5s; aqui ele vem do evento
// onTitleChange do espelho headless, no instante em que o Claude emite o
// OSC. A regra de classificacao em si nao mudou - ela ja estava certa.

const IDLE_GLYPHS = new Set(["✳"]); // U+2733 = ✳

/**
 * O Claude Code escreve o proprio estado no titulo, com um glyph na frente do
 * assunto da conversa. Medido em ConPTY: "claude" -> "✳ Claude Code" ->
 * "◐ Claude Code" -> "◑ Resposta simples OK" -> "✳ Resposta simples OK".
 *
 * A regra e "qualquer glyph que nao seja ✳", e nao uma lista fechada de frames
 * do spinner: uma lista incompleta faria uma sessao trabalhando aparecer como
 * parada, que e o erro caro.
 */
function classify(title) {
  const t = String(title == null ? "" : title).trim();
  const glyph = [...t][0] || "";
  if (IDLE_GLYPHS.has(glyph)) {
    return { status: "idle", glyph, label: t.slice(glyph.length).trim() };
  }
  if (glyph && glyph.codePointAt(0) > 0x2000) {
    return { status: "busy", glyph, label: t.slice(glyph.length).trim() };
  }
  return { status: "shell", glyph: "", label: t };
}

// Quando o Claude abre um dialogo ele ja deixa uma opcao pre-selecionada e o
// Enter confirma ELA - texto enviado as cegas seria engolido e o default
// aprovado. "^\s+❯" = opcao de menu (indentada); o ❯ da caixa de input fica na
// coluna 0, e e esse o discriminador que evita falso positivo.
//
// Confirmado no spike em ConPTY contra o dialogo real "Teach auto mode about
// your environment?", que traz "❯ 1. Yes" e "Enter to confirm · Esc to cancel".
const MENU_RE = /(Enter to confirm|Esc to cancel|❯\s*\d+\.\s|^\s+❯\s)/;

function trimBlank(lines) {
  const out = lines.slice();
  while (out.length && !out[out.length - 1]) out.pop();
  while (out.length && !out[0]) out.shift();
  return out;
}

function detectMenu(lines) {
  // aparar o branco do fim antes do slice: um pane com poucas linhas tem o
  // viewport preenchido de vazio, e a janela de 15 pegaria so branco
  return trimBlank(lines).slice(-15).some((l) => MENU_RE.test(l));
}

// O rodape de uma sessao Claude e so moldura: caixa do prompt, statusline e
// footer. Usado so nos previews da grade - na tela cheia o xterm mostra tudo.
function stripChrome(lines) {
  for (let i = Math.max(0, lines.length - 14); i < lines.length; i++) {
    if (/^[─━]{10,}/.test(lines[i])) return lines.slice(0, i);
  }
  return lines;
}

module.exports = { classify, detectMenu, trimBlank, stripChrome, MENU_RE, IDLE_GLYPHS };
