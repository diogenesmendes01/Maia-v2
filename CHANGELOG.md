# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Unreleased]

### ⚠️ BREAKING (operacional) — schema incompatível agora MATA o processo, com exit code por invariante ([#516](https://github.com/diogenesmendes01/Maia-v2/issues/516))

> **O que muda no seu dia:** antes, um app que subisse contra um schema
> incompatível ficava **de pé** respondendo 503 no `/readyz`. Agora ele **não
> sobe** — encerra com exit code **90-97**, e sob um supervisor que reinicia
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
- **Exit codes distinguíveis** (`src/runtime/lifecycle/schema-boot-gate.ts`), porque `1` para tudo não diz nada a quem lê `docker inspect --format '{{.State.ExitCode}}'`: **90** dirty/`running` órfão · **91** checksum divergente · **92** checksum ausente (ledger v1 nunca backfillado) · **93** migration no banco que este build não empacota · **94** migration obrigatória ausente · **95** schema acima do máximo suportado · **96** `running` em voo · **97** veredito `unknown`. `1` continua sendo qualquer outra falha de boot. A faixa 90-97 não colide com os códigos do migrator (0/1/2), do Node (1-14), do shell (126-165) nem com 255.
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
