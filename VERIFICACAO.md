# Estado de verificação

O que foi testado de fato, como, e o que continua sem teste. Escrito em
2026-10-28, ao fim da construção inicial; atualizado em 2026-10-30, quando
entraram o menu lateral e a tela cheia, e em 2026-11-03, quando entraram a
exclusão de sessão e os grupos.

A novidade de 03/11 é que **a página rodou num navegador pela primeira vez**. Boa
parte do que estava em aberto desde 30/10 fechou aí; o que continua aberto está
listado no fim, com o motivo.

A regra aqui: nada sobe para "verificado" por parecer certo no código. Sobe
quando houve um teste que teria falhado se estivesse errado.

## Verificado

| Afirmação | Como foi testado | Resultado |
|---|---|---|
| `wezterm cli list --format json` enumera os panes e o título carrega o estado | leitura direta, 3 amostras seguidas | `✳` estável em panes parados, `◐`/`◑` nos que trabalhavam |
| `✳` = parado, outros glyphs = trabalhando | a sessão que estava trabalhando (a própria, durante o teste) aparecia com `◑`; as paradas com `✳` | confirmado |
| `get-text` devolve UTF-8 legível no Windows | `get-text` num pane com acentuação | acentos e box-drawing íntegros |
| `get-text --start-line -N` devolve N + viewport, não N | contagem de linhas devolvidas com `-16` | ~51 linhas, não 16 |
| As ~7 linhas finais são moldura | dump completo do `tail` de um card | confirmado; motivou o `stripChrome` |
| `send-text` via stdin preserva acento e travessão | `printf` e `spawn` do node num pane PowerShell descartável | `olá ção — acentos` íntegro |
| **Texto + `\r` submete de verdade no Claude Code** | sessão Claude real num pane descartável; enviado "Responda apenas com a palavra: ok" | a sessão respondeu `● ok` — era o teste mais importante |
| `Esc` interrompe / limpa a linha | `\x1b` com `--no-paste` num pane com texto digitado | linha limpa |
| `activate-pane` existe e aceita `--pane-id` | `--help` | confirmado (o efeito visual **não** foi testado) |
| Token obrigatório em `/api/*` | request sem header | 401 |
| Token válido passa | request com header | 200 |
| `Host` estranho é recusado | `Host: evil.com` | 403 |
| `/api/send` recusa GET | GET na rota | 405 |
| Placeholder do token é substituído na página servida | grep por `__DECK_TOKEN__` na resposta | ausente; token presente |
| Envio completo pelo HTTP com acento | POST com corpo UTF-8 vindo de arquivo | `via HTTP: ação — ok` executado no pane |
| Guarda de menu devolve 409 | menu falso impresso num pane, depois POST em `/api/send` | 409 com mensagem explicativa |
| Guarda de menu marca `menu=true` e preserva as opções no card | snapshot do pane com menu falso | `menu=true`, moldura não cortada |
| `MENU_RE` não dá falso positivo | 5 casos: 2 diálogos reais capturados, 1 prompt de permissão **sintético**, sessão normal digitando, prompt vazio | 5/5 corretos |
| Sem falso positivo nos panes reais | snapshot de todos os panes em uso | `menu=false` em todos |
| Porta ocupada dá erro amigável | subir um segundo servidor na mesma porta | mensagem sobre `DECK_PORT`, sem stack trace |
| `?full=N` aprofunda só o pane pedido | `/api/panes` e `/api/panes?full=2` no mesmo servidor | 18 linhas em todos os panes; 200 só no pane 2 |
| Abrir a tela cheia não zera o "parado Xs" | 4 leituras alternadas no mesmo pane parado: rasa, funda, funda, rasa | `quietFor` 43 → 45 → 46 → 48, sempre crescendo |
| `full` inválido não derruba a rota | `?full=abc;rm` | 200 com a lista normal (que as outras rotas não aprofundaram foi lido no código, não testado) |
| `/api/spawn` abre uma sessão de verdade | POST com a pasta do próprio repo | 200 com `{paneId:9}`; o id já estava no `cli list` com aquele `cwd`, e 6s depois o título era `✳ Claude Code` |
| Pasta com acento chega íntegra pelo `execFile` | spawn em `…\teste-ação` | o `cli list` devolveu o pane novo com `cwd` terminando em `/teste-a%C3%A7%C3%A3o/`, que é "ação" em UTF-8 |
| Caminho com barra no fim funciona | spawn com a string exata que `/api/panes` devolve (`D:\…\repos\`), que é a que a página manda | 200; pane novo na pasta certa, título `✳ Claude Code` |
| **Prompt de permissão real é detectado** | sessão aberta numa pasta nunca confiada, depois `GET /api/panes` | `menu: true`, e a tela do pane trazia `❯ No, exit` e `Enter to confirm · Esc to cancel` — fecha a lacuna aberta em 28/10 |
| Pane em diálogo sobrevive ao filtro | o mesmo teste | `status: "shell"` (título `claude.exe`) mas `menu: true`, então passa no `status !== "shell" \|\| menu` |
| `/api/spawn` recusa entrada inválida | 5 corpos: pasta relativa, inexistente, um arquivo, `--new-window` e vazio | 400 nos cinco |
| `cwd` por pane bate com a pasta | `cli list` com 8 panes abertos | cada pane com o seu caminho; nenhum caiu no home |
| Sintaxe do script da página | `node --check` no `<script>` extraído | passa |
| Sintaxe do servidor | `node --check server.js` | passa |
| O `.wezterm.lua` instalado carrega | `wezterm show-keys` | 35 bindings ALT registrados |

## Verificado em 03/11 — exclusão e grupos

Tudo rodou num **segundo servidor na porta 7790**, com o deck do usuário na 7788
intocado. O único pane morto em teste foi um criado para isso.

### Servidor (27 asserções automatizadas, 27 OK)

| Afirmação | Como foi testado | Resultado |
|---|---|---|
| `kill-pane` existe e não pergunta nada | `wezterm cli kill-pane --help` | aceita `--pane-id`, sem confirmação |
| `/api/kill` mata o pane | pane descartável criado com `spawn`, depois POST | 204, e o pane sumiu do `cli list` |
| `/api/kill` recusa o pane do próprio deck | POST com o `WEZTERM_PANE` do servidor | 400 |
| `/api/kill` recusa entrada inválida | `pane: "abc"` | 400 |
| `/api/kill` com pane inexistente | `pane: 999999` | 404, não 500 |
| `/api/kill` recusa GET | GET na rota | 405 |
| `/api/kill` exige token | request sem header | 401 |
| Nenhum pane do usuário foi afetado | `cli list` antes e depois de toda a bateria | os 5 panes originais intactos |
| `/api/groups` grava e devolve | POST seguido de GET | o GET devolve exatamente o que o POST gravou |
| Nome é aparado e perde controles | `"  incidentes\u0007  "` | `"incidentes"` |
| Nome é cortado em 32 | nome de 99 caracteres | 32 |
| Nome vazio derruba o grupo | `"   "` | grupo descartado |
| Cor fora da paleta é substituída | `"javascript:alert(1)"` | cor da paleta |
| Id fora do formato é descartado | `"nao-bate"` | sumiu |
| Id duplicado entra uma vez só | dois grupos com o mesmo id | 1 |
| Chave de membro não numérica some | `{"abc": "gteste1"}` | descartada |
| Membro de grupo inexistente some | `{"3": "grupo-fantasma"}` | descartado |
| O card carrega o grupo | pane posto num grupo, depois `/api/panes` | `group: "gteste1"` |
| `/api/panes` continua um array | mesma chamada | `Array.isArray` verdadeiro |
| Matar um pane poda a participação dele | kill do pane agrupado, depois `/api/groups` | a chave sumiu do arquivo |
| Os grupos sobrevivem ao restart do servidor | processo derrubado e subido de novo | 3 grupos e 2 membros de volta |
| **Instância diferente zera membros e mantém grupos** | `instance` trocada para `gui-sock-99999` no arquivo, depois restart | 3 grupos mantidos, `members: {}`, e o arquivo regravado com o socket real |
| **BOM não apaga os grupos** | arquivo regravado com BOM pelo `Out-File` do PowerShell | lido normalmente (sem o tratamento, os 3 grupos sumiam em silêncio — foi assim que o bug apareceu) |

### Página, num navegador de verdade

| Afirmação | Como foi testado | Resultado |
|---|---|---|
| **A página renderiza** | aberta no Chrome | menu lateral, tela cheia e grade corretos |
| Troca de visão | clique em **grade** | os cards apareceram lado a lado |
| Criar grupo pelo formulário | clique em **+ grupo**, nome digitado, Enter | grupo criado, seção "sem grupo" apareceu |
| Botão direito na linha do menu lateral | right-click real | menu com *abrir em tela cheia*, *focar*, *mover para*, *novo grupo…*, *excluir sessão* |
| Botão direito no cabeçalho do card | evento `contextmenu` no `.head` | mesmo menu |
| O `<pre>` não sequestra o menu nativo | `contextmenu` no `<pre>` | `defaultPrevented` falso — copiar texto continua possível |
| Mover para grupo pelo menu | clique real no item do grupo | sessão entrou no grupo, contagem foi para ●1 |
| Etiqueta do grupo no card | inspeção do cabeçalho | `concluído` + `incidentes` lado a lado, borda esquerda ainda sendo o estado |
| Faixas de grupo na grade | visão em grade | `INCIDENTES 1 sessão` e `SEM GRUPO 2 sessões`, largura inteira |
| Colapsar e expandir | cliques reais no cabeçalho | lista some e volta; **a contagem ●1 continua visível colapsada** |
| **Excluir sessão pelo ✕ do card** | clique real, com `confirm` substituído por stub | texto: `Excluir a sessão "pwsh in scratchpad" (#6)? / O pane é fechado no WezTerm.`; pane morto; os outros 4 intactos |
| **Excluir grupo não encerra sessão** | clique real em *excluir grupo* | texto diz `As sessões NÃO são encerradas`; grupo sumiu; as 3 sessões continuaram na lista e os 4 panes vivos |
| Com zero grupos o menu lateral volta ao de antes | depois de excluir o único grupo | nenhuma seção, lista plana |
| Os grupos sobrevivem ao reload da aba | F5 na página | grupos e membros de volta, vindos do servidor |
| Renomear e trocar cor | *renomear / mudar cor* no menu do grupo | formulário veio preenchido com o nome e a cor atuais; salvou nome e cor novos |
| Seletor de grupo da nova sessão | abertura do formulário **+ sessão** | lista com `sem grupo` e os grupos existentes |
| Handlers de arraste | `DragEvent` com `DataTransfer` | `dragover` marcou o alvo, `drop` moveu a sessão, `dragend` limpou a marca |
| **"sem grupo" reaparece durante o arraste** | todas as sessões postas num grupo só, depois `dragstart` | seção vazia escondida antes, visível durante o arraste, e o drop nela tirou a sessão do grupo |
| **Página nova contra servidor antigo não perde dados** | `fetch` stubbado devolvendo 200 com HTML em `/api/groups` e `/api/kill` | alerta `servidor desatualizado — reinicie o node server.js e recarregue esta aba`, e o grupo criado **não** ficou na tela (desfeito) |
| **A armadilha do `railHold`** | `mouseenter` no menu lateral antes do drop | a sessão entrou no grupo na hora, sem esperar o ponteiro sair |
| Sem erro no console | console lido após carga limpa | nenhum erro ou exceção |

## Não verificado

| Afirmação | Por que ainda está em aberto |
|---|---|
| **Arraste com o mouse de verdade** | os handlers foram exercitados com `DragEvent` sintético e funcionaram, mas o Chrome não aceita arraste HTML5 vindo de evento sintetizado de mouse. O arraste real, feito à mão, nunca aconteceu — se ele não iniciar, o menu de contexto faz a mesma coisa |
| **Rascunho e envio pelo navegador** | digitar num card, ver o texto sobreviver aos refreshes, mandar com Enter e tratar 204/409 continuam sem teste de tela. O servidor já foi testado por HTTP |
| **O estado "precisa de você" no menu** | o campo `menu` do card já foi testado no servidor, inclusive contra um diálogo real, mas nunca foi visto pintando a linha do menu lateral |
| **O botão + sessão na página** | a rota `/api/spawn` foi testada direto por HTTP, e o seletor de grupo do formulário foi visto preenchido. Abrir uma sessão pelo formulário — prefill da pasta, Enter/Esc, botão travado durante o pedido, a sessão nova nascendo no grupo escolhido — não foi exercitado |
| **A tecla Delete na linha do menu lateral** | o caminho existe no código e usa a mesma função do ✕, que foi testada, mas a tecla em si não foi apertada |
| **Persistência da visão no `localStorage`** | o reload foi testado para os grupos, que vêm do servidor. Se a visão e a sessão aberta voltam como estavam, não foi conferido nesta rodada |
| **Clique-para-focar** | só o `--help` do `activate-pane` foi lido. Se ele troca de aba e se traz a janela do WezTerm para frente, ninguém viu |
| **Responder menu pelo navegador** | caminho não exercitado; por isso a orientação é usar ⤢ ou Esc |
| **"Mensagem para pane ocupado entra na fila"** | suposição, nunca testada. O card afirma isso como fato — é uma string em `public/index.html` se você quiser suavizar |
| **Colisão das teclas `ALT`** com atalhos do Claude Code | não foi possível localizar a lista de bindings do CLI instalado. `ALT+p`, `ALT+z`, `ALT+x` e `ALT+setas` são candidatos |

## Bugs encontrados testando (e corrigidos)

Registrados porque os dois só apareceram em execução, não na leitura do código:

**O menu de contexto fechava sozinho.** O fecho ouvia `scroll` em fase de captura,
para o menu `position:fixed` não descolar da âncora. Só que o `tick` escreve
`pre.scrollTop` a cada refresh que muda o conteúdo de um card, e isso dispara
`scroll` igual a uma rolagem de verdade: o menu morria em menos de 1,5s. Apareceu
quando o clique em *excluir grupo* simplesmente não fazia nada. Agora o fecho ouve
`wheel` e o `scroll` só de `#rail` e `#grid`.

**BOM no `deck-state.json` apagava todos os grupos em silêncio.** `JSON.parse`
estoura com BOM, e o `Out-File -Encoding utf8` do PowerShell 5.1 grava um — o
Notepad também. Apareceu quando um teste de troca de instância devolveu zero
grupos em vez dos três esperados. Agora o BOM é removido na leitura, e um JSON
quebrado de verdade gera aviso no console em vez de recomeçar calado.

## Checklist para fechar as lacunas

Depois de recarregar a aba do painel:

1. Digite num card e espere 5s — o texto tem que sobreviver às atualizações.
2. Shift+Enter, depois Enter — quebra linha e envia.
3. Clique no **Esc** de um card.
4. Clique no **⤢** e veja se o WezTerm foca o pane certo e vem para frente.
5. Com um diálogo real aberto numa sessão, confira se o card trava a caixa.
6. Teste `ALT+p`, `ALT+z` e `ALT+x` dentro de uma sessão Claude.
7. Clique num item do menu lateral — a sessão abre em tela cheia e o item fica marcado.
8. Digite em tela cheia e espere 5s — foco e texto têm que sobreviver aos refreshes.
9. Recarregue a aba — a visão e a sessão abertas voltam como estavam.
10. Com um diálogo real aberto, confira se o item do menu vira "precisa de você".
11. Clique em **+ sessão**: a pasta vem preenchida, a lista suspensa tem as outras,
    e abrir leva a sessão nova para a tela cheia — dentro do grupo escolhido.
12. Abra uma sessão numa pasta que o Claude não conhece e confirme que ela aparece
    como "precisa de você" mesmo com "só sessões Claude" ligado.
13. **Arraste** uma linha do menu lateral para cima de um grupo, com o mouse mesmo.
    Se o arraste não iniciar, use o botão direito → *mover para* e avise: a linha
    já é `div role=button` justamente para o arraste funcionar.
14. Aperte **Delete** com uma linha do menu lateral focada pelo teclado.
