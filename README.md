# claude-deck

Ver, lado a lado, o que cada sessão Claude está fazendo — e responder sem trocar
de janela.

Nasceu de um problema concreto: com várias sessões Claude abertas, não dá para
ver o que está acontecendo em paralelo nem saber qual delas parou esperando
resposta.

> ### 🖥️ Existe agora uma versão desktop: **[`app/`](app/README.md)**
>
> Nela **o terminal é o app**: cada sessão nasce num PTY que ele mesmo abre, com
> saída ao vivo, cor e input de verdade — sem WezTerm. É o caminho em que o
> projeto continua.
>
> A versão web abaixo **continua funcionando e não foi alterada**. As duas são
> independentes; a desktop existe porque o teto da web era o `wezterm cli`, que
> não tem stream — ela lê um retrato da tela a cada 1,5s e injeta texto como
> paste. Comparação em [app/README.md](app/README.md#a-diferença-que-motivou-a-migração).

---

## Versão web (WezTerm)

Zero dependências: todo o estado vem do `wezterm cli`.

- **Como funciona por dentro, e por quê:** [ARQUITETURA.md](ARQUITETURA.md)
- **O que foi testado e o que não foi:** [VERIFICACAO.md](VERIFICACAO.md)

### O que existe

O projeto tem duas camadas independentes — a primeira funciona sozinha, sem o app.

| Camada | O que é | Estado |
|---|---|---|
| 0 | `wezterm.lua`: panes em grade + aba colorida por estado | instalado |
| 1 | `server.js` + `public/index.html`: o painel web | pronto para rodar |
| 2 | hooks do Claude Code (não construída) | ver ARQUITETURA.md |

## Camada 0 — panes em grade

Já está instalado em `~/.wezterm.lua`. O `wezterm.lua` deste repo é uma cópia
sincronizada, mantida aqui para versionamento.

Teclas adicionadas:

| tecla | ação |
|---|---|
| `ALT+\` | dividir à direita |
| `ALT+-` | dividir abaixo |
| `ALT+setas` | mover entre panes |
| `ALT+z` | ampliar/reduzir o pane atual |
| `ALT+p` | escolher pane por letra |
| `ALT+x` | fechar o pane atual |

A barra de abas também fica colorida pelo estado da sessão: verde quando o título
começa com `✳` (parado, esperando você), amarelo para qualquer outro glyph
(spinner girando), cinza para shell comum.

### Reverter

O config anterior está em `~/.wezterm.lua.bak`. O WezTerm recarrega sozinho ao
salvar. Atenção ao shell: no prompt `!` do Claude Code você está em **bash**, num
pane do WezTerm você está em **PowerShell**.

    # bash (prompt ! do Claude Code)
    cp ~/.wezterm.lua.bak ~/.wezterm.lua

    # PowerShell (pane do WezTerm)
    Copy-Item "$HOME\.wezterm.lua.bak" "$HOME\.wezterm.lua"

## Camada 1 — o painel

### Rodar

Precisa ser **de dentro de um pane do WezTerm**: é de lá que o processo herda o
`WEZTERM_UNIX_SOCKET`, sem o qual o `wezterm cli` não enxerga pane nenhum. O
servidor avisa no boot se a variável estiver faltando.

    node D:\Users\lucas.paiva\source\repos\claude-deck\server.js

Depois abra <http://localhost:7788> — de preferência num segundo monitor, ou lado
a lado com o WezTerm.

O pane onde o servidor roda fica ocupado, então vale usar um split fininho
(`ALT+-`) em vez de uma aba inteira. Esse pane é filtrado do painel automaticamente
(via `WEZTERM_PANE`), então ele não aparece como card.

### O que o painel mostra

À esquerda, o **menu lateral**: uma linha por sessão, com um ponto colorido, o
título, o `#id` do pane e o status embaixo. Ele é a navegação — clicar numa linha
abre aquela sessão em tela cheia. O `#id` está ali porque os títulos se repetem.
Se você tiver criado grupos, as linhas aparecem debaixo do grupo a que pertencem
(veja [Agrupar sessões por tema](#agrupar-sessões-por-tema)).

| estado | quando | cor |
|---|---|---|
| **concluído** | título começa com `✳`: parou, esperando você | verde |
| **trabalhando** | qualquer outro glyph acima de U+2000 no título | amarelo |
| **precisa de você** | a sessão está travada num diálogo aberto | rosa |
| **shell** | pane sem glyph, não é sessão Claude | cinza |

"precisa de você" vem **antes** do glyph: uma sessão parada num pedido de permissão
tem glyph de parada, mas não concluiu nada — é justamente o caso que o menu existe
para mostrar. E uma sessão recém-aberta ainda se chama `claude.exe`, sem glyph
nenhum: ela contaria como shell e sumiria com o filtro ligado, então um pane com
diálogo aberto fica na lista de qualquer jeito.

À direita, duas visões, alternadas pelos botões **grade** e **tela cheia**:

- **grade** — um card por pane com as últimas **18** linhas úteis, lado a lado
- **tela cheia** — uma sessão só, ocupando a área inteira, com **200** linhas para
  rolar. É a visão padrão. A visão escolhida e a sessão aberta ficam salvas no
  navegador e voltam no próximo carregamento; se aquele pane não existir mais, abre
  a primeira sessão da lista

Nas duas:

- os parados sobem para o topo, com "parado Xs" desde a última mudança de tela —
  é o que responde "quem precisa de mim agora?"
- a moldura do pane (caixa do prompt, statusline, footer) é cortada, mas a linha
  do spinner com o tempo decorrido fica
- atualização a cada 1,5s; o scroll que você fixar é preservado, e o menu lateral
  para de reordenar enquanto o ponteiro estiver sobre ele, para o clique não errar
  o alvo

Dois checkboxes no topo: **só sessões Claude** esconde panes de shell comum, e
**auto-atualizar** congela o painel para você ler algo com calma.

### Responder pelo navegador

Cada card tem uma caixa de texto: **Enter envia**, **Shift+Enter** quebra linha.
O botão **Esc** interrompe a sessão, e o **⤢** foca aquele pane no WezTerm.
Clicar no cabeçalho ou na área de saída do card também foca o pane — a área da
caixa de texto é excluída de propósito, para digitar não roubar o foco do navegador.
Na tela cheia o clique na saída **não** foca: ali ele serve para selecionar texto,
então use o cabeçalho ou o **⤢**.

Enquanto você estiver digitando em algum card, o painel para de reordenar, para o
card não fugir debaixo do cursor.

**Não é um terminal ao vivo no navegador.** É injeção de texto no pane
(`wezterm cli send-text`) mais um retrato da tela a cada 1,5s: sem cores, sem
streaming.

Detalhes que importam:

- se você já tinha algo meio digitado naquele pane, o texto enviado **gruda** nele
- o card mostra "ocupado — o que você enviar entra na fila" quando a sessão está
  trabalhando. **Esse comportamento de fila não foi verificado** (ver
  [VERIFICACAO.md](VERIFICACAO.md)); o que é certo é que o texto chega como se
  tivesse sido digitado naquele instante
- acento, multiline e um `/` ou `!` inicial passam intactos

### Abrir uma sessão nova

O botão **+ sessão**, no topo do menu lateral, abre uma aba nova no WezTerm já
rodando o `claude`. A caixa de pasta vem preenchida com a pasta da sessão que você
está vendo, e a lista suspensa traz as pastas de todos os panes — inclusive as de
shell comum. A lista de grupos logo abaixo já vem no grupo da sessão que você está
vendo, então uma sessão aberta a partir de um incidente nasce dentro de
"incidentes". **Enter** abre, **Esc** cancela.

O servidor roda sempre o mesmo comando, `powershell.exe -NoExit -Command claude`,
espelhando o `default_prog` do `wezterm.lua`. O pedido escolhe **só a pasta**, que
precisa ser um caminho absoluto e existente; o `-NoExit` deixa o shell vivo se o
claude sair.

Duas coisas que acontecem na sua tela:

- o WezTerm **ativa a aba nova** assim que ela nasce, então o foco sai do navegador
- numa pasta que o Claude ainda não conhece, a sessão abre direto no *"is this a
  project you trust?"*. Isso é um diálogo: o card entra em **precisa de você** e a
  caixa de texto trava — responda no WezTerm (⤢)

### Excluir uma sessão

Três caminhos, todos com confirmação antes:

- **botão direito** numa linha do menu lateral ou no **cabeçalho de um card** →
  *excluir sessão*
- o **✕** no canto direito do cabeçalho do card
- a tecla **Delete** com a linha do menu lateral focada pelo teclado

Excluir aqui significa **fechar o pane no WezTerm** (`wezterm cli kill-pane`), não
esconder a sessão do painel. A confirmação mostra o título e o `#id` — os títulos se
repetem — e avisa quando a sessão está trabalhando, porque nesse caso ela é
interrompida no meio.

O pane onde o próprio deck roda é recusado pelo servidor: excluí-lo mataria o
processo que está respondendo ao pedido.

Se a sessão excluída era a que estava em tela cheia, o painel abre sozinho a
próxima da lista.

### Agrupar sessões por tema

Para ver de relance sobre o que cada agente está trabalhando, junte as sessões em
grupos coloridos — "incidentes", "fotolivros", o que fizer sentido.

**Criar:** botão **+ grupo** no topo do menu lateral. Dê um nome (até 32
caracteres) e escolha uma das seis cores. **Enter** salva.

**Colocar uma sessão num grupo**, de três jeitos:

- **arraste** a linha do menu lateral para cima do grupo
- **botão direito** na linha (ou no cabeçalho do card) → *mover para* → o grupo
- no mesmo menu, *novo grupo…* cria um grupo já com aquela sessão dentro

Soltar uma sessão em **sem grupo** tira ela do grupo — esse alvo reaparece
sozinho enquanto você arrasta, mesmo que esteja vazio.

**No cabeçalho do grupo:** clicar colapsa e expande; botão direito abre *renomear /
mudar cor* e *excluir grupo*. Mesmo colapsado, o cabeçalho continua mostrando os
pontos coloridos e a contagem por estado — colapsar nunca esconde uma sessão que
está esperando por você.

**Excluir um grupo não encerra sessão nenhuma**: elas voltam para "sem grupo".

Os grupos aparecem nas duas visões: como seções no menu lateral, como faixas de
largura inteira na grade, e como uma etiqueta colorida no cabeçalho de cada card.
A cor do grupo nunca vai na borda esquerda do card — aquela continua sendo o
estado da sessão.

Com zero grupos criados o painel fica exatamente como era antes.

**Onde isso fica guardado:** num `deck-state.json` ao lado do `server.js`, não no
navegador. É a única informação do painel que não vem do `wezterm cli` — agrupar
por tema é coisa sua, o terminal não sabe disso.

Um detalhe que vale saber: **o pane-id reinicia junto com o WezTerm**. Quando isso
acontece, o deck mantém os grupos (nome, cor, ordem) e esvazia os membros — senão
um pane novo herdaria o grupo de um que morreu. Panes fechados saem do arquivo
sozinhos.

### Guarda de menu

Quando o Claude abre um diálogo (confiar na pasta, pedir permissão, escolher
opção), ele já deixa uma opção **pré-selecionada** e o Enter confirma **ela**. Se
você digitasse "espera, não faz isso" e desse Enter, o texto poderia ser engolido
e o default aprovado.

Por isso o `/api/send` relê o pane **no momento do envio** — o retrato do painel
pode estar 1,5s atrasado — e devolve **409** se achar um diálogo. O card avisa, a
caixa trava e o rascunho volta intacto. Nesse caso, responda pelo WezTerm (botão
**⤢**) ou mande **Esc**.

Com diálogo aberto o card também para de cortar a moldura, para as opções ficarem
visíveis.

### Variáveis

| variável | padrão | efeito |
|---|---|---|
| `DECK_PORT` | 7788 | porta do servidor |
| `DECK_TAIL` | 18 | linhas úteis por card na grade |
| `DECK_FULL_TAIL` | 200 | linhas no card aberto em tela cheia |

Em PowerShell: `$env:DECK_TAIL=30; node server.js`

## Editar o projeto

- **`public/index.html`** é lido do disco a cada request: editou, basta recarregar
  a aba.
- **`server.js`** exige reiniciar o processo. E **todo restart gera um token novo**,
  então uma aba aberta de antes passa a tomar 401 até ser recarregada.
- **`deck-state.json`** é escrito pelo servidor e guarda só os grupos. Pode ser
  apagado a qualquer momento: o painel volta sem grupo nenhum, e nenhuma sessão é
  afetada. Editar à mão é seguro — BOM o servidor tolera; só um JSON realmente
  quebrado faz os grupos recomeçarem vazios, e nesse caso ele avisa no console.

## Se der problema

| sintoma | causa |
|---|---|
| `porta 7788 já está em uso` | já tem um deck rodando; feche-o ou use `DECK_PORT` |
| nenhum card aparece | rodou fora do WezTerm, sem `WEZTERM_UNIX_SOCKET` |
| `401` / painel vazio após restart | token novo; recarregue a aba |
| `servidor desatualizado` no card | página nova contra servidor velho; reinicie o `node` |
| `409` ao enviar | diálogo aberto no pane; use ⤢ ou Esc |
| `400` ao abrir sessão nova | a pasta não existe, ou não é caminho absoluto |
| `400` ao excluir uma sessão | é o pane onde o próprio deck está rodando |
| `404` ao excluir uma sessão | o pane já tinha sido fechado; o painel se atualiza sozinho |
| os grupos continuam, mas as sessões saíram deles | o WezTerm foi reiniciado: os pane-ids mudaram e os membros foram zerados de propósito |
| os grupos sumiram todos de uma vez | `deck-state.json` ficou ilegível; o servidor avisa no console e recomeça vazio |

Para ver quem está ocupando uma porta (bash, prompt `!`):

    powershell.exe -NoProfile -Command 'Get-NetTCPConnection -LocalPort 7788 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }'
