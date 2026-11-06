# Arquitetura — app desktop

Como o app funciona por dentro, e por que cada decisão foi tomada assim.
Para instalar e usar, veja o [README](README.md).

## Visão geral

Três processos, como em qualquer Electron, com uma regra que organiza tudo:
**o main é dono das sessões; o renderer é só uma view.**

    ┌─ main ─────────────────────────────────────────────┐
    │  SessionManager                                    │
    │    Session ─── node-pty ──▶ claude.exe (ConPTY)    │
    │        └───── @xterm/headless  (o ESPELHO)         │
    │                 ├ título  → classify() → status    │
    │                 ├ buffer  → MENU_RE   → diálogo?   │
    │                 └ serialize()         → snapshot   │
    │  Store (grupos + catálogo de sessões, em disco)    │
    └──────────────────┬─────────────────────────────────┘
                       │ IPC (contextBridge, sem ipcRenderer cru)
    ┌─ renderer ───────┴─────────────────────────────────┐
    │  menu lateral  +  xterm.js (view da sessão aberta) │
    └────────────────────────────────────────────────────┘

### Por que um espelho headless no main

Cada sessão tem **dois** terminais xterm: um headless no main e, quando está na
tela, um visível no renderer. Parece redundante e não é — o espelho resolve
quatro coisas de uma vez:

- **Status de quem não está na tela.** O menu lateral mostra o estado de todas
  as sessões. Sem o espelho, só a sessão aberta teria estado.
- **Reload da janela não perde nada.** O scrollback mora no main. Recarregar o
  renderer é pedir o snapshot de novo.
- **A guarda de menu lê um buffer de verdade**, não uma heurística sobre texto
  cru — `MENU_RE` roda contra as linhas que o terminal realmente renderizou.
- **A grade (quando vier) não precisa de N terminais vivos.** O Chromium limita
  os contextos WebGL por página a cerca de 16; previews saem do buffer do
  espelho, não de xterms de verdade.

### O protocolo de attach

Anexar uma view a uma sessão tem uma corrida óbvia: entre tirar o snapshot e
começar a receber o stream, bytes podem cair. E o inverso também: bytes já
absorvidos pelo espelho podem ser reentregues e aparecer duas vezes.

O handler do `deck:attach` resolve os dois, e por isso é **síncrono do começo
ao fim** (nenhum `await` no meio):

```js
s.flush();                  // 1. esvazia a fila: o espelho JÁ tem esses bytes
const snapshot = s.snapshot();  // 2. retrato completo
attached.add(id);           // 3. a partir daqui o stream vai para a tela
```

Como o main é single-threaded, nada roda entre os três passos. E a ordem de
mensagens do main para o renderer é preservada pelo Electron, então a resposta
do `invoke` chega antes de qualquer `deck:data` posterior. Do lado do renderer
há ainda uma fila (`queued`) para o caso de o usuário trocar de sessão durante
o `await`.

O passo 1 só está correto porque o `_pending` **só recebe o chunk depois de o
espelho tê-lo parseado** — ver [O write do xterm não é
imediato](#o-write-do-xterm-não-é-imediato). O comentário do código afirmava o
contrário, e era por esse buraco que bytes sumiam.

### Coalescência da saída

O TUI do Claude emite em rajada — frames de *synchronized output*, dezenas por
segundo durante uma resposta. Cada chunk como uma mensagem de IPC própria
inundaria o renderer sem ganho visual nenhum. A fila é esvaziada a cada 16 ms,
o que junta a rajada num quadro só.

A detecção de menu tem um debounce maior (180 ms): varrer 15 linhas a cada
chunk durante o streaming é desperdício, e o que interessa é o estado quando a
tela **para** de mudar.

## Detecção de status

Vem do título, como na versão WezTerm — mas agora por evento, não por polling.
O Claude Code emite `OSC 0`/`OSC 2` e o espelho dispara `onTitleChange` no
instante em que isso chega. Medido em ConPTY, a sequência de uma sessão real:

    0.4s  "D:\...\claude.exe"     (o ConPTY põe o caminho do exe)
    0.9s  "claude"
    2.1s  "✳ Claude Code"         ← idle
   13.1s  "◐ Claude Code"         ← busy, prompt enviado
   14.7s  "◑ Resposta simples OK" ← o título carrega o assunto da conversa
   14.9s  "✳ Resposta simples OK" ← idle de novo

A regra de classificação é a mesma de antes e pelo mesmo motivo: `✳` é idle,
**qualquer outro** glyph acima de `U+2000` é busy. Não é uma lista fechada de
frames do spinner — uma lista incompleta faria uma sessão trabalhando aparecer
como parada, que é o erro caro.

## Decisões e descobertas

Coisas que custaram teste para descobrir, registradas para não serem
redescobertas.

### O marcador de sessão filha — o bug que quebrava o resume

Este é o mais importante do documento.

As sessões nasciam sem transcript. O `--resume` respondia *"No conversation
found with session ID"*, mesmo com a conversa tendo acontecido na tela. O
`--session-id` não estava sendo ignorado — testado isolado em print mode, ele
funciona e o `--resume` depois também.

A causa apareceu numa linha da statusline da sessão filha:

    ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker

O Claude Code injeta um punhado de variáveis nos processos que ele abre, para
marcar "você é uma sessão filha" — e sessão filha não salva transcript. O app
passava `process.env` inteiro para o `pty.spawn`. Aberto de dentro de uma sessão
Claude (o que, para **este** app, é até provável), ele herdava o marcador e o
repassava para todas as sessões que criava. Sem transcript não há o que retomar.

A correção é o `envLimpo()` em `main/sessions.js`: as sessões criadas aqui são
de topo, não filhas de nada, então estes caem —

    CLAUDECODE                     CLAUDE_CODE_MESSAGING_SOCKET
    CLAUDE_CODE_CHILD_SESSION      CLAUDE_CODE_MESSAGING_TOKEN
    CLAUDE_CODE_ENTRYPOINT         CLAUDE_CODE_SESSION_ATTENDED
    CLAUDE_CODE_EXECPATH           CLAUDE_CODE_SESSION_ID
    CLAUDE_PID

— enquanto `CLAUDE_EFFORT` e `ANTHROPIC_*` ficam: são preferência e credencial
do usuário, não marca de sessão.

A lição mais geral: **herdar o ambiente inteiro num app que spawna processos é
uma decisão, não um default inócuo.**

### A confirmação de fechamento estava no lugar errado

A confirmação "você tem N sessões abertas" nasceu no `before-quit`, que é o
lugar intuitivo e é o **errado**. Ao clicar no X a ordem é:

    win fecha → janela destruida → window-all-closed → app.quit() → before-quit

Quando o diálogo aparecia, a janela já não existia. Cancelar deixava o app
**vivo com zero janelas** — invisível, sem `activate` para trazer de volta no
Windows, e com todas as sessões ainda rodando em auto mode. Era exatamente o
órfão que a confirmação existe para evitar.

Agora ela está no `win.on("close")`, onde o `preventDefault()` cancela o
fechamento da janela de verdade. O `before-quit` virou rede de segurança para
os caminhos que não passam pelo X (logoff, `app.quit()` de outro lugar).

Junto veio o `requestSingleInstanceLock()`: duas instâncias compartilhariam o
mesmo `deck-state.json`, a segunda mostraria as sessões **vivas** da primeira
como "encerrada", e o botão retomar rodaria `--resume` num id que ainda está
rodando do outro lado.

### Colar: nem texto cru, nem `term.paste()`

Três bugs no mesmo lugar, e os três só apareceram com entrada de verdade.

O primeiro era grosseiro: havia um listener de `paste` no `document`. Colar uma
pasta no campo do **+ sessão** mandava o caminho para o PTY da sessão aberta e
deixava o campo vazio. O textarea do xterm já trata o paste sozinho; o listener
foi removido, e o de `copy` passou a escutar no `#term` — no `document`, uma
seleção velha do terminal sequestrava o `Ctrl+C` dos campos.

Os outros dois exigiram medição. O Claude **liga** bracketed paste
(`bracketedPasteMode: true`), então a suposição natural — "os marcadores
protegem o multilinha" — parecia segura. Não é:

| combinação | resultado |
|---|---|
| marcadores + `\r` dentro | **enviou o prompt** |
| cru + `\n` | quebrou linha, não enviou |
| **marcadores + `\n` dentro** | **quebrou linha, não enviou** ✓ |

O Claude trata o `\r` de dentro dos marcadores como "enviar". E texto do
clipboard do Windows vem cheio de `\r\n` — era por isso que um paste de várias
linhas submetia a primeira como prompt.

`term.paste()` do xterm também não serve, e pelo motivo oposto ao esperado: ele
normaliza `\n` para `\r`, que é a convenção de terminal, e cai no primeiro caso.

A implementação final converte as quebras para `\n` e põe os marcadores só se o
modo estiver ligado. Pelo mesmo caminho, `Shift+Enter` manda `\n`.

O clipboard é lido pelo módulo `clipboard` do Electron, não por
`navigator.clipboard`: num renderer sandboxed servido de `file://`, a API web
depende de permissão e de foco e falha calada.

### Tela congelada: `current` sem `anexado`

O renderer guardava só `current` — qual sessão está na tela. O main guarda
`attached` — de quais sessões ele empurra bytes. Quando uma sessão morre, o
main esquece a inscrição; se ela voltar por um resume que não passe pelo
`openSession`, o renderer continua com `current` apontando para ela e a tela
**congelada no último quadro de antes**. Sem erro nenhum, que é o pior tipo.

Apareceu comparando o espelho e a tela lado a lado num teste: o espelho mostrava
`ctrl+g to edit in Notepad.exe` (conteúdo multilinha recém-colado) e a tela
mostrava `0k/1000k · R$0,00`, de uma sessão anterior.

O renderer passou a guardar `anexado` além de `current`, e a cada atualização
de sessões ele compara os dois: divergiu, reanexa sozinho. O teste também
mudou — passou a clicar no **botão retomar** da interface em vez de chamar a
ponte direto, porque era justamente o atalho do teste que escondia o problema.

### O atributo `hidden` perdia para o CSS

O renderer esconde painel, cabeçalho e rodapé com `elemento.hidden = true`. Só
que `[hidden] { display: none }` mora na folha do **navegador**, e qualquer
regra de **autor** com `display` vence, independente de especificidade. Como
`.nothing` era `display: grid` e `.head`/`.bar` eram `display: flex`, os três
`hidden` do código eram **no-op**.

O efeito visível: a mensagem de "sessão encerrada" ficava na tela para sempre,
inclusive com a sessão viva ao lado. E como `.nothing` e `#termWrap` são os dois
`flex: 1`, o palco rachava ao meio. Medido numa janela de 1400×900:

| | mensagem | terminal |
|---|---|---|
| antes | `display: grid`, 361px | 361px de 779px — **46% do palco** |
| depois | `display: none`, 0px | 722px de 779px — **93%** |

Na prática o PTY nascia com ~21 linhas e passou a nascer com 43 — a sessão
enxerga o dobro de tela.

A correção é uma linha, `[hidden] { display: none !important; }`. O arquivo já
tinha um `#ctx[hidden] { display: none }`, remendo pontual do mesmo problema que
nunca foi generalizado. O autoteste agora trava a regressão: com sessão aberta,
a mensagem tem de estar invisível e o terminal ocupar mais de 80% do palco.

Vale como regra geral do projeto: **toda vez que um elemento precisar de
`display` próprio, conferir se ele é alternado por `hidden`.**

### O menu lateral congelado pelo próprio congelamento

O `railHold` existia por um motivo legítimo: a ordem das sessões é automática
(por estado), e reordenar debaixo do ponteiro faz o clique cair na linha errada.
Só que ele barrava o `paintRail` **inteiro** enquanto o ponteiro estivesse sobre
o rail — e **"+ sessão" e "abrir" ficam dentro do rail**, então logo depois de
criar uma sessão o ponteiro está sempre ali.

Resultado, reproduzido no app real: a sessão nova não aparecia na lista, a
seleção não movia e o contador "parado Xs" congelava, tudo até o usuário tirar o
mouse do menu. Um app que parece travado sem estar.

Agora o congelamento vale **só para a ordem**: o conteúdo repinta sempre, e uma
sessão nascida com o ponteiro no rail entra no fim da lista sem embaralhar o
resto — aparecer fora de ordem é muito melhor do que não aparecer. A única
janela em que repintar de fato come um clique é com o botão apertado, e essa é
guardada por um `railPressed` separado.

O `railPressed` solta em `pointerup`, `pointercancel`, `dragend` **e** `blur`.
Os quatro são necessários: quando começa um arraste HTML5 o Chromium manda
`pointercancel` e o `pointerup` **nunca chega** — só com `pointerup` um único
arraste entre grupos recriaria o congelamento para sempre.

### Retomar anexava duas vezes

O handler `deck:resume` chama `pushMeta()` **antes** de devolver o meta. Então o
`deck:sessions` chega ao renderer primeiro, o auto-reparo (acima) vê
`anexado !== current` e dispara um `openSession` por conta própria — e logo
depois o `await` do `resume()` dispara o segundo. Dois snapshots na mesma tela,
e o texto duplicado fica lá: o TUI nunca repinta aquelas linhas, porque para ele
elas não existem.

Medido sobre os interleavings possíveis: 12 de 15 duplicavam. E um contador de
geração **sozinho não resolve** (9 de 9 ainda duplicavam), porque o primeiro
attach já pôs a sessão em `attached` no main e os chunks entregues também estão
dentro do segundo snapshot. O que zera é marcar `attaching = id` **antes** da ida
ao main, fazendo a guarda do auto-reparo pular: quem abre a sessão é o `await`
do `resume`, e só ele. O contador de geração ficou como rede para os outros
caminhos.

Na mesma função havia o oposto: `openSession` fazia `if (!s) return` quando a
sessão ainda não constava da lista. O push `deck:sessions` e a resposta do
`invoke` do spawn são duas mensagens diferentes e nada garante a ordem — quando
a resposta chegava primeiro, o palco ficava parado no quadro da sessão
**anterior**, sem erro nenhum. O `deck:attach` já valida o id, então seguir em
frente é seguro.

### node-pty sem rebuild

O caminho óbvio (`@electron/rebuild`) **falha** nesta máquina, e a mensagem não
ajuda:

    'GetCommitHash.bat' não é reconhecido como um comando interno
    gyp: Call to 'cmd /c "cd shared && GetCommitHash.bat"' returned exit status 1
         while in deps\winpty\src\winpty.gyp

O tarball do npm não traz os submódulos do winpty, então compilar da fonte não
funciona. Mas não é preciso: o node-pty 1.1 é escrito com **node-addon-api
(Node-API)** e já publica binários prontos em `prebuilds/win32-x64/`. Node-API é
ABI-estável entre versões do Node **e** do Electron, então o mesmo `.node` roda
nos dois. Verificado: `pty.spawn` funciona sob o Electron 45 sem rebuild nenhum.

Se um dia for preciso compilar mesmo, aí sim vão fazer falta MSVC e Python —
ambos presentes nesta máquina (VC Tools 14.44, `C:\Windows\py.exe`).

### `claude.exe` direto, sem shell no meio

A versão WezTerm abria `powershell.exe -NoExit -Command claude`. Aqui o app
spawna o `claude.exe` direto (resolvido no PATH por `resolveClaude()`). Dois
motivos:

- **O PowerShell sobrescreve o título.** Na captura em ConPTY os títulos do
  shell e do Claude se intercalavam: `powershell.exe`, `claude`, `powershell.exe`,
  `✳ Claude Code`… Com o shell fora, a única fonte de título é o Claude.
- **O `-NoExit` existia para o pane não sumir quando o Claude saísse.** Aqui
  isso é indesejado: se o Claude saiu, a sessão acabou, e o card deve virar
  "encerrada" — não um shell vazio fingindo ser uma sessão.

### O PTY nasce no tamanho da janela

Spawnar com um tamanho padrão e redimensionar logo depois faz o TUI **limpar a
tela para redesenhar**, o que aparece como um piscar na abertura de toda sessão.
E, pior, abre uma janela em que um snapshot tirado no instante errado pega a
tela em branco — foi exatamente assim que um teste falhou com um snapshot de
16 caracteres.

Por isso o renderer calcula as dimensões (`fitAddon.proposeDimensions()`) antes
de pedir o spawn, e elas vão no próprio pedido.

### O PTY tem um tamanho só

Um PTY não pode estar certo em dois tamanhos ao mesmo tempo. A regra adotada:
**o PTY segue a tela cheia**, e o espelho headless redimensiona em lockstep com
ele — senão a guarda de menu passaria a ler um viewport de tamanho diferente do
real. Quando a grade existir, os previews saem do buffer, não de PTYs próprios.

### O TUI do Claude não usa o buffer alternativo

Investigado porque um snapshot veio vazio e a suspeita natural era essa: se o
Claude usasse o *alternate screen buffer*, o `SerializeAddon` (que serializa o
buffer normal mais o scrollback) perderia a tela visível. Medido em cinco
momentos de uma sessão real — boot, pronto, prompt digitado, trabalhando,
respondeu — o `buffer.active.type` foi **`normal` em todos**, e o serialize
devolveu de 1959 a 2478 caracteres. A suspeita estava errada; a causa do
snapshot vazio era o redimensionamento, acima.

### Largura de célula: três camadas que precisam concordar

Esta é a causa do "apago com backspace e a letra continua na tela".

O ConPTY **não repassa** os bytes do Claude. Ele desenha num buffer de console
do Windows e **re-serializa** o que ficou lá. Quem decide quantas células um
glyph ocupa, portanto, não é o Claude nem o xterm — é o ConPTY. E o da caixa do
Win10 19045 usa uma tabela de largura mais velha que a do TUI do Claude.

Medido com ConPTY de verdade (com `[Console]::OutputEncoding` forçado para
UTF-8; sem isso o PowerShell translitera tudo para `?` e a medida não vale nada):

| glyph | ConPTY do SO | ConPTY da dll | xterm v6 | xterm v11 | `Bun.stringWidth` |
|---|---|---|---|---|---|
| ⚡ ⏳ ✅ | **1** | 2 | 1 | 2 | **2** |
| 🚀 | 2 | 2 | 1 | 2 | 2 |
| ✳ ◐ ❯ │ Nerd Font | 1 | 1 | 1 | 1 | 1 |

Os glyphs de estado do próprio Claude não divergem — quem diverge são os emoji.
O estrago, com a linha `❯ ⚡ abcdefgh` e a intenção de apagar o `h`:

| ConPTY | coluna que o app manda apagar | bytes que o ConPTY emite | efeito |
|---|---|---|---|
| SO | 11 (modelo ⚡=1) | `abcdefgh\b ` (backspace relativo) | ok |
| **SO** | **12 (modelo ⚡=2, o do Claude)** | `abcdefgh ` (só um espaço no fim) | **o `h` sobrevive** |
| dll | 12 (modelo do Claude) | `ESC[1;13H ` (CUP absoluto) | ok |

A linha do meio é o bug. O Claude calcula ⚡ = 2 células, manda apagar a coluna
12; o ConPTY do SO acha que a linha acabou na 11, **não apaga nada** e só
acrescenta um espaço no fim. Como o estrago acontece dentro do buffer do ConPTY,
**antes de qualquer xterm**, nenhum ajuste no renderer alcança — e o resíduo
aparece igual em Unicode 6 e em Unicode 11.

Por isso `useConptyDll: true` no `pty.spawn`: o node-pty traz um ConPTY próprio
e bem mais novo em `third_party/conpty/1.23.251008001` (o mesmo arquivo que vai
para `prebuilds/win32-x64/conpty` — conferido por sha256), e esse concorda
célula a célula com o `Bun.stringWidth`. A opção está em
`node_modules/node-pty/typings/node-pty.d.ts:104` e é repassada em
`lib/windowsTerminal.js:51`.

E por isso o espelho headless passou a carregar o **Unicode 11**, que o renderer
já usava: só existe uma combinação sem divergência nenhuma — ConPTY da dll mais
Unicode 11 nos dois xterm. Migrar um lado só gera lixo novo, e isso está na
tabela acima.

O node-pty marca `useConptyDll` como **EXPERIMENTAL** e ela muda os caminhos de
kill/exit/conout, daí o fallback em `abrirPty()`: se a dll sumir num build
empacotado, a sessão ainda nasce — com o bug de largura de volta, mas aberta.
Para desligar de propósito: `CLAUDE_DECK_CONPTY=windows`.

**Ressalva honesta:** que o TUI do Claude use o modelo ⚡=2 é inferência forte,
não observação direta. O `claude.exe` é binário Bun de 329 MB com o JS embutido;
a varredura não achou `string-width`/`get-east-asian-width`, achou
`Bun.stringWidth`, que mede 2. O mecanismo do ConPTY está medido; esse elo
final, não. **Falsificador:** se o resíduo aparecer numa linha só com texto
simples e acentos, sem nenhum emoji, a teoria de largura está errada.

### O write do xterm não é imediato

`term.write(d)` **enfileira** e parseia num tick seguinte. O código fazia

```js
this.term.write(d);
this._pending.push(d);   // ← antes do parse
```

e isso abria um buraco por onde o byte sumia das duas pontas de uma vez: o
`deck:attach` chama `flush()` — o chunk sai da fila e, como o id ainda não está
em `attached`, **vai para o vazio** — e logo depois `snapshot()`, que serializa
só o que **já foi parseado**, ou seja, sem o chunk.

Medido: um chunk que apagava uma linha se perdia assim, e a linha velha ficava
na tela da view **para sempre** — o TUI acha que já apagou aquilo e nunca mais
repinta. O `_pending.push` passou para dentro do callback do `write`, que é
exatamente o sinal de "já parseei". Aparece ao trocar de sessão ou retomar
durante streaming, não ao digitar.

### `kill()` custava ~1 s por sessão, e o erro no console era a pista

Ao matar um PTY, o node-pty dispara um processo auxiliar
(`conpty_console_list_agent`) que, sob o Electron, falha com `AttachConsole
failed` e despeja um stack trace no stdout. A leitura original era "ruído, não
impede o kill" — e isso continua certo quanto a **órfãos**: medido com um filho
aninhado (a mesma topologia de `claude.exe` sob um shell), tanto o shell quanto
o filho morrem, e o auxiliar é um caminho de melhor-esforço.

O que estava errado era achar que não custava nada. Como o auxiliar falha, o
`pty.kill()` cai no timeout/fallback de `windowsPtyAgent.js:189-193`, e isso
**segura o thread do main**. Medido com sessões `claude.exe` reais que já tinham
trabalhado:

    pty.kill() = 1049ms / 871ms / 835ms

O main é quem bombeia as mensagens da janela, então encerrar três sessões era
**2,76 s de janela congelada** — e isso roda no ✕, quando uma sessão sai
sozinha, e N vezes seguidas ao fechar o app, logo depois de um
`showMessageBoxSync` que já é modal.

O `useConptyDll` da seção anterior resolve junto: `pty.kill()` cai para ~0 ms e
o handler `deck:kill` inteiro, de 835-1049 ms para 2-4 ms. Os processos filhos
continuam morrendo nos dois modos — conferido, inclusive sem sobrar
`OpenConsole.exe` nem `node.exe` de MCP server.

Isso importa porque uma sessão em **auto mode** órfã continuaria agindo onde
ninguém vê. O autoteste confere a contagem de `claude.exe` antes e depois.

### Grupos: a chave de instância sumiu

Na versão WezTerm, membro de grupo era gravado por `pane_id`, que reinicia junto
com o GUI — daí a "chave de instância" (`WEZTERM_UNIX_SOCKET`): se o socket
mudasse, os grupos ficavam e os membros caíam, senão um pane novo herdaria o
grupo de um morto.

Aqui a chave é o **session-id do próprio Claude**, um UUID que o app gera no
spawn e reusa no `--resume`. Ele nunca colide, então a chave de instância deixa
de existir e a participação em grupo **sobrevive a reiniciar o app** — que é
exatamente o desejado, já que a sessão também sobrevive, via resume.

O resto da lógica de grupos foi portado quase verbatim: normalização única para
o que vem da tela e o que vem do disco, gravação `tmp` + `rename`, remoção de
BOM na leitura (o Notepad e o `Out-File -Encoding utf8` do PowerShell 5.1
gravam um, e `JSON.parse` estoura com BOM).

### O renderer WebGL não escreve no DOM

Um teste falhou lendo `.xterm-rows` e encontrando vazio. Com o `addon-webgl`
ativo o texto é desenhado num canvas, e o DOM das linhas fica vazio. Conferir
"o que está na tela" tem que ser feito pelo `term.buffer`, não pelo DOM.

O addon também passou a ter handler de `onContextLoss`. Sem ele, uma perda de
contexto da GPU (suspensão do Windows, troca de adaptador, OOM do driver)
congela o canvas: o que estava escrito fica na tela e nenhum repaint do TUI
apaga. Descartar o addon devolve o renderer DOM, mais lento mas que sempre
repinta. **Não medido** — não dá para forçar perda de contexto de forma
confiável em teste automatizado; o handler está lá por ser o padrão recomendado
no README do `@xterm/addon-webgl`.

## Diagnóstico de travamento

`main/diag.js` é **inerte** sem `DECK_DIAG=1`: sem a variável, nem a sonda nem o
embrulho dos handlers rodam. Com ela, grava sonda de atraso do event loop do
main, cronômetro em todo handler de IPC (embrulhando `ipcMain.handle`, então
vale para os que vierem depois) e passos nomeados dentro de `deck:spawn`,
`deck:kill` e da troca de label.

Três detalhes que custaram para descobrir e estão codificados ali:

- **Precisa gravar em arquivo** (`DECK_DIAG_LOG`). O `electron.exe` é binário de
  subsistema **GUI** no Windows, então o que o main imprime **não chega** a um
  shell que redireciona a saída. A primeira tentativa de coletar números voltou
  vazia por isso.
- **Medir com a janela em primeiro plano**, e com
  `--disable-background-timer-throttling`, `--disable-renderer-backgrounding` e
  `--disable-backgrounding-occluded-windows`. Em segundo plano o Chromium
  estrangula os timers e a sonda do renderer acusa ~900 ms de atraso por
  segundo, que não é travamento nenhum.
- **`webContents.on("unresponsive")` vigia o RENDERER** e demora dezenas de
  segundos para disparar. A ausência dessa linha **não** prova que a janela não
  congelou; a métrica do congelamento é o atraso do event loop do main.

Como ler: atraso grande **com** um passo nomeado logo acima → é código deste
repositório, e o nome diz qual. Atraso grande **sem** passo atribuído → é código
nativo (ConPTY, antivírus interceptando a criação do processo) ou o próprio
Chromium.

## Segurança

A superfície é muito menor que a da versão web, que precisava de token por boot,
validação de `Host` e preflight de CORS para impedir que qualquer site aberto no
navegador dirigisse o Claude da máquina. Aqui não há servidor HTTP: a conversa é
IPC entre processos do mesmo app.

O que resta de cuidado:

- **`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.** O
  `ipcRenderer` cru nunca é exposto — o `preload.js` publica uma lista fechada
  de funções e nada mais.
- **Navegação bloqueada.** `will-navigate` e `window.open` são interceptados;
  link de terminal vai para `shell.openExternal`, e só `http:`/`https:`.
- **Menu default removido.** Fora o visual, ele sequestra teclas que pertencem
  ao terminal — `Ctrl+R` recarregaria a janela no meio de uma sessão.
- **O programa executado é fixo**, escrito no servidor: o `claude.exe` resolvido
  no PATH. Do renderer vem só o `cwd`, que precisa ser absoluto e ser um
  diretório existente, e os argumentos vão por array, sem shell no meio.
- **Toda entrada de estado passa pela mesma normalização**, inclusive o arquivo
  lido do disco: nome aparado e sem controles, máximo 32; cor obrigatoriamente
  da paleta; id no formato `g[0-9a-z]+`; membro apontando para grupo inexistente
  é descartado.

## O que falta

Em ordem de valor, na minha leitura:

1. **A grade.** Vários cards lado a lado, como na versão web. Os previews saem
   do buffer do espelho (`stripChrome` já está portado e sem uso por enquanto),
   não de xterms vivos.
2. **Notificação nativa no bell.** O `onBell` do espelho + `new Notification` dá
   "a sessão X precisa de você" sem a janela estar na frente. É o caso de uso
   que originou o projeto.
3. **Bandeja e hotkey global.** Trazer o deck para a frente de qualquer lugar.
4. **Empacotamento.** `electron-builder`, com `asarUnpack` para os `.node` do
   node-pty — binário nativo dentro do asar não carrega. **Atenção:** com o
   `useConptyDll` ligado, `conpty.dll` e `OpenConsole.exe` são carregados **de
   disco** em tempo de execução, então `node-pty/prebuilds/win32-x64/conpty/`
   também precisa ficar fora do asar. Se escaparem, o `abrirPty()` cai no
   ConPTY do Windows e o bug de largura de célula volta calado.
5. **Hooks (a "camada 2" que a versão WezTerm não conseguiu construir).** O app
   já injeta `CLAUDE_DECK_SESSION=<uuid>` no ambiente de cada sessão, que é
   justamente o mapeamento que faltava: um hook `Notification`/`Stop` agora sabe
   de qual sessão está falando.

## A decisão que está esperando um número

Há um relato de **janela congelada por mais de 5 s ao criar sessão**, que
ninguém reproduziu: `deck:spawn` mede 50-122 ms, e `pty.spawn("cmd /c exit")`
custa o mesmo que `claude.exe` — ou seja, o custo é criar o ConPTY, não subir o
Claude — e **não escala** com o número de sessões vivas. O Windows só marca "Não
está respondendo" por volta dos 5 s, então o que foi medido está uma ordem de
grandeza longe do sintoma.

O próximo passo é rodar com `DECK_DIAG=1` **no ambiente real** (sem
`--user-data-dir`, com o `%APPDATA%` e o catálogo de verdade) e ler o log. O
número decide o rumo, e cada rumo tem um custo bem diferente:

- **`manager.spawn` perto de 5000 ms** → o bloqueio é nativo: antivírus
  corporativo interceptando a criação do processo. A saída é exclusão no AV, ou
  tirar o node-pty do thread do main (`utilityProcess` do Electron, com
  `sessions.js` inteiro do outro lado e um canal novo para dados/meta/exit —
  reescreve `sessions.js` e `index.js` e mexe no `selftest.js`).
- **`rememberSession` dominando** → `store.save()` é `writeFileSync` + `rename`
  **síncronos**, e roda a cada troca de label, várias vezes por sessão. Medido
  em 39-49 ms numa máquina com antivírus corporativo e catálogo quase vazio; num
  `%APPDATA%` de perfil de rede pode ser muito pior. A correção é barata: salvar
  com debounce, mantendo gravação síncrona no `quit`.

Deliberadamente **não** implementado antes da medição: 39 ms é 40× menor que o
sintoma relatado, e seria mitigação enviada para um problema não medido.
