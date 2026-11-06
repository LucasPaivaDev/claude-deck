# Verificação — app desktop

O que foi medido, como, e o que **não** foi. Mesma convenção do
[VERIFICACAO.md](../VERIFICACAO.md) da versão web: afirmação sem medição aqui
não vale.

Última execução completa: **06/11/2026**, Windows 10 Pro 19045, Node 24.21.0,
Electron 45.2.1, node-pty 1.1.0, xterm 6.0.0, Claude Code 2.1.319.
Autoteste: **49/49 OK**, inclusive com `DECK_DIAG=1`.

## Como reproduzir

    node main/_smoke.js                               # lógica pura
    node main/_smoke.js --live "D:\alguma\pasta"      # + sessão real
    npx electron . --selftest "D:\alguma\pasta"       # ponta a ponta, pela UI

O `--selftest` dirige a UI de verdade — ele clica nos botões do renderer via
`executeJavaScript`, não chama o IPC por baixo. A diferença importa: a maior
parte dos erros possíveis mora na ligação entre os dois.

**Feche o app antes**, ou passe `--user-data-dir` — veja a primeira armadilha
no fim deste documento. Com uma instância já aberta o autoteste sai com
**código 0 sem rodar asserção nenhuma**, e isso já foi lido como sucesso uma vez.

Para medir travamento, com a janela em primeiro plano:

    $env:DECK_DIAG="1"; $env:DECK_DIAG_LOG="$env:TEMP\deck-diag.log"
    npx electron . --disable-background-timer-throttling `
      --disable-renderer-backgrounding --disable-backgrounding-occluded-windows

## Verificado

### Ambiente e build

| o quê | como | resultado |
|---|---|---|
| node-pty roda sob o ABI do Electron | `pty.spawn` dentro do `app.whenReady` do Electron 45 | **sim**, sem rebuild — binário Node-API |
| `@electron/rebuild` | `npx electron-rebuild -f -w node-pty` | **falha** (submódulos do winpty ausentes no tarball) — e é dispensável |
| ConPTY entrega escapes | captura crua do `onData` | **sim**: cor truecolor, box-drawing, synchronized output |
| versões do xterm batem | `npm view … time` | todas publicadas no mesmo release train (2025‑12‑22) |

### Sessão

| o quê | como | resultado |
|---|---|---|
| `claude.exe` spawna direto, sem shell | `resolveClaude()` + `pty.spawn` | **sim**, `D:\…\.local\bin\claude.exe` |
| título chega como OSC | regex `\x1b]0;` sobre o stream | **sim**, com as transições `claude` → `✳` → `◐`/`◑` → `✳ <assunto>` |
| status sai do título | `classify()` no `onTitleChange` | **sim**, chega a `idle` sozinho |
| o TUI renderiza certo | buffer do xterm após boot | **sim**: banner, molduras e glyphs corretos |
| prompt enviado pelo app funciona | `deck.write` + `\r`, espera busy→idle | **sim** |
| resize chega ao PTY e ao espelho | `s.resize(100,30)` | **sim**, em lockstep |
| PTY nasce no tamanho da janela | `proposeDimensions()` no spawn | **sim**, 156×21 medido |
| `serialize()` preserva cor | regex sobre o snapshot | **sim**, ~1500–2500 chars |
| reattach devolve snapshot | `detach` + `attach` pela ponte | **sim** |

### Resume

| o quê | como | resultado |
|---|---|---|
| `--session-id` + `--resume` em print mode | `claude --session-id <uuid> -p` e depois `--resume` | **sim** |
| transcript é escrito em modo interativo | procura do `<uuid>.jsonl` enquanto a sessão vive | **não**, antes da correção do ambiente — ver abaixo |
| idem, com `envLimpo()` | mesma checagem | **sim** |
| retoma com o mesmo id e a mesma pasta | `deck.resume` | **sim** |
| a conversa anterior volta na tela | busca do texto do prompt antigo no buffer | **sim** |
| grupo sobrevive ao fechar e retomar | estado em disco | **sim** |

O caso que quebrava: sessões abertas **de dentro de outra sessão Claude**
herdavam `CLAUDE_CODE_CHILD_SESSION` e não salvavam transcript, então não havia
o que retomar. A statusline dizia (e foi assim que apareceu):

    ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker

Corrigido por `envLimpo()`; detalhes em
[ARQUITETURA.md](ARQUITETURA.md#o-marcador-de-sessão-filha--o-bug-que-quebrava-o-resume).

### Teclado e área de transferência

Testados com entrada **real** (`clipboard.writeText` do sistema +
`webContents.sendInputEvent`/`paste()`), não com eventos sintéticos — o que
quebra aqui mora justamente no caminho nativo.

| o quê | como | resultado |
|---|---|---|
| colar num campo do formulário | `webContents.paste()` com `newCwd` focado | cai **no campo**, e **não** vaza para o PTY |
| colar multilinha no terminal | `Ctrl+V` por `sendInputEvent`, texto com `\r\n` | entra **1×**, as duas linhas, **sem enviar** |
| `Shift+Enter` | `sendInputEvent` | quebra linha, **não envia** |
| o Claude liga bracketed paste | `term.modes` do espelho | **sim** (`bracketedPasteMode: true`) |

A sequência de quebra de linha foi **medida, não lembrada**. Cinco candidatas
contra o TUI real:

| candidata | resultado |
|---|---|
| `\x1b\r` | engoliu a primeira linha |
| `\x1b[13;2u` (kitty) | ignorado — as duas linhas numa só |
| `\x1b[27;2;13~` | ignorado — idem |
| `\\` + `\r` | quebrou linha ✓ (mas deixa a barra na tela) |
| `\n` | **quebrou linha ✓** |

E, para colar, quatro combinações:

| combinação | resultado |
|---|---|
| marcadores de paste + `\r` dentro | **ENVIOU** o prompt |
| cru + `\n` | quebrou linha, não enviou |
| **marcadores de paste + `\n` dentro** | **quebrou linha, não enviou ✓** — é o que o app usa |
| `/` inicial dentro de marcadores | ainda abre o seletor de comandos |

A conclusão que importa: **bracketed paste sozinho não protege** — o Claude
trata o `\r` de dentro dos marcadores como "enviar". E `term.paste()` do xterm
**não serve**, porque normaliza `\n` para `\r` e cai justamente nesse caso.

### Fechar a janela

| o quê | como | resultado |
|---|---|---|
| cancelar o fechamento | `confirmClose` forçado a `false` + `win.close()` | a **janela continua viva** e as sessões também |
| aceitar o fechamento | `confirmClose` forçado a `true` + `win.close()` | as sessões são encerradas |

Antes da correção a confirmação estava no `before-quit`, e cancelar deixava o
app **vivo sem janela nenhuma** — invisível, com as sessões rodando. Detalhes
em [ARQUITETURA.md](ARQUITETURA.md#a-confirmação-de-fechamento-estava-no-lugar-errado).

### Processos

| o quê | como | resultado |
|---|---|---|
| `kill()` não deixa órfão | contagem de `claude.exe` antes/depois do autoteste | **14 → 14** |
| nem com filho aninhado | shell com filho de longa duração, `kill` no pai | ambos morrem |
| o app não deixa Electron pendurado | contagem após `app.exit` | **0** |
| `AttachConsole failed` no console | observado em todo `kill` | **ruído** quanto a órfãos, mas **custava ~1 s** — ver abaixo |
| nenhum órfão com `useConptyDll` | `Win32_Process` com `ParentProcessId`, após 4 rodadas de autoteste | **sim**: zero `claude.exe --session-id`, `node.exe` ou `OpenConsole.exe` sobrando |

### Custo de tempo no processo main

Medido com `DECK_DIAG=1`, sonda de atraso do event loop + cronômetro por passo.
O main é quem bombeia as mensagens da janela: tudo aqui é tempo de janela parada.

| passo | antes | depois | o que mudou |
|---|---|---|---|
| `pty.kill()` | **835-1049 ms** por sessão | ~0 ms | `useConptyDll` |
| `deck:kill` (handler inteiro) | 835-1052 ms | **2-4 ms** | idem |
| `manager.spawn` (ConPTY) | 49-73 ms | igual | — |
| `deck:spawn` (handler inteiro) | 52-122 ms | igual | — |
| `rememberSession` (`writeFileSync`+`rename`) | 1-49 ms | igual | não mexido de propósito |

Três sessões abertas significavam **2,76 s de janela congelada** ao fechar o
app. `pty.spawn("cmd /c exit")` custa o mesmo que `claude.exe` (84-91 ms): o
custo é criar o ConPTY, não subir o Claude, e **não escala** com o número de
sessões vivas.

### Largura de célula e resíduo no terminal

| o quê | como | resultado |
|---|---|---|
| ConPTY do SO vs. da dll vs. xterm vs. Bun | sequências reais por ConPTY, `OutputEncoding` em UTF-8 | ⚡ ⏳ ✅ valem **1** no ConPTY do SO e **2** nos outros três |
| ✳ ◐ ❯ e Nerd Font divergem? | idem | **não**, 1 célula em todas as tabelas |
| o resíduo é anterior ao xterm | apagar a coluna 12 com o modelo ⚡=2 | ConPTY do SO **não apaga nada**, só acrescenta espaço — resíduo igual em v6 e v11 |
| `useConptyDll` sob **Electron** | sonda no processo main | `onData`, `resize` e `kill → onExit` **ok**; `OpenConsole.exe` do pacote confirmado em uso |
| `addon-unicode11` sob `@xterm/headless` | `t.unicode.versions` | **sim**: `["6","11"]`, e ⚡ passa a medir 2 células no espelho |
| redimensionar antes de escrever o snapshot ajuda? | espelho 120×34 vs. view 80×24 | **não** — lixo idêntico com e sem; e o `await` extra piorava a corrida do resume |

### Layout do palco

| o quê | como | resultado |
|---|---|---|
| `hidden` esconde a mensagem do palco | `getComputedStyle` numa janela 1400×900 | antes **não** (`display: grid` vencia); depois **sim** |
| o terminal ocupa o palco | mesma sonda | **361px → 722px** de 779px (46% → 93%) |
| a regra `[hidden]` é mesmo a causa | removida do CSSOM em runtime, remedido | bug **reaparece** exatamente (361/361) |
| o PTY nasce maior | autoteste | **156×43**, antes ~156×21 |
| mensagem some com sessão aberta | asserção do autoteste | **sim** |

### Menu lateral sob o ponteiro

| o quê | como | resultado |
|---|---|---|
| contador avança com o ponteiro no rail | `pointerenter` + 2,6 s, asserção do autoteste | **sim**: `"parado 0s"` → `"parado 1s"` |
| sessão nova aparece com o ponteiro no rail | UI dirigida por CDP | antes **não**; depois **sim** |
| seleção acompanha | idem | antes **não** (`.on` vazio); depois **sim** |

### Estado e UI

| o quê | como | resultado |
|---|---|---|
| normalização rejeita lixo | `normalizeState` com id ruim, grupo órfão, chave antiga de pane-id | **sim** |
| grupo criado e sessão movida | pela UI, via ponte | **sim**, e persistido em disco pelo main |
| *esquecer* tira sessão e membro juntos | estado após `kill(id, true)` | **sim** |
| ponte e addons carregam no renderer | log de boot | xterm, fit, webgl, unicode11, ponte — todos ok |
| diálogo real é detectado | `MENU_RE` contra a tela capturada do *"Teach auto mode about your environment?"* | **sim** |
| buffer alternativo | `buffer.active.type` em 5 momentos de uma sessão real | **normal** sempre — o TUI não usa alt buffer |

## Não verificado

Coisas que o app faz ou assume e que **ninguém mediu**. Tratar como suspeitas,
não como funcionando.

- **Se o resíduo de letras sumiu de fato.** A causa raiz está medida e o
  autoteste prova que a correção **não regrediu nada** — não que o sintoma
  acabou. Reproduzir exige um humano digitando: linha com emoji (⚡ ⏳ ✅)
  seguida de texto, backspace até o meio. **Falsificador:** se o resíduo
  aparecer numa linha só com texto simples e acentos, sem emoji, a teoria de
  largura de célula está errada.
- **Que o TUI do Claude use o modelo ⚡=2.** Inferido do `Bun.stringWidth`
  encontrado no binário, não observado nos bytes de uma sessão real.
- **A janela congelando por 5+ s ao criar sessão.** Relatada pelo usuário,
  **não reproduzida**: o maior número medido no caminho de criar é 122 ms, e o
  Windows precisa de ~5 s para marcar "Não está respondendo". Pendente de rodar
  com `DECK_DIAG=1` no ambiente real — ver
  [ARQUITETURA.md](ARQUITETURA.md#a-decisão-que-está-esperando-um-número).
- **`useConptyDll` com sessão Claude que tenha subprocessos.** O caminho de kill
  foi medido com `cmd`+`ping` e, indiretamente, por ausência de órfãos depois do
  autoteste. Uma sessão com shells da tool Bash ou MCP servers stdio abertos
  **não** foi testada de propósito. Escape: `CLAUDE_DECK_CONPTY=windows`.
- **`onContextLoss` do WebGL.** O handler existe e é o padrão recomendado, mas
  perda de contexto de GPU não é forçável de forma confiável em teste. Para
  simular à mão no DevTools:
  `window.__term._core._renderService._renderer.value._gl.getExtension('WEBGL_lose_context').loseContext()`.

- **O diálogo de confirmação em si.** O caminho de fechar foi testado com a
  função de confirmação **substituída**; a caixa real do `dialog` nunca foi
  vista por olhos humanos.
- **`Ctrl+C`, `Shift+Tab` e `Esc Esc`.** O `Ctrl+C` tem os dois ramos
  implementados (copia com seleção, interrompe sem) e **nenhum** foi medido.
  `Shift+Tab` (alternar auto mode) e `Esc Esc` também não.
- **Reload da janela (`Ctrl+R` foi removido, mas o reload programático existe).**
  O caminho de reattach foi testado por `detach`+`attach` e pelo auto-reparo;
  um reload de verdade do renderer, não.
- **Segunda instância.** O `requestSingleInstanceLock` foi exercitado **sem
  querer** (ver armadilhas) e funciona: a segunda instância sai calada. O
  caminho de *focar a janela existente* é que continua sem teste.
- **Várias sessões ao mesmo tempo.** O autoteste ainda usa uma só. Medições
  avulsas com 2 e 3 sessões mostraram que o custo do spawn **não escala**, mas
  trocar entre sessões sob carga, a ordenação do menu lateral e o custo de N
  espelhos headless continuam desconhecidos.
- **Sessões longas.** O scrollback está em 5000 linhas no espelho e no
  renderer; nada foi medido sobre memória numa sessão de horas.
- **O arraste entre grupos.** O `railHold` foi reescrito de novo (agora congela
  só a ordem, e quem guarda o clique é o `railPressed`, solto por `pointerup`,
  `pointercancel`, `dragend` e `blur`). O caminho do `pointercancel` existe
  justamente porque um arraste HTML5 nunca manda `pointerup` — mas **o gesto
  com o mouse continua sem teste**.
- **Links clicáveis no terminal.** `shell.openExternal` está ligado, mas o xterm
  não tem addon de link carregado — então provavelmente **não há** link
  clicável ainda.
- **Qualquer plataforma que não seja Windows 10.**
- **Desempenho do WebGL com a janela grande.** Apareceu um aviso
  `task queue exceeded allotted deadline by 55ms` durante o autoteste; não foi
  investigado.

## Armadilhas de teste

Registradas porque custaram tempo:

- **Instância aberta faz o autoteste mentir.** Com um claude-deck já rodando, o
  `requestSingleInstanceLock` mata a instância de teste na largada: ela sai com
  **código 0 e nenhuma asserção**, e o log traz só `Unable to move the cache:
  Acesso negado`. Isso já foi lido como "tudo passou". Feche o app antes, ou
  passe `--user-data-dir` — que isola o lock **e** o `deck-state.json`.
- **`--user-data-dir` esconde o que você quer medir.** Ele é certo para testar e
  **errado para diagnosticar**: troca o `%APPDATA%` real e o catálogo real por
  um vazio, que são justamente as variáveis onde antivírus e perfil de rede
  pesam. Para medir travamento, rodar sem ele.
- **O stdout do main não chega ao shell.** `electron.exe` é binário de
  subsistema GUI no Windows: redirecionar a saída devolve arquivo vazio. Por
  isso o `diag.js` grava em `DECK_DIAG_LOG`.
- **Janela em segundo plano inventa travamento.** O Chromium estrangula timers e
  a sonda do renderer acusa ~900 ms de atraso por segundo sem haver bloqueio
  nenhum. Medir com a janela na frente e com
  `--disable-background-timer-throttling` e companhia.
- **`webContents.on("unresponsive")` não é a métrica.** Ele vigia o renderer e
  demora dezenas de segundos; a ausência dele **não** prova que a janela não
  congelou. A métrica é o atraso do event loop do main.
- **Medir largura de glyph no PowerShell sem UTF-8 dá lixo.** Sem forçar
  `[Console]::OutputEncoding`, os emoji viram `?` e a medição não vale nada —
  uma primeira rodada caiu nisso.
- **Pipe segura o processo.** `node script.js | tail` não retorna no tempo
  esperado quando o script usa node-pty; redirecionar para arquivo
  (`> saida.txt`) funciona. Isso é artefato do ambiente de teste, não do código.
- **Ler `.xterm-rows` dá falso negativo** com o renderer WebGL ativo: o texto
  vai para canvas. Conferir pelo `term.buffer`.
- **Olhar a tela logo após o spawn** pode pegar o instante do redesenho e
  encontrar branco. O autoteste espera o conteúdo aparecer em vez de olhar uma
  vez só.
- **`claude --resume` de uma conversa vazia** falha legitimamente com *"No
  conversation found"*. Testar resume exige ter conversado antes.
