# C57 — reconstrução LOCAL do histórico e integração de P05, P06 e P07

> **Estado: preparado localmente, NÃO publicado.** Nada daqui foi empurrado,
> mergeado na `main` ou aberto como PR. Em 17/09/2026 não existia branch remota
> nem PR para a épica ou para as branches de agente: `git ls-remote --heads
> origin` (374 heads) filtrado por `hermes|mh-|integracao` voltou vazio, e
> `gh pr list --state all` com `--search hermes` e com `--head` de cada uma das
> quatro branches voltou vazio. Publicar esta linha é um `push` de branch NOVA —
> não um force-push — e continua exigindo autorização explícita do dono.

## 1. Por que existe

O job bloqueante `typecheck + test + lint + build` roda
`scripts/check-commit-trailers.ts`, que reprova qualquer commit da PR com
`Co-Authored-By:` de assistente de IA (AGENTS.md § Coautoria). Seis commits da
épica traziam `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`, e as três
branches de agente partiam de um deles (`7993e563`). Mergear essas branches como
estavam traria os seis commits de volta como ancestrais.

**Correção do registro original.** O C57 falava em SETE commits. O sétimo,
`e3d6993b`, só cita `Co-Authored-By:` em PROSA no corpo (linha 64); o gate testa
cada linha contra `^\s*co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$` e não o
rejeita. O número 7 veio de `git log --grep`, que é falso positivo. O gate real,
executado, rejeita exatamente seis (seção 6).

## 2. Autorização e limites

Autorizado pelo dono em 17/09/2026, somente LOCAL: nova branch/worktree de
integração, reconstrução da linha da épica com mensagens conformes, transporte
de P05/P06/P07 por dependência, sem reescrever `main`, branches remotas nem as
branches originais dos agentes, sem descartar alterações locais, sem push, sem
merge em branch compartilhada.

## 3. Refs envolvidas

**Backups** (criados antes de qualquer escrita, conferidos iguais aos tips):

| Backup | SHA |
|---|---|
| `backup/c57-20260917/claude/maia-hermes-integration-158579` | `8003ee05110d51edace11e1e8c22fe25836009b4` |
| `backup/c57-20260917/claude/mh-p05-broker` | `8a309b3deb9db69fb416afed415b76469a6e4aae` |
| `backup/c57-20260917/claude/mh-p06-gateway` | `0a7d6e00f0c7023f95b7ebf92dc94c9937eb0eb7` |
| `backup/c57-20260917/claude/mh-p07-supervisor` | `5627eda07165226b1174111cd43e2690cb5590fb` |
| `backup/c57-20260917/claude/mh-p00-worker` | `053a23ba29083e4e6e2135e2520d02a2ad908556` |
| `backup/c57-20260917/claude/mh-p01-charact` | `ec4a27e87dd4c9d4ae00e9b18a7aa570bf1c9ef8` |
| `backup/c57-20260917/main` | `2bbeefe9de1784a3c90c184ea80d8f0cc6119ad1` |

As branches originais continuam nos mesmos SHAs (conferido depois da
integração). **Refs novas:**

| Ref | SHA | O que é |
|---|---|---|
| `claude/mh-c57-epica` | `155d09022adef907bcdfcd691003d07506ccaa2d` | linha da épica reconstruída, antes da integração |
| `claude/mh-c57-p05-broker` | `d589191af5b2a6d618d8aa029b661a59400a5a50` | cópias do P05 sobre `18e9843e` |
| `claude/mh-c57-p06-gateway` | `fbfb61f2db63a251f3874eeb2c8322e667795cb8` | cópias do P06 sobre `18e9843e` |
| `claude/mh-c57-p07-supervisor` | `3cb3b2afa4d4a0d8d23e85127cf12200b5bdb80a` | cópias do P07 sobre `18e9843e` |
| `claude/mh-integracao-c57` | (tip corrente) | a linha integrada; worktree `.claude/worktrees/mh-integracao-c57` |

**Estado dos agentes antes da escrita:** worktrees de P05 e P06 limpas (inclusive
não rastreados), últimos commits em 16/09 às 12:02, 11:57 e 11:27, nenhum
processo com a worktree na linha de comando, nenhuma sessão par no repositório.
A worktree do P07 estava limpa às 11:36 e **foi removida às 11:37:52 por agente
que não identifiquei** — não por comando meu nem dos investigadores somente-leitura
(transcrições conferidas). Todo o conteúdo está em `5627eda0` e no backup.

## 4. Escopo mínimo

O primeiro commit rejeitado é `378999e1`, cujo pai é `001a0098`. Tudo até
`001a0098` — inclusive os dois merges da épica (`7058b5fc`, `cda8263e`) — fica
com os MESMOS SHAs. Reconstruídos: 20 commits lineares da épica
(`001a0098..8003ee05` na notação do git, que exclui o ponto de partida — de
`378999e1` a `8003ee05`, inclusive) + 17 dos agentes (6 + 9 + 2) = **37**.

**Convenção de intervalo.** Neste documento, `A..B` segue a semântica do git
(exclui `A`). As mensagens dos três merges escrevem o intervalo de forma
INCLUSIVA (`3edb9420..8a309b3d` para "seis commits"); já estão gravadas e não
foram reescritas. **Nota sobre a mensagem de `155d0902`:** é cópia byte a byte
de `8003ee05` e por isso ainda diz "trailers de IA em 7 commits" — o número
certo é 6 (seção 1); mudar a mensagem quebraria a cópia fiel.

## 5. Método e critério de equivalência

`git commit-tree <árvore original> -p <pai novo>`, com `GIT_AUTHOR_*` e
`GIT_COMMITTER_*` copiados do original. A pré-condição — árvore da base nova
igual à da base original — foi verificada pelo script, que aborta se falhar.
Com ela, "mesma árvore, pai novo" é a cópia fiel por CONSTRUÇÃO; um cherry-pick
chegaria ao mesmo resultado pela maquinaria de merge, e a identidade viraria
consequência a conferir. A mensagem só muda quando tem trailer de IA com
endereço `@anthropic.com` no bloco final; coautoria humana seria preservada (não
havia nenhuma).

Conferido **de forma independente do script**, com git puro, em cada um dos 37
pares: árvore igual, autor/committer/datas iguais, `git patch-id --stable`
igual, e diff de mensagem = vazio (31) ou exatamente a linha do trailer mais a
linha em branco que a precedia (6). As 17 cópias partem de `18e9843e`, e nenhum
dos 6 commits rejeitados é ancestral de nenhuma tip nova.

**Diferenças intencionais:** as 6 remoções de trailer; os três merges de
integração; o commit do C27 (`afde96d7`); este commit de documentação.
**Diferenças acidentais:** nenhuma encontrada — a árvore integrada, antes do
C27, é `8f4d7d1ec3f7eb828233c555af9c419f8911a9b1`, exatamente a que
`git merge-tree --write-tree` previu antes de qualquer escrita.

## 6. Tabelas de mapeamento

### Linha da épica (`001a0098..8003ee05` → `001a0098..155d0902`)

Base original `001a0098` → base nova `001a0098` (mesma árvore). Tip `8003ee05` → `155d0902`.

| # | Original | Reconstruído | Árvore | Autor/committer/datas | Mensagem | Assunto |
|---|---|---|---|---|---|---|
| 1 | `378999e1a07033cf72630fe5747a9c56e7b0a347` | `6d56590b64d51503edcb449e20f2eec54a381d60` | = | = | −1 trailer de IA | feat(db): fechamento do run com prova de outbound (P03.6b) |
| 2 | `4b9daed3366144bd49eb32b26921a26b78c57745` | `114dbfa525c96d595a008f47bc3ef01f42cbea2b` | = | = | −1 trailer de IA | feat(db): varredura do journal, cross-tenant e sob ALS (P03.7a) |
| 3 | `606827835fa512aeaf6e1c3514af049a1e73adce` | `c54f01a9021b1db3ad74aea3088078753b32f166` | = | = | −1 trailer de IA | feat(db): manutenção de metadata do journal (P03.7b) |
| 4 | `277f14e93f66f8ea4322a9782029d35617bda6b0` | `dd980e6ed3bfcd06fbf42e1a9a0be114a065239b` | = | = | −1 trailer de IA | test(db): caracterização de engine_projections (P03.8a) |
| 5 | `f2f4b4f90ae21eb8814b892b5d0c8b1e23b13055` | `6102d66d233449f7cd6a9ac2acb2428f917f110c` | = | = | −1 trailer de IA | feat(runtime): política de recovery do journal (P03.8b) |
| 6 | `7993e56339c202e472a400a06765058a5c0d8fa7` | `18e9843ef3ed32e43dee0a950d1962a358db5c14` | = | = | −1 trailer de IA | feat(db): tabela de comandos do controle humano (P04.1) |
| 7 | `e3d6993b492cb631ed2f230be319609546bc5d41` | `6aaa3fbdbc06e40bffb687e17791d86fe5f78695` | = | = | = | feat(governance): vocabulário de auditoria do controle humano (P04.2) |
| 8 | `5b7405e2784bcc2c0c7d47c8aa1517a051bc66a6` | `39fe8b6841d010881e237f398be29da517c2a580` | = | = | = | docs(hermes): validação pessoal do P07 e dois achados adotados (C25, C26) |
| 9 | `ef90c38e23ceed58639a2418a9761f6a9b7ed727` | `984cd583b7df2581f0219d4b6638b74a29aa9922` | = | = | = | docs(hermes): validação de P05/P06 e as contradições das três frentes (C27-C39) |
| 10 | `40cc3c1f94716509020ddd1a811b5eaf592b8c31` | `af29cf818e3f2adf601a1911d23cb7270146b06c` | = | = | = | refactor(db): extrai o trancamento do controle para módulo puro (P04.3a) |
| 11 | `f92f0d4de64b05a9bc7ff71aa967e1b2c490f6a0` | `f677817573520b3a2a089ab20b4e801df10846ba` | = | = | = | feat(db): transação de pausa do controle humano (P04.3b) |
| 12 | `dca217d5425669f3f4f87ed8862e532cd7cb8d3f` | `1049d33b4e6d3da6b6ca7015894148380909d7ec` | = | = | = | feat(db): reconciliação `pausing → human` do controle humano (P04.4) |
| 13 | `51e61cd5c9dab233d548861042f4a4ed6bc7f8e2` | `4ca75fe1275ea2d3a33c8db5815ea692ad3bb439` | = | = | = | feat(db): retomada `human → bot` com watermark de ingresso (P04.5a) |
| 14 | `52ae2c0e16ce0e5bbbd4a2f00d6031cd8d005455` | `1d56b7678ecab695d6060e4302cf3fd96939e384` | = | = | = | feat(turns): hold de admissão/claim sob controle humano (P04.6) |
| 15 | `0b581c66287d0fbed3bcb39e5e55c4fe0a203688` | `108327726bfb8ebeff275914edef252eb2af8bd2` | = | = | = | feat(turns): arestas manuais de descarte de backlog no contrato (P04.5b.1) |
| 16 | `703236f9ac553011965ef5401b07571539d8a9de` | `145d5b1cc8e9709bf7045117789c3746e1c4fbea` | = | = | = | feat(db): construtores puros do descarte de backlog retido (P04.5b.2a) |
| 17 | `7c2fee783fd4fa07f8966cd69294e36d25353af8` | `39021b28e8cdbbccd858dbc910a218b0f64ffa75` | = | = | = | fix(turns): hold de controle humano no fechamento de debounce (P04.6b) |
| 18 | `87c3106c77737c8bc416ca26a3f6183afc4188e5` | `75be29ced2283589b0e60cb4e5d1f041b1b5680e` | = | = | = | feat(turns): primitiva do descarte administrativo de backlog retido (P04.5b.2b) |
| 19 | `3b138664af8ba8895dec46ed7f57ca921072ae9f` | `a80889655bb5d66005220f6e0002a8a9ff706813` | = | = | = | feat(db): resume descarta o backlog retido — `future_only` executado (P04.5b.2c) |
| 20 | `8003ee05110d51edace11e1e8c22fe25836009b4` | `155d09022adef907bcdfcd691003d07506ccaa2d` | = | = | = | docs(plans): registra C57 — trailers de IA em 7 commits reprovam gate bloqueante |

### P05 — `claude/mh-p05-broker` → `claude/mh-c57-p05-broker`

Base original `7993e563` → base nova `18e9843e` (mesma árvore). Tip `8a309b3d` → `d589191a`.

| # | Original | Reconstruído | Árvore | Autor/committer/datas | Mensagem | Assunto |
|---|---|---|---|---|---|---|
| 1 | `3edb9420fec9c05ab8635f0d7a9e6831c03d2712` | `e365b2562f8f8e78d8adc83d7ab219c5b53d6ec1` | = | = | = | feat(hermes): manifest estrito do runtime, default vazio (P05, K-19) |
| 2 | `37db03610934297ed41d4e93090e0da7c257fe14` | `76849537a14dde5254789aff2321dcf5a891a27e` | = | = | = | feat(hermes): RunBinding congelado e ACL de recurso (P05, T19/T24) |
| 3 | `5424f676f330cfcffab3452b0ae85cdab17d6fd5` | `949f98ed5ab40ff8c7c9daea94172b362f0ff6cd` | = | = | = | feat(hermes): superfície efetiva e admissão de tool (P05, INV-03) |
| 4 | `16b9f0b9ef54729b7d40a3bce48dc2b06dbde179` | `1d1c5ae11cca295df3b7cfa9c34edec262bbdc97` | = | = | = | docs(hermes): relatório da fatia de contrato/política do P05 |
| 5 | `989355eb54250dca57e7b5378fe96b20ac40c5bb` | `f17fac7f3a95dd7097a333d3aa9112241d789d07` | = | = | = | fix(hermes): estourar teto de profundidade recusa, não silencia (P05) |
| 6 | `8a309b3deb9db69fb416afed415b76469a6e4aae` | `d589191af5b2a6d618d8aa029b661a59400a5a50` | = | = | = | docs(hermes): registra o fail-open de profundidade e as correções de referência |

### P06 — `claude/mh-p06-gateway` → `claude/mh-c57-p06-gateway`

Base original `7993e563` → base nova `18e9843e` (mesma árvore). Tip `0a7d6e00` → `fbfb61f2`.

| # | Original | Reconstruído | Árvore | Autor/committer/datas | Mensagem | Assunto |
|---|---|---|---|---|---|---|
| 1 | `309abf2e6588d93d9f36b17cf95ca2cc2c71112f` | `6a1eb8428b2886c9b61ee9236e7699e65747882d` | = | = | = | feat(hermes): contrato do gateway de inferência e validação de grant (P06.1) |
| 2 | `58e7fe976b1da3d5da5b25cd784740c0363b2494` | `086429348a5a561835502078758c0f3652566e7f` | = | = | = | feat(hermes): contabilidade idempotente e reserva de admissão (P06.2) |
| 3 | `c93dc128c3baa4ccf8718cc2b92d731ec763ea11` | `d96582125f2db7118bcbe001168596bebb6bcf7a` | = | = | = | test(hermes): fecha lacunas que a verificação por mutação revelou (P06.3) |
| 4 | `9f5063d320d5cc72a7989776f68a6e55c9dbe611` | `05be988460a845487e2dc119c634baca41580fb5` | = | = | = | feat(hermes): schema estrito da resposta do gateway (P06.4) |
| 5 | `1d820bcccb9671687d4ce1ecbb89305debce39e1` | `950d9fa89066c410ad3f82ef285243f86f26216a` | = | = | = | docs(hermes): relatório da fatia de contrato/política do P06 |
| 6 | `5736e2964dc66772e36144d2624de1ed5df24985` | `46cdb92e327119dfc030c939f77b638b43dc0cac` | = | = | = | test(hermes): cobre o fail-closed de instante ilegível no grant (P06.5) |
| 7 | `56fdff483f1a19990f576322762a2b2bdae5caba` | `1a4b4e6875a3caf5dbfe1879ff862f0af00789fd` | = | = | = | docs(hermes): corrige o relatório do P06 após a revisão independente |
| 8 | `99845c948b31108d147c9c32f040949e93aa3384` | `9e722ac1eec640ea3b54d4a129601fde82dcd256` | = | = | = | feat(hermes): valida pares tool_call/tool_result no gateway (P06.6) |
| 9 | `0a7d6e00f0c7023f95b7ebf92dc94c9937eb0eb7` | `fbfb61f2db63a251f3874eeb2c8322e667795cb8` | = | = | = | docs(hermes): atualiza o relatório após a metade "para frente" do C26 |

### P07 — `claude/mh-p07-supervisor` → `claude/mh-c57-p07-supervisor`

Base original `7993e563` → base nova `18e9843e` (mesma árvore). Tip `5627eda0` → `3cb3b2af`.

| # | Original | Reconstruído | Árvore | Autor/committer/datas | Mensagem | Assunto |
|---|---|---|---|---|---|---|
| 1 | `a1c3de3aa6cd50a4920dd67ff6483ea48ea94c84` | `1fab7778a8dbafdd2380815ab6cc528bf59142b4` | = | = | = | feat(hermes): política pura do supervisor (P07 — contrato) |
| 2 | `5627eda07165226b1174111cd43e2690cb5590fb` | `3cb3b2afa4d4a0d8d23e85127cf12200b5bdb80a` | = | = | = | docs(hermes): relatório do P07 (contrato + política pura do supervisor) |

### Integração (commits novos, sem equivalente original)

| SHA | Commit | Pais |
|---|---|---|
| `9a22fc21` | `merge(p05): integra o manifest estrito, o RunBinding e o broker de tools` | `155d0902` + `d589191a` |
| `ed0cd748` | `merge(p06): integra o contrato do gateway de inferência e a contabilidade de custo` | `9a22fc21` + `fbfb61f2` |
| `3b7fe541` | `merge(p07): integra a política pura do supervisor` | `ed0cd748` + `3cb3b2af` |
| `afde96d7` | `fix(hermes): nome da tool de fixture obedece K-19 (C27)` | `3b7fe541` |
| `2608feb2` | `docs(plans): registra a integração local do C57 e o C27, com o mapeamento de commits` | `afde96d7` |
| `a5730a0f` | `fix(migrations): restaura LF no ledger RESERVATIONS.md…` (achado da revisão adversarial) | `2608feb2` |
| `95aed007` | `test(hermes): guarda do C27 cobre progress.tool_name e as linhas cruas` (achado da revisão) | `a5730a0f` |

Commits posteriores a esta tabela (correções de documentação) estão no log do git
e no VERIFICATION-LOG; um documento não consegue citar o SHA do commit que o grava.

Ordem P05 → P06 → P07: a spec (cap. 10, linhas 2627-2629) declara P06
dependendo de P05 e P07 de P03–P06, e os relatórios dos agentes apontam os
handoffs no mesmo sentido. Não há dependência de CÓDIGO entre as três (nenhum
import cruzado; interseção de arquivos vazia), então a ordem é de rastreabilidade,
não de conflito — os merges comutam sem conflito, par a par e encadeados.

## 7. Gate de trailers — resultado efetivo

Evento de PR JSON UTF-8 sem BOM, `base.sha = 2bbeefe9`, `base.ref = main`
(o script usa `origin/main`, igual ao CI), `head.sha` real, executado com Node
v22.23.2 pelo runner do projeto (`tsx scripts/check-commit-trailers.ts`), sem
alterar o script:

| head | exit | saída |
|---|---|---|
| `8003ee05` (épica antiga — controle negativo) | **1** | rejeita `7993e563`, `f2f4b4f9`, `277f14e9`, `60682783`, `4b9daed3`, `378999e1` |
| `3b7fe541` (integração, antes do C27) | **0** | `passou: 55 de 60 commit(s) do intervalo inspecionado(s)` |
| sem `GITHUB_EVENT_PATH` | 0 | `pulado` — **não conta como aprovação** |

~~A execução na tip FINAL fica registrada no log de verificação (V-047).~~
**Corrigido:** essa frase prometia um registro que o V-047 não tinha (achado da
revisão adversarial). As execuções nas tips posteriores — `afde96d7` (56 de 61),
`2608feb2` (57 de 62), `a5730a0f` e `95aed007` — estão no V-049. A execução na
tip do commit que grava estas linhas não pode ser registrada por ele mesmo; ela
é informada ao dono no relatório da integração.

## 8. Como ler SHAs antigos nos documentos

Entradas anteriores do IMPLEMENTATION-STATE, do VERIFICATION-LOG, da
REQUIREMENTS-MATRIX e dos AGENT-REPORT citam SHAs da linha ORIGINAL (por exemplo
`7993e563`, `a1c3de3a`, `99845c94`). Esses registros são históricos e **não
foram reescritos**: reescrevê-los dentro dos commits reconstruídos mudaria as
árvores e destruiria a prova de equivalência da seção 5. Para localizar o commit
correspondente na linha integrada, use as tabelas da seção 6. Os originais
seguem alcançáveis **só LOCALMENTE**, pelas branches originais e pelos backups —
nenhuma delas está no remoto. Para quem revisar no GitHub depois de um push, os
SHAs antigos não resolvem, e a tabela da seção 6 é a ÚNICA tradução.

## 9. O que ainda exige autorização

- `git push` da branch nova `claude/mh-integracao-c57` e abertura da PR contra
  a `main` (não há histórico remoto a substituir).
- Decidir o destino das branches antigas (`claude/maia-hermes-integration-158579`
  e as três de agente): ficam intactas; apagá-las continua NÃO autorizado.
- O job `fault injection (#510)` deve reprovar por outro motivo (C58), que
  pede decisão sobre CI antes de abrir a PR.
