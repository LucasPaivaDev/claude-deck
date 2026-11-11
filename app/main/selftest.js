"use strict";

/* Autoteste de ponta a ponta. Dirige a UI de verdade (clica nos botoes do
 * renderer), nao o IPC por baixo dela - a diferenca importa, porque a maioria
 * dos erros possiveis esta na ligacao entre os dois.
 *
 *   npx electron . --selftest "D:\caminho\do\projeto"
 *
 * Abre uma sessao Claude real na pasta dada, espera o titulo mudar, confere
 * que o xterm recebeu conteudo, testa o reattach (que e o que um reload da
 * janela faz) e encerra a sessao no fim. */

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** O que o xterm da janela esta realmente mostrando, lido do buffer. */
const telaDoRenderer = (js) =>
  js(`(() => {
    const t = window.__term;
    if (!t) return "";
    const b = t.buffer.active, out = [];
    for (let y = 0; y < t.rows; y++) {
      const l = b.getLine(b.baseY + y);
      if (l) out.push(l.translateToString(true));
    }
    return out.join(" ").replace(/\\s+/g, " ").trim();
  })()`);

async function run(win, manager, store, cwd, api) {
  const linhas = [];
  let falhas = 0;
  const ok = (cond, msg) => {
    linhas.push((cond ? "  OK    " : "  FALHA ") + msg);
    if (!cond) falhas++;
  };
  const js = (code) => win.webContents.executeJavaScript(code, true);

  try {
    linhas.push("== autoteste ==");
    linhas.push("  pasta: " + cwd);

    ok(await js("!!window.deck"), "ponte window.deck existe no renderer");
    ok(await js("!!window.Terminal"), "xterm carregou");

    // --- abrir sessao pela UI, como o usuario faria
    await js(`(() => {
      document.getElementById("newBtn").click();
      document.getElementById("newCwd").value = ${JSON.stringify(cwd)};
      document.getElementById("newGo").click();
      return true;
    })()`);

    // o claude leva alguns segundos ate emitir o primeiro titulo proprio
    let meta = null;
    for (let i = 0; i < 40; i++) {
      await espera(500);
      meta = manager.list()[0] || null;
      if (meta && meta.status !== "shell") break;
    }
    ok(!!meta, "sessao foi criada pelo formulario");
    if (!meta) throw new Error("sem sessao");

    ok(meta.status === "idle" || meta.status === "busy", `status veio do titulo: ${meta.status}`);
    ok(/^[0-9a-f-]{36}$/.test(meta.id), "id e um uuid (serve para --resume)");

    const msg = await js(`document.getElementById("newMsg").textContent`);
    ok(!/não|erro|Error/i.test(msg), "formulario nao reportou erro: " + JSON.stringify(msg));

    // --- o xterm da tela recebeu conteudo? Lido do buffer, nao do DOM: com o
    // renderer WebGL ativo o texto e desenhado em canvas e o .xterm-rows fica
    // vazio, entao conferir o DOM daria falso negativo.
    //
    // Com espera: o primeiro fit redimensiona o pty logo depois do spawn, e o
    // Claude limpa a tela para redesenhar - olhar nessa janela pega a tela em
    // branco. Nao e defeito, e so o instante errado.
    let vista = "";
    for (let i = 0; i < 20; i++) {
      vista = await telaDoRenderer(js);
      if (vista.length > 40) break;
      await espera(500);
    }
    ok(vista.length > 0, "xterm recebeu texto no buffer: " + JSON.stringify(vista.slice(0, 90)));
    ok(/Claude Code/.test(vista), "o conteudo e a tela do Claude, nao lixo");

    const cols = await js(`document.querySelector("#term .xterm") ? 1 : 0`);
    ok(cols === 1, "o xterm esta montado no palco");

    // --- regressao de layout.
    //
    // A mensagem do palco ("nenhuma sessao aberta" / "sessao encerrada") tem
    // `display: grid`, e regra de autor vence o `[hidden] { display: none }` da
    // folha do navegador. O `hidden` que o openSession setava nela era um no-op:
    // mensagem e terminal ficavam visiveis ao MESMO tempo e, como os dois sao
    // `flex: 1`, o terminal ficava com metade do palco - medido, 361px de 779px.
    // O `[hidden] { display: none !important }` do styles.css conserta; isto
    // aqui garante que ninguem reintroduza um `display` que volte a vence-lo.
    const layout = await js(`(() => {
      const st = document.getElementById("stage").getBoundingClientRect();
      const nd = document.getElementById("nothing");
      const tw = document.getElementById("termWrap");
      return {
        mensagemNaTela:
          getComputedStyle(nd).display !== "none" || nd.getBoundingClientRect().height > 0,
        fracao: st.height ? tw.getBoundingClientRect().height / st.height : 0,
      };
    })()`);
    ok(!layout.mensagemNaTela, "a mensagem do palco sumiu com a sessao aberta");
    ok(
      layout.fracao > 0.8,
      `o terminal ocupa o palco inteiro (${Math.round(layout.fracao * 100)}% da altura)`
    );

    // --- regressao do menu lateral congelado.
    //
    // O railHold barrava o paintRail INTEIRO enquanto o ponteiro estivesse
    // sobre o menu - e "+ sessão" e "abrir" ficam DENTRO dele, entao logo
    // depois de criar uma sessao o ponteiro esta sempre ali. A lista parava de
    // atualizar: sessao nova nao aparecia, a selecao nao movia e o "parado Xs"
    // congelava, ate o usuario tirar o mouse do menu. Um app que parece parado.
    // Agora o congelamento vale so para a ORDEM dos itens.
    for (let i = 0; i < 20; i++) {
      const m = manager.get(meta.id);
      if (m && m.status === "idle") break;
      await espera(500);
    }
    const idleAgora = (manager.get(meta.id) || {}).status === "idle";
    ok(idleAgora, "sessao esta parada para medir o contador do menu lateral");
    if (idleAgora) {
      const cont = await js(`(async () => {
        const rail = document.getElementById("rail");
        rail.dispatchEvent(new PointerEvent("pointerenter"));
        const ler = () => {
          const el = document.querySelector("#railList .rail-state");
          return el ? el.textContent : "<sem item>";
        };
        const antes = ler();
        await new Promise((r) => setTimeout(r, 2600));
        const depois = ler();
        rail.dispatchEvent(new PointerEvent("pointerleave"));
        return { antes, depois };
      })()`);
      ok(
        cont.antes !== cont.depois,
        `o menu lateral atualiza com o ponteiro sobre ele (${JSON.stringify(cont.antes)} -> ${JSON.stringify(cont.depois)})`
      );
    }

    // --- menu lateral e cabecalho
    const railN = await js(`document.querySelectorAll("#railList .rail-item").length`);
    ok(railN >= 1, `menu lateral tem ${railN} sessao(oes)`);
    const badge = await js(`document.getElementById("headBadge").textContent`);
    ok(["concluído", "trabalhando", "precisa de você", "iniciando…"].includes(badge), "badge de estado: " + badge);

    // --- o PTY acompanhou o tamanho da janela?
    ok(meta.cols > 20 && meta.rows > 5, `pty dimensionado pelo fit: ${meta.cols}x${meta.rows}`);

    // --- reattach: e exatamente o que um reload da janela faz
    const s = manager.get(meta.id);
    s.flush();
    const snap = s.snapshot();
    ok(snap.length > 200, `snapshot do espelho tem ${snap.length} chars`);
    ok(/\u001b\[/.test(snap), "snapshot preserva escapes de cor");

    const depois = await js(`(async () => {
      await window.deck.detach(${JSON.stringify(meta.id)});
      const r = await window.deck.attach(${JSON.stringify(meta.id)});
      return r.snapshot.length;
    })()`);
    ok(depois > 200, "reattach devolveu snapshot (" + depois + " chars)");

    // --- grupos
    const st = await js(`(async () => {
      const g = [{ id: "g1", name: "autoteste", color: (await window.deck.bootstrap()).state.palette[0], collapsed: false }];
      const s1 = await window.deck.saveGroups(g, {});
      const s2 = await window.deck.setMember(${JSON.stringify(meta.id)}, "g1");
      return { grupos: s2.groups.length, membro: s2.members[${JSON.stringify(meta.id)}] };
    })()`);
    ok(st.grupos === 1 && st.membro === "g1", "grupo criado e sessao movida para dentro dele");
    ok(store.state.members[meta.id] === "g1", "membro persistido no disco pelo main");

    // --- regressao: clique esquerdo no menu lateral.
    //
    // O destravamento do rail rodava paintRail() dentro do listener de
    // `pointerup`. O Chromium despacha pointerup ANTES de mouseup e de click,
    // no mesmo task, entao o `.rail-item` (ou o cabecalho de grupo) em que o
    // mousedown caiu ja estava fora do DOM quando o click seria emitido - e o
    // click nao era emitido. O menu inteiro parava de navegar, em todo clique
    // esquerdo; so o botao direito funcionava, porque `contextmenu` nao exige o
    // mesmo no nas duas pontas.
    //
    // Este teste PRECISA de input real (sendInputEvent). Um el.click() ou um
    // dispatchEvent(new MouseEvent("click")) miram o no direto e passam com o
    // bug presente - foi por isso que a leva anterior passou no autoteste.
    await espera(600);
    const alvo = await js(`(() => {
      const h = document.querySelector("#railList .group-head");
      if (!h) return null;
      const r = h.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    ok(!!alvo, "cabecalho de grupo esta no menu lateral para receber o clique");
    if (alvo) {
      const antesColapso = !!(store.state.groups[0] || {}).collapsed;
      const evento = (type, extra) =>
        win.webContents.sendInputEvent(Object.assign({ type, x: alvo.x, y: alvo.y }, extra));
      evento("mouseMove");
      await espera(120);
      evento("mouseDown", { button: "left", clickCount: 1 });
      await espera(60);
      evento("mouseUp", { button: "left", clickCount: 1 });
      await espera(700);
      const depoisColapso = !!(store.state.groups[0] || {}).collapsed;
      ok(
        depoisColapso !== antesColapso,
        `clique esquerdo de verdade no menu lateral chegou ao onclick (collapsed ${antesColapso} -> ${depoisColapso})`
      );
      // devolve o grupo ao estado anterior para nao mudar o que vem depois
      if (depoisColapso !== antesColapso) {
        evento("mouseDown", { button: "left", clickCount: 1 });
        await espera(60);
        evento("mouseUp", { button: "left", clickCount: 1 });
        await espera(700);
      }
      // tira o ponteiro do rail: parado sobre ele, o railHold congela a ordem
      win.webContents.sendInputEvent({ type: "mouseMove", x: 10, y: 10 });
      await espera(150);
    }

    // --- uma conversa de verdade antes de encerrar: o --resume precisa de
    // algo para retomar, e sessao vazia nao e o caso que importa testar
    await js(`window.deck.write(${JSON.stringify(meta.id)}, "responda apenas: OK")`);
    await espera(400);
    await js(`window.deck.write(${JSON.stringify(meta.id)}, "\\r")`);
    let trabalhou = false;
    for (let i = 0; i < 60; i++) {
      await espera(500);
      const m = manager.get(meta.id);
      if (!m) break;
      if (m.status === "busy") trabalhou = true;
      if (trabalhou && m.status === "idle") break;
    }
    ok(trabalhou, "o prompt enviado pelo app fez a sessao trabalhar");
    const depoisDoPrompt = manager.get(meta.id);
    ok(!!depoisDoPrompt && depoisDoPrompt.status === "idle", "e ela voltou para parado");

    // --- encerrar guardando o historico
    await js(`window.deck.kill(${JSON.stringify(meta.id)}, false)`);
    await espera(1500);
    ok(manager.sessions.size === 0, "sessao encerrada e removida do gerenciador");
    ok(
      store.state.sessions.some((x) => x.id === meta.id && x.closedAt),
      "sessao ficou no catalogo marcada como fechada"
    );
    ok(store.state.members[meta.id] === "g1", "o grupo sobrevive ao fechamento (volta no resume)");

    // --- retomar PELO BOTAO da interface.
    // Chamar window.deck.resume direto pularia o openSession do renderer: o
    // teste passaria enquanto a tela ficasse congelada no ultimo quadro de
    // antes de morrer. Foi exatamente o que aconteceu, e so apareceu porque
    // o espelho e a tela foram comparados lado a lado.
    const abriu = await js(`(() => {
      const it = document.querySelector('#railList .rail-item[data-id=${JSON.stringify(meta.id)}]');
      if (!it) return "sem linha no menu lateral";
      it.click();
      return "ok";
    })()`);
    ok(abriu === "ok", "a sessao encerrada aparece no menu lateral: " + abriu);
    await espera(600);
    const clicou = await js(`(() => {
      const b = document.getElementById("resumeBtn");
      if (!b) return "sem botao retomar";
      b.click();
      return "ok";
    })()`);
    ok(clicou === "ok", "o painel da sessao encerrada oferece o botao retomar: " + clicou);

    let r = { ok: false };
    for (let i = 0; i < 60; i++) {
      await espera(500);
      const m = manager.get(meta.id);
      if (m) { r = { ok: true, m: m.meta() }; break; }
    }
    ok(r.ok, "o botao retomar trouxe a sessao de volta");
    if (r.ok) {
      ok(r.m.id === meta.id, "retomou com o MESMO id (--resume <uuid>)");
      ok(r.m.cwd === meta.cwd.replace(/\//g, "\\") || r.m.cwd === meta.cwd, "mesma pasta");

      let vivo = null;
      for (let i = 0; i < 40; i++) {
        await espera(500);
        vivo = manager.get(meta.id);
        if (vivo && vivo.status !== "shell") break;
      }
      ok(!!vivo && vivo.status !== "shell", "sessao retomada chegou a um estado conhecido: " + (vivo && vivo.status));

      let texto = "";
      for (let i = 0; i < 20; i++) {
        texto = await telaDoRenderer(js);
        if (/responda apenas/.test(texto)) break;
        await espera(500);
      }
      ok(texto.length > 0, "a sessao retomada esta na tela");
      // o teste do resume: a CONVERSA anterior voltou, nao so um claude novo
      ok(/responda apenas/.test(texto), "a conversa anterior foi restaurada: " + JSON.stringify(texto.slice(0, 110)));
    }

    // ------------------------------------------------------------------
    // Teclado: com entrada de verdade (sendInputEvent + clipboard do
    // sistema), nao eventos sinteticos - o bug que isto pega mora
    // justamente no caminho nativo.
    // ------------------------------------------------------------------
    const { clipboard } = require("electron");
    const vivo = manager.get(meta.id);

    // 1) colar num CAMPO do formulario nao pode ir para o PTY
    const caminhoFalso = "D:\\pasta\\colada\\pelo\\teste";
    clipboard.writeText(caminhoFalso);
    await js(`(() => {
      document.getElementById("newBtn").click();
      const el = document.getElementById("newCwd");
      el.value = ""; el.focus(); el.select();
      return document.activeElement.id;
    })()`);
    win.webContents.paste();
    await espera(700);
    const noCampo = await js(`document.getElementById("newCwd").value`);
    ok(noCampo === caminhoFalso, "colar no campo do formulario cai no campo: " + JSON.stringify(noCampo));
    const telaAgora = await telaDoRenderer(js);
    ok(!telaAgora.includes("pasta\\colada"), "e NAO vazou para o PTY da sessao");
    await js(`document.getElementById("newCancel").click()`);

    // 2) colar multilinha no terminal nao pode enviar a primeira linha
    const diag = await js(`(() => {
      const d = window.__diag ? window.__diag() : {};
      return {
        current: d.current, anexado: d.anexado,
        temTerm: !!window.__term,
        brk: !!(window.__term && window.__term.modes && window.__term.modes.bracketedPasteMode),
        termWrapHidden: document.getElementById("termWrap").hidden,
      };
    })()`);
    ok(
      diag.temTerm && !diag.termWrapHidden && diag.anexado === meta.id,
      "o terminal esta visivel e ANEXADO antes do teste de teclado: " + JSON.stringify(diag)
    );

    clipboard.writeText("PASTEA111\r\nPASTEB222");
    await js(`(() => { window.__term.focus(); return true; })()`);
    await espera(300);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "V", modifiers: ["control"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "V", modifiers: ["control"] });
    await espera(1800);
    const colado = await telaDoRenderer(js);
    const vezesA = (colado.match(/PASTEA111/g) || []).length;
    ok(vezesA === 1, `o texto colado aparece uma vez so (apareceu ${vezesA}x)`);
    ok(/PASTEB222/.test(colado), "a segunda linha do paste tambem entrou");
    ok(vivo && vivo.status !== "busy", "o paste multilinha NAO enviou o prompt (status=" + (vivo && vivo.status) + ")");

    // 3) Shift+Enter quebra linha em vez de enviar
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: ["shift"] });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers: ["shift"] });
    await espera(400);
    await js(`window.deck.write(${JSON.stringify(meta.id)}, "SHIFTC333")`);
    await espera(900);
    const tri = await telaDoRenderer(js);
    ok(/SHIFTC333/.test(tri), "o texto depois do Shift+Enter entrou");
    ok(vivo && vivo.status !== "busy", "Shift+Enter nao enviou o prompt");

    // limpa a caixa (Esc duas vezes)
    await js(`window.deck.write(${JSON.stringify(meta.id)}, "\\x1b")`);
    await espera(400);
    await js(`window.deck.write(${JSON.stringify(meta.id)}, "\\x1b")`);
    await espera(600);

    // ------------------------------------------------------------------
    // Fechar a janela: o caminho que o app.exit do autoteste nunca tocava.
    // ------------------------------------------------------------------
    const vivasAntes = manager.sessions.size;
    ok(vivasAntes > 0, "ha sessao viva para o teste de fechamento");

    api.setConfirmClose(() => false); // usuario clica "Cancelar"
    win.close();
    await espera(1200);
    ok(!win.isDestroyed(), "cancelar o fechamento mantem a JANELA viva");
    ok(manager.sessions.size === vivasAntes, "e mantem as sessoes vivas");

    // --- esquecer: tira do catalogo e do grupo
    await js(`window.deck.kill(${JSON.stringify(meta.id)}, true)`);
    await espera(1200);
    ok(!store.state.sessions.some((x) => x.id === meta.id), "esquecer tira a sessao do catalogo");
    ok(store.state.members[meta.id] === undefined, "e tira o membro do grupo junto");
    await js(`window.deck.saveGroups([], {})`);

    // --- e agora aceitar o fechamento: janela fecha e sessoes morrem
    const extra = manager.spawn({ cwd, cols: 100, rows: 28 });
    for (let i = 0; i < 40 && extra.status === "shell"; i++) await espera(500);
    ok(manager.sessions.size === 1, "sessao extra aberta para o teste de aceitar o fechamento");

    api.setConfirmClose(() => true); // usuario clica "Fechar mesmo assim"
    win.close();
    await espera(1500);
    ok(manager.sessions.size === 0, "aceitar o fechamento encerra as sessoes");
    store.closeSession(extra.id, { forget: true });
  } catch (e) {
    linhas.push("  EXCECAO " + (e && e.message));
    falhas++;
  }

  linhas.push(falhas ? `\n${falhas} FALHA(S)` : "\nAUTOTESTE: TUDO OK");
  console.log("\n" + linhas.join("\n") + "\n");
  return falhas;
}

module.exports = { run };
