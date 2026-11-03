# claude-deck — app desktop

O terminal **é** o app. Cada sessão Claude nasce dentro dele, num PTY que ele
mesmo abre, e aparece numa janela única com menu lateral à esquerda e a sessão
ao vivo à direita. O WezTerm não entra mais na história.

Isto é a camada nova, ao lado da versão web (`../server.js`), que continua
intacta e funcionando. As duas não conversam.

- **Como funciona por dentro, e por quê:** [ARQUITETURA.md](ARQUITETURA.md)
- **O que foi testado e o que não foi:** [VERIFICACAO.md](VERIFICACAO.md)

## A diferença que motivou a migração

A versão web lia a tela do WezTerm com `wezterm cli get-text` a cada 1,5s e
escrevia nela com `send-text`. Daí vinham todos os limites: sem cor, sem
streaming, moldura cortada na heurística, estado inferido do título com atraso,
texto injetado grudando no que já estava digitado.

Aqui o app é dono do processo. O que isso muda:

| | versão web | app |
|---|---|---|
| saída | retrato a cada 1,5s | stream ao vivo, com cor |
| entrada | `send-text` (paste) | você digita no terminal |
| estado | título lido no polling | evento `OSC` no instante em que muda |
| identidade da sessão | pane-id, reinicia com o WezTerm | UUID do app, sobrevive ao resume |
| sessão morre quando | — | o app fecha (veja abaixo) |

**O preço:** fechar o app encerra todas as sessões. É inerente a ser dono do
PTY. A rede de segurança é o `--resume`: cada sessão nasce com `--session-id
<uuid>`, o uuid fica salvo, e **retomar** reabre a conversa de onde parou.
Ao fechar com sessões abertas o app pergunta antes, dizendo quantas estão
trabalhando.

## Rodar

    cd app
    npm install
    npm start

O `npm install` precisa rodar os install scripts do `electron` (baixa o binário)
e do `node-pty`. No npm 11 eles vêm bloqueados; se o `npm start` reclamar:

    npm install-scripts approve electron
    npm install-scripts approve node-pty

Não é preciso compilar nada: o `node-pty` 1.1 usa Node-API e o binário
pré-compilado que vem no pacote roda no Electron sem `@electron/rebuild`
([por quê](ARQUITETURA.md#node-pty-sem-rebuild)).

## O que dá para fazer

**+ sessão** — abre o Claude numa pasta. O campo aceita digitar ou colar; o
botão **…** abre o seletor de pastas do sistema; a lista suspensa traz as pastas
das sessões que você já abriu. Dá para escolher o grupo já na criação.

**Menu lateral** — uma linha por sessão, com ponto colorido, nome e estado.
Clicar abre a sessão. As que esperam por você sobem para o topo.

| estado | quando | cor |
|---|---|---|
| **precisa de você** | a sessão está travada num diálogo | rosa |
| **concluído** | título começa com `✳` | verde |
| **trabalhando** | spinner girando | amarelo |
| **iniciando…** | subiu agora, ainda sem título próprio | cinza |
| **encerrada** | não está rodando; dá para retomar | cinza escuro |

"precisa de você" vem **antes** do glyph: uma sessão parada num pedido de
permissão tem glyph de parada, mas não concluiu nada.

**A sessão na tela** é um terminal de verdade: digite, cole, role, selecione.
`Ctrl+C` copia quando há seleção e interrompe quando não há. `Ctrl+V` cola.

**Grupos** — **+ grupo** cria; arraste a linha do menu lateral para dentro, ou
use o botão direito → *mover para*. Excluir um grupo não encerra sessão nenhuma.
A cor do grupo nunca vai na borda esquerda do card: aquela é o estado.

**Encerrar** — o **✕** no cabeçalho, botão direito → *encerrar sessão*, ou
`Delete` na linha focada. Sempre com confirmação, que avisa quando a sessão está
trabalhando. O histórico fica: dá para retomar depois.

**Retomar** — uma sessão encerrada continua na lista em cinza. Abrir ela mostra
o botão **retomar**, que roda `claude --resume <uuid>` na mesma pasta. A conversa
anterior volta na tela. *Esquecer* tira ela da lista de vez.

## Onde fica o estado

Num `deck-state.json` dentro de `app.getPath("userData")` — no Windows,
`%APPDATA%\claude-deck-app\`. O caminho exato sai no `bootstrap` e no console.

Guarda três coisas: os grupos, quem está em qual grupo, e o catálogo de sessões
conhecidas (id, pasta, nome, quando fechou). Nada de conteúdo de conversa — isso
é do Claude, em `~/.claude/projects/`.

Apagar o arquivo é seguro: você perde os grupos e a lista de sessões retomáveis,
e nada mais.

## Testes

    node main/_smoke.js                               # lógica pura, sem Electron
    node main/_smoke.js --live "D:\alguma\pasta"      # + uma sessão real
    npx electron . --selftest "D:\alguma\pasta"       # ponta a ponta, pela UI

O `--selftest` dirige a interface de verdade (clica nos botões do renderer),
abre uma sessão Claude real, conversa com ela, encerra, retoma e confere que a
conversa voltou. Gasta alguns tokens, por isso não roda sozinho.

## Limites conhecidos

- **Uma sessão na tela por vez.** A grade com vários cards lado a lado ainda não
  foi portada — veja [ARQUITETURA.md](ARQUITETURA.md#o-que-falta).
- **Sem empacotamento.** Roda por `npm start`; não há `.exe` instalável ainda.
- **Só Windows, por ora.** O código não tem nada de específico além do caminho
  do `claude.exe`, mas só foi testado aqui.

## Atalhos

| tecla | ação |
|---|---|
| `Enter` | envia |
| `Shift+Enter` | quebra linha (medido: o app manda `\n`) |
| `Ctrl+C` | copia se há seleção, senão interrompe a sessão |
| `Ctrl+V` | cola (multilinha não envia o prompt) |
| `Delete` | encerra a sessão com a linha do menu lateral focada |

`Ctrl+R` **não** recarrega a janela: o menu default do Electron foi removido
para não roubar teclas do terminal.
