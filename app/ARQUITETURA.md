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

### `kill()` não deixa órfão, apesar do erro no console

Ao matar um PTY, o node-pty dispara um processo auxiliar
(`conpty_console_list_agent`) que, sob o Electron, falha com `AttachConsole
failed` e despeja um stack trace no stdout. Parece grave e não é: medido com um
filho aninhado (a mesma topologia de `claude.exe` sob um shell), tanto o shell
quanto o filho morrem. O auxiliar é um caminho de melhor-esforço.

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
   node-pty — binário nativo dentro do asar não carrega.
5. **Hooks (a "camada 2" que a versão WezTerm não conseguiu construir).** O app
   já injeta `CLAUDE_DECK_SESSION=<uuid>` no ambiente de cada sessão, que é
   justamente o mapeamento que faltava: um hook `Notification`/`Stop` agora sabe
   de qual sessão está falando.
