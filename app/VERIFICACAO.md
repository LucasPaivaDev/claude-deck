# Verificação — app desktop

O que foi medido, como, e o que **não** foi. Mesma convenção do
[VERIFICACAO.md](../VERIFICACAO.md) da versão web: afirmação sem medição aqui
não vale.

Última execução completa: **03/11/2026**, Windows 10 Pro 19045, Node 24.21.0,
Electron 45.2.1, node-pty 1.1.0, xterm 6.0.0, Claude Code 2.1.317.

## Como reproduzir

    node main/_smoke.js                               # lógica pura
    node main/_smoke.js --live "D:\alguma\pasta"      # + sessão real
    npx electron . --selftest "D:\alguma\pasta"       # ponta a ponta, pela UI

O `--selftest` dirige a UI de verdade — ele clica nos botões do renderer via
`executeJavaScript`, não chama o IPC por baixo. A diferença importa: a maior
parte dos erros possíveis mora na ligação entre os dois.

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
| `AttachConsole failed` no console | observado em todo `kill` | **ruído**, não impede o kill |

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

- **O diálogo de confirmação em si.** O caminho de fechar foi testado com a
  função de confirmação **substituída**; a caixa real do `dialog` nunca foi
  vista por olhos humanos.
- **`Ctrl+C`, `Shift+Tab` e `Esc Esc`.** O `Ctrl+C` tem os dois ramos
  implementados (copia com seleção, interrompe sem) e **nenhum** foi medido.
  `Shift+Tab` (alternar auto mode) e `Esc Esc` também não.
- **Reload da janela (`Ctrl+R` foi removido, mas o reload programático existe).**
  O caminho de reattach foi testado por `detach`+`attach` e pelo auto-reparo;
  um reload de verdade do renderer, não.
- **Segunda instância.** O `requestSingleInstanceLock` está ligado mas não foi
  exercitado abrindo o app duas vezes.
- **Várias sessões ao mesmo tempo.** Tudo foi medido com uma só. Trocar entre
  sessões, a ordenação do menu lateral sob carga e o custo de N espelhos
  headless são desconhecidos.
- **Sessões longas.** O scrollback está em 5000 linhas no espelho e no
  renderer; nada foi medido sobre memória numa sessão de horas.
- **O arraste entre grupos.** A lógica de `railHold` foi corrigida para que o
  drop não fique congelado, mas o gesto não foi testado com o mouse.
- **Links clicáveis no terminal.** `shell.openExternal` está ligado, mas o xterm
  não tem addon de link carregado — então provavelmente **não há** link
  clicável ainda.
- **Qualquer plataforma que não seja Windows 10.**
- **Desempenho do WebGL com a janela grande.** Apareceu um aviso
  `task queue exceeded allotted deadline by 55ms` durante o autoteste; não foi
  investigado.

## Armadilhas de teste

Registradas porque custaram tempo:

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
