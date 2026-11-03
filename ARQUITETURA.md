# Arquitetura

Como o claude-deck funciona por dentro, e por que cada decisão foi tomada assim.
Para instalar e usar, veja o [README](README.md).

## Visão geral

O WezTerm expõe um CLI que fala com a instância gráfica em execução. Todo o
projeto se apoia em seis comandos:

| comando | uso |
|---|---|
| `wezterm cli list --format json` | enumera panes, títulos, tamanho |
| `wezterm cli get-text --pane-id N --start-line -K` | lê a tela de um pane |
| `wezterm cli send-text --pane-id N` | escreve num pane |
| `wezterm cli activate-pane --pane-id N` | foca um pane |
| `wezterm cli spawn --cwd DIR -- PROG` | abre uma aba nova e devolve o pane-id |
| `wezterm cli kill-pane --pane-id N` | fecha um pane |

O servidor é um `http.createServer` sem dependências. A cada request de
`/api/panes` ele lista os panes, lê a tela de cada um em paralelo e devolve JSON.
A página faz polling a cada 1,5s.

    navegador  ──GET /api/panes──▶  server.js  ──wezterm cli list──▶  WezTerm
        ▲                              │        ──wezterm cli get-text──▶
        └──────── JSON (cards) ────────┘
        └──POST /api/send──▶  server.js  ──wezterm cli send-text──▶  pane

## Rotas

Todas exigem o header `x-deck-token` e um `Host` local.

| rota | método | corpo | resposta |
|---|---|---|---|
| `/` | GET | — | HTML com o token injetado no lugar de `__DECK_TOKEN__` |
| `/api/panes` | GET | — | array de cards; `?full=N` devolve o pane N com `FULL_TAIL` linhas em vez de `TAIL` |
| `/api/focus` | POST | `{pane}` | 204 |
| `/api/send` | POST | `{pane, text, submit}` ou `{pane, key:"esc"}` | 204, ou 409 se houver menu aberto |
| `/api/spawn` | POST | `{cwd}` | `{paneId}` da sessão nova, ou 400 se a pasta não servir |
| `/api/kill` | POST | `{pane}` | 204; 400 se for o pane do próprio deck, 404 se o pane já sumiu |
| `/api/groups` | GET | — | `{groups, members, palette}` |
| `/api/groups` | POST | `{groups, members}` | o estado inteiro, normalizado e já gravado |

Cada card tem: `paneId`, `tabId`, `windowId`, `title`, `glyph`, `status`, `menu`,
`group`, `quietFor`, `cols`, `cwd`, `tail`.

`/api/groups` substitui o estado inteiro em vez de aceitar operações. É um painel
de um usuário só, com um punhado de grupos: mandar o documento completo elimina
a necessidade de sincronizar deltas, e a normalização no servidor vira a única
porta de entrada — o mesmo código valida o que vem da página e o que vem do disco.

## Detecção de status

O Claude Code escreve o próprio estado no **título do pane**, com um glyph na
frente do assunto da conversa. A classificação usa isso:

- `✳` → `idle` (parado, esperando você)
- qualquer outro glyph com codepoint acima de `U+2000` → `busy`
- sem glyph → `shell`

A regra é "qualquer glyph que não seja `✳`", e não uma lista fechada de frames,
justamente porque o spinner tem vários e uma lista incompleta faria uma sessão
trabalhando aparecer como parada.

Além do glyph, o servidor guarda um hash implícito do conteúdo de cada pane
(`lastSeen`) para calcular `quietFor` — há quantos segundos a tela não muda. É o
que dá o "parado 40s" no card.

Esse hash usa **sempre as últimas `TAIL` linhas**, mesmo quando o pane é lido fundo
para a tela cheia. Se usasse o texto devolvido, abrir uma sessão em tela cheia
mudaria o conteúdo comparado e zeraria o contador exatamente no pane que você
está olhando.

## Envio de texto

```
sanitize(texto)                               remove controles, mantém \n e \t
  │
  ├─ wezterm cli send-text --pane-id N        via stdin, bracketed paste
  │                                            (sem --no-paste)
  ├─ sleep 150ms
  └─ wezterm cli send-text ... --no-paste     stdin: "\r"
```

Três decisões aqui:

- **Texto por stdin, não por argumento.** No Windows, argv passa por conversão de
  codepage e quebra acento, aspas e multiline.
- **Bracketed paste para o texto.** Garante que um `/`, `!` ou `#` inicial não
  troque o modo de input do Claude no meio do caminho.
- **Enter numa chamada separada.** Mandado junto, corre o risco de ser tratado
  como parte do paste em vez de submissão.

O `Esc` é `\x1b` com `--no-paste`.

## Guarda de menu

`MENU_RE` roda contra as últimas 15 linhas não-vazias da tela:

```js
/(Enter to confirm|Esc to cancel|❯\s*\d+\.\s|^\s+❯\s)/
```

O `/api/send` relê o pane no momento do envio — não confia no snapshot, que pode
estar 1,5s atrasado — e devolve 409 se houver menu. Quando há menu, o card também
pula o corte de moldura, senão as opções sumiriam da tela.

## Excluir uma sessão

`kill-pane`, não `/exit`. O `/api/spawn` cria a sessão com
`powershell.exe -NoExit -Command claude`: mandar `/exit` por `send-text` fecharia o
Claude e deixaria o PowerShell vivo, com o pane ainda na lista e o card ainda no
painel. `kill-pane` fecha o pane, que é o que "excluir a sessão" quer dizer aqui.

A rota faz três coisas antes de matar:

- recusa qualquer `pane` que não seja só dígitos
- recusa o `WEZTERM_PANE` do próprio deck — matá-lo mataria o processo que está
  respondendo ao pedido, e o painel inteiro junto
- relê o `cli list` e devolve 404 se o pane não está mais lá, em vez de deixar o
  erro do `wezterm` virar um 500

Depois de matar, limpa o `lastSeen` e a participação do pane em grupo. A
confirmação fica no cliente, não no servidor: só a página sabe o título, e o
`#id` entra na pergunta porque os títulos se repetem.

## Grupos: o único estado que não vem do WezTerm

Agrupar sessões por tema é informação do usuário. O `wezterm cli` não tem onde
guardá-la, então ela vive num `deck-state.json` ao lado do `server.js`.

**Por que no servidor e não no `localStorage`.** Todo restart do `server.js`
derruba a página, e o navegador não distingue "o deck reiniciou" de "o WezTerm
reiniciou" — e são casos opostos: no primeiro os grupos devem continuar, no
segundo os membros têm que cair. Fora isso, `localhost` e `127.0.0.1` são origens
separadas, cada uma com o seu próprio `localStorage`: os mesmos grupos
apareceriam diferentes dependendo da URL digitada.

**A chave de instância.** O `pane_id` sobe dentro de uma instância do WezTerm e
nunca se repete, mas reinicia do zero junto com o GUI. Membros gravados por
`pane_id` fariam um pane novo herdar o grupo de um morto. O arquivo guarda então o
`WEZTERM_UNIX_SOCKET`, que traz o pid do GUI (`gui-sock-<pid>`); no boot, se ele
difere do atual, os **grupos ficam** e os **membros caem**.

**A poda roda no servidor, contra a lista crua.** Podar no cliente, contra o que
está na tela, apagaria o grupo de todo pane de shell no instante em que o filtro
"só sessões Claude" fosse ligado.

**Toda entrada passa pela mesma normalização**, inclusive o arquivo lido do disco
— ele pode ter sido editado à mão. Nome aparado, sem caracteres de controle,
máximo 32; cor obrigatoriamente da paleta; id no formato `g[0-9a-z]+`; membro
apontando para grupo inexistente é descartado. Gravação é `tmp` + `rename`, para
um Ctrl+C no meio não deixar um JSON pela metade.

**O BOM.** `JSON.parse` estoura com BOM, e tanto o Notepad quanto o
`Out-File -Encoding utf8` do PowerShell 5.1 gravam um. Sem tratar isso, abrir o
arquivo para espiar apagaria todos os grupos em silêncio. O servidor remove o BOM
na leitura e, quando o JSON está quebrado mesmo, avisa no console em vez de
recomeçar calado.

**As cores dos grupos não podem colidir com as de estado.** O card mostra os dois
ao mesmo tempo, e eles respondem a perguntas diferentes: o estado é "precisa de
mim?", o grupo é "sobre o quê?". Por isso a paleta de grupo evita o verde do
`idle`, o âmbar do `busy`, o rosa do `menu` e o cinza do `shell`, e a cor do grupo
nunca vai na borda esquerda do card — aquela borda já é o estado. O grupo aparece
como etiqueta no cabeçalho, como faixa na grade e como seção no menu lateral.

## Segurança

Escrever num pane equivale a digitar na sessão, e qualquer site aberto no
navegador alcança `127.0.0.1`. Com as sessões em auto mode, um endpoint aberto
deixaria qualquer página dirigir o Claude da máquina. Por isso:

- **Token por boot**, aleatório, injetado na página. Toda rota `/api/*` exige o
  header `x-deck-token`. Header customizado obriga preflight CORS, que página
  externa não passa.
- **`Host` validado** contra `localhost:PORT` e `127.0.0.1:PORT`, o que corta DNS
  rebinding — sem isso, um site poderia resolver um domínio para 127.0.0.1 e ler
  o conteúdo de todos os terminais via `/api/panes`.
- **Só POST** em `/api/send`, `/api/focus`, `/api/spawn`, `/api/kill` e na escrita
  de `/api/groups`.
- **`/api/kill` só aceita um `pane_id`**, nunca um nome de processo nem um
  comando: o que a rota faz é fixo, e o pane do próprio deck é recusado.
- **Programa fixo no `/api/spawn`.** A rota cria processos, então o que roda é
  escrito no servidor (`powershell.exe -NoExit -Command claude`) e nunca vem do
  pedido. Do corpo vem só o `cwd`, que precisa ser absoluto — o que também impede
  que um valor começando com `-` chegue ao wezterm como flag — e ser um diretório
  existente. Os argumentos vão por array no `execFile`, sem shell no meio.
- **Controles removidos** do texto, exceto `\n` e `\t`: um `ESC[201~` colado
  encerraria o bracketed paste e viraria sequência de teclas.
- **Corpo limitado** a 1 MB, concatenado como `Buffer` antes de virar string —
  juntar como string partiria caractere multi-byte na borda do chunk.

## As duas visões da página

A página mantém um card por pane num `Map`, e o DOM de cada card sobrevive aos
refreshes — é o que preserva rascunho, scroll e foco. As duas visões são o mesmo
card em lugares diferentes:

- **grade**: todos os cards dentro de `#grid`, reordenados a cada tick (os parados
  sobem), exceto enquanto você está digitando em algum
- **tela cheia**: o card escolhido é movido para `#solo`; os outros saem do DOM e
  voltam intactos quando você retorna

`append` num nó que já está no lugar certo o remove e reinsere, o que tira o foco
do `textarea` — então o append só acontece quando o pai muda de verdade. O menu
lateral tem o mesmo cuidado pelo outro lado: congela a ordem enquanto o ponteiro
está sobre ele, senão o item fugiria debaixo do clique.

Só o pane pedido em `?full=N` é lido fundo. Ler 200 linhas de todos os panes a
cada 1,5s custaria caro para mostrar o que ninguém está olhando.

## Decisões e descobertas

Coisas que custaram teste para descobrir, registradas para não serem redescobertas:

**`get-text --start-line -N` não devolve as últimas N linhas.** Devolve N linhas
acima do topo do viewport **mais** o viewport inteiro. Com viewport de 34 linhas e
`-18`, voltam ~52. O corte para N é feito no código.

**As ~7 linhas finais de um pane do Claude são moldura** — borda da caixa de
prompt, statusline e footer. Sem cortar, metade do card era chrome. `stripChrome`
procura a primeira borda `───` dentro das últimas 14 linhas e corta dali para
baixo, preservando a linha do spinner com o tempo decorrido, que é o sinal mais
útil do card.

**`❯` indentado é opção de menu; `❯` na coluna 0 é a caixa de input.** Esse é o
discriminador que evita falso positivo na guarda de menu quando você está apenas
digitando.

**`trimBlank` antes de `slice(-15)`.** Um pane com poucas linhas tem o viewport
preenchido de branco no fim; sem aparar antes, a janela de 15 linhas pegava só
vazio e a guarda de menu dava falso negativo. Esse bug foi encontrado em teste.

**O `cwd` do `cli list` serve.** Em 28/10 a conclusão registrada aqui era o
contrário: que ele reportava o home para todos os panes. Na medição de 30/10, com 8
panes abertos, cada um veio com a sua própria pasta, batendo com a realidade. Por
que mudou não foi investigado. É desse campo que sai a lista de pastas do botão
**+ nova sessão**. O nome do projeto continua vindo do título.

**Abrir a sessão nova com o programa no próprio `spawn`.** A alternativa — spawnar
o shell e mandar `claude` por `send-text` — corre com a inicialização do
PowerShell: o texto pode chegar antes de existir prompt para recebê-lo. Já
`spawn --cwd DIR -- powershell.exe -NoExit -Command claude` é uma chamada só, sem
corrida, e devolve o pane-id para a página abrir a sessão em tela cheia.

**Um pane em diálogo pode não ter glyph nenhum.** Uma sessão recém-aberta, parada no
*"is this a project you trust?"*, se chama `claude.exe`: pela regra do título ela é
shell comum, e o filtro "só sessões Claude" a esconderia justamente quando ela
espera por você. Por isso o filtro da página é `status !== "shell" || menu`.
Descoberto testando o botão de nova sessão.

**Git Bash corrompe UTF-8 no argv de executáveis nativos.** Um `curl --data` com
acento chega corrompido; o mesmo texto via stdin ou via navegador chega íntegro.
Isso é armadilha de teste, não bug do servidor.

**`scroll` em fase de captura fechava o menu de contexto sozinho.** O menu é
`position:fixed` e precisa fechar quando a página rola, senão descola da âncora.
Mas o `tick` escreve `pre.scrollTop` em todo refresh que muda o conteúdo de um
card, e isso dispara `scroll` como qualquer rolagem — o menu morria em menos de
1,5s, antes de dar tempo de clicar. O fecho passou a ouvir `wheel` (que é gesto do
usuário) e `scroll` apenas dos dois containers que o usuário rola de fato,
`#rail` e `#grid`. Encontrado testando no navegador: o clique em "excluir grupo"
simplesmente não acontecia.

**O menu de contexto é um elemento único, filho direto do `body`.** Se ele
morasse dentro do card ou da linha do menu lateral, o refresh de 1,5s poderia
reconstruí-lo debaixo do clique. Ele guarda o `paneId` no momento em que abre.

**Botão direito só no cabeçalho e na linha do menu lateral.** No `<pre>` o menu
nativo do navegador é o que serve para copiar o texto da sessão — ali o
`contextmenu` não é interceptado. Na caixa de texto, idem.

**A linha do menu lateral é `div role=button`, não `<button>`.** Um `<button
draggable>` não inicia arraste em parte dos navegadores, e arrastar para o grupo é
o gesto principal da funcionalidade.

**Trocar de pai no menu lateral ignora o `railHold`.** O `railHold` existe para a
ordem não fugir debaixo do clique enquanto o ponteiro está sobre o menu — mas o
drop de um arraste acontece exatamente ali, com o ponteiro sobre o menu. Se o
congelamento valesse para tudo, a sessão só entraria no grupo quando o mouse
saísse do menu. A regra ficou: mudança de pai (o usuário moveu de grupo) aplica
sempre; reordenação por estado, que é automática, continua congelada.

## Alternativas descartadas

**Parsear os transcripts `.jsonl`** de `~/.claude/projects/`. São ~72 arquivos de
vários MB, e nada neles mapeia um transcript para um pane do WezTerm — seria
adivinhação. O título do pane dá o mesmo sinal de graça.

**TUI em vez de página web.** A página cabe num segundo monitor sem gastar um
pane, e o clique-para-focar sai de graça. O custo é precisar de um pane para o
servidor.

## Camada 2, não construída

Hooks `Notification` / `Stop` / `UserPromptSubmit` em `~/.claude/settings.json`,
gravando `{pane: $WEZTERM_PANE, evento, ts}` num diretório, dariam duas coisas que
o glyph do título não dá:

- um sinal **confiável** de "precisa de você", em vez de inferência pelo título
- o mapeamento exato pane ↔ sessão: qual transcript pertence a qual pane (o `cwd`
  já vem do `cli list`)

Não foi construída porque mexer no `settings.json` é decisão do usuário.
