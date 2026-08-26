# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Unreleased]

### Console: as dez jornadas saem da quarentena e viram gate ([#623](https://github.com/diogenesmendes01/Maia-v2/issues/623), continuação da [#472](https://github.com/diogenesmendes01/Maia-v2/issues/472))

**O que estava acontecendo.** O job `build + e2e do console (admin-ui)` media
cinco testes de boot. As dez jornadas do operador estavam marcadas
`@pendente-472` e ninguém as executava. Medido nesta árvore, contra o artefato
standalone e um banco migrado: **27 casos, 23 reprovando e 4 passando — e os 4
passavam por engano**. `audit-log.spec.ts` terminava num comentário
(`// Verify via API: audit count incremented by 1`) sem asserção nenhuma;
`proposal-approval.spec.ts` afirmava só que existia um `h1`, e o `h1` que ele
encontrava era `Entrar no Maia Console`. Uma suíte que não roda não envelhece:
ela apodrece e mente.

**As duas causas, medidas.** (1) SESSÃO: toda rota protegida redireciona para
`/auth/signin`, e contra o artefato de produção o único profile satisfazível é
`staging`, onde o console registra apenas OIDC. (2) FIXTURES: os ids das specs
(`test-id`, `locked-test`, `test-trace-id`) nem chegavam ao repositório —
`proposals.getProposal` e `traces.getTrace` validam `z.string().uuid()`.

**O que passou a existir.** `tests/admin-ui/e2e/_apoio/sessao.ts` minta o cookie
de sessão com o `encode()` do próprio Auth.js e o `NEXTAUTH_SECRET` do processo:
nenhum provider novo é registrado, nenhuma flag de dev-auth é ligada, e o
middleware, o `auth()`, o `createTRPCContext` e o `assertRole` continuam sendo
exercitados de verdade — o que o teste pula é o handshake com o IdP, que não é
do console. `scripts/seed-admin-ui-e2e-fixtures.ts` semeia usuários por papel,
propostas cujo risco e travas são DERIVADOS do spec pelo caminho de produção
(`src/db/capability-risk.ts`), duas versões de perfil e um trace escrito por
`writeEnvelope`/`writeBody` — assinado, porque a tela recomputa o HMAC na
leitura.

**Um defeito de produção que a quarentena escondia.** A tela de detalhe lia
`proposal.locks` (só as travas DERIVADAS do spec) para decidir banner e botões,
enquanto `proposals.approve` aplica a UNIÃO com as travas da CLASSE de aprovação
(`architectureLocksFor`). Para toda classe cuja trava vem da matriz —
`capability_dangerous_tool`, `policy_rule_hard_limit`, `soul_bias_core_value`,
`identity_drift_correction` — o console mostrava os botões HABILITADOS para
`owner` e o clique voltava `FORBIDDEN: Architecture-lock proposals require
founder role` dentro do modal. O servidor estava certo; a tela prometia uma ação
que ele recusa. Corrigido em
[`src/admin-ui/app/proposals/[id]/page.tsx`](src/admin-ui/app/proposals/%5Bid%5D/page.tsx),
com caso de regressão em `architecture-lock.spec.ts`.

**Determinismo, não retentativa.** As jornadas que MUTAM restauram a própria
fixture antes de cada caso e afirmam o estado FINAL de forma absoluta
(`exatamente uma linha de auditoria`, `exatamente três rejeições`), nunca por
delta: com `retries: 2` no CI, uma asserção por delta ficaria verde na segunda
tentativa herdando a mutação da primeira. A fila do inbox, que é um agregado,
restaura TODAS as fixtures — sem isso ela passaria conforme quem rodou antes.

**O que sobrou em quarentena, e por quê.** Uma spec:
`channel-lines-pairing.spec.ts`, agora marcada `@pendente-runtime` (a #472
fechou; o motivo que resta é outro). `channelLines.startPairing` só grava um
COMANDO em `channel_line_state`: quem produz o QR e o código é o worker
`channel_pairing` do RUNTIME, e o job sobe apenas o console. O critério objetivo
de saída está escrito no cabeçalho do arquivo — subir um runtime com adapter de
canal falso no mesmo job e `getPairingStatus` responder `pairing_available:
true`.

**Gate.** `TEST_ADMIN_UI_MIN_TESTS` sobe de `5` para `27`, e
`tests/unit/ci/admin-ui-e2e-gate.spec.ts` passa a conferir esse piso contra a
contagem de casos das specs fora da quarentena — um piso que não acompanha a
suíte deixaria apagar as jornadas do checkout sem ficar vermelho.

### Ordenação: só o HEAD-OF-LINE da conversa é reivindicável ([#626](https://github.com/diogenesmendes01/Maia-v2/issues/626), fatia C de [#505](https://github.com/diogenesmendes01/Maia-v2/issues/505), fase 6 de 9)

> **AÇÃO DO OPERADOR: aplique a migration `126` ANTES de subir o código, e
> confirme `pg_index.indisvalid` à mão depois** ([runbook §11.4](docs/runbooks/turn-state-machine.md)).
> Ao contrário da `124`, aqui um índice inválido não quebra a invariante —
> quebra o DESEMPENHO: a regra continua correta e passa a varrer o histórico
> inteiro de cada conversa a cada claim. Um `CREATE INDEX CONCURRENTLY` que
> falha deixa o índice inválido e **reaplicar a migration devolve sucesso**, sem
> nenhum sinal do runner.

**O problema.** A #625 respondeu *quantos* turnos de uma conversa podem estar
ativos (um). Faltava responder *qual* — e sem essa resposta, o turno que
ganhava a corrida era o que chegasse primeiro ao claim, não o que chegou
primeiro ao usuário. São as falhas nº 1 e nº 3 da issue-mãe: *M1 e M2 chegam
nessa ordem, mas M2 termina antes de M1*, e *um retry antigo reaparece depois de
um turno mais novo*.

**A regra.** Um turno só é reivindicável quando **não existe turno anterior não
terminal na mesma stream** — "anterior" medido por `first_ingress_seq`, a
fronteira que a fatia A ([#624](https://github.com/diogenesmendes01/Maia-v2/issues/624))
passou a persistir. Nunca por timestamp: a issue-mãe proíbe explicitamente
("timestamps não são fonte primária de ordenação"), porque ordenar por tempo
faria a ordem depender do relógio de cada réplica.

**Uma única definição, quatro consumidores.** A issue é literal sobre o modo de
falha: *"duas cópias da regra de elegibilidade divergem, e a divergência só
aparece durante um recovery"*. A regra vive num módulo PURO
([`src/db/repositories/stream-head-sql.ts`](src/db/repositories/stream-head-sql.ts))
e é chamada pelo `WHERE` do claim (`claimNextEligibleTurn`, renomeado de
`tryClaimTurn`), pelo filtro do recovery (`findRecoverableTurns`), pelo
dispatcher cross-tenant e pelo canário do varredor. Nenhum monta predicado
próprio, e um teste unitário conta as chamadas e proíbe uma segunda cópia
escrita à mão. Sem isso, o varredor rearmaria turnos que o claim vai recusar: a
fila cresce, a métrica de recovery diz que houve trabalho, e a conversa não anda.

**O índice não decide nada — decide o CUSTO.** A regra é um `NOT EXISTS`,
correta sem índice nenhum. A migration `126` cria
`agent_turns_stream_head_live_idx` sobre
`(tenant_id, agent_id, stream_key, first_ingress_seq)` **com os terminais fora
do índice**, e não é redundante com o `agent_turns_stream_head_idx` da `122`:
naquele, `status` vem depois de `first_ingress_seq`, então o `NOT IN` é FILTRO,
não busca. Medido contra PostgreSQL 16 com 205.000 turnos / 20.001 streams /
1.003 vivos / 2 tenants, numa conversa com 5.000 turnos (4.997 concluídos):

| | plano | buffers | tempo |
|---|---|---|---|
| com a `126` | `Index Only Scan`, `Rows Removed by Filter: 0` | 2 | 0,097 ms |
| sem a `126` | `Index Only Scan` no índice largo, **`Rows Removed by Filter: 4997`** | 97 | 2,362 ms |

Sem o índice o custo cresce com o HISTÓRICO da conversa, que nunca encolhe. Com
ele, cresce com o BACKLOG, que é 0–2 na operação normal. Os estados terminais
entram na consulta como **literais**, não parâmetros: o PostgreSQL só usa um
índice parcial quando prova que a cláusula implica o predicado, e com `$1..$4` a
prova depende de plano CUSTOM — a degradação apareceria só depois da sexta
execução da mesma sessão.

**Duas recusas novas, e elas não são sinônimos.** `not_head` é "a conversa tem
fila, e ela anda sozinha" — não faça nada. `stream_blocked` é "o anterior está
em `outbound_pending`, e nenhum claim o move" — vá ao runbook do outbox
([#506](https://github.com/diogenesmendes01/Maia-v2/issues/506)). Esperar
resolve a primeira e não resolve a segunda.

**A decisão de projeto a contestar.** `outbound_pending` **bloqueia a ordem**,
embora a fatia B tenha decidido que ele **não ocupa** a stream. As duas
convivem porque respondem a perguntas diferentes, mas o efeito prático é que uma
indisponibilidade do provedor de saída para a CONVERSA (não o tenant, não a
fila). É o preço de FIFO — responder M2 antes de a resposta de M1 ter saído é
exatamente a inversão que a #505 existe para impedir. A alavanca para não pagar
esse preço é a flag, nunca mexer no predicado.

**O que a recuperação de claim expirado deixou de fazer.** Antes desta fatia, um
head que morria com a lease vencida era destravado pelo SUCESSOR: ele
reivindicava, a transação da #625 recuperava o morto e a conversa andava na hora
— fora de ordem. Agora a recuperação continua acontecendo (é o que devolve o
head a `retryable`), e o sucessor é recusado como `not_head`: quem avança é o
head, na vez dele, quando o varredor o rearmar (até 2 min). **É ordem comprada
com latência no caminho de crash.** A promoção idempotente do sucessor
([#627](https://github.com/diogenesmendes01/Maia-v2/issues/627)) devolve a
latência sem devolver a inversão.

**Observabilidade.** `maia_stream_fifo_violation_total{stage}` (`claim` /
`recovery`) — **sempre zero**, e publicada em ZERO no import: um contador que
nasce na primeira violação satisfaria "sempre zero" por AUSÊNCIA, e nenhum
alerta escrito contra ele dispararia. O estágio `claim` é uma pós-condição
dentro da transação do claim concedido; o estágio `recovery` é uma consulta
separada sobre os ids que o filtro devolveu. Mais
`maia_stream_blocked_total{reason}` e as `audit_log` `turn_stream_blocked`
(com `blocked_by_turn_id`, para reconstruir a fila sem recorrer à `stream_key`)
e `turn_stream_fifo_violation`. Nenhuma carrega `stream_key`, telefone ou
conteúdo.

**Códigos centralizados.** `eligible`, `not_head`, `stream_blocked`,
`stream_busy`, `promoted` — os cinco que a issue nomeia, num vocabulário único
(`STREAM_SCHEDULING_RESULTS` em [`src/runtime/turns/claim.ts`](src/runtime/turns/claim.ts)).
`promoted` entra **sem produtor**, de propósito: a #627 acrescentar um sexto
rótulo a uma série de métrica já em uso quebraria um alerta em silêncio.

**Kill switch:** `FEATURE_TURN_HEAD_OF_LINE=false` + restart. O claim volta ao
comportamento de #625 e a plataforma volta a poder responder M2 antes de M1.
Religar não reordena nada — a ordem vem de `first_ingress_seq`, gravado nas duas
posições. A combinação com `FEATURE_TURN_STREAM_KEY=false` é **recusada no
boot**: seria inerte, e o operador acreditaria ter ligado o FIFO.

**Fora de escopo (fatias irmãs):** promoção de sucessor (#627), debounce
transacional (#628), retry/DLQ/fairness (#629).

Arquivos: `migrations/126_agent_turns_stream_head_live{,_down}.sql`,
`src/db/repositories/stream-head-sql.ts` (novo, puro),
`src/db/repositories/turn-repos.ts` (`claimNextEligibleTurn`,
`explainClaimRejection`, `listNonHeadTurns`, filtro FIFO no recovery e no
dispatcher), `src/runtime/turns/claim.ts` (vocabulário dos cinco códigos),
`src/runtime/turns/stream-metrics.ts` (novo), `src/runtime/turns/lease.ts`
(auditoria), `src/runtime/turns/lifecycle.ts` (motivos `not_head`/
`stream_blocked`), `src/workers/message-recovery.ts` (canário),
`src/config/contract.ts` + `src/config/rules.ts` (`FEATURE_TURN_HEAD_OF_LINE`),
`src/governance/audit-actions.ts`, `src/db/schema.ts`.


### Ordenação: o banco passa a garantir NO MÁXIMO UM turno ativo por conversa ([#625](https://github.com/diogenesmendes01/Maia-v2/issues/625), fatia B de [#505](https://github.com/diogenesmendes01/Maia-v2/issues/505), fase 5 de 9)

> **AÇÃO DO OPERADOR: pause os consumidores do turno antes de aplicar a
> migration `124`, e rode a consulta de duplicatas do
> [runbook §10.2](docs/runbooks/turn-state-machine.md) ANTES.** Um par de turnos
> já ativos da mesma stream reprova o `CREATE UNIQUE INDEX CONCURRENTLY` e deixa
> um índice **inválido** para trás, que custa escrita, não serve a leitura e não
> some sozinho — a limpeza é manual (§10.4). Diferente da `120`, a ordem entre
> código e migration aqui é indiferente: nenhuma das duas metades quebra sem a
> outra estar presente.

**O problema.** A #504 entregou exclusão por **turno**: dois workers não
reivindicam a mesma linha. Faltava a exclusão por **conversa** — dois turnos
DIFERENTES da mesma stream podiam ser `claimed` por réplicas diferentes no mesmo
instante e executar em paralelo. É a falha nº 2 da lista da issue-mãe, e é a que
o usuário percebe: duas respostas para a mesma conversa, produzidas por
processos que não sabiam um do outro.

**Onde a exclusão foi colocada, e por quê.** No **banco**. Um mutex de processo
não existe para a segunda réplica; um lock de Redis sem fence persistido
sobrevive à própria expiração (o dono cujo lock venceu não descobre que venceu e
continua escrevendo). Só o PostgreSQL sabe, no instante do UPDATE, quantos
turnos daquela conversa estão ativos — porque é ele quem guarda o estado.

**O PostgreSQL não expressa a invariante numa constraint.** O que se quer é
temporal ("um turno com lease VIVA por stream"), e uma constraint não depende de
`now()` — uma lease vence sozinha, sem nenhuma escrita acontecer. A issue-mãe
prescreve, então, a combinação de duas metades, e **nenhuma delas isolada é a
invariante**:

- **estrutural** — índice único parcial `agent_turns_stream_active_uq`
  (migration `124`) sobre `(tenant_id, agent_id, stream_key)` onde
  `status IN ('claimed','running')`. É ele que DECIDE: um segundo claim na mesma
  stream levanta `23505` e vira o motivo tipado `stream_busy`;
- **temporal** — a recuperação de claims **expirados dentro da MESMA transação**
  do claim (`agentTurnsRepo.tryClaimTurn`). Sem ela, o primeiro crash de worker
  deixa uma linha `claimed` com lease vencida ocupando a chave e a stream fica
  **bloqueada para sempre**: o índice deixa de ser proteção e vira o defeito.

**Por que a recuperação não é um sweeper à parte.** Entre um sweeper liberar a
linha vencida e o claim rodar, um terceiro worker pode reivindicar aquele turno
de volta — e a stream fica parada um ciclo inteiro do sweeper por nada. Dentro
da transação, "liberar" e "ocupar" são o mesmo instante lógico: ninguém observa
a stream vazia e ninguém a ocupa no vão. O turno recuperado volta a `retryable`
com `next_attempt_at = now()`, **preservando** `claim_token`/`claimed_by` (a
forense de "quem tinha este turno quando o pod morreu?") e **sem** gastar
tentativa — contar o crash de um worker como tentativa mandaria um turno
inocente para a DLQ por causa de um deploy.

**O escopo é parte da chave do índice, e isso não é cerimônia.** A `stream_key`
já embute tenant e agent no material canônico, mas embutir não é escopar: uma
colisão de hash (que a issue trata como risco de **segurança**), um backfill ou
um replay manual fariam duas tenants disputarem a MESMA chave — e o turno da
tenant A bloquearia a conversa da tenant B, de forma invisível, porque nada na
linha de B diria que a causa é de A.

**Sem lock global.** Streams distintas não se tocam: o índice serializa por
chave, e o `FOR UPDATE` da recuperação tranca só as linhas ativas **daquela**
stream. Medido com volume representativo (200 mil turnos, 20 mil streams, 1000
ativos): o claim custa `Execution Time: 0.254 ms` e a recuperação `0.938 ms`,
ambos por Index Scan, sem nenhum sequential scan. Numa stream **quente** (5 mil
turnos na mesma conversa) os números não mudam — a recuperação lê pelo índice de
exclusão, que é proporcional ao trabalho EM VOO, não ao histórico. O índice
parcial ocupa **152 kB** contra 46 MB da tabela.

**`outbound_pending` está deliberadamente FORA** do predicado. A resposta já foi
comprometida no outbox e quem finaliza é o delivery worker (#506), que não
disputa posse com ninguém; prender a conversa ali faria uma indisponibilidade do
provedor de saída parar a stream inteira. Consequência honesta: entre
`outbound_pending` e o terminal, a stream aceita um novo claim. Isso **não** é
reordenação — QUEM pode ser reivindicado é o head-of-line (#626), que é a fatia
seguinte. Esta decide QUANTOS podem estar ativos, e a resposta é um.

**Esta fatia não toca na elegibilidade.** Head-of-line no claim (#626), promoção
de sucessor (#627), debounce transacional (#628) e retry/DLQ/fairness por stream
(#629) continuam como estavam.

**Observabilidade.** `maia_turn_claim_total` ganha `result="stream_busy"` —
distinto de `not_eligible` de propósito: um fala da STREAM ("a conversa está
ocupada"), o outro do TURNO ("este aqui não pode ser reivindicado agora"), e
colapsar os dois apagaria o único sinal de uma conversa serializando.
`maia_turn_stream_claim_recovered_total{from}` conta claims expirados devolvidos
à fila e deve ser **zero** em operação saudável. Duas linhas novas de
`audit_log`: `turn_stream_busy` (a exclusão agiu) e `turn_stream_claim_recovered`
(a stream estava presa por um dono morto) — nenhuma carrega `stream_key`,
telefone, texto ou prompt.

**Rollback: derrubar um índice.** `DROP INDEX CONCURRENTLY IF EXISTS
agent_turns_stream_active_uq` (ou o `_down` da `124`, que é esse mesmo
statement) devolve o claim ao comportamento de #504 na primeira tentativa
seguinte. Nenhuma linha muda de estado, nenhuma coluna é apagada, o escalonador
não é revertido — foi para isso que a fatia foi separada.
### Fixed — migration com índice `CONCURRENTLY` inválido deixa de ser marcada como aplicada ([#658](https://github.com/diogenesmendes01/Maia-v2/issues/658))

**O defeito, medido contra o Postgres 16.** `CREATE UNIQUE INDEX CONCURRENTLY`
que reprova — por duplicata pré-existente, deadlock ou cancelamento — **não
desaparece**: o índice fica no catálogo com `pg_index.indisvalid = false`. E o
`IF NOT EXISTS` da tentativa seguinte o enxerga, pula a criação e devolve
sucesso:

```
1a tentativa:  ERROR: could not create unique index "t_k_uq"
catálogo:      t_k_uq | indisvalid = f
2a tentativa:  NOTICE: relation "t_k_uq" already exists, skipping
               CREATE INDEX          ← exit 0
catálogo:      t_k_uq | indisvalid = f     ← continua inválido
```

O runner lia exit 0 e gravava `applied`. Como aqui índice único parcial é
**mecanismo de exclusão** e não otimização (`agent_turns_stream_active_uq` e
afins), o resultado era a exclusão mútua **não existir** com o ledger dizendo
"aplicada" — a mesma classe de defeito que a épica
[#505](https://github.com/diogenesmendes01/Maia-v2/issues/505) existe para
eliminar.

**A correção** é uma invariante ABSOLUTA — "nenhum índice inválido no escopo" —,
não um diff de `pg_index` antes/depois (delta é vazio justamente na
reaplicação, que é o caso perigoso). Ela é asserida em dois pontos:

- **pré-voo**, antes de qualquer DDL: um índice inválido produz o blocker
  `invalid_index` e o `up` sai `blocked` sem enviar statement nenhum. É o que
  fecha a reaplicação — e ela sobrevive inclusive a um `repair --as pending`,
  porque limpar a linha do ledger não conserta o catálogo;
- **na hora de escrever `applied`** (modos `self`/`none`): a migration vira
  `dirty` com `error_class = MIGRATION_INVALID_INDEX`, mesmo tendo terminado
  sem levantar erro. É o caso do operador que roda DDL concorrente à mão numa
  sessão paralela enquanto o job de migration está em voo.

Como o pré-estado é provadamente vazio, qualquer índice inválido encontrado
depois nasceu naquela migration: atribuição por invariante, sem parser de SQL.

**O que o operador vê.** `MigrationStatusReport` passa a carregar
`invalid_indexes`; `getSchemaReadiness()` responde `blocked` com o índice
nomeado e o remédio no texto; e o boot morre com **exit 98** — código novo,
à frente do 90 na precedência, porque quando os dois aparecem juntos o índice
inválido é a CAUSA e o `dirty` é a consequência. Remédio completo (`DROP INDEX
CONCURRENTLY` → resolver a duplicata → reaplicar) em
[`docs/runbooks/migrations.md`](docs/runbooks/migrations.md#índice-inválido-deixado-por-ddl-concurrently);
tabela de exit codes em
[`docs/runbooks/operational.md` §8.1](docs/runbooks/operational.md).

Efeito colateral declarado: o caminho de leitura de `getSchemaReadiness()`
passou de duas para três consultas, então o teto por statement do `maia doctor`
caiu de 4s para 3s (3 × 3s = 9s < 10s de deadline), agora travado contra a
contagem real de statements em vez de um `2` literal.
### Added — a triagem no console fecha o ciclo: aceitar → issue → tool registrada → gap fechado ([#638](https://github.com/diogenesmendes01/Maia-v2/issues/638), fatia C de [#471](https://github.com/diogenesmendes01/Maia-v2/issues/471) — fecha a épica)

**O que faltava.** A fatia A (#636) fez o gap recorrente virar pedido
estruturado; a fatia B (#637) fez N pedidos parecidos virarem UM com contador.
Nas duas, o pedido morria no backlog: ninguém decidia nada sobre ele, e nada
acontecia quando a ferramenta finalmente existia. A tela que havia (`#476`)
montava o corpo de uma issue **no navegador** e abria um link para
`issues/new?...` — sem idempotência (dois cliques, duas abas), duplicando lógica
de backend (um `slugify` próprio que não é o `esbocarNomeDeTool` da fatia A) e
mostrando o GAP em vez do PEDIDO AGRUPADO.

**O que passa a existir.** `tool_request_issues` (a reserva do aceite),
`resolved_at`/`resolved_reason`/`resolved_tool_name` em `agent_capability_gaps`
(o fechamento) e `tool_request_notifications` (o aviso ao agente) — migração
132. No console, o router `toolRequests` com `list` / `detail` / `aceitar` /
`desagrupar`. No runtime, dois workers: o relayer que abre a issue (a cada 5
min) e o monitor que fecha o gap (de hora em hora).

**Aceitar duas vezes cria UMA issue, e a decisão é do banco.** Não é um `if` que
consulta antes de inserir — essa janela é exatamente onde dois cliques rápidos
caem. É a UNIQUE `(tenant_id, agent_id, aggregate_id)` com
`ON CONFLICT DO NOTHING`: o segundo aceite não colhe linha, lê a existente e
devolve `ja_aceito`, auditado como `tool_request_accept_duplicado` — um aceite
sem efeito não pode ser indistinguível de um aceite que nunca chegou.

**A chave de idempotência viaja no corpo da issue.** `sha256` truncado de
`maia.tool_request.v1|tenant|agent|aggregate`, determinística e reproduzível.
Ela estende a idempotência para além do banco: se o processo morrer entre a
chamada externa ter sucedido e o resultado ser gravado, o relayer **encontra** a
issue pelo marcador e a ADOTA (`adopted = true`) em vez de abrir a segunda.
Limitação declarada: a busca pagina no máximo 5 × 100 issues com o label da
triagem; o caminho normal não depende disso (é a UNIQUE que o serve), só a
janela de crash.

**O corpo da issue é escrito supondo que a issue é pública.** Fora dele, de
propósito: `tenant_id`/`agent_id` em texto claro (a correlação é o hash) e o
texto livre de cada situação, que sai de turno real e pode carregar nome, valor
ou assunto do interlocutor — o corpo diz onde lê-las (o console, atrás de
autenticação). É a mesma decisão de privacidade que a fatia A tomou para
`attempted_args`, levada até o fim. Consequência aceita: a issue sozinha não
reconstrói o caso de uso em detalhe; ela permite DECIDIR.

**A credencial do GitHub não existe no processo que serve o botão.**
`MAIA_TOOL_REQUEST_GITHUB_TOKEN` é declarado com `services: ['runtime']`, e o
Admin UI valida o próprio subset no boot — o token não é lido, não é tipado e
não existe lá. O DESTINO (`MAIA_TOOL_REQUEST_ISSUE_REPO`) é lido pelos dois,
porque o dono precisa ver para onde a issue vai antes de aceitar. O preço é uma
indireção (aceitar reserva; o relayer abre em até 5 min); o ganho é que a
separação é estrutural, não disciplina.

**O gap fecha por FATO, nunca por caixa marcada.** `resolved_at` só é escrito
quando a tool é chave viva do registro **e** está no conjunto que o grant
daquele tenant/agent deriva. O casamento de nome é a MESMA função da fatia A
(`encontrarToolExistente`), na direção oposta. Nenhuma rota do console escreve
essas colunas, e o teste arquitetural do console proíbe `resolverGap(` e
`resolved_at:` em todo o caminho da triagem. Consequência aceita e escrita: uma
ferramenta implementada com nome que não aparece no texto do gap nem entre os
nomes propostos **não** fecha sozinha — o erro cai do lado barato.

**O agente é avisado, e o aviso custa zero ida a mais ao banco.** O gap resolvido
sai do bloco de limitações (ele parava de dizer "não consigo" só por isso) e
entra num bloco novo, `## Capacidades novas`, que diz qual ferramenta passou a
existir. Os dois blocos saem da MESMA leitura
(`capabilityGapsRepo.listParaOTurno`), no caminho mais quente do sistema. O que
isso NÃO é: recibo de entrega por turno — o que é auditável é a EMISSÃO
(`tool_request_agent_notified`); que o prompt carrega o aviso é provado por
teste sobre o `buildPrompt` de produção.

**O guardrail continua inegociável.** *O agente especifica; humano implementa e
instala.* Não há botão "aprovar e instalar". Aceitar cria uma issue e nada mais.
Além da invariante de runtime do #636 (agora rodada também depois de ACEITAR e
de FECHAR), a fatia traz uma varredura estática **do console**, derivada do
grafo de imports a partir do router real — a do #636 não cobria isso, porque
`admin-ui/` é barreira lá (o console legitimamente edita grants em outras
telas).

**Reversibilidade.** `desagrupar` expõe no console a ação da fatia B:
`detached_at` + motivo + autor, nunca `DELETE`; o `original_spec` do membro
continua legível e o contador é recalculado a partir dos ativos.

**Auditoria.** `tool_request_accepted`, `tool_request_accept_duplicado`,
`tool_request_issue_created` (com `adopted`), `tool_request_issue_failed` (só
falha TERMINAL — auditar cada retentativa de um 500 transitório viraria log de
rede), `tool_request_gap_closed` e `tool_request_agent_notified`. As três
primeiras carregam `instalou_tool: false` / `concedeu_capability: false` na
própria linha.

### Added — N pedidos de ferramenta parecidos viram UM pedido com contador ([#637](https://github.com/diogenesmendes01/Maia-v2/issues/637), fatia B de [#471](https://github.com/diogenesmendes01/Maia-v2/issues/471))

**O que mudava de mão antes.** A fatia A (#636) faz cada gap recorrente de tool
virar UMA proposta. Nada nela sabe que dois gaps diferentes podem ser o MESMO
pedido dito com outras palavras — então o backlog acumularia duplicatas em que
nenhum item carrega o peso da demanda real: cinco pedidos de duas ocorrências,
em vez de um pedido de dez.

**O que passa a existir.** `tool_request_aggregates` (UM pedido, com contador) e
`tool_request_aggregate_members` (o ledger append-only de quem entrou, com que
número e quando), ambos escopados por `tenant_id + agent_id`. A decisão de
agregar acontece **antes** de criar a proposta: um pedido que se funde NÃO vira
linha em `capability_proposals` — é esse o "N vira 1".

**O limiar tem medição, não gosto.** Métrica `dice_token_v1` (coeficiente de
Dice sobre os tokens de conteúdo da descrição do gap), limiar **0,85**, escolhido
pela regra escrita antes do número: *o menor θ da grade de 0,05 com zero falsas
fusões no conjunto negativo real*. O conjunto negativo tem rótulo REAL — os 2080
pares de tools distintas do catálogo committado, que são 65 coisas que este
projeto já decidiu que merecem implementações separadas. Em 0,80 ainda há uma
falsa fusão (`save_fact` × `save_rule`, 0,833); em 0,90 não há segurança a mais
e há 10 pontos de recall a menos. Reproduzir:
`npx tsx scripts/medir-limiar-tool-request.ts`. O número é mantido honesto por
`tests/unit/tool-request-limiar-medicao.spec.ts`, que reroda a medição contra o
catálogo VIVO — uma tool nova que empurre o pior par negativo acima de 0,85 fica
VERMELHA no CI em vez de virar agrupamento errado em produção.

**O que a medição NÃO prova, dito aqui e não só no código.** O conjunto positivo
é SINTÉTICO (325 paráfrases por cinco transformações committadas), porque não
existe no repositório um par de gaps rotulado como "mesmo pedido" — o ledger de
ocorrências nasceu na fatia A e está vazio em todo ambiente. E há a limitação
herdada: enquanto `completeness` for `'name_only'`, a assinatura sai de uma frase
curta, e Dice sobre conjuntos pequenos é grosso — a 0,85, duas descrições de 4–5
tokens só fundem se o conjunto de tokens for IGUAL. Na prática, HOJE o contador
sobe para repetição quase literal. Quando os rascunhos ficarem ricos, o limiar
**não vale como está**; por isso a assinatura é versionada e a versão é
persistida por agregado e por membro.

**A política de fusão de rascunhos: nenhum vence, nunca.** Compatíveis → UNIÃO
(nenhum campo descartado, `observed_in` soma, `required` só sobrevive quando é
obrigatório em todos). Incompatíveis → `contract_state = 'divergent'`: NÃO se
produz contrato fundido, os rascunhos ficam lado a lado como variantes, e o
conflito é NOMEADO (campo, lado, as expressões Zod em disputa e de quem vieram).
O contador continua contando — a demanda é real —, mas o contrato fica
explicitamente indefinido. Fundir dois contratos incompatíveis produziria uma
spec que não descreve nenhum dos dois casos; escolher um deles apagaria o outro
por ordem de chegada, que não é evidência de nada. O CHECK
`tool_request_aggregates_divergent_has_no_draft` (migração 129) torna impossível
gravar `divergent` com um rascunho pendurado, venha o INSERT de onde vier.

**Escopo: por tenant + agent, sem contador global.** A agregação compara o texto
do pedido de um cliente com o de outro; um contador global exigiria que o dado de
A entrasse no cálculo que produz a linha de B, e "só o número atravessa" não
salva, porque contagem pequena é reconstruível. A pergunta legítima ("quantos
clientes pediram isto?") tem caminho próprio — agregação estatística deliberada
com anonimização e ADR —, nunca efeito colateral de agrupar pedidos.
Consequência aceita e escrita: dois tenants que precisam da mesma ferramenta
produzem dois pedidos. Provado por teste de leak com pedidos BYTE A BYTE iguais
em dois tenants.

**A fusão não pode apagar a evidência, em três camadas.** (1) A agregação só
escreve em tabelas NOVAS — `capability_proposals`, `agent_capability_gaps` e
`agent_capability_gap_observations` não são tocadas. (2) Cada membro guarda o
`proposed_spec` INTEIRO como entrou (`original_spec`), com situações, links de
trace e o rascunho original — necessário porque o pedido fundido não gera
proposta. (3) Sair do agregado é `detached_at` com motivo e autor, nunca
`DELETE`; e um gap já destacado NÃO volta ao agregado por similaridade, senão
"reversível" duraria até a próxima passada do cron.

**Sem coluna `vector` e sem índice ivfflat/hnsw, de propósito.** Um limiar de
cosseno dependeria de uma API paga externa que o CI não tem — logo não seria
calibrável nem retestável, e trocar de provedor moveria a escala inteira em
silêncio sobre dado de governança. Some-se a isso que `name_only` é o regime em
que cosseno de frase curta separa pior. Uma coluna vazia que ninguém popula é
dívida com cara de recurso, e um índice ivfflat sobre dezenas de linhas por
tenant é mais lento que a varredura sequencial. O ponto de extensão fica: sinal
semântico calibrado entra como `ASSINATURA_VERSION` nova, **com re-medição**.

**O guardrail da fatia A continua valendo palavra por palavra.** Agregar não
registra tool, não concede nada e não avalia `zod_source`. Os arquivos novos
entram sozinhos na varredura estática do guardrail porque ela deriva do grafo de
imports dos call sites reais — e a sonda que planta um registro de tool dentro
de `aggregation.ts` fica vermelha nas DUAS defesas (a invariante absoluta de
runtime e a varredura de fonte).

Migração `129_tool_request_aggregation.sql` (+ `_down` com envelope
`BEGIN`/`COMMIT` explícito, que RECUSA reverter com dado: um membro
não-representante não tem linha em `capability_proposals`, então derrubar a
tabela apagaria pedidos inteiros, não o agrupamento).

Auditoria: `tool_request_aggregated` (com similaridade, limiar, métrica e versão
da assinatura — agrupamento sem o número que o justificou é fato sem prova) e
`tool_request_aggregate_detached`.

### Added — o gap recorrente que exige uma tool INEXISTENTE vira um pedido estruturado, e inerte ([#636](https://github.com/diogenesmendes01/Maia-v2/issues/636), fatia A de [#471](https://github.com/diogenesmendes01/Maia-v2/issues/471))

**O que mudava de mão antes.** Um gap recorrente subia pela cadeia
determinística de escalada (`src/cognition/gap-escalation/engine.ts`) e, no
topo, virava uma spec em prosa escrita por Sonnet — ou morria no dashboard. Um
dev que recebesse isso ainda tinha de reconstruir do zero as quatro coisas que
decidem o pedido: **o que** o agente queria fazer, **em que situações reais**,
**quantas vezes e em que janela**, e **qual seria o contrato**.

**O que passa a existir.** Um tipo novo de proposta, `capability_type =
'tool_request'`, gerado SEM LLM a partir de evidência persistida:

- **intenção** — a descrição da lacuna, nas palavras em que foi registrada;
- **situações** — as ocorrências reais, com `root_trace_id` ligando ao envelope
  em `runtime_trace_envelopes`. Um id que não resolve **no mesmo tenant+agent**
  vira situação SEM link, nunca link que atravessa fronteira;
- **frequência com janela** — `agent_capability_gap_observations`, o ledger novo
  de ocorrências. O contador `frequency_score` responde "quantas vezes" e nada
  mais; janela e situação precisam de linhas com timestamp;
- **rascunho de contrato Zod** — nome, inputs e outputs **derivados** dos
  argumentos que o agente tentou usar. Quando nenhuma ocorrência registrou
  argumentos, o rascunho diz `completeness: 'name_only'` em vez de inventar
  campos: um contrato imaginado pareceria mais completo e valeria menos.

**O guardrail é o recurso, não uma nota de rodapé.** *O agente especifica;
humano implementa e instala.* Nada nesta fatia registra tool, executa o código
proposto ou cria capability — a proposta é um documento inerte, e aprová-la
(`dispatchApproval` → `acknowledged_for_humans`) continua não instalando nada.
Tool nova segue o caminho normal: código revisado, contrato Zod, classe de
risco, aprovação. A marcação que impede confundir o rascunho com contrato
vigente é redundante de propósito e vive em três camadas independentes — o
literal Zod (`contract_status`), o CHECK
`capability_proposals_tool_request_marking_check` da migração 125 (que recusa o
INSERT venha ele de onde vier, inclusive de um `psql`), e o cabeçalho literal do
`zod_source`, que sobrevive ao copiar-e-colar.

**Precedência no topo da escalada.** O pedido de ferramenta é a rota
ESPECÍFICA e roda primeiro; o `capability-proposer` genérico continua atendendo
todo o resto — knowledge, procedure, e o gap de tool cuja ferramenta **já
existe** (aí não falta código, falta grant). Se a rota nova falhar ou lançar, a
genérica assume: uma rota recém-introduzida não pode derrubar em silêncio o
comportamento que já existia.

**O guardrail afirma INVARIANTE, não delta** (correção pós-revisão). A primeira
versão do teste fotografava o registro de tools antes e depois e comparava as
duas fotos. Um delta sobre estado global e mutável não sobrevive ao `retry: 1`
do vitest: a tentativa 1 ficava vermelha, a mutação persistia no objeto de
módulo, e a tentativa 2 tomava o estrago como sua própria linha de base — delta
zero, verde, `falharam=0`. O guardrail passou a afirmar três coisas ABSOLUTAS,
verdadeiras ou falsas por si só em qualquer tentativa: nenhuma tool viva fora do
catálogo committado (`src/admin-ui/generated/tool-catalog.ts`), o grant do
agente exatamente como semeado, e zero capability criada. E a varredura de
fonte deixou de ser `readdirSync` de uma pasta — ela agora percorre o GRAFO DE
IMPORTS a partir dos call sites reais (gerar, disparar, **aprovar**), porque a
fronteira do comportamento proibido não é um diretório: `proposal-approval-handler.ts`
é precisamente o arquivo onde alguém escreveria "aprovou, então instala", e ele
ficava de fora.

**Fora de escopo desta fatia**, de propósito: agregação por similaridade
([#637](https://github.com/diogenesmendes01/Maia-v2/issues/637)) e triagem no
console ([#638](https://github.com/diogenesmendes01/Maia-v2/issues/638)).

- Migração **125** (`125_tool_request_proposals.sql`): `agent_capability_gap_observations`
  (com CHECK fail-closed contra o literal `default`), `tool_request` na lista
  fechada de `capability_type`, e o CHECK da marcação. O `_down` **recusa** com
  dado presente — apagar a evidência não é rollback, é perda.
- `src/cognition/tool-request/` — `types.ts` (contrato Zod + marcação),
  `existing-tool.ts` (a tool já existe no `REGISTRY`?), `contract-draft.ts`
  (derivação dos campos) e `proposer.ts` (o call site).
- `src/workers/gap-escalation-monitor.ts` — as duas rotas a partir de `proposed`.
- `tests/helpers/grafo-de-imports.ts` — travessia de imports com fronteira
  declarada, para que uma varredura estática não volte a mentir quando nascer um
  arquivo novo fora da pasta.
- `src/db/repositories/capability-repos.ts` — `capabilityGapObservationsRepo` e
  o registro da ocorrência junto ao upsert do gap.

### ⚠️ BREAKING (operacional) — schema incompatível agora MATA o processo, com exit code por invariante ([#516](https://github.com/diogenesmendes01/Maia-v2/issues/516))

> **O que muda no seu dia:** antes, um app que subisse contra um schema
> incompatível ficava **de pé** respondendo 503 no `/readyz`. Agora ele **não
> sobe** — encerra com exit code **90-98**, e sob um supervisor que reinicia
> isso é **crash loop**. Se o seu deploy não tem gate de migration, ele passa a
> ter um sintoma novo. Verifique, ANTES de subir este release, que o migrator
> roda antes do app: `depends_on: { migrate: { condition:
> service_completed_successfully } }` no Compose (já é assim em
> `compose.prod.yml` e `docker-compose.yml`), ou `npm run release:migrate` no
> comando de pré-deploy do painel ([#565](https://github.com/diogenesmendes01/Maia-v2/issues/565)).
>
> **Em `development`/`staging`**, a alavanca declarada continua sendo
> `READINESS_SCHEMA_CHECK=false` (silenciosa em dev, aviso em staging,
> **recusada no boot em production**). Nenhuma variável nova foi criada.

**A decisão é do dono e está registrada** — [ADR 0004](docs/architecture/decisions/0004-boot-fails-closed-on-the-canonical-schema-verdict.md):
*"Produção greenfield não precisa preservar a postura intermediária.
`getSchemaReadiness()` deve decidir o boot… Se acontecer, o crash loop é sinal
de quebra de invariante."*

**O PORQUÊ.** A #516 entregou o veredito canônico de schema
(`getSchemaReadiness()`) e ligou o `/readyz` nele. O **boot**, porém, ficou com
`checkSchemaVersion()` — que comparava o id mais novo do ledger com o `.sql`
mais novo em disco e **nada mais**. Havia dois vereditos de schema no mesmo
processo, com forças diferentes, e **o mais fraco decidia se o processo
nascia**: um app subia tranquilo sobre uma migration editada depois de aplicada,
sobre uma linha `dirty` e sobre uma migration que o build não empacota, e só
descobria na primeira query que tocasse a coluna nova. Agora existe um veredito
só.

O que mudou:

- **`src/index.ts` (etapa `schema`)** chama `checkSchemaReadiness()` — o MESMO adaptador cacheado do `/readyz`, então boot e probe não podem divergir — e lança `SchemaBootAbortError`; o handler de `main()` sai com `bootExitCode(err)`.
- **Exit codes distinguíveis** (`src/runtime/lifecycle/schema-boot-gate.ts`), porque `1` para tudo não diz nada a quem lê `docker inspect --format '{{.State.ExitCode}}'`: **90** dirty/`running` órfão · **91** checksum divergente · **92** checksum ausente (ledger v1 nunca backfillado) · **93** migration no banco que este build não empacota · **94** migration obrigatória ausente · **95** schema acima do máximo suportado · **96** `running` em voo · **97** veredito `unknown` · **98** índice `indisvalid = false` ([#658](https://github.com/diogenesmendes01/Maia-v2/issues/658)). `1` continua sendo qualquer outra falha de boot. A faixa 90-98 não colide com os códigos do migrator (0/1/2), do Node (1-14), do shell (126-165) nem com 255.
- **Mensagem de morte acionável**, porque um crash loop sem diagnóstico é pior que um 503: `maia.schema_boot_refused` carrega `exit_code`, `blocker`, `blockers`, `migration_id`, `expected_checksum` (arquivo empacotado) vs. `found_checksum` (linha do ledger), os dois heads e a `remediation` (o comando exato). Nada disso carrega SQL, texto de driver ou DSN — a mensagem de erro do `pg` embute a connection string com senha.
- **`checkSchemaVersion()` e `src/runtime/lifecycle/schema-version.ts` foram REMOVIDOS**, com o spec dedicado. Não sobrou um segundo veredito de schema para divergir.
- **Coerência com a [ADR 0003](docs/architecture/decisions/0003-health-is-diagnostic-livez-readyz-are-the-probes.md):** o `/readyz` continua sendo o único gate de roteamento, role-aware e fail-closed, e continua respondendo 503 quando o schema muda debaixo de um processo **que já subiu** — esse caso não vira crash loop. A árvore de decisão do operador (quando olhar exit code, quando olhar readiness) está em `docs/runbooks/operational.md` §8.1.

**A evidência.** `tests/unit/runtime/schema-boot-gate.spec.ts` importa o
**`src/index.ts` real** (a avaliação do módulo dispara `main()` e o handler de
falha) e injeta apenas o que um unitário não pode ter: um pool de ledger falso e
um diretório temporário de migrations — a classificação do veredito é a de
produção. Reintroduzindo o defeito no call site REAL, um de cada vez:
neutralizar a decisão (`if (false && failure)`) deixa **7 de 10 casos
vermelhos** (`expected 1 to be 90`, `expected 1 to be 91`, …); trocar
`process.exit(bootExitCode(err))` por `process.exit(1)` deixa **os mesmos 7
vermelhos**. Contraste no verde: com o schema verificado o boot passa da etapa e
morre no passo seguinte com exit 1 (sentinela do Redis), então o gate não está
recusando tudo. Em Postgres real, `tests/integration/migrations-runner-real-db.spec.ts`
repete a tradução veredito ⇒ exit code contra ledger de verdade.

### ⚠️ AÇÃO DO OPERADOR — o TTL do export de privacidade passa a APAGAR o arquivo ([#536](https://github.com/diogenesmendes01/Maia-v2/issues/536))

> **Até este release, `privacy_requests.export_expires_at` era um carimbo sem
> executor.** O prazo existia no banco; o `.enc` — um pacote cifrado com o dado
> consolidado de um titular — ficava no disco **para sempre**. Não era uma
> retenção frouxa: era um vazamento com deadline infinito, e mais fácil de
> esquecer que o comum, porque a coluna dá a impressão de que alguém já cuidou
> disso.
>
> A partir daqui um cron horário (`privacy_export_sweep`) **remove** o artefato
> vencido. Duas coisas para fazer antes de subir:
>
> 1. **rode um passe em dry-run** e compare com a expectativa —
>    `npm run privacy:export -- sweep --dry-run`. Num ambiente que nunca teve
>    varredura, o primeiro passe real pode apagar todo o acervo acumulado;
> 2. **confira `PRIVACY_EXPORT_TTL_DAYS`** (novo, default `7`). Ele vale na
>    EMISSÃO e fica carimbado em `export_expires_at`; o varredor honra o
>    carimbo, nunca a configuração atual — mudar o número não encurta nem
>    estica o que já foi emitido (o runbook §8 traz o `UPDATE` para quando isso
>    for deliberado).
>
> Migration **118** (aditiva, `IF NOT EXISTS`). Para desarmar temporariamente:
> `PRIVACY_EXPORT_SWEEP_DRY_RUN=true` — mas leia o §9 do runbook antes, porque
> o dry-run permanente devolve exatamente o estado que esta entrega conserta.

**Sete dias viram a política inicial, e o mecanismo que a cumpre existe.** Decisão do dono sobre a #536: aceite o prazo, mas implemente o TTL de verdade antes do go-live. O prazo saiu do código (`const EXPORT_TTL_MS`) e virou `PRIVACY_EXPORT_TTL_DAYS`, porque quem decide é o DPO e a decisão vai mudar.

**Idempotência mora na ORDEM, e a ordem é evidência.** O varredor cruza um arquivo no disco com uma linha no banco, e os dois não commitam juntos — então a pergunta é qual ordem deixa o estado intermediário LEGÍVEL. `marcar → apagar` deixa o pedido dizendo "artefato removido" com o `.enc` vivo e sem candidato para reencontrá-lo: órfão para sempre. `apagar → marcar` deixa, no pior caso, o arquivo removido e o pedido ainda na fila — a execução seguinte prova o caminho, encontra a ausência (`already_absent`), e conclui. Escolhemos a segunda. A marcação e a auditoria vão na MESMA transação, condicionadas a `export_purged_at IS NULL`: quem não ganha a transição não audita, então rodar duas vezes (em série ou em paralelo) produz **exatamente uma** linha `privacy_export_purged`.

**O locator é entrada não confiável para um `rm`, e é tratado como tal** (`src/ops/privacy/export-locator.ts`). Quatro camadas antes de qualquer remoção: forma (o UUID que o próprio `sealExport` emite), contenção (filho direto da raiz, provado por identidade — `startsWith` sozinho aceita `/exports-evil/x` para uma raiz `/exports`), inode (`lstat` e nunca `stat`, porque `stat` segue o symlink e esconde justamente o caso; mais arquivo-regular e `nlink === 1`, já que um segundo hard link significa que remover o nosso destrói o rastro e não o dado) e **binding** — a linha é relida no instante da remoção, porque entre planejar e apagar o export pode ter sido reemitido e o arquivo do plano pode ser um artefato vivo. A ordem das checagens é contrato, como em `assertDrillTarget`: as recusas estruturais vêm primeiro para que o código auditado nomeie o **pior fato verdadeiro** — `../../etc/passwd` tem que ser registrado como `path_separator`, não como o também-verdadeiro "não parece um UUID". Toda recusa é auditada (`privacy_export_purge_refused`) e **nada é apagado**.

**Evidência de que o guarda está NO CAMINHO, e não apenas disponível.** A sonda que vale para código destrutivo é a chamada de remoção nem ser alcançada. Neutralizando a validação no call site real (`const proven = { path: ..., present: true }` no lugar de `proveExportArtifact`), `tests/unit/ops/privacy-export-sweeper.spec.ts` fica vermelho com a chamada mostrada:

```
AssertionError: expected "vi.fn()" to not be called at all, but actually been called 1 times
Received:
  1st vi.fn() call:
    Array [ "/srv/backups/privacy-export/../../etc/passwd" ]
```

**Legal hold congela o export, não só a origem.** O varredor avalia o hold sobre `privacy.export` **e** sobre toda classe de escopo de titular que o pacote empacota: a cópia entregue é material responsivo tanto quanto as linhas de que ela foi feita. A avaliação **não** consulta o `legal_hold_applicable` da classe — condicionar uma recusa destrutiva a um campo mutável de registro significa que uma edição de um caractere desarma a proteção. Hold ilegível reprova o passe inteiro; "não sei se há hold" nunca vira "não há hold". `privacy.export` passou de `legal_hold_applicable: false` para `true` em `data-classes.ts`, corrigindo uma declaração que só era inócua enquanto nada apagava a classe.

**O pedido passa a indicar artefato expirado.** `readExportArtifact` é o único lugar que decide o que um leitor vê: `none` · `available` · `expired` · `purged`. `expired` **retém** o locator de propósito — entre o vencimento e a passagem do varredor o arquivo ainda existe, e entregá-lo nessa janela furaria o próprio TTL. `npm run privacy:export -- show --request=<uuid>` é a leitura do operador.

- **Migration 118** — `export_purge_started_at` (passe que caiu fica visível) + `export_purged_at` (a transição de vencedor único), CHECK recusando "varrido sem nunca ter tido artefato", e dois índices **parciais** no padrão de `067`/`070`: a fila do varredor e a pergunta de incidente "algum passe começou e nunca terminou?".
- **Cobertura**: 75 testes unitários novos + 9 casos na spec de forma das migrations (`ops-migrations-shape.spec.ts` passa de 42 para 51: colunas, CHECK, os dois índices PARCIAIS, idempotência do up e o envelope `BEGIN`/`COMMIT` do down — sem Postgres) (`privacy-export-locator.spec.ts` 30, `privacy-export-sweeper.spec.ts` 33, `privacy-export-sweep-scheduler.spec.ts` 12) + 12 de integração (`privacy-export-ttl-real-db.spec.ts`) que provam o que só o banco prova — o CHECK, a ordem da fila e o `RETURNING` do UPDATE condicional sob concorrência real. Os de integração **não foram executados** nesta rodada: Postgres está fora do ar no ambiente de desenvolvimento; rodam no CI.
- **Alerta novo, com threshold 1** — `privacy_export_locator_refused` em `src/workers/audit-watcher.ts`. A taxa normal de `privacy_export_purge_refused` é **zero**, então agrupá-la por volume (como as outras regras de threshold, que usam 3) esconderia o primeiro evento — o único que importa. `urgent` e não `critical`: nada foi apagado, o guarda recusou antes da remoção.
- **Contra a armadilha do espelho**: `tests/unit/workers/privacy-export-sweep-scheduler.spec.ts` passa pelo REGISTRO real (`JOBS`) e pelo adaptador real (`runPrivacyExportSweepJob` → `withOpsLock`), não por um agendador próprio. Remover a entrada do cron reprova 11 dos 12 casos com `Error: o job privacy_export_sweep não está no registro de workers` — um harness privado continuaria verde com o TTL desligado, que é exatamente o defeito original em outra roupa.
- **Fora de escopo, e deliberadamente**: purgar `privacy.export` como parte de um pedido de EXCLUSÃO de outro titular (continua em `UNSUPPORTED_CLASSES` — é uma pergunta diferente do TTL) e qualquer redação de `postgres.audit`, que segue bloqueada até decisão campo a campo do DPO.
- Runbook novo: [`docs/runbooks/privacy-export-ttl.md`](docs/runbooks/privacy-export-ttl.md). Docs reconciliados: `docs/architecture/modules/ops.md`, `docs/architecture/concerns/data-retention-matrix.md` e `docs/runbooks/backup-restore.md` §7/§9 — a frase "a retenção não apaga nada hoje" deixou de ser verdade inteira e agora nomeia as duas exceções, para que ninguém opere com a expectativa errada.

### Fixed — `markSuperseded` vira DUAS operações: o fence pertence a quem ABSORVE ([#504](https://github.com/diogenesmendes01/Maia-v2/issues/504))

`markSuperseded` era uma operação para dois fatos diferentes — e por isso não tinha fence nenhum.

Marcar um turno `superseded` acontece em dois lugares, e a AUTORIDADE de cada um
é de uma linha diferente:

| Operação | Linha que muda | Posse exigida |
|---|---|---|
| `markSupersededSelf` (auto-supersessão) | o próprio turno | o `claim_token` **do próprio turno** |
| `markSupersededByAbsorber` (absorção de irmão pelo debounce) | o turno **irmão** | o `claim_token` + lease VIVA do turno **ABSORVEDOR**, num `EXISTS` na mesma declaração |

O erro que isso corrige é conceitual, e os dois jeitos de errar são simétricos.
**Exigir claim do irmão** tornaria a absorção legítima impossível no caso comum:
o turno absorvido normalmente NUNCA foi reivindicado — quem foi reivindicado é o
executor da rajada —, então `claim_token IS NULL` é o estado normal dele.
**Não exigir nada dos dois lados** — o que estava no código — deixava um worker
zumbi (lease vencida, tentativa já sucedida) absorver turnos e apagar trabalho do
sucessor, e deixava `superseded` ser a **única transição terminal** que uma
tentativa sem posse conseguia atravessar: como `superseded` é terminal, o
sucessor perdia o turno e nada aparecia como conflito. **O fence pertence a quem
absorve.**

O compare-and-swap na linha do irmão (`expected_version`) passou a ser
**obrigatório** na assinatura, e não opcional como nas demais transições: é ele
que decide a corrida entre duas absorções concorrentes, e omiti-lo por descuido
faria a rajada produzir dois turnos executáveis disputando as mesmas mensagens.

`absorbDebounceInputs` (`src/runtime/turns/lifecycle.ts`) ganhou o guard de posse
que não tinha: uma tentativa que JÁ SABE ter perdido a lease não absorve nada —
nem o irmão, nem o `attachInputTx` da irmã sem turno — e uma recusa vinda do
banco (`stale_claim`) PARA a rajada inteira em vez de insistir. A posse é
reavaliada a cada irmã, porque a rajada pode ser longa e a lease pode morrer no
meio dela.

**Evidência, e por que ela não é um espelho.** O `WHERE` do compare-and-swap
saiu de dentro de `runTransition` para um módulo PURO
(`src/db/repositories/turn-fence-sql.ts`), e `runTransition` não acrescenta
predicado nenhum depois de chamá-lo. Isso é o que permite a
`tests/unit/db/turn-fence-sql.spec.ts` compilar o SQL **real** de produção com
`PgDialect` — sem Postgres — e afirmar caractere a caractere que
`absorvedor.lease_expires_at > now()` está lá, que só existe UMA referência a
`claim_token` e que ela está dentro do `EXISTS` (nenhuma sobre o irmão), e que
`state_version` está no `WHERE`. Um teste que remontasse a query com o próprio
harness continuaria verde depois de alguém deletar o call site.
`tests/unit/runtime/turn-absorption-fence.spec.ts` prova o mesmo contrato no call
site real do lifecycle, e `tests/integration/turn-absorption-fence-real-db.spec.ts`
prova contra PostgreSQL o que só o banco decide (lease pelo relógio dele,
takeover, corrida de duas absorções, projeção legada na mesma transação).

### ⚠️ BREAKING (operacional) — as três flags de turno passam a vir `true` ([#504](https://github.com/diogenesmendes01/Maia-v2/issues/504))

> **Um `.env` que não menciona as flags de turno muda de comportamento neste
> release.** `FEATURE_TURN_CLAIM` e `FEATURE_TURN_STATE_AUTHORITATIVE` saíram de
> `false` para `true` no contrato. Quem já declarava um valor não é afetado.

| Flag | Antes | Agora |
|---|---|---|
| `FEATURE_TURN_STATE_MACHINE` | `true` | `true` |
| `FEATURE_TURN_STATE_AUTHORITATIVE` | `false` | **`true`** |
| `FEATURE_TURN_CLAIM` | `false` | **`true`** |
| `FEATURE_TURN_JOB_V2` | `false` | `false` (inalterada — exige todas as réplicas de consumo no build que entende V2) |

Numa produção greenfield não existe histórico a backfillar nem coorte a
comparar, e o rollout por etapas só serviria para deixar a produção rodando, por
semanas, no caminho que **não** tem exclusão mútua. `FEATURE_TURN_CLAIM=false`
não é "modo conservador": é a janela de execução dupla aberta.
`FEATURE_TURN_STATE_AUTHORITATIVE=false` faz um turno `retryable` (timeout de
reasoner, falha pre-send do outbound) sumir do recovery.

**`false` nas três é rollback emergencial, não configuração suportada.** Está
escrito no contrato, no `.env.app.prod.example` (que agora declara as três
explicitamente, para que o regime não dependa de o leitor saber qual é o
default), no runbook (§2.0 greenfield, §2.1 base com histórico, §2.2 rollback) e
no doc de módulo. O código do caminho legado continua existindo **e testado** —
sem isso o rollback não funcionaria —, mas deixou de ser o caminho que um teste
herda sem pedir. Desligar SÓ `FEATURE_TURN_STATE_MACHINE` é recusado no boot (as
outras duas ficariam inertes); a remediação das regras
`turn-state/authoritative-requires-dual-write` e `turn-claim/requires-state-machine`
agora diz para desligar as três juntas.

**O que o flip do default quebrou, e por quê.** 13 casos em
`tests/unit/workers/message-recovery-{cross-tenant,oom}.spec.ts`. Nenhum era bug
de produção: os dois arquivos **nunca declaravam o regime** e herdavam o default,
então provavam o contrato do dispatcher e o fail-closed por OOM em UM dos dois
inners de `runMessageRecovery` — e ninguém sabia em qual. Com o default novo eles
passaram a rodar o inner autoritativo, cujo `agentTurnsRepo` não estava no mock.
Os dois arquivos agora escolhem o regime EXPLICITAMENTE e rodam a matriz nos
DOIS, o que é cobertura nova: a abortagem por OOM de `runTurnRecoveryInner`
nunca tinha sido exercitada. O bloco de READ ISOLATION, que dirige a query
drizzle real do inner legado, fixa `authoritative = false` e diz por escrito que
é o caminho de rollback.

**E `tests/integration/turn-lease-lost-turn-pipeline-real-db.spec.ts`, pelo mesmo
motivo: media o fim do turno na fonte de verdade ANTIGA.** O CONTROLE dessa
suíte exigia `mensagens.processada_em` não-nulo. Com o regime autoritativo por
default isso passou a ser a asserção ERRADA, não um defeito do pipeline: a
projeção legada agora SEGUE o estado — `runTransition` só carimba
`processada_em` em transição terminal —, e o turno do CONTROLE termina
`retryable`/`outbound_failure`, porque no harness o Baileys é dublê e não há
canal ativo para entregar. Carimbar ali é exatamente o que matava o retry.

A asserção foi trocada pelo sinal EQUIVALENTE na fonte nova, e ficou mais forte
nas duas pontas: o CONTROLE exige que o **dono** tenha fechado a tentativa
(`status`/`outcome`/`last_error_code`, lease devolvida, mensagem ligada por
`agent_turn_inputs`, `state_version` = 3) e cada BARREIRA exige que a última
gravação da linha tenha sido a do **sucessor** — `state_version` idêntica à do
takeover, sem outcome, sem erro, sem projeção. A versão antiga era vacinada
contra os dois defeitos que a nova pega: um `markAllProcessed` incondicional
(o P1 que mata o retry) deixava o CONTROLE VERDE, e um zumbi que grava
`markRetryable` sem fence no turno alheio deixava as cinco barreiras VERDES.
Nenhuma barreira foi enfraquecida — a contagem de efeitos pós-gate, os
`workloads` de LLM e o `boundary` que recusou continuam iguais.

### ⚠️ BREAKING (esquema de evidência) — `envelope_hmac` vira versionado e passa a assinar `root_trace_id`/`attempt` ([#535](https://github.com/diogenesmendes01/Maia-v2/issues/535))

> **Rode a migration 119 ANTES de subir a aplicação.** O escritor grava `runtime_trace_envelopes.signature_version`; sem a coluna, todo turno com `side_effect_level >= medium` falha fechado no envelope obrigatório — ou seja, **aborta**. Ordem inversa não existe: o `_down` da 119 recusa enquanto houver linha v2, de propósito.

**O que mudou.** A migration 107 acrescentou `root_trace_id` e `attempt` e os deixou **fora** do `envelope_hmac`, com o argumento — escrito no próprio arquivo — de que assiná-los invalidaria todo envelope já escrito. O argumento caducou antes de valer: `FEATURE_RUNTIME_TRACE_V1` nunca foi ligada em produção, então **não existe corpus a invalidar**. Decisão do owner: consertar o contrato agora, de forma versionada.

| | v1 | v2 |
|---|---|---|
| Campos assinados | `trace_id`, `tenant_id`, `agent_id`, `conversa_id`, `turno_id`, `policy_id`, `decision`, `side_effect_level`, `redaction_class`, `hmac_key_version` | v1 **∪** `root_trace_id`, `attempt`, `signature_version` |
| Escrito por produção | **não**, nunca mais | **sim**, sempre |
| Lido pelo verifier | sim (fixtures / ambientes antigos) | sim |
| Reassinado retroativamente | **não** | — |

O escritor lê a versão de uma **constante** (`CURRENT_ENVELOPE_SIGNATURE_VERSION`), nunca do input: um chamador não consegue pedir assinatura mais fraca. As duas materiais canônicas moram num arquivo só (`src/control-plane/runtime-trace/lib/signature.ts`) para que assinador e verificador não possam divergir.

**Por que isso não é um downgrade attack.** A versão mora numa coluna, e coluna é justamente o que um atacante com escrita no banco controla. Por isso a material da v2 contém `"signature_version":2` — separação de domínio explícita. Virar a coluna de uma linha v2 para `1` faz o verifier recomputar a material **v1** e comparar com um HMAC tirado sobre a material **v2**: não bate, e a linha lê `invalid`. O relabel na direção oposta é detectado do mesmo jeito. Evidência: `tests/unit/observability/verify-envelope.spec.ts` → "DOWNGRADE: relabelling a v2 row as v1 does not free the new fields".

**O risco que continua aberto, e é decisão de operador.** Uma linha *genuinamente* assinada em v1 mantém `root_trace_id`/`attempt` fora da assinatura — nelas, essas duas colunas seguem editáveis sem detecção. Produção não escreve mais v1, então isso está limitado a fixtures e a ambientes que já gravaram alguma. Duas defesas, ambas independentes da assinatura:

- **`RUNTIME_TRACE_ACCEPT_SIGNATURE_V1`** (nova, default `true`) recusa v1 **na leitura** quando `false`. O veredito é `rejected_version`, deliberadamente distinto de `invalid`: uma assinatura v1 pode ser perfeitamente legítima, e chamá-la de adulteração é o mesmo erro de categoria que o antigo `hmac.length > 0` cometia, ao contrário. O default é `true` porque virar toda linha legada para `rejected_version` no dia do deploy destruiria exatamente a evidência que a chave existe para proteger.
- **`listAttempts()` passa a exigir o `turno_id` ASSINADO** (abaixo).

### Changed — `listAttempts()` exige o `turno_id` assinado; dois turnos não podem mais se fundir visualmente ([#535](https://github.com/diogenesmendes01/Maia-v2/issues/535))

`runtimeTraceRepo.listAttempts()` recebia `{ tenantId, rootTraceId }`. `root_trace_id` é o campo que diz "estas linhas são do mesmo turno", e até a #535 ele não era assinado — um único `root_trace_id` editado enxertava a tentativa de um turno na cadeia de **outro**, e o Explorer renderizava dois turnos distintos como uma sequência de retry. Essa é a fusão visual que o owner mandou fechar.

Agora a assinatura do método é `{ tenantId, rootTraceId, turnoId }`, os três obrigatórios, e:

1. `turnoId` em branco/ausente **falha fechado** (`TraceAttemptScopeError`) em vez de cair para agrupamento só por `root_trace_id`. O fallback seria o controle desligado por omissão de argumento;
2. o filtro por `turno_id` está **no SQL**, servido por `runtime_trace_env_attempt_turn_idx` (migration 119) — `turno_id` está dentro do `envelope_hmac` desde a migration 052, nas **duas** versões, então entrar no grupo passa a exigir concordar num campo que a própria assinatura da linha cobre;
3. um irmão devolvido cujo envelope verifica como `invalid` é **descartado** — e devolvido ao chamador em `refused`, que o router audita como `runtime_trace_attempt_group_row_refused`. Detecção que ninguém consegue ler depois não é detecção. `unknown` e `rejected_version` são reportados, não escondidos: sumir com uma linha que o operador já vê na listagem pareceria evidência desaparecendo.

Isto é **defesa em profundidade**, não o controle primário — o controle primário é a v2 assinar `root_trace_id` e `attempt`. Esta camada é a que continua valendo numa linha v1.

Evidência: `tests/unit/observability/envelope-signature-v2.spec.ts` compila o WHERE que a produção construiu (`PgDialect.sqlToQuery`) em vez de olhar argumentos de mock, e `tests/integration/trace-explorer-attempt-grouping.spec.ts` roda escritor real → repositório real → router e enxerta uma linha de outro turno com o `root_trace_id` reescrito, exigindo que ela seja recusada e auditada.

**Codificação canônica — achado negativo, verificado.** A pergunta era se um valor contendo o separador consegue forjar outro envelope. Não consegue: a codificação é `canonicalJson` (JSON de verdade, chaves ordenadas, `JSON.stringify` em toda chave e string), não concatenação com separador — aspas, vírgulas e dois-pontos dentro de um valor saem escapados e não fecham a própria string. Passou a ser teste em vez de comentário (`envelope-signature-v2.spec.ts` → "canonical encoding is unambiguous"), incluindo o caso de deslocamento de fronteira entre campos adjacentes (`tenant_id`+`agent_id`).


### ⚠️ AÇÃO DO OPERADOR — o recurso de migration da infra real recebe SÓ o subset `migrator` ([#565](https://github.com/diogenesmendes01/Maia-v2/issues/565))

> **Se o seu Coolify já tem um recurso próprio para o passo de migration**,
> copie `.env.migrator.prod.example` para o editor de variáveis dele, preencha
> os `__SET_ME__`, e **remova de lá qualquer chave de aplicação que estiver
> sobrando** — `WHATSAPP_*`, `OWNER_*`, chave de LLM, `VOYAGE_API_KEY`,
> `BACKUP_S3_*`, `NEXTAUTH_SECRET`, `OIDC_*`. Elas não são usadas, e o único
> efeito de estarem ali é aumentar o que um container comprometido pode vazar.
> Passo a passo: `docs/runbooks/deploy-prod.md` §7.5. Quem sobe por
> `compose.prod.yml` não tem nada a fazer — lá o serviço `migrate` já não tem
> `env_file` desde a #516.

A #565 entregou o gate (`npm run release:migrate`) e deixou em aberto a
**configuração de deploy real**. Decisão do dono: a infraestrutura tem uma
aplicação/job de migration **separada**, então ela recebe o subset `migrator` e
nada mais. Isso fecha, fora do Compose, a lacuna que `deploy-prod.md` §7.3
listava por escrito — *"o processo do migrator não os recebe, mas o container
em volta dele sim"*. Agora nem o container recebe.

- **`.env.migrator.prod.example`** (novo) — o subset `migrator` inteiro, 15
  chaves, com o porquê de cada uma e a lista explícita do que ele NÃO recebe.
  Ele é lido do disco por `tests/unit/config/migrator-subset.spec.ts`: o
  arquivo cru **reprova** (os `__SET_ME__` são placeholders de verdade,
  `secret/placeholder`) e, preenchido, faz `loadMigrationConfig()` passar. Um
  exemplo que ninguém executa é um exemplo que apodrece.
- **`src/config/migrator-subset.ts`** (novo) — a invariante do subset, e a
  razão de ela não ser uma lista de nomes. O guard que existia
  (`tests/unit/config/contract.spec.ts`) congelava sete nomes; a `WHATSAPP_*`
  criada na semana que vem passaria por ele em silêncio. Aqui a afirmação é
  sobre a **origem** da chave, lida do contrato: `group` (só `core` e
  `database`), namespace Maia (só `MAIA_`, todo o resto de
  `MAIA_KEY_PREFIXES` nomeia domínio de aplicação) e segredo-só-de-banco. Um
  grupo novo em `GROUP_ORDER` ou um prefixo novo em `MAIA_KEY_PREFIXES` nasce
  proibido **sem ninguém editar nada**. O PISO é a outra metade: `DATABASE_URL`
  presente e obrigatória nos três profiles — um subset que encolhe demais não é
  raio de explosão menor, é job quebrado.
- **`loadMigrationConfig()` chama o guard no boot** (`src/config/migration-config.ts`),
  e `scripts/migrate.ts` imprime a `MigratorSubsetError` inteira com exit 2 —
  mesma exceção à redaction que a `ConfigValidationError` já tinha, e pela
  mesma razão: a mensagem é feita de nome de variável, grupo e regra, nunca de
  valor. Acrescentar `WHATSAPP_NUMBER_MAIA` ao subset não amplia o raio de
  explosão do próximo deploy: derruba o migrator, nomeando a variável e a
  regra.
- **`tests/unit/scripts/migrate-subset-boot.spec.ts`** (novo) — a CLI REAL
  (`tsx scripts/migrate.ts`) num processo separado, com o
  `.env.migrator.prod.example` e mais nada (`PATH`/`HOME` à parte, que é o que
  a imagem dá ao container). Ela tem de **atravessar** o gate de configuração —
  a prova positiva é o `readiness: unknown … (ECONNREFUSED)` que só se imprime
  depois dele — e não pode nomear nenhuma chave de aplicação. Evidência de que
  fica vermelho: trocando `loadServiceConfig('migrator')` por
  `loadServiceConfig('runtime')` em `src/config/migration-config.ts` (uma
  linha, no call site de produção), o processo sai 2 com `Invalid configuration
  for service "runtime"` cobrando `REDIS_URL`, `WHATSAPP_NUMBER_MAIA`,
  `OWNER_*`, `BACKUP_S3_BUCKET`, `RUNTIME_TRACE_HMAC_MASTER_SECRET` e
  `ANTHROPIC_API_KEY`. É o defeito da #596 do outro lado.
- **Docs**: `docs/runbooks/deploy-prod.md` §7.5 (nova; Kubernetes virou §7.6),
  com a tabela "executado / não verificado" estendida; `docs/runbooks/migrations.md`
  ganhou a seção do recurso separado; `docs/admin-ui-deploy.md` deixa de
  descrever a topologia como só duas aplicações;
  `docs/architecture/modules/{migrations,config}.md`.

### Ordenação: a conversa passa a ter identidade e sequência duráveis — em shadow ([#505](https://github.com/diogenesmendes01/Maia-v2/issues/505), fases 1–2 de 9)

> **AÇÃO DO OPERADOR: aplique as migrations 118/119 ANTES de subir o código.**
> `FEATURE_TURN_STREAM_KEY` nasce ON, e um processo com a flag ligada contra um
> banco sem as colunas derruba **todo o ingresso** — a mesma armadilha (e a
> mesma ordem) do `FEATURE_TURN_STATE_MACHINE` com as `096`/`097`.

**O problema.** A BullMQ controla a concorrência do worker e não expressa
contrato de ordenação: duas mensagens da mesma conversa podem ser processadas
fora de ordem ou ao mesmo tempo. A #505 quer FIFO **por conversa** sem
serializar a fila inteira — e para isso a unidade de serialização precisa
existir **no ingresso**, antes de qualquer resolução de identidade, porque é ali
que a ordem de chegada é decidida. `conversa_id` não serve: `agent_turns.conversa_id`
é nullable por construção (o inbound é persistido antes da resolução), e uma
unidade de ordenação que às vezes é NULL colapsa todo mundo numa stream só —
exatamente a serialização global que a issue proíbe.

**Esta fatia entrega as fases 1–2 (shadow) e nada além.** As colunas passam a
ser preenchidas; **nada as lê para decidir**. Head-of-line como condição do
claim, exclusão "no máximo um turno ativo por stream", debounce transacional,
promoção de sucessor, política de retry/DLQ por stream e backfill ficam para as
fatias seguintes.

**`stream_key` — por que comprimento-prefixado, e não `a:b:c`.** A chave é um
SHA-256 de material canônico sobre `tenant_id + agent_id + tipo de canal + linha
+ identidade remota normalizada`. Concatenar com separador é ambíguo:
`["a:b","c"]` e `["a","b:c"]` produzem a **mesma** string, e duas conversas
distintas passariam a compartilhar ordem, lock e — na fase de enforcement —
exclusão mútua. A issue classifica colisão como risco de **segurança**, não de
qualidade. O encoding é netstring (`<bytes>:<valor>,`, comprimento em bytes UTF-8),
que é injetivo por construção; escapar o separador consertaria também, mas
transferiria a corretude para quem lembrasse de aplicar o escape em cada
componente novo. A versão do algoritmo aparece no valor (`v1:<sha256>`) **e** na
coluna `stream_key_version` — o prefixo torna a chave auto-descritiva e faz duas
versões nunca colidirem.

**Fail-closed, sem exceção.** `tenant_id`/`agent_id` são obrigatórios;
`'default'` e `'system'` são recusados; a LINHA (`channel_id`) é obrigatória
(desde a `090` a conversa é escopada por canal — sem ela, o mesmo interlocutor
em duas linhas colapsaria numa stream). Ingresso irresolúvel é **recusado**,
auditado (`stream_ingress_rejected`) e **não persistido**. Nunca há queda para
stream genérica: é a invariante MUST nº 2/nº 8, e a issue nomeia esse fallback
como uma das falhas que ela existe para impedir (§Falhas 8). Em produção esse
caso já era fail-closed antes daqui — todo ramo não-lançante de `resolveChannel`
devolve `channel_id`, e um miss já derrubava a mensagem no `handleIncoming`.

**`ingress_seq` — por que a alocação mora DENTRO da transação do INSERT.**
`SELECT max(seq)+1` seguido de INSERT é a forma intuitiva e está errada: dois
produtores leem o mesmo máximo e alocam o mesmo número. A alocação é um
`INSERT … ON CONFLICT DO UPDATE … RETURNING` sobre `agent_stream_sequences` —
uma declaração atômica cujo lock de row serializa **apenas** aquela stream
(streams distintas nunca se veem, e não há lock global por tenant, agente ou
fila). Ela corre na mesma transação do INSERT da mensagem, e é isso que faz
"redelivery reusa a sequência original" (§Acceptance) valer **por construção**:
se a reentrega colidir na unique de dedup, a transação inteira reverte e o
número volta. Não há caminho de compensação a lembrar de escrever. A dedup por
`whatsapp_id` precede tudo, no pre-check de `createInbound`, então a reentrega
comum nem abre transação.

**Onde a decisão mora, e por quê.** A GUARDA (`requireStreamIdentity`, pura) é
chamada por `mensagensRepo.createInbound`; o RELATO (métrica, `audit_log`, log)
é chamado pelo GATEWAY. A divisão não é estética: `src/db/repositories/` é
compartilhado entre o container `app` e o console `admin-ui`, e a cadeia
`métrica → labels → src/config/env.ts` faria o console validar o subset `runtime`
no boot e exigir dele as seis `BACKUP_*` num processo que nunca roda backup — a
regressão que `tests/unit/config/admin-import-boundary.spec.ts` pegou nesta
própria fatia. Pela mesma razão a flag é lida por `contractEnv`. Consequência
honesta: um chamador futuro de `createInbound` que não relate continua
fail-closed, mas a recusa dele não vira série nem `audit_log`.

**A evidência de que cada invariante está de fato travada** — cada defeito
reintroduzido com UMA edição no código de PRODUÇÃO, não num harness espelhado:

| Defeito reintroduzido | Teste que ficou vermelho |
|---|---|
| a recusa vira `return { stream_key: 'default' }` em `requireStreamIdentity` | 4 casos: `createinbound-stream-fail-closed` (3) + `stream-ingress-sequence-real-db` (1) — todos `promise resolved … instead of rejecting` |
| `lengthPrefixed` volta a ser `` `${value}:` `` | 7 casos de `stream-key-canonical` — `expected 'maia.stream.v1:a:b:c:' not to be 'maia.stream.v1:a:b:c:'` |
| a alocação sai da transação (`allocateIngressSeq(db, …)` no lugar de `(tx, …)`) | `stream-ingress-sequence-real-db` — `expected '6' to be '1'` no contador, e a corrida de 50 estoura o pool |
| `reportStreamIngressRejected` some do `catch` do gateway | `baileys-stream-identity-drop` — a recusa vira queda SEM trilha |

O teste de fail-closed entra por `mensagensRepo.createInbound`, o call site REAL
do ingresso, e afirma a ausência do INSERT — não só o `throw`. Recusar depois de
persistir seria fail-open com log bonito. O da trilha entra por
`ingressUpsertMessage`, o ponto por onde o Baileys entrega `messages.upsert`.

**Fronteiras do turno.** `first_ingress_seq`/`last_ingress_seq` nascem iguais
(turno simples). `absorbDebounceInputs` estende com `LEAST`/`GREATEST` e **só**
com ingressos da mesma `stream_key`: uma mensagem de outra conversa não move a
fronteira, o que é fail-closed por construção em vez de validação do chamador.

**Observabilidade.** `maia_stream_ingress_total{channel_kind,result}` e
`maia_stream_ingress_rejected_total{reason}` — vocabulários FECHADOS.
`stream_key`, `remote_jid` e `turn_id` **não** são labels (a issue proíbe): eles
vivem no log estruturado `stream.ingress_sequenced`, que é de onde se reconstrói
a ordem de uma conversa. Em `audit_log` entram só dois fatos: a recusa, e o
NASCIMENTO da stream (`ingress_seq = 1`). Auditar cada mensagem inflaria a tabela
na razão do tráfego sem acrescentar decisão governável — a issue pede a auditoria
"quando relevante" (§Observability), e é essa a ressalva.

**Schema (migrations 118 + 119, ambas com `_down`).** `mensagens` ganha
`stream_key`/`stream_key_version`/`ingress_seq`; `agent_turns` ganha
`stream_key`/`stream_key_version`/`first_ingress_seq`/`last_ingress_seq`; nasce
`agent_stream_sequences` (PK `(tenant_id, agent_id, stream_key)` — a chave já
embute o par no material canônico, mas embutir não é **escopar**: com o par na
PK, uma `stream_key` forjada não consegue nem endereçar o contador de outro
tenant). Tudo NULLABLE nesta fase, **sem backfill** — inventar ordem histórica
que nunca existiu seria pior que admitir que ela não existe (§Backfill).

A `119` é separada e `no-transaction` pela mesma razão que a `096` foi separada
da `097`: a unique parcial `(tenant_id, agent_id, stream_key, ingress_seq)` e o
índice de head-of-line são construídos `CONCURRENTLY`, e os CHECK entram
`NOT VALID` com `VALIDATE` em statement próprio — validar sob ACCESS EXCLUSIVE
numa tabela quente é janela de perda de ingresso. Os CHECK usam
`(x IS NULL) = (y IS NULL)` como guarda porque um CHECK do Postgres só reprova
em FALSE: com NULL ele **aceita**, que é a armadilha ternária documentada na
`097`. O `_down` da `118` tem envelope `BEGIN`/`COMMIT` (o runbook aplica `_down`
com `psql -f`, que é autocommit por statement); o da `119` **não pode** ter —
`DROP INDEX CONCURRENTLY` é recusado em transação —, e em compensação todo
statement dele é idempotente e independente. Round-trip up→down→up verificado
contra PostgreSQL 16 real.

**`ingress_seq` colide de nome com o de `agent_turn_inputs`, e a colisão é
deliberada — registre a distinção:** aquele é a posição **dentro do turno**
(0 = representativa, `integer`); este é a posição **dentro da stream** (começa em
1, `bigint`, porque uma stream longeva pode passar de 2^31 ao longo de anos e
migrar o tipo depois exigiria reescrever a tabela mais quente do runtime).

### Added — o ledger `outbound_messages` vira outbox durável, e a saída do turno ganha DUAS identidades ([#630](https://github.com/diogenesmendes01/Maia-v2/issues/630), fatia A de [#506](https://github.com/diogenesmendes01/Maia-v2/issues/506))

**Nada muda em runtime.** A fatia é aditiva: schema + tipos, nenhum caminho
novo de envio, nenhum call site tocado. `src/agent/output-dispatch.ts` continua
byte-a-byte o que era. O que passa a existir é o vocabulário que as fatias
irmãs (#631 commit transacional, #632 delivery worker, #633 recovery/DLQ, #634
call sites, #635 multipart) precisam para não divergirem entre si.

**Por que duas chaves, e não uma.** `logical_dedupe_key` responde "qual saída
lógica é esta, dentro da Maia" e é o eixo do UNIQUE que impede um retry do
turno de virar uma segunda resposta. `provider_idempotency_key` responde "que
identificador o adaptador usa" e vira o `messageId` que o Baileys grava na key
da mensagem — dedupe real do lado do WhatsApp, que chaveia por
`(remoteJid, fromMe, id)`. Colapsá-las numa coluna só custaria uma das duas
coisas: ou a Maia perde unicidade para caber no formato alheio (`3EB0` + 18
hex), ou entrega a um terceiro o identificador que é a sua própria chave de
dedupe. As duas saem do **mesmo material canônico** com **rótulo de domínio
diferente**: mesma origem, namespaces disjuntos, nenhuma derivável da outra.

**A ambiguidade de encoding é real, não teórica — e foi por isso que o
separador `:` sugerido em #506 não foi usado.** `tenants.id` e `agents.id` são
`TEXT PRIMARY KEY` **sem CHECK de formato** (migração `007`): um id **pode**
conter `:`. Sob concatenação ingênua, `tenant='acme:x' agent='y'` e
`tenant='acme' agent='x:y'` produzem o **mesmo** material — dois tenants, uma
chave, violação do invariante nº 1. O material usa **netstring**
(`<bytes>:<conteúdo>`, bytes em UTF-8), injetiva para qualquer string,
inclusive uma que contenha o separador ou NUL. Evidência: a sonda que troca o
enquadramento por `join(':')` deixa `SONDA 1` vermelha com as duas chaves
idênticas.

**O material só tem campo imutável** — `tenant_id`, `agent_id`, `turn_id`,
`sequence_in_turn`, `payload_hash`. `attempt`, `status`, `claim_token` e
timestamps ficam de fora: uma chave que muda entre a tentativa 1 e a 2 não
deduplica nada, garante o duplo envio que existe para impedir.
`deriveOutboundKeysFromRow` aceita a row **inteira**, com os mutáveis, e o
corpo projeta só os imutáveis — é o que torna a propriedade verificável num
lugar só.

**O risco declarado na mãe ("constraints em tabela existente podem falhar com
duplicatas históricas") não se materializa, e a razão é estrutural, não
otimista.** Os dois uniques são **PARCIAIS** (`WHERE … IS NOT NULL`) sobre
colunas **novas**, que nascem NULL em toda row existente: o conjunto indexado
no momento do apply é **vazio**, então não há entrada possível para colidir.
Não há backfill (promover row legada é decisão de dado, não de schema). Ainda
assim a migração pré-checa com `RAISE EXCEPTION` que conta as duplicatas e
nomeia o escopo, para o caso de rodar depois de um backfill de outra branch.

**O que a plataforma realmente sabe enviar foi verificado, não presumido.** A
fronteira única de saída (`LineOutput`, `src/gateway/line-output.ts`) declara
`sendText`/`sendVoice`/`sendDocument`/`sendPoll`/`sendReaction`. Portanto:
`image` e `video` **não** entram na união nem no CHECK — não há primitiva, e
#506 §Out of Scope proíbe implementar tipo não suportado; admiti-lo só no
schema criaria row que nenhum worker entrega, um `pending` eterno vendido como
completude. `interactive` genérico também não existe: a única forma real é a
enquete, e o valor chama-se `interactive_poll` justamente para ninguém concluir
que botão/lista estão cobertos.

**Segredo não é filtrado por regex — não tem onde caber.** Mídia só existe
como `local_path` ou `storage_object`; nenhuma variante aceita URL, então URL
assinada de vida longa não é persistível por construção. Cada membro da união
é `.strict()`, inclusive o objeto aninhado de mídia — o teste de contrato pegou
exatamente esse buraco (um `signed_url` extra era silenciosamente descartado em
vez de recusado) antes do primeiro commit.

Migração `121_outbound_messages_durable_outbox.sql` (+ `_down` com envelope
`BEGIN`/`COMMIT`, que o `psql -v ON_ERROR_STOP=1 -f` exige para não ser
fail-open). O `_down` aborta **inteiro** e com mensagem acionável se houver row
nos estados novos: reescrevê-los para caber no vocabulário de 063 apagaria a
distinção entre "o provedor aceitou" e "não sabemos", que é a origem do reenvio
cego.

**Evidência contra Postgres real** (não só afirmada). Os dois specs
pré-existentes que exercitam `outbound_messages` pelo caminho síncrono legado
(`turn-lease-lost-outbound-branches-real-db`, `turn-lease-lost-effects-real-db`)
seguem verdes junto com os 14 casos novos — 25/25 —, que é a prova de que o
aditivo é aditivo. O subconjunto de leak com banco real (`leak`, `repos-leak`,
`agent-turns-leak`, `cross-entity`, `constitutional`) fecha 61/61.

**Reversibilidade, também medida:**
`up` aplica; `down` devolve a tabela às 12 colunas e aos CHECKs de 4 valores
da 063 — com `provider_message_id` PRESERVADA, porque ela é da 063 e a 121 só
a reaproveitou (dropá-la seria o erro clássico de down escrito por lista de
colunas em vez de por diff); `up` reaplica; e uma segunda aplicação seguida do
`up` não produz nenhum erro (idempotente). Com uma row em `delivery_unknown`
plantada, o `down` aborta com a mensagem acionável **e a coluna
`logical_dedupe_key` continua existindo** — isto é, o rollback inteiro voltou
atrás, que é precisamente o que o envelope existe para garantir.

Contrato puro em `src/runtime/outbound/contract.ts` (irmão de
`src/runtime/turns/contract.ts`: sem `db`, sem I/O, sem ALS, sem relógio).
Docs: [`modules/runtime.md`](docs/architecture/modules/runtime.md),
[`modules/db.md`](docs/architecture/modules/db.md) (§ acrescentar constraint a
tabela com dado),
[`modules/agent.md`](docs/architecture/modules/agent.md).

### ⚠️ AÇÃO DO OPERADOR — se algum health check seu aponta para `GET /health`, ele nunca reprovou nada ([#613](https://github.com/diogenesmendes01/Maia-v2/issues/613))

> **Nada quebra neste release. O que muda é que agora está escrito.** Se você
> configurou o health check do `app` (Coolify, load balancer, uptime monitor)
> como `GET /health` → 200 — o que `docs/admin-ui-deploy.md` mandava fazer até
> a #565 —, esse check está **verde desde sempre**, inclusive durante as quedas
> de Postgres, Redis e WhatsApp que ele deveria ter pego. Troque:
>
> | O campo decide… | Endpoint certo |
> |---|---|
> | reiniciar o container | **`GET /livez`** — é o que `compose.prod.yml` usa; sem I/O, não vira restart loop numa queda de dependência |
> | mandar tráfego (pool do LB) | **`GET /readyz`** — role-aware, fail-closed, é onde a readiness de schema da #516 está ligada |
>
> `compose.prod.yml` já usa `/livez` (#512), então quem sobe só por Compose não
> tem nada a fazer.

**A decisão, e por que ela não é "fazer `/health` responder 503"** — [ADR 0003](docs/architecture/decisions/0003-health-is-diagnostic-livez-readyz-are-the-probes.md).

`/health` e `/health/{db,redis,whatsapp}` passam a ser **explicitamente
endpoints de diagnóstico**: respondem **200 sempre** que conseguem produzir o
relatório, inclusive com `"status": "down"` no corpo. O 200 afirma *"produzi o
relatório"*; o veredito é o corpo.

A alternativa — 503 quando `unhealthy` — foi considerada e **recusada**, porque
`checkAll()` (`src/lib/healthcheck.ts`) é **role-blind e chapado**: não conhece
`MAIA_PROCESS_ROLE`, não separa componente obrigatório de observado e não tem
política de degradação. `whatsapp: down` derruba o agregado para `down`, e esse
é o estado **normal** de um processo `api`, `worker` ou `scheduler` — que nunca
teve sessão de WhatsApp. Promover esse agregado a veredito de roteamento não
tiraria de rotação instâncias erradamente saudáveis; tiraria instâncias
**corretamente saudáveis**, e faria o `all` flapar a cada reconexão de rotina do
Baileys. O gate role-aware continua sendo o `/readyz`, e passa a ser o único.

O que mudou no código e no contrato de resposta:

- **`src/server.ts`**: os quatro handlers de `/health*` chamam `asDiagnostic(reply)` — `reply.code(200)` **explícito**. Antes o handler simplesmente não chamava `reply.code`, e uma omissão não se distingue de uma decisão.
- **Header novo em toda resposta de `/health*`**: `x-maia-endpoint-kind: diagnostic`.
- **Corpo do `/health` ganhou dois campos**: `"probe": false` e `"probes": { "liveness": "/livez", "startup": "/startupz", "readiness": "/readyz" }` — para quem apontou um check para lá descobrir isso na resposta que já está lendo. Nada neste repositório consome o corpo do `/health`; um consumidor externo que afirme conjunto exato de chaves precisa de ajuste.
- **`tests/unit/server/health-probe-contract.spec.ts`** fixa a distinção entre os quatro endpoints contra o `buildServer()` **real** (não um Fastify espelhado): fica vermelho tanto se alguém fizer `/health` reprovar quanto se remover a marcação de diagnóstico do handler.
- Docs reconciliados: `docs/admin-ui-deploy.md`, `docs/runbooks/operational.md` §8.1, `docs/architecture/modules/lib.md`, `docs/architecture/modules/runtime.md`.

### Changed — o gate do console passa a medir o ARTEFATO DE PRODUÇÃO, e o typecheck passa a enxergar os tipos do Next 16 ([#472](https://github.com/diogenesmendes01/Maia-v2/issues/472) parte A)

Duas decisões do dono sobre o job `admin-ui` de `.github/workflows/ci.yml`, entregues juntas porque a segunda é o que torna a primeira possível.

- **Typecheck do console DEPOIS do build, e bloqueante.** `src/admin-ui/tsconfig.json` já listava `.next/types/**/*.ts` em `include`, mas trazia `.next` em `exclude` — e `exclude` vence `include`. Os tipos que o `next build` **gera** (um arquivo por rota, onde o Next 16 declara que `params` é `Promise`) **nunca foram checados**. O `exclude` encolheu para `["node_modules", "dist"]` e o job ganhou um passo `Typecheck do console PÓS-BUILD`, depois do build e sem `continue-on-error`. **Medido**: revertendo `params: Promise<{ id: string }>` para `params: { id: string }` em `app/proposals/[id]/page.tsx`, com `.next` no `exclude` o `tsc --noEmit` sai **0**; sem ele, reprova em `.next/types/app/proposals/[id]/page.ts(39,29): error TS2344`. O `Typecheck admin-ui` do job `validate` continua onde estava: aquele job não constrói o console, então cobre o código-fonte em duas pernas de Node — este cobre o que só existe depois do build.
- **E2E contra o servidor standalone.** `scripts/admin-ui-e2e.sh` deixou de rodar `next start`: agora monta o artefato como o `src/admin-ui/Dockerfile` monta (`.next/standalone` como raiz, `.next/static` copiado para `src/admin-ui/.next/static` dentro dele) e sobe `node src/admin-ui/server.js` — o mesmo `CMD` da imagem. `next start` serve o `.next` da árvore de trabalho com o `node_modules` inteiro ao alcance e é cego para as duas falhas que derrubam o container: módulo que o tracer do Next não seguiu, e estático fora de posição. **Medido**: sem o `cp` de `.next/static`, 2 dos 5 testes do `smoke` reprovam.
- **O profile do E2E mudou de `development` para `staging`, e isso ENDURECE o gate.** Não foi escolha: o `server.js` que o `next build` gera abre com `process.env.NODE_ENV = 'production'`, antes do `require('next')` e muito antes de `instrumentation.register()`. Com isso `MAIA_ENV=development` reprova o boot em `profile/node-env-contradiction`, e `MAIA_ENV` ausente cai em `production`. `staging` é o único profile satisfazível — e é o que `compose.prod.yml` injeta no container. O passo passa a declarar as quatro `OIDC_*` (issuer em `.invalid`, RFC 2606 — o smoke nunca contata IdP) e `NEXTAUTH_URL` em https. Antes, o boot do console era validado no profile `development`, onde o subset `admin-ui` só exige `DATABASE_URL`; agora o E2E prova que o artefato de produção sobe sob a validação **estrita** do contrato. `MAIA_CONFIG_STRICT_BOOT` continua fora do bloco: desligar o contrato para o E2E passar seria o desarme que o guard abaixo existe para impedir.
- **`tests/unit/ci/admin-ui-e2e-gate.spec.ts` foi reescrito para PARSEAR o workflow**, em vez de varrer texto. Ele lê `jobs['admin-ui'].steps` com parser YAML, extrai o entrypoint e o destino do estático do **próprio Dockerfile** (nenhum caminho é escrito duas vezes) e — o caso central — **executa** `register()` de `src/admin-ui/instrumentation.ts` com o bloco `env:` literal do workflow mais o `NODE_ENV=production` que o artefato impõe. Se o bloco do CI deixar de bootar o console, a spec fica vermelha em vez de o CI quebrar. Reprova também: typecheck movido para antes do build, `.next` de volta no `exclude`, `next start` de volta no script, e `continue-on-error`/`|| true` em qualquer passo de veredito.

### Removed — `recharts` sai do console; o upgrade 2 → 3 não tinha o que migrar ([#605](https://github.com/diogenesmendes01/Maia-v2/issues/605))

A issue pedia o major `recharts` 2 → 3 "com o visual do console verificado", e o primeiro critério de aceite era o **inventário das telas que usam Recharts**. O inventário deu **vazio**: nenhum arquivo do repositório importa `recharts`, e nenhum commit da história inteira jamais importou (`git log --all -S "from 'recharts"` não devolve nada). O pacote entrou no scaffold do P8.5 (`e23c8523`) junto com um kit de UI que nunca foi ligado. As telas do console — `audit`, `dashboard`, `drift`, `traces` — são tabelas, badges e formulários; **não há gráfico**.

- **`recharts` removido** de `src/admin-ui/package.json`. O critério de aceite da issue exigia "snapshot visual, ou asserção sobre o SVG gerado, ou E2E que confira os elementos do gráfico; **nenhuma verificação não serve**" — com zero telas afetadas esse critério é insatisfazível para um upgrade: não existe SVG para assertar. Subir para o 3.x seria trocar um major por outro sem uma única evidência de render. A remoção, essa sim, é verificável: nada importava o pacote, então nada era empacotado, e o build e o smoke E2E do console não mudam.
- **Lockfile: remoção pura.** `src/admin-ui/package-lock.json` foi de 572 para 538 pacotes — 34 saíram (`recharts`, `recharts-scale`, `victory-vendor`, `react-smooth`, os 11 `d3-*` e 9 `@types/d3-*`, `lodash`, `clsx`, `eventemitter3`, `tiny-invariant`, `decimal.js-light`, `dom-helpers`, `fast-equals`, `internmap`, `react-transition-group`, `react-is@18` aninhado), **zero adicionados e zero com versão alterada**.
- **`tests/unit/admin-ui-dependencia-sem-importador.spec.ts`** tranca a invariante geral, não o nome: toda dependência de runtime do console tem importador em `src/`, ou tem motivo escrito. Uma dependência fantasma não é inerte — ela vira advisory no ledger de exceções ([#526](https://github.com/diogenesmendes01/Maia-v2/issues/526)) e PR de major do Dependabot (foi a [#587](https://github.com/diogenesmendes01/Maia-v2/issues/587)) por código que não existe.
- **Três dívidas da mesma origem ficaram documentadas** na allowlist do guard, em vez de invisíveis: `@tanstack/react-table`, `react-hook-form` e `react-diff-viewer-continued` também vieram do scaffold e também não têm importador. Removê-las está fora do escopo desta issue.

### ⚠️ BREAKING (operacional) — o console valida o subset `admin-ui` no boot, e o `.env.admin` encolhe ([#596](https://github.com/diogenesmendes01/Maia-v2/issues/596))

> **Um `.env.admin` que sobe hoje pode recusar o boot depois deste release** — e é esse o ponto. Rode `npm run config:preflight` antes do `up`.

1. **O boot do `admin-ui` passou a avaliar o subset `admin-ui` do contrato**, em `src/admin-ui/instrumentation.ts` — o hook que o Next.js aguarda em `BaseServer.prepare()`, antes do primeiro request. Um erro ali impede o container de servir.

   | Condição | Antes | Agora |
   |---|---|---|
   | As quatro `OIDC_*` ausentes em `staging`/`production` | **sobe** e entrega a tela "no providers configured" | **não sobe** (`profile/required`) |
   | `OIDC_TENANT_SLUGS=default` (o slug É o `tenant_id`) | sobe | **não sobe** (`admin-ui/tenant-slugs-default-literal`) |
   | `NEXTAUTH_SECRET` fraco / placeholder | lançava no PRIMEIRO REQUEST | **não sobe** |
   | Chave exclusivamente `runtime` ausente (as seis `BACKUP_*`, `WHATSAPP_*`, `OWNER_*`, chave de LLM, `VOYAGE_API_KEY`) | **não subia** | sobe — o console não as usa |

   O `next build` **não** passa pelo hook (o Next pula instrumentation em `phase-production-build`), então a imagem continua construível sem `.env.admin`.

2. **`.env.admin.prod.example` perdeu o bloco `BACKUP_*` e o bloco "exigidas transitivamente".** A orientação anterior — pôr no `.env.admin` uma credencial S3 separada e sem permissão, e keyring fictício mas válido — **não vale mais**: aquelas variáveis não vão mais para o container do console. Se o seu `.env.admin` as tem, remova-as: elas só aumentam o raio de explosão de um vazamento.

   `RUNTIME_TRACE_HMAC_MASTER_SECRET` **fica**, e agora por direito: o console verifica a integridade dos envelopes de trace, então as três `RUNTIME_TRACE_HMAC_*` passaram a declarar `services: ['runtime', 'admin-ui']` no contrato. Sem ela, o explorador de traces mostraria tudo como "não verificável".

3. **Causa raiz desfeita, e não contornada.** O console importava `src/config/env.ts` — direto em `src/admin-ui/trpc/tool-enablement.ts` e `src/admin-ui/trpc/routers/tools-catalog.ts`, e transitivamente por `@/db/client.ts` — e aquele singleton valida `service: 'runtime'` no import. Os sete módulos **compartilhados** pelos dois containers (`db/client.ts`, `lib/logger.ts`, `lib/llm-settings.ts`, `governance/idempotency.ts`, `control-plane/runtime-trace/lib/hmac.ts`, `gateway/staging-crypto.ts`, `config/feature-flags.ts`) passaram a ler o contrato por `src/config/contract-env.ts` — uma variável por vez, no acesso, com o mesmo schema. `tests/unit/config/admin-import-boundary.spec.ts` reprova se algum caminho de import do console voltar a alcançar o singleton.

   O boot fail-closed do **runtime** não mudou: sete scripts que alcançavam `@/config/env.js` de carona (`import-ofx`, `import-review`, `seed-holidays`, `seed-proposals-fixtures`, `activate-synthetic-probe`, `backfill-agent-turns`, `p8d-migration-priorities`) ganharam o import explícito, e o mesmo teste fixa por nome o conjunto de entrypoints que o alcançam.

4. **`COMPOSE_SERVICE_CONTRACT['admin-ui']` voltou a ser `['admin-ui']`.** `npm run config:preflight` continua sendo o gate que mede os ARQUIVOS antes de existir container; ele deixou de ser a ÚNICA checagem daquele subset.

### Added — CI constrói e executa o console de administração ([#472](https://github.com/diogenesmendes01/Maia-v2/issues/472) parte A)

Pré-requisito declarado das issues [#604](https://github.com/diogenesmendes01/Maia-v2/issues/604) (Next 15.5 → 16) e [#605](https://github.com/diogenesmendes01/Maia-v2/issues/605) (Recharts 2 → 3): até aqui o CI rodava `admin:typecheck` e as specs de `tests/admin-ui/unit/`, e **nenhum dos dois executa o console**. Um `next build` quebrado e uma regressão de runtime do Admin passavam por todos os checks.

- **Job novo `admin-ui`** em `.github/workflows/ci.yml`, bloqueante: `next build` + Playwright contra o console **construído**, com Postgres (pgvector) e Redis de serviço, migrations aplicadas e Chromium instalado pelo próprio workflow.
- **`tests/admin-ui/e2e/console-boot.spec.ts`**: smoke de boot do artefato — redirect do middleware (bundle Edge), route handler do NextAuth, hidratação do bundle de cliente, cabeçalhos de segurança de `next.config.mjs`, e canário de "zero erro de console / zero 5xx".
- **`scripts/admin-ui-e2e.sh`** sobe e derruba o console e **falha fechado** em cada pré-requisito ausente (sem build, sem `DATABASE_URL`/`REDIS_URL`/`NEXTAUTH_SECRET`, servidor que não responde).
- **`scripts/check-playwright-run.ts`** reprova rodada com **0 teste executado** ou com **qualquer teste pulado**. O Playwright sai com código 0 quando não acha teste nenhum; sem esse piso, "Running 0 tests" seria um check verde.
- **`tests/unit/ci/admin-ui-e2e-gate.spec.ts`** impede o gate de ser desarmado por edição: `continue-on-error` num passo de veredito, piso de testes removido, quarentena crescendo em silêncio, e divergência entre o env de build do CI e o do `src/admin-ui/Dockerfile`.

### Fixed — o build da imagem do console estava quebrado, e três comandos documentados não rodavam

Encontrados ao construir o gate acima. Todos eram invisíveis porque nada no CI executava o console.

- **`src/admin-ui/Dockerfile`**: o bloco de env do estágio `build` estava desatualizado em relação ao contrato #515. Sem `MAIA_ENV` e sem `BACKUP_S3_BUCKET`/`BACKUP_S3_ACCESS_KEY`/`BACKUP_S3_SECRET_KEY`, `next build` morria em `Failed to collect page data for /api/auth/[...nextauth]` — ou seja, a imagem de produção do Admin **não construía**.
- **`npm run admin:build` / `admin:start`**: eram `cd src/admin-ui && next build`, e o `next` só existe em `src/admin-ui/node_modules`, que não está no `PATH` de um script npm da raiz. Falhavam com `sh: 1: next: not found`. Agora delegam via `npm --prefix src/admin-ui run build`.
- **`npm run test:admin-ui:e2e`**: morria em `Cannot find package '@playwright/test' imported from playwright.config.ts` antes mesmo de carregar o config — o pacote só existia no `node_modules` do admin-ui. `@playwright/test` passa a ser `devDependency` da raiz, onde o config e as specs vivem.

### Changed — suíte e2e do Admin dividida em `smoke` e `jornadas-pendentes`

`playwright.config.ts` ganha dois `projects`. O gate do CI roda **`smoke`**. As dez specs de P8.5/#518 ficam marcadas `@pendente-472` no título do `describe` e **fora do gate**: elas navegam para telas atrás de sessão (o `middleware.ts` redireciona tudo para `/auth/signin`) e dependem de fixtures que `scripts/seed-proposals-fixtures.ts` não cria (`test-id`, `locked-test`, `hard-limit-test`, `audit-test`, `reject-test`, `test-trace-id`). Fazê-las passar é o corpo da #472. A quarentena é auditável: a lista exata de arquivos é fixada em `tests/unit/ci/admin-ui-e2e-gate.spec.ts`, e uma spec e2e nova entra em `smoke` por construção.

### ⚠️ BREAKING (operacional) — `/readyz` passa a gatear no veredito canônico de schema ([#516](https://github.com/diogenesmendes01/Maia-v2/issues/516))

> **Duas mudanças que podem tirar instâncias de rotação (ou recusar o boot) num ambiente que sobe hoje.** Rode `tsx scripts/migrate.ts status` contra cada banco **antes** de deployar: se ele não imprimir `readiness: ready`, o `/readyz` do release novo responderá 503. Runbook: [`docs/runbooks/operational.md`](docs/runbooks/operational.md) §8.1.

1. **O componente `schema` do `/readyz` agora é `getSchemaReadiness()`** (`src/migrations/readiness.ts`), não mais a comparação "id mais novo do ledger × arquivo mais novo em disco" (`checkSchemaVersion()`). Passam a responder **503** condições que antes davam 200:

   | Condição | Antes | Agora |
   |---|---|---|
   | Linha `dirty` no ledger | 200 | **503** (`dirty_migration`) |
   | Checksum do artefato ≠ do ledger | 200 | **503** (`checksum_mismatch`) |
   | Migration aplicada sem checksum registrado (ledger v1) | 200 | **503** (`checksum_unknown`) |
   | Ledger cita migration que o build não empacota | 200 | **503** (`missing_file`) |
   | Migration `running` (migrator em voo ou morto) | 200 | **503** (`running_migration`) |
   | Banco à frente do artefato | 200 (explicitamente `ok`) | 503 só se o build declarar `max_supported_migration` |
   | Head esperado não aplicado | 503 | **503** (`schema_below_minimum`) |
   | Banco fora / ledger ausente / `migrations/` ilegível | 503 | **503** (`unknown`, fail-closed) |

   **Ordem de deploy:** o migrator precisa rodar **antes** da aplicação. Um banco com ledger v1 mantém o `/readyz` em 503 com `checksum_unknown` até `npm run db:migrate` adotar os checksums empacotados.

   O veredito é cacheado por **10 s** e chamadas concorrentes são coalescidas, então o custo é ~uma avaliação por 10 s por réplica, independente da frequência do load balancer. Atenção ao número que importa em incidente: o `/readyz` também passa pelo cache composto de `READINESS_CACHE_MS` (2 s no default), então um 200 obsoleto pode sobreviver por `SCHEMA_READINESS_TTL_MS + READINESS_CACHE_MS` — **12 s nos defaults**, e mais se o `READINESS_CACHE_MS` subir.

2. **`READINESS_SCHEMA_CHECK=false` passa a ser inválido no profile `production` e recusa o boot** (regra `lifecycle/schema-check-disabled`, severidade `error`, escopo `boot` — vale inclusive sob `MAIA_CONFIG_STRICT_BOOT=false`). Em `staging` continua permitido, com aviso; em `development`, silencioso. Antes era aviso em todos os profiles fora de `development`.

   **Ação:** remova `READINESS_SCHEMA_CHECK=false` do `.env` de produção (o default é `true`).

O passo de **boot** (`src/index.ts`, etapa `schema`) continua usando `checkSchemaVersion()` de propósito — unificá-lo com o veredito estrito transformaria toda condição que hoje produz uma instância diagnosticável fora de rotação num crash loop, e isso é decisão de política ainda aberta na #516.

### ⚠️ BREAKING (operacional) — o boot passa a falhar fechado por configuração ([#515](https://github.com/diogenesmendes01/Maia-v2/issues/515))

> **Um ambiente que sobe hoje pode parar de subir no primeiro release que contiver esta mudança.** Rode `npm run config:check -- --profile production --env-file .env` contra o `.env` de cada ambiente **antes** de deployar. Runbook completo: [`docs/runbooks/config-contract.md`](docs/runbooks/config-contract.md).

O boot agora valida o contrato inteiro e **aborta em TODOS os profiles — `development` incluído**. Antes, só as regras legadas de boot eram aplicadas e o resto ficava no `maia config check`.

> **Abortar em `development` é decisão deliberada do owner, não descuido.** O rollout descrito na issue #515 (passo 6) previa *aviso* em `development` e erro só em staging/produção. Durante a review da [PR #522](https://github.com/diogenesmendes01/Maia-v2/pull/522) o owner decidiu explicitamente ligar o fail-closed em todos os profiles, ciente da divergência em relação ao texto da issue: um `.env` que sobe no laptop e morre em staging é justamente o drift que o contrato existe para eliminar. Quem for revisitar isso depois: o ponto de revert é único e está documentado no runbook §4.3.

Passam a abortar o boot:

| Situação | Regra | Antes |
|---|---|---|
| `FEATURE_MULTI_CHANNEL`, `FEATURE_COGNITIVE_GRAPH` ou `APROVAR_MENSAGENS_PROATIVAS` no ambiente | `contract/removed` | ignorado em silêncio |
| Qualquer `MAIA_*` / `FEATURE_*` / `BACKUP_*` … fora do contrato | `contract/unknown` | ignorado em silêncio |
| `MAIA_ENV` ausente em staging/produção | `profile/required` | não existia |
| `MAIA_ENV` contradizendo `NODE_ENV` | `profile/node-env-contradiction` | não existia |
| Placeholder (`__SET_ME__`, `sk-ant-...`) em staging/produção | `secret/placeholder` | não existia |
| Valor de fixture sintética de CI em staging/produção | `secret/synthetic-fixture` | não existia |
| Dependência condicional não satisfeita (ex.: `FEATURE_OUTBOUND_VOICE=true` sem `OPENAI_API_KEY`) | `contract/required-when` | não existia |

**Ações necessárias antes de deployar:**

1. **Adicione `MAIA_ENV=production`** (ou `staging`) — `NODE_ENV` nem consegue expressar `staging`.
2. **Remova as variáveis removidas** do `.env` de cada ambiente. O gate real de mensagens proativas é `FEATURE_PROACTIVE_MESSAGES`.
3. **Substitua qualquer `__SET_ME__` remanescente.**

**Rollback de emergência, env-only e sem redeploy:** `MAIA_CONFIG_STRICT_BOOT=false` volta ao loader anterior (schema Zod + regras de boot legadas, com as mensagens históricas preservadas) e desliga a validação de contrato inteira. O boot degradado loga um aviso alto a cada start; é alavanca para destravar um ambiente, não estado estável. Os loaders programáticos (`loadMigrationConfig`, `loadAdminConfig`, `loadBackupConfig`) têm a equivalente `validate: false`. Procedimento em [`docs/runbooks/config-contract.md`](docs/runbooks/config-contract.md) §4.

Namespaces de terceiros (`CLAUDE_*`, `ANTHROPIC_*`, `POSTGRES_*`, `REDIS_*`, `SMTP_*`, `NEXTAUTH_*`, `OPENAI_*`) **nunca** são recusados como desconhecidos — são populados por ferramentas e plataformas de hosting. As variáveis que a Maia possui nesses namespaces estão no contrato pelo nome.

### Added — Contrato único de configuração ([#515](https://github.com/diogenesmendes01/Maia-v2/issues/515))

**Impacto para operadores.** A configuração da Maia passa a ter uma fonte única de verdade tipada e **sem efeitos colaterais no import**: `src/config/contract.ts`. `.env.example`, `docs/configuration.md`, o JSON Schema, o manifest de variáveis por serviço e as fixtures por profile são **gerados** — não edite `.env.example` à mão; rode `npm run config:generate`. O CI falha se os artefatos estiverem desatualizados.

- **Profiles explícitos**: `MAIA_ENV=development|staging|production` decide quais regras são obrigatórias. `NODE_ENV` segue controlando apenas as otimizações da plataforma Node (e nem consegue expressar `staging`); a contradição entre os dois é erro. Em staging/produção `MAIA_ENV` é **obrigatória**.
- **Novos comandos**: `npm run config:generate`, `npm run config:check -- --profile production --env-file .env [--json] [--allow-placeholders] [--allow-fixtures]`, `npm run config:check:drift`, `npm run config:init -- --profile production`. O `check` reporta **todos** os problemas numa execução, com variável + regra + remediação, e **nunca** o valor de um segredo.
- **`config:init` gera um ponto de partida operacional, não uma fixture**: todo valor que pertence ao operador vem como `__SET_ME__` e a validação estrita **falha de propósito** até ser preenchido. As fixtures em `src/config/generated/fixtures/` provam que o contrato é satisfazível e têm valores previsíveis que não autenticam em nada — usá-las como `.env` é recusado fora de development (regra `secret/synthetic-fixture`); só o opt-in `--allow-fixtures` as aceita.
- **Configuração mínima por serviço**: `runtime`, `admin-ui`, `migrator`, `backup` e `maintenance` recebem apenas o subconjunto declarado. O migrator não recebe chave de LLM, sessão do WhatsApp nem credencial de S3.
- **Variáveis removidas viram erro explícito**: `FEATURE_MULTI_CHANNEL` (#411), `FEATURE_COGNITIVE_GRAPH` (#412), `FEATURE_CONTEXT_PACKET_V1(_KILL_SWITCH)` (#406) e `APROVAR_MENSAGENS_PROATIVAS` (sem consumidor) têm *tombstone*. Configurá-las é erro em staging/produção e aviso em development — nunca mais um no-op silencioso. **Ação necessária:** remova-as do `.env` dos ambientes reais.
- **Variáveis Maia desconhecidas** (prefixos `MAIA_`, `FEATURE_`, `BACKUP_`, `OUTBOX_`, …) são erro em staging/produção e aviso em development. Namespaces de plataforma (`POSTGRES_`, `REDIS_`, `SMTP_`, `NEXTAUTH_`, `OPENAI_`) ficam de fora da rejeição por injeção legítima de hosting.
- **Dependências condicionais são executáveis** (`requiredWhen`): o contrato declara a condição como dado (`equals`/`includes`/`truthy`/`present`/`anyOf`/`allOf`) e o validador a **executa** (regra `contract/required-when`); a frase da documentação é derivada da condição, então as duas não podem divergir. Fecha três lacunas reais: `FEATURE_OUTBOUND_VOICE=true` sem `OPENAI_API_KEY`, `RUNTIME_TRACE_DEBUG_S3_BUCKET` sem `RUNTIME_TRACE_DEBUG_AES_KEY` e `ALLOW_DEV_AUTH=true` sem `ADMIN_UI_DEV_LOGIN_TOKEN`.
- **Novas regras cross-field** (validador, ainda não no boot): provider de embeddings × modelo × dimensões, bucket S3 × credenciais, canal de alerta × transporte, `MAIA_MULTI_LINE` × modo de roteamento, `strict` × keyring de staging, dev auth proibido fora de development, https obrigatório fora de development, `OIDC_TENANT_SLUGS` sem o literal `default`, ordenação de janelas (debounce, SLO da sonda, backoff do outbox) e recusa de placeholders em staging/produção.
- **Variáveis que já eram lidas direto de `process.env` agora estão documentadas** no contrato: `MAIA_REJECT_DEFAULT_LITERAL`, `PROCEDURE_TTL_DAYS`, `REAPER_BATCH_SIZE`, `REAPER_GLOBAL_BUDGET`, `CONTRADICTION_OVERLAY_TTL_HOURS`, além das variáveis do Admin UI (`ADMIN_UI_PORT`, `NEXTAUTH_*`, `AUTH_TRUST_HOST`, `NEXT_PUBLIC_API_URL`, `OIDC_*`, `ALLOW_DEV_AUTH`, `ADMIN_UI_DEV_LOGIN_TOKEN`, `FEATURE_ADMIN_UI_*`).

### Changed — Configuração

- `src/config/env.ts` virou um **loader fino**: schema, defaults e regras cross-field vêm do contrato. O comportamento de boot é **idêntico** ao anterior (as mensagens das regras de escopo `boot` foram preservadas literalmente) — as regras novas ficam no `maia config check` até o passo de rollout dedicado.
- `src/admin-ui/lib/env.ts` deixou de manter um **segundo schema Zod** e passou a derivar do contrato (`objectSchemaForService('admin-ui')`). Admin e runtime não podem mais divergir na interpretação da mesma variável.
- `assertSafeAuthDir`/`isReservedRootEntry` migraram para `src/setup/auth-dir-path.ts` (puro, sem import de `config`); `src/setup/auth-dir.ts` os re-exporta — nenhum import site mudou.
- **Node 22 documentado onde já estava pinado**: README e `AGENTS.md` diziam Node 20+ enquanto `.nvmrc`, `package.json` engines e as imagens Docker usam 22. Teste de paridade em `tests/unit/config/parity.spec.ts`.
- **Lint gate**: `no-restricted-properties` recusa novas leituras de `process.env` fora de uma allow-list explícita em `eslint.config.js` (orçamento de migração, não isenção permanente).

### Changed — LLM Gateway governado ([#508](https://github.com/diogenesmendes01/Maia-v2/issues/508))
- **Fronteira única para chamadas de modelo.** Novo módulo `src/lib/llm/` centraliza seleção de provider/modelo, deadline, cancelamento, retry, fallback, orçamento, custo, métricas e correlação de trace. `src/lib/claude.ts` vira facade fino: `callLLM()` delega ao gateway e aceita `workload`/`tier`.
- **Nenhum módulo importa SDK de provider.** Os 13 call sites que instanciavam `@anthropic-ai/sdk` direto (risk gate, role selector, step evaluator, capability proposer, calendar detector, os 7 detectores de drift e a visão) foram migrados; regra ESLint `no-restricted-imports` bloqueia novos bypasses fora de `src/lib/llm/providers/**`, e o grep gate de auditoria passou a cobrir `executeLLM` além de `callLLM`.
- **Visão pelo mesmo caminho.** `src/lib/vision.ts` usa blocos de imagem provider-neutrais; o adapter OpenRouter converte para `image_url`/data URI. Antes, visão só funcionava com Anthropic.
- **OpenRouter deixa de exigir `ANTHROPIC_API_KEY`.** As checagens de chave nos módulos de cognição passaram a consultar o provider ativo (`isLLMConfigured()`).
- **Uma leitura de settings por chamada, cacheada.** `getCurrentMainModel` + `getCurrentFastModel` (duas operações sequenciais por chamada, a cada iteração do ReAct) viraram uma leitura conjunta com cache por `tenant_id + agent_id`, TTL curto e TTL de falha menor.
- **Uma única camada de retry.** Os adapters passam `maxRetries: 0` ao SDK; erro é classificado por *kind* e só transitório retenta; `Retry-After` é respeitado; cancelamento nunca é retentado. O deadline total é absoluto e não reinicia a cada tentativa — `CLAUDE_TIMEOUT_MS` ganhou consumidor no hot path como teto **por tentativa**.
- **Fallback deixa de ser silencioso.** É controlado por política de workload (`src/lib/llm/workloads.ts`) e registrado com origem, destino e razão.

### Added — Governança de custo e propagação de configuração ([#508](https://github.com/diogenesmendes01/Maia-v2/issues/508))
- **Quota diária por tenant+agent** (`LLM_DAILY_BUDGET_USD`, default `0` = desligada): imposta antes de qualquer requisição ao provider, com erro não retentável.
- **Invalidação distribuída do cache de modelos** via Redis pub/sub (`maia:llm:settings:invalidate`): trocar o modelo no Admin passa a valer em todas as réplicas imediatamente, com o TTL curto como rede de segurança.
- **Métricas novas**: `maia_llm_requests_total`, `maia_llm_request_duration_ms`, `maia_llm_attempts_total`, `maia_llm_fallback_total`, `maia_llm_timeouts_total`, `maia_llm_cancelled_total`, `maia_llm_settings_cache_total`, `maia_llm_scope_missing_total`, `maia_llm_cost_ledger_failures_total`, `maia_llm_budget_*`. `maia_llm_calls_total{status}` passou a incrementar também em erro/timeout/rate limit/cancelamento, como o runbook já documentava.

### Fixed — LLM ([#508](https://github.com/diogenesmendes01/Maia-v2/issues/508))
- `src/runtime/decision/prod-env.ts`: o HaikuClientAdapter criava um `AbortController`, encadeava o sinal do caller nele e nunca o passava adiante — cancelar a classificação não cancelava a requisição HTTP.
- Falha ao persistir o ledger de custo deixou de ser engolida (`.catch(() => undefined)`) e passou a emitir counter alertável.
- A seleção de provider deixou de ser congelada no carregamento do módulo.
- **Quota de LLM deixou de ser check-then-act** (review da PR #531): virou reserva atômica por `tenant_id + agent_id` antes de qualquer requisição ao provider, liquidada com o custo real depois. Antes, N chamadas simultâneas liam o mesmo gasto acumulado e passavam todas — a quota falhava exatamente no retry storm.
- **Erro de provider não propaga mais o corpo da resposta.** Um `400` costuma ecoar o input (que é conversa de cliente); truncar em 200 caracteres preservava justamente o começo do eco. A mensagem passa a ser montada só com `kind`, `status` e `request_id`, e `cause` foi removido do erro para não vazar por serializador de log.
- **Chamada sem contexto de tenant no ALS é rejeitada** (`missing_tenant_context`) em vez de executada sem quota. Trabalho genuinamente global declara `runWithSystemContext()`.
- **Deadline absoluto passou a ser derivado** de `LLM_TURN_DEADLINE_MS` quando o caller não declara um: a mecânica existia mas o campo era opcional e ninguém o passava, então na prática o gateway rodava sem teto agregado.
- **`response_invalid` deixou de ser letra morta**: um 200 sem conteúdo utilizável (ex.: `choices: []`) era registrado como `status="ok"` com resposta vazia.
- **Escopo de tenant em todas as métricas tenant-aware** — antes só `maia_llm_requests_total` o carregava.
- **`workload` é obrigatório** e o escape hatch `legacy` foi removido, com gate de CI provando que todo call site declara política.
- **Allow-list de `process.env` encolhida** (#515): a migração dos call sites de LLM removeu as leituras diretas de `ANTHROPIC_API_KEY` em `src/cognition/{calendar-pattern-detector,capability-proposer}.ts`, `src/cognition/drift/**`, `src/cognition/role-selector/llm-suggester.ts` e `src/shared/risk/llm-gate.ts` — as cinco entradas saíram do orçamento de migração em `eslint.config.js` e do espelho em `tests/unit/config/no-direct-env-reads.spec.ts`. A chave passa a entrar pelo `config` tipado num único ponto (`src/lib/llm/providers/**`).

### Fixed — Dependências e supply chain

- **`sharp` deixou de ser implícito, e os binários Linux-musl entraram no lockfile.** `sharp` chegava só como `peerDependency` não-opcional do Baileys (`@whiskeysockets/baileys` declara `"sharp": "*"`); o npm resolvia o pacote JS mas **não** as `optionalDependencies` `@img/sharp-*` dele — o `package-lock.json` da raiz tinha uma única entrada `@img/*` (`@img/colour`) e **nenhum** binário nativo. Como a imagem de produção é Alpine e usa `npm ci`, qualquer caminho de imagem quebrava lá; e quebrava em SILÊNCIO, porque o Baileys carrega a biblioteca com `import('sharp').catch(() => {})` (`lib/Utils/messages-media.js:19`) — sem binário, o thumbnail simplesmente não é gerado. Agora `sharp@^0.35.3` é dependência direta da raiz e o lockfile carrega as 28 entradas `@img/*`, incluindo `@img/sharp-linuxmusl-{x64,arm64}` e os `@img/sharp-libvips-linuxmusl-*` correspondentes. Sonda de runtime: `npm run sharp:smoke` (`scripts/sharp-smoke.ts`) — ela carrega o binário nativo esperado, não só `import('sharp')`, porque o sharp cai em `@img/sharp-wasm32` quando o binário falta e um `import` sozinho fica verde com produção rodando em WASM. Guard de regressão sem Docker: `tests/unit/sharp-lockfile-binaries.spec.ts`.
- **Dependabot passou a cobrir o `src/admin-ui`.** `.github/dependabot.yml` só declarava um bloco npm em `"/"`, e um bloco npm enxerga apenas o manifesto do próprio diretório — o admin-ui, que tem lockfile separado, nunca recebeu PR automática. É o mesmo ponto cego que deixou um `critical` do Next passar no `npm audit` ([#521](https://github.com/diogenesmendes01/Maia-v2/issues/521)) e que o ledger de exceções ([#526](https://github.com/diogenesmendes01/Maia-v2/issues/526)) tornou visível: com o ledger, o próximo advisory do admin-ui **reprova o CI**; sem Dependabot, esse CI reprovado ficaria esperando correção manual. O bloco novo espelha cadência, limite de PRs abertas e agrupamentos do bloco da raiz, com guard anti-drift em `tests/unit/dependabot-admin-ui.spec.ts`.

### Added — Plataforma de funcionários digitais (rodada 2026-06-10)
- **Fase 1 do blueprint** ([#467](https://github.com/diogenesmendes01/Maia-v2/pull/467)): diff de perfil antes de aprovar (#461), aba Atividade (#462), página `/audit` (#463), checklist de ativação (#465), console responsivo (#466), arquétipos no wizard e **rollback real** de `agent_operational_profile_versions` (#468).
- **Playground sandbox** ([#473](https://github.com/diogenesmendes01/Maia-v2/pull/473), #464): aba "Testar" — chat com o perfil ativo ou uma versão proposta, sem outbox/memória/aprendizado; migração 087; Postgres-as-queue + worker `playground_turn_drain`.
- **Packs de arquétipo** ([#474](https://github.com/diogenesmendes01/Maia-v2/pull/474), #470): função escolhida no wizard vira grant de packs (vendedor→`domain.sales` etc.) sobre `BASE_AGENT_PACKS`; `agents.getCapabilities` + card "Capacidades da função".
- **Work loop v1** ([#475](https://github.com/diogenesmendes01/Maia-v2/pull/475), #469): `agent_objectives`/`objective_tasks` (migração 088), registry de kinds, workers perceive/execute, fila de exceções com resolução auditada, aba "Objetivos".
- **Pedidos de ferramenta** ([#476](https://github.com/diogenesmendes01/Maia-v2/pull/476), #471 v1): lacunas `tipo='tool'` viram backlog com geração de issue pré-preenchida.
- **MCP externo v1** ([#480](https://github.com/diogenesmendes01/Maia-v2/pull/480), #478): servers MCP first-party (ERP) com governança completa — migração 089, cliente SDK, bridge no dispatcher, worker `mcp_sync`, tela `/setup/mcp`, flag `FEATURE_MCP_TOOLS` (default OFF).

### Fixed
- **Roteamento de canal para JID `@lid`**: eventos do WhatsApp que chegam como `XXX@lid` sem `senderPn`/`participantPn` deixavam de resolver e eram descartados como `channel_resolution_failed` (risco de perda de mensagem conforme o WhatsApp migra o endereçamento para LID). Agora `resolveScopeForJid` aceita um resolvedor LID→telefone injetado (a *signal LID mapping store* do Baileys, via `socket.signalRepository.lidMapping.getPNForLID`, com *feature-detection*) como terceiro fallback; o telefone recuperado também passa a alimentar a identidade (`tel`) em `handleIncoming`, mantendo roteamento e identidade consistentes. Quando nada resolve, o drop continua *fail-closed* mas é auditado como a ação dedicada `channel_resolution_skipped_lid_unmapped` (separando ruído de sync do WhatsApp de falhas reais de posse cross-tenant). Ver `src/gateway/jid-tenant-resolver.ts` e `src/gateway/baileys.ts`.

### Docs
- Specs versionadas: visão "funcionários digitais", playground, work loop e MCP (`docs/superpowers/specs/2026-06-10-*`); novo doc de módulo `objectives.md`.
- `docs/architecture/modules/gateway.md`: lista `jid-tenant-resolver.ts` e documenta a ordem de recuperação de `@lid`.

### Changed — Admin UI
- **Redesign visual completo da console** ([#460](https://github.com/diogenesmendes01/Maia-v2/pull/460)): camada visual reconstruída do zero sobre design system próprio (`src/admin-ui/components/ui/`) com navegação agent-first em pt-BR (sidebar + badge de aprovações pendentes). Nova experiência de agentes: hub `/agents` em cards, wizard de criação em 4 passos (`/agents/new`) e detalhe por agente com edição de perfil pré-preenchida e aprovação de versões (`/agents/[agentId]`); `/setup/agents` virou redirect. Tela de versões passou a expor o fluxo de rollback (auditado; `NOT_IMPLEMENTED` sinalizado na UI). Routers tRPC preservados como camada de dados.

### Added — Admin UI
- **`agents.getProfileVersions`** ([#460](https://github.com/diogenesmendes01/Maia-v2/pull/460)): procedure read-only que expõe a versão ativa + propostas do perfil operacional (com `profile_body`) para pré-preencher o editor de perfil.

## [3.1.0] - 2026-05-20 — "Hot-path wiring + governance functional"

This release closes the build-then-wire gap from v3.0.0: components that
were implemented in isolation now actually execute in production.

### Added — wiring
- **Context Packet (P8a) — wired to hot path** ([#151](https://github.com/diogenesmendes01/Maia-v2/pull/151)): `agent/core.ts` now builds and renders via `buildContextPacket` when `FEATURE_CONTEXT_PACKET_V1=true`, falling back to legacy on error.
- **Decision Engine (P9b) — wired to hot path** ([#152](https://github.com/diogenesmendes01/Maia-v2/pull/152)): `runDecisionEngineIfEnabled` invoked before every LLM call. Honors all 5 `decision_class` values + applies `tool_reductions`. `engine_error` is **fail-closed by default** (`FEATURE_DECISION_ENGINE_ERROR_FALLBACK=legacy` reverts to pre-P9b behavior).
- **Risk Scoring (P9c) — both callsites wired** ([#153](https://github.com/diogenesmendes01/Maia-v2/pull/153)): `RiskScorerStubImpl` and KSM stub replaced with real `TurnRiskScorer` + `KnowledgeRiskScorer` wrappers (no-downgrade invariant + gate fallback escalation active).

### Added — DecisionEngine real adapters (Camada 2/3)
- **Real deps inside `getDecisionEngine()`** ([#154](https://github.com/diogenesmendes01/Maia-v2/pull/154)): `PolicyDescriptorResolver`, `PolicyRulesRepo`, `PolicyDSLEvaluator`, `SkillsRepo` no longer stubbed.
- **`LockdownReader` real** ([#155](https://github.com/diogenesmendes01/Maia-v2/pull/155)): dual-layer enforcement — channel via `BaseContextPacket.channel.is_locked_down` + entity/permissao via `entity_states.flags['lockdown_snapshot']` + `permissoes.status='suspensa'`.
- **`procedure_domain` real** ([#156](https://github.com/diogenesmendes01/Maia-v2/pull/156)): migration `060_p3a_procedure_definitions_domain.sql` adds `domain TEXT` column; adapter performs JOIN; `WorkflowSelector` no longer falls back to TTL heuristic.
- **`ChannelPoliciesReader` real** ([#157](https://github.com/diogenesmendes01/Maia-v2/pull/157)): drizzle query on `channel_policies` with mandatory `tenant_id` predicate (cross-tenant isolation preserved).
- **`RiskScorerProdAdapter` (engine-internal)** ([#158](https://github.com/diogenesmendes01/Maia-v2/pull/158)): bridges DE's `{intent, base}` interface to P9c's `TurnRiskSignals` + maps 4-level `ScoredRisk` to 3-level `RiskLevel` (CRITICAL caps to HIGH + `requires_human_review=true`).
- **`active_sensitive_memory_count` field** ([#159](https://github.com/diogenesmendes01/Maia-v2/pull/159)): added to `BaseContextPacket`, populated by `buildBaseContextPacketFromTurn` (with agent-isolation preserved), consumed by `RiskScorerProdAdapter` for risk-floor calculation.

### Migrations
- `060_p3a_procedure_definitions_domain.sql` — `ALTER TABLE procedure_definitions ADD COLUMN domain TEXT` with CHECK allowlist (onboarding/support/transfer/cancel/unknown) + partial index.

### Production readiness
With this release, the following can be enabled together in production:
- `FEATURE_CONTEXT_PACKET_V1=true`
- `FEATURE_DECISION_ENGINE_V1=true` (default `FEATURE_DECISION_ENGINE_ERROR_FALLBACK=fail-closed`)
- `FEATURE_SOUL_LAYER_V1=true`
- `FEATURE_POLICY_RESOLVER_V1=true`
- `FEATURE_SKILL_REGISTRY_V1=true`
- `FEATURE_KNOWLEDGE_STATE_MACHINE_V1=true`
- `FEATURE_CALENDAR_V2=true`
- `FEATURE_RUNTIME_TRACE_V1=true` (requires `RUNTIME_TRACE_HMAC_MASTER_SECRET` + `RUNTIME_TRACE_DEBUG_S3_BUCKET` + `RUNTIME_TRACE_DEBUG_AES_KEY`)

### Known limitations
- Admin UI auth (P8.5) still returns `providers=[]` in production until OIDC/SAML/magic-link is wired. Setting `FEATURE_ADMIN_UI_V1=true` does not enable production login.

## [3.0.0] - 2026-05-20 — "Maia v3 Runtime Architecture"

Full Runtime Architecture v3.1.1 cutover: Hot Path stages, Context Packet,
Decision Engine, Policy DSL Evaluator, Skill Abstraction, Knowledge State Machine,
Runtime Trace, Soul Layer, User Layer namespace, Identity Completion,
Admin UI v1, Calendar v2, and all P0–P11 foundation phases.

### Added

#### P0–P7 Foundation Phases
- **P0 Foundation** ([#75](https://github.com/diogenesmendes01/Maia-v2/pull/75)) — multi-tenant isolation + cognitive logging + agent runtime bootstrap
- **P1 Reflection pipeline** ([#81](https://github.com/diogenesmendes01/Maia-v2/pull/81)) — trigger → candidate → classificador → typed destination (fact/rule/procedure/gap/tool_request/discard)
- **P2 Memory + Self-model** ([#82](https://github.com/diogenesmendes01/Maia-v2/pull/82)) — 5-layer scoped memory + 3-layer self-model (domain/skill/gap) with deterministic confidence formula
- **P3a Procedure Definitions** ([#83](https://github.com/diogenesmendes01/Maia-v2/pull/83)) — declarative procedure objects + Modo ENSINO
- **P3b Procedure Runtime** ([#84](https://github.com/diogenesmendes01/Maia-v2/pull/84)) — stateful execution engine with TTL + step audit
- **P3c Procedure Governance** ([#85](https://github.com/diogenesmendes01/Maia-v2/pull/85)) — matview + reaper + step evaluator + CHECK constraints
- **P4 Operational Identity** ([#86](https://github.com/diogenesmendes01/Maia-v2/pull/86)) — 4-layer identity model (core/operational/episodic/backlog) + drift detector (7 types × 4 severities)
- **P5 Dialogical Capability Acquisition** ([#87](https://github.com/diogenesmendes01/Maia-v2/pull/87)) — Maia proposes, owner decides; 4 deterministic escalation levels (silent/dashboard/mentionable/proposed)
- **P6 Channel/Role/Policy separation** ([#88](https://github.com/diogenesmendes01/Maia-v2/pull/88)) — LLM suggests (`suggested_by`), Policy decides (`decided_by`); anti-oscillation lock + `affects_user` announcement
- **P7 Cognitive Graph orchestration** ([#90](https://github.com/diogenesmendes01/Maia-v2/pull/90)) — declarative module descriptors (runWhen/timeout/fallback/model/version) + sync/async/conditional + per-node audit + p95 budget

#### P8 Hot Path Stages
- **P8a Context Packet** ([#96](https://github.com/diogenesmendes01/Maia-v2/pull/96)) — `BaseContextPacket` → `ExecutionContextPacket` + 7 slice builders + Redis cache with TTL + invalidation bus
- **P8b Soul Layer** ([#95](https://github.com/diogenesmendes01/Maia-v2/pull/95)) — persistent behavioral biases with scope enforcement + feature-flag gating + replay-safe materialization (modulates, never blocks)
- **P8c User Layer namespace** ([#94](https://github.com/diogenesmendes01/Maia-v2/pull/94)) — fail-closed tenant boundary + agent-isolated resolvers (memory/facts/rules/hints) + JSONB `lifecycle_transitions` contract
- **P8d Identity Completion** ([#100](https://github.com/diogenesmendes01/Maia-v2/pull/100)) — operational profile v2 (4-layer) + `papel_drift` detector with feature-flag gating + `seedNewActive` atomic transition + audit precedence
- **P8e PolicyDescriptorResolver** ([#93](https://github.com/diogenesmendes01/Maia-v2/pull/93)) — single shared component for policy resolution with structured cache keys + ordered candidate fallback + fail-closed behaviour
- **P8.5 Admin UI v1** ([#101](https://github.com/diogenesmendes01/Maia-v2/pull/101)) — Next.js 14 + tRPC v11 + NextAuth v5 governance console: `/inbox` (proposals), `/drift`, `/traces`, `/versions` screens wired; `/dashboard`, `/identities`, `/capabilities`, `/procedures`, `/knowledge` routes not yet wired + approval matrix + dual founder lockdown

#### P9 Decision & Policy Layer
- **P9a Skill Abstraction** ([#99](https://github.com/diogenesmendes01/Maia-v2/pull/99)) — declarative skill artifacts + `SkillRunner` with 4 execution modes (sync/async/streaming/batch) + tenant-admin guard
- **P9b Decision Engine** ([#103](https://github.com/diogenesmendes01/Maia-v2/pull/103)) — 3 PEPs (Early/Mid/Late) + `DecisionPacket` + per-step deadline enforcement + `AbortController` integration
- **P9c Risk Scoring** ([#97](https://github.com/diogenesmendes01/Maia-v2/pull/97)) — `TurnRiskScorer` + `KnowledgeRiskScorer` with no-downgrade invariant + fail-closed LLM gate
- **P9d Policy DSL Evaluator** ([#98](https://github.com/diogenesmendes01/Maia-v2/pull/98)) — pure, total, ReDoS-safe DSL with bounded literals + order-invariant error detection + runtime fan-out caps

#### P10 Knowledge & Traceability
- **P10a Knowledge State Machine** ([#104](https://github.com/diogenesmendes01/Maia-v2/pull/104)) — 9-state lifecycle + DB-trigger transition enforcement + visibility filters + auto-promoter + `propose_*` tools
- **P10b Runtime Trace** ([#102](https://github.com/diogenesmendes01/Maia-v2/pull/102)) — sync envelope + async body with HMAC versioned keyring + redaction allowlists + matview + S3 idempotency

#### Calendar & Scheduling
- **Calendar v2** ([#105](https://github.com/diogenesmendes01/Maia-v2/pull/105)) — Brazilian holidays + business-day calendar + RRULE extension + cognitive pipeline integration
- **Scheduling v2 (Spec 18)** ([#72](https://github.com/diogenesmendes01/Maia-v2/pull/72)) — series → occurrences → tasks → outbox architecture; 7 production requirements (transactional outbox, 10k backlog drain, month-end policies, missed-run policies, cancel-race safety, multi-pending disambiguation, per-occurrence audit trail); constitutional rules C-006/C-007/C-008; 47 unit specs

#### Test Infrastructure
- `tests/fixtures/factsRepo.ts` shared mock factory ([#116](https://github.com/diogenesmendes01/Maia-v2/pull/116)) — resolves ~64 stale mock specs
- `tests/fixtures/agentProfile.ts` 4-layer profile builder ([#117](https://github.com/diogenesmendes01/Maia-v2/pull/117)) — resolves ~16 schema-mismatch specs
- `tests/fixtures/driftCandidate.ts` typed drift fixture ([#125](https://github.com/diogenesmendes01/Maia-v2/pull/125))
- `docker-compose.yml` + fail-fast integration test setup ([#123](https://github.com/diogenesmendes01/Maia-v2/pull/123))
- `tests/db/repositories-barrel.spec.ts` regression guard ([#127](https://github.com/diogenesmendes01/Maia-v2/pull/127))
- Inline snapshot for `ProposalStatus` enum (7 values) ([#114](https://github.com/diogenesmendes01/Maia-v2/pull/114))

### Changed
- **vitest 2.1.9 → 4.1.6** ([#120](https://github.com/diogenesmendes01/Maia-v2/pull/120)) — constructor mock arrow→function migration, `vi.mock()` hoisting via `vi.hoisted()`; 15 spec files migrated
- **@anthropic-ai/sdk 0.30.1 → 0.97.1** ([#122](https://github.com/diogenesmendes01/Maia-v2/pull/122)) — bump applied; `TextBlock.citations` required-field adjustment across 7 drift detectors ([#126](https://github.com/diogenesmendes01/Maia-v2/pull/126))
- **@fastify/cookie 10.0.1 → 11.0.2** ([#121](https://github.com/diogenesmendes01/Maia-v2/pull/121))
- **next-auth 5.0.0-beta.25 → 5.0.0-beta.31** ([#124](https://github.com/diogenesmendes01/Maia-v2/pull/124)) — v5 stable not yet shipped upstream
- **node-cron v3 → v4** ([#78](https://github.com/diogenesmendes01/Maia-v2/pull/78)) — API migration applied in P8–P10 batch

### Fixed
- `transitionProcedureStatus` CHECK constraint: accepts `auto_abandoned` + `human_confirmation` event types ([#92](https://github.com/diogenesmendes01/Maia-v2/pull/92))
- LLM anchor on fresh state + persisted tool results ([#74](https://github.com/diogenesmendes01/Maia-v2/pull/74))
- 4-layer AgentProfile schema mismatch in ~16 specs ([#117](https://github.com/diogenesmendes01/Maia-v2/pull/117))
- Stale `factsRepo` mocks in ~64 specs ([#116](https://github.com/diogenesmendes01/Maia-v2/pull/116))
- `TextBlock.citations` typecheck after Anthropic SDK 0.97 bump ([#126](https://github.com/diogenesmendes01/Maia-v2/pull/126))
- `ProposalStatus` enum assertion brittleness ([#114](https://github.com/diogenesmendes01/Maia-v2/pull/114))
- 8 of 11 failing specs on main post-P8–P11 integration ([#128](https://github.com/diogenesmendes01/Maia-v2/pull/128))
- WhatsApp privacy IDs (`@lid`): `pessoasRepo.findByPhone` failure + phantom send to invalid JID ([#71](https://github.com/diogenesmendes01/Maia-v2/pull/71))

### Security
- Tenant boundary fails closed when ALS context is missing (P8c, [#94](https://github.com/diogenesmendes01/Maia-v2/pull/94) round-2)
- HMAC versioned keyring for Runtime Trace (P10b, [#102](https://github.com/diogenesmendes01/Maia-v2/pull/102) round-2)
- Capability proposals cannot self-declare low risk (P8.5, [#101](https://github.com/diogenesmendes01/Maia-v2/pull/101) round-2)
- Strict redaction with schema-driven nested allowlists for decision blobs (P10b, [#102](https://github.com/diogenesmendes01/Maia-v2/pull/102) round-2)
- `Secure` flag added to `maia_session` cookie in production ([#58](https://github.com/diogenesmendes01/Maia-v2/pull/58))
- Stored XSS escaped in `pessoa.nome` in title/h1 ([#57](https://github.com/diogenesmendes01/Maia-v2/pull/57))

### Infrastructure
- Tech-debt issues opened and resolved: #109 drift-detector casts (resolved [#125](https://github.com/diogenesmendes01/Maia-v2/pull/125)), #110 next-auth stable (resolved [#124](https://github.com/diogenesmendes01/Maia-v2/pull/124)), #112 docker-compose (resolved [#123](https://github.com/diogenesmendes01/Maia-v2/pull/123)), #113 capabilityProposalsRepo barrel (resolved [#127](https://github.com/diogenesmendes01/Maia-v2/pull/127))
- S3/B2/R2 backup upload + cloud rotation after nightly `pg_dump` ([#65](https://github.com/diogenesmendes01/Maia-v2/pull/65))
- Per-pessoa LLM cost breakdown + per-OpenRouter-model USD pricing ([#63](https://github.com/diogenesmendes01/Maia-v2/pull/63), [#62](https://github.com/diogenesmendes01/Maia-v2/pull/62))
- `maia_db_connected` Prometheus gauge ([#61](https://github.com/diogenesmendes01/Maia-v2/pull/61))
- TS path aliases via `tsc-alias` (Coolify deploy fix) ([#67](https://github.com/diogenesmendes01/Maia-v2/pull/67))
- ESLint `no-floating-promises` (warn) on `src/` ([#64](https://github.com/diogenesmendes01/Maia-v2/pull/64))

### Known issues (open at release)
- **Production bugs tracked for follow-up**: #135 `transitionProcedureStatus` event recording, #136 contradiction TTL, #137 events-block cardinality, #138 pdfmake import
- **Runbook gaps**: #129 P8c, #130 P8.5, #131 P9b, #132 P9c
- **Admin UI**: 3 specs (`proposals-router`, `tenant-resolver`, `versions-router`) fail because `@trpc/server` is not yet installed at the repo root. Fix tracked in #139 (PR #146). **The `v3.0.0` git tag must NOT be cut until PR #146 merges.**
- **next-auth**: still on beta.31 — waiting for v5 stable upstream (#110)

### Notes
- `package.json` bumped to `3.0.0` in this PR to align with the CHANGELOG entry.
- The `v3.0.0` git tag should be cut after both this PR and PR #146 (`@trpc/server` hoist) are merged to `main`.

---

### Scheduling v2 (Spec 18) — detailed notes

#### Added
- **Spec 18 v2.3 — addresses 1 follow-up BLOCKER** raised in PR #72
  review 3:
  - **B1/r3 — `claimInProgressForAdvance()` restricted to
    `recurring_outreach`**: the SQL claim now `JOIN`s on `series` and
    filters `tipo = 'recurring_outreach'`, so `one_shot_reminder`
    occurrences whose outbox row is still pending (rate-limited,
    Baileys disconnected, retry pending) are never picked up by the
    engine's in-progress pass. Previously they could be falsely
    finalized as `completed/fired` while the underlying WhatsApp
    message had never been sent. Completion for `one_shot_reminder`
    now flows exclusively through `outbox-drain`: `markSent` →
    `task.completed` → `occurrence.completed(fired)`, or `markDead`
    → `task.failed` → `occurrence.failed(reason=outbox_dead)`.

    Defence-in-depth: `advanceInProgressOccurrence` now `releaseClaim`s
    when the series tipo is not `recurring_outreach` (instead of marking
    the occurrence `completed`). Even if a future change widens the
    claim filter or a race exposes the wrong tipo, the engine never
    audits a phantom success.
- **Spec 18 v2.2 — addresses 4 follow-up BLOCKERs** raised in PR #72 review 2:
  - **B1/r2 — `payment_due` never audits confirmed on dispatch failure**:
    `resolvePaymentOccurrence` now inspects the `dispatchTool` return
    value. When the dispatcher returns `{ error: ... }` (forbidden /
    requires_dual_approval / invalid_args / etc.) OR throws, the
    occurrence is parked as `failed`, the task is marked `failed`
    with the dispatch error, the operator is alerted via the outbox,
    and the next cycle is NOT scheduled. `payment_due_confirmed`
    only audits on a real success.
  - **B2/r2 — outreach timeout anchor**: `occurrencesRepo.setStatus`
    now sets `started_at` on transitions to `awaiting_third_party`
    and `awaiting_owner` (not just `in_progress`). The
    `listAwaitingTimedOut` query relies on `started_at IS NOT NULL`
    and previously never matched any outreach occurrence.
  - **B3/r2 — forward task gated on `outbox_sent` confirmation**:
    `advanceInProgressOccurrence` enqueues the forward outbox row
    and leaves the task `in_progress`. The outbox-drain marks the
    task `completed` ONLY after a successful send. The occurrence
    finalizes (and the next cycle schedules) on the next engine tick
    that sees `forward.status='completed'`. Dead outbox rows for
    forward / fire_reminder tasks now mark the occurrence `failed`
    instead of leaving a phantom success.
  - **B4/r2 — outbox-drain loops within one cron firing**: the
    worker calls `runOutboxDrain` up to `OUTBOX_DRAIN_LOOP_PASSES`
    times (default 55), sleeping `OUTBOX_DRAIN_LOOP_SLEEP_MS` ms
    (default 1000) between passes when the rate gate denied any
    send. Honours the per-second cadence with a per-minute cron.
    Without this loop, a 10k backlog drained at ~1 msg/minute
    (rate gate denied 49 of 50 attempts per tick).
- **Spec 18 v2.1 — addresses 10 review BLOCKERs** raised on PR #72:
  - **B1 — payment_due never silently dispatches**: pending-resolver
    detects `acao_proposta.scheduling_kind === 'payment_due'` and
    routes to `resolvePaymentOccurrence`. `register_transaction`
    fires ONLY in the `sim` branch — `nao` skips and `adiar`
    postpones. Previously, the generic dispatcher would have
    executed the transaction for any chosen option.
  - **B2 — lease reclaim re-enters the pending queue**: both
    `runSchedulingTick` and `runOutboxDrain` reclaim expired leases
    by resetting rows to `pending` (clearing `claimed_by` /
    `claimed_at`). The subsequent `claimDue` in the same tick picks
    them up naturally. Previously, reclaimed rows stayed `claimed`
    indefinitely.
  - **B3 — recurring_outreach completes the cycle**: engine claims
    `in_progress` occurrences in a dedicated pass to run the
    `forward` step, scans `awaiting_third_party` for
    `wait_response_hours` timeouts and escalates, and inserts the
    next cycle via `insertNextOccurrenceIfActive`. The previous
    cycle could stall after the response was captured.
  - **B4 — engine advances are transactional**: new
    `advanceWithTx(fn)` wraps `tasks.setStatus` +
    `occurrences.setStatus` + `outbox.enqueue` inside one DB
    transaction. Either all three commit or none. Previously the
    three writes were separate calls; a crash between them left
    half-states.
  - **B5 / B6 — feature flag gates the tools**: `schedule_reminder`,
    `cancel_reminder`, `start_recurring_outreach`,
    `start_recurring_payment` only register in the LLM tool
    registry when `FEATURE_SCHEDULING_V2=true`. Prevents the LLM
    from creating series that no worker would execute.
  - **B7 — workers match the spec**: added
    `series_next_scheduler` cron (`*/10 * * * *`) that backfills
    missing next-cycle occurrences for active series whose chain
    broke (crash between complete + reschedule). Spec updated to
    document the in-tick lease reaper.
  - **B8 — exclusive_per_destinatario enforced**: when a series
    has the flag set and the engine claims an outreach occurrence,
    it checks for sibling occurrences already
    `in_progress`/`awaiting_third_party` with the same destinatario
    and defers (releases the claim with a 10-min backoff) if so.
  - **B9 — inbound hook wired**: `agent/core.ts` calls
    `captureInboundForOutreach` on every text inbound when
    scheduling is enabled. Third-party replies now actually advance
    their occurrence.
  - **B10 — integration tests for the 7 critérios**: seven specs
    under `tests/integration/scheduling/` exercise crash recovery,
    backlog drain under backpressure, month-end policy outcomes,
    missed-run policy decisions, cancel-race, multi-pending
    disambiguation, and per-occurrence audit reconstruction.
- **Spec 18 v2 — Scheduling: series → occurrences → tasks → outbox**
  (`docs/specs/18-scheduling-and-recurring-workflows.md`). Operational
  engineering spec for proactive scheduling. Supersedes the v1
  discovery draft. Satisfies seven production requirements:
  1. Outbox never loses a message — transactional outbox table.
  2. 10k-deep backlog drains under per-second + per-hour + per-
     recipient backpressure (`OUTBOX_MAX_*` env).
  3. Monthly series on day 31 follows a documented
     `month_end_policy` (`skip_invalid_month` | `last_day_of_month`
     | `nearest_previous` | `nearest_next`).
  4. Multi-day downtime follows a documented `missed_run_policy`
     (`fire_all` | `fire_latest_only` | `skip_all` |
     `escalate_to_owner`).
  5. Cancelling a series prevents new occurrences even with a
     concurrent engine tick — version-gated INSERT + atomic
     status+occurrence transaction.
  6. Multiple open outreaches with the same destinatario never
     capture each other's response — correlation tokens
     (`_ref: A4F2_`) + disambiguation prompt to the owner.
  7. Every occurrence has an auditable trail from scheduling to
     final outcome in **one SQL query** — `audit_log.occurrence_id`
     populated on every state transition.
- **Migration `007_scheduling.sql`**: four new tables
  (`series`, `occurrences`, `tasks`, `outbox_messages`) +
  `audit_log.occurrence_id`. All indexes for hot paths.
- **`src/scheduling/`** module: `rrule.ts` (RFC 5545 subset +
  month-end policies), `repos.ts` (transactional repos with
  `FOR UPDATE SKIP LOCKED` and optimistic locking),
  `backpressure.ts` (Redis token-bucket per-second/per-hour +
  per-recipient pacing, fail-CLOSED on Redis outage),
  `correlation.ts` (4-hex tokens for outreach disambiguation),
  `policies.ts` (missed-run decision table),
  `disambiguation.ts` (multi-pending owner prompt),
  `engine.ts` (claim + advance per-tipo, never sends directly),
  `outbox-drain.ts` (lease-based claim, polynomial backoff, DLQ).
- **New tools**:
  - `schedule_reminder` (rewritten) — creates a `one_shot_reminder`
    series + initial occurrence + reminder task atomically.
  - `cancel_reminder` (rewritten) — invokes
    `seriesRepo.cancelAtomic` so cancellation pre-empts in-flight
    engine ticks.
  - `start_recurring_outreach` (new) — `recurring_outreach` series
    with C-007 dual-approval gate at creation.
  - `start_recurring_payment` (new) — `recurring_payment` series
    with C-006 hard-limit gate at creation.
- **New workers**: `scheduling_tick` (cron `* * * * *`) and
  `outbox_drain` (cron `* * * * *`). Both register only when
  `FEATURE_SCHEDULING_V2=true`.
- **Constitutional rules**: **C-006** (`start_recurring_payment`
  above `VALOR_LIMITE_DURO` rejected), **C-007**
  (`start_recurring_outreach` requires `dual_approval_granted`),
  **C-008** (defence-in-depth — occurrence rejected at claim if
  `contexto_snapshot.valor` exceeds current `VALOR_LIMITE_DURO`).
- **Env vars**: `FEATURE_SCHEDULING_V2`, `OUTBOX_MAX_PER_SECOND`
  (default 1), `OUTBOX_MAX_PER_HOUR` (default 600),
  `OUTBOX_WORKER_CONCURRENCY` (default 4),
  `OUTBOX_LEASE_TTL_SECONDS` (default 300),
  `OCCURRENCE_LEASE_TTL_SECONDS` (default 300).
- **23 new audit actions** covering series, occurrence, outbox,
  outreach, payment_due lifecycles.
- **47 new unit specs** across 8 files, one per requirement
  (rrule, policies, correlation, backpressure, disambiguation,
  cancel-race, outbox-drain, engine).

## [0.1.0] - 2026-04-27

### Added
- Estrutura inicial do projeto (Node 20 + TypeScript)
- Documentação de arquitetura completa (`docs/arquitetura.md`)
- Schema do banco com 16 tabelas (PostgreSQL 16 + pgvector)
- System prompt da Maia v0 (`src/identity/maia-prompt.md`)
- Template de inventário para preencher (`docs/inventario.md`)
- Docker Compose com Postgres + pgvector + Redis
- Configuração TypeScript strict mode
- `.env.example` documentado
- Licença MIT
