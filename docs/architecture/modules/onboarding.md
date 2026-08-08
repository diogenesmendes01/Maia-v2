# onboarding

**Path:** `src/onboarding/`

**Purpose** — Provisiona um `(tenant, agente)` completo por uma **saga durável, retomável e idempotente**, e expõe o **readiness canônico** — a única resposta autorizada à pergunta "este agente pode operar?". Issue #519.

Duas coisas moram aqui e é útil separá-las desde já:

| | O que é | Quem consome |
|---|---|---|
| **Readiness** (`readiness.ts`) | Função pura + loader. Diz se um par está pronto, com códigos estáveis e remediation. | `maia doctor` (#517), a ativação da saga, dashboard, go-live checklist, `npm run setup` |
| **Saga** (`wizard.ts` + `provisioning.ts`) | Máquina de estados persistida que CRIA o par e sua governança. | Console administrativo, CLI |

O readiness é útil sozinho — um agente provisionado à mão continua sendo avaliado pelo mesmo contrato. A saga depende do readiness; o contrário não.

## Por que não estendemos `npm run setup`

`scripts/setup.ts` semeia **dados de domínio dentro de um tenant que já existe** (`self_state`, dona, entidades, contas, permissões do home `primary` da #323). Ele nunca criou tenant, agente, papel, política ou canal, e seu estado vive num `readline` — some no primeiro crash.

Construímos **ao lado**, não por cima:

- substituir quebraria `npm run setup` para a instalação single-tenant existente, que ainda precisa daquele seed;
- estender acoplaria uma saga de governança a um TTY — "persistido e retomável" e "prompt interativo" são requisitos incompatíveis.

O que `scripts/setup.ts` ganhou foi **uma linha de verdade**: no fim ele imprime o readiness canônico de `primary/primary` em vez de declarar `done` sem prova (`scripts/setup.ts` → `reportPrimaryReadiness`).

## Key files

| File | Role |
|---|---|
| `src/onboarding/readiness.ts` | **A API pública para #517.** Tipos, avaliador PURO e `evaluateAgentReadiness` |
| `src/onboarding/readiness-facts.ts` | Loader dos fatos (o único I/O do readiness) |
| `src/onboarding/state-machine.ts` | Estados, passos e transições. Puro |
| `src/onboarding/wizard.ts` | Orquestrador: escopo → RBAC → payload → idempotência → commit → métricas/auditoria |
| `src/onboarding/provisioning.ts` | As escritas de cada passo, todas recebendo o `tx` do passo + os schemas Zod |
| `src/onboarding/idempotency.ts` | Hash da chave, hash canônico do payload, decisão replay/conflito |
| `src/onboarding/scope.ts` | Guard fail-closed dos literais reservados |
| `src/onboarding/sanitize.ts` | Denylist de chave para as três colunas `jsonb` |
| `src/onboarding/errors.ts` | Códigos de erro estáveis |
| `src/db/repositories/onboarding-repos.ts` | `commitStep` — a transação curta que dá atomicidade à saga |
| `migrations/109_onboarding_runs.sql` | `onboarding_runs`, `onboarding_events`, `onboarding_step_results` |
| `migrations/110_agents_status_provisioning.sql` | `agents.status` passa a admitir `provisioning` — com a auditoria dos consumidores no cabeçalho |
| `migrations/113_onboarding_idempotent_creation.sql` | ledger de criação na run, unicidade do escopo inicial sem agente, `outcome_kind` no ledger de passos e o ponto de retomada (`failed_step`/`resume_state`) |
| `tests/unit/onboarding/_migration-schema.ts` | Lê `CHECK`s e colunas `uuid` de `migrations/*.sql` para as suítes SEM banco |
| `tests/unit/onboarding/schema-constraint-compatibility.spec.ts` | Literais do código ⊆ `CHECK` real, sem banco |
| `tests/unit/onboarding/audit-fk-safety.spec.ts` | `tx` falso **com integridade referencial**: a auditoria nunca referencia tenant inexistente |
| `tests/unit/onboarding/metrics-taxonomy.spec.ts` | vocabulários fechados ≡ constantes do código; texto livre/PII nunca vira label |
| `tests/integration/onboarding-review-541.spec.ts` | as cinco correções da 1ª rodada de review do PR #541, contra Postgres real |
| `tests/integration/onboarding-review-541-round2.spec.ts` | as cinco correções da 2ª rodada (conjunção por canal, criação idempotente, resultados conclusivos, ponto de retomada, entradas tipadas) |

## O contrato de readiness (para #517)

```ts
import { evaluateAgentReadiness } from '@/onboarding/index.js';

const r = await evaluateAgentReadiness({ tenant_id, agent_id });
// r.ready: boolean — true ⟺ todo check `blocking` passou
// r.checks: { code, status: 'pass'|'fail', severity: 'blocking'|'advisory', message, remediation }[]
// r.channels: veredito POR CANAL — { channel_id, policy_governed, policy_role_active,
//                                    ownership_proven, online, activatable, failed_checks[] }
// r.activatable_channel_ids: os canais que a ativação vai ligar — e SÓ eles
// r.evaluated_at, r.configuration_fingerprint, r.schema_fingerprint
```

Escopo inválido (vazio, com whitespace, ou os literais `'default'`/`'system'`) **lança** `OnboardingError` — não devolve `ready:false`. Devolver um relatório para um escopo proibido convidaria a UI a renderizar "quase pronto" para um alvo que nunca pode existir.

**Não re-derive prontidão no CLI.** O requisito de #517 é explícito: o backend calcula, a partir do mesmo contrato que o runtime usa.

### Checks

| Código | Severidade | O que prova |
|---|---|---|
| `tenant_exists` / `tenant_enabled` | blocking | o tenant existe e está `active` |
| `agent_exists` / `agent_belongs_to_tenant` | blocking | há agente com esse id NESTE par. Os dois códigos sobrevivem (são contrato público) mas **não distinguem mais** "não existe" de "é de outro tenant" — ver [Escopo do agente](#escopo-do-agente-e-o-que-o-readiness-recusa-a-responder) |
| `profile_active` | blocking | há profile operacional `active` DO MESMO par |
| `capability_grant_present` | blocking | existe `agent_tool_grants` do par |
| `required_packs_granted` | blocking | `BASE_AGENT_PACKS` ⊆ `granted_packs` |
| `tool_permissions_coherent` | blocking | nenhuma tool concedida E negada |
| `default_role_resolved` | blocking | **exatamente um** papel `is_default` + `active` |
| `channel_declared` | blocking | ≥1 canal não-sintético do par |
| `channel_policy_resolved` | blocking | política DO MESMO par apontando para esse canal |
| `channel_policy_role_active` | blocking | **existe um canal** cuja política resolve para papel ativo do par |
| `channel_ownership_proven` | blocking | **existe um canal que satisfaz os TRÊS predicados de canal ao mesmo tempo** — política + papel ativo + posse (`connected`/`verified_offline`, #518). Ver [A conjunção é por canal](#a-conjunção-é-por-canal) |
| `channel_online` | advisory | algum canal ativável está `connected` agora — socket caído se recupera sozinho |
| `schema_ready` | blocking | o **veredito canônico** de `src/migrations/` (`getSchemaReadiness`) — ver [Schema](#schema_ready-consome-o-veredito-canônico-nunca-schema_migrations) |
| `governance_no_blocking_pending` | blocking | nenhum alerta de drift `critical` sem `resolved_at` |
| `agent_activated` | advisory | `agents.status='active'` — advisório porque readiness é a PRECONDIÇÃO da ativação. O agente criado pela saga nasce em `agents.status='provisioning'` (`migrations/110_agents_status_provisioning.sql`), um estado distinto de `paused` (= esteve ativo e foi parado) |

### A conjunção é por canal

Os predicados de canal (`channel_policy_resolved`, `channel_policy_role_active`,
`channel_ownership_proven`) precisam valer **para o MESMO canal**. Enquanto eles
eram três `.some()` independentes sobre o conjunto de canais governados, dois
canais do mesmo agente podiam **dividir entre si** o papel válido e a posse
provada — canal A com política → papel ativo mas sem posse, canal B com posse
mas com política → papel inativo — e o agregado ficava verde sem que **nenhum**
dos dois fosse operável. Pior: a ativação selecionava os canais só pela
existência de política e ligava os dois.

O contrato, agora:

1. cada canal recebe um **veredito próprio** (`AgentReadiness.channels`);
2. `ready` exige **pelo menos um** canal com a conjunção inteira satisfeita;
3. a ativação liga **exatamente** `activatable_channel_ids` — e `applyActivate`
   re-deriva o mesmo conjunto contra o banco, sob os locks, recusando (`deny`)
   se os dois divergirem;
4. **fail-closed por decisão de política**: um canal governado inválido **não é
   ativado** (continua `active=false`, fora do roteamento) e a exclusão aparece
   no veredito — em `channels[].failed_checks` e, nomeada, na mensagem de
   `channel_ownership_proven`.

A alternativa considerada e **recusada** foi "todos os canais governados
precisam estar prontos". Ela transforma um canal quebrado num agente inteiro
parado: um tenant com três linhas, uma delas com pareamento vencido, não ativaria
nenhuma — e a remediação óbvia viraria apagar a linha ruim (destrutivo) em vez
de consertá-la. A regra escolhida é fail-closed onde importa (nada roteia sem
posse E papel válido) e permissiva só onde é seguro.

Prova: `tests/unit/onboarding/readiness.spec.ts` (composição INTRA-agente) e
`tests/integration/onboarding-review-541-round2.spec.ts`.

### A propriedade central

O avaliador é puro e recebe os fatos com o **escopo dono embutido em cada objeto**. Ele não confia que o loader filtrou — ele **prova**, descartando todo objeto cujo par não seja o requisitado. Um fato de outro escopo é tratado como **ausente**, jamais como satisfeito. É o que mata o falso positivo "profile de A + canal de B ⇒ pronto" (`tests/unit/onboarding/readiness.spec.ts`).

### Escopo do agente, e o que o readiness recusa a responder

O loader lê `agents` pelo **par completo** (`tenant_id + agent_id`), como toda
outra leitura do módulo. Consequência deliberada: um agente que existe em OUTRO
tenant é **indistinguível de ausência** — `agent_exists` e
`agent_belongs_to_tenant` reprovam juntos, com a mesma mensagem, e
`configuration_fingerprint` é o mesmo dos dois casos.

Isto **reverte** um desenho anterior que lia `agents` por `id` apenas para poder
dizer "existe, mas é de outro tenant". Aquele diagnóstico era comprado com uma
leitura cross-tenant no caminho default: violava a invariante 1 do `AGENTS.md`
e **vazava existência** — quem chutasse o id de um agente alheio recebia a
confirmação de que ele existe. Nenhum diagnóstico de operador paga esse preço.

O diagnóstico global continua disponível, mas fora do caminho default:

```ts
import { diagnoseAgentOwnershipGlobally } from '@/onboarding/index.js';
// só `founder`; qualquer outro papel ⇒ OnboardingError('forbidden')
// toda consulta grava `admin_audit_log` (bucket `system`) com ator, alvo e veredito
```

Ela devolve `absent | owned_by_requested_tenant | owned_by_other_tenant` e nada
mais — nunca status, nome ou configuração do agente alheio. `evaluateAgentReadiness`
**não** a chama.

`applyProvisionAgent` segue a mesma regra: a releitura pós-`INSERT` carrega o
par, e um id já em uso recusa com `duplicate_agent` **sem nomear o dono**.

### `schema_ready` consome o veredito canônico, nunca `schema_migrations`

`loadSchemaState()` chama `getSchemaReadiness({ pool, migrationsDir })` de
[`src/migrations/`](migrations.md) e projeta o resultado. Ele **não** lê
`schema_migrations` — o doc daquele módulo é explícito: um consumidor nunca
re-deriva estado de schema por conta própria.

O que isso corrige: a leitura crua tratava **toda linha do ledger como
aplicada**. Migration `dirty`, `failed`, `running`, com checksum divergente ou
desconhecido, e arquivo ausente (o banco aplicou algo que este build não
empacota) **não são pendentes** — logo `pending_migrations.length === 0` deixava
`schema_ready` verde no exato instante de uma ativação.

Os fatos passam a carregar:

| Campo | O que é |
|---|---|
| `ready` / `state` | o veredito (`ready` / `blocked` / `unknown`). `unknown` (banco fora do ar, ledger ilegível) **reprova** — `getSchemaReadiness` nunca lança, sempre falha fechado |
| `blockers` | `{ kind, id }` — códigos ESTÁVEIS. Nunca SQL, DSN ou mensagem de driver: a mensagem do check é persistida |
| `verified` | `{ id, state, checksum }` por migration — a evidência, e o insumo do fingerprint |

### Fingerprints

- `configuration_fingerprint` — SHA-256 da projeção canônica de profile, grants, papéis, políticas e canais. **Não inclui `channels.external_id`** (é o telefone da linha, e o fingerprint aparece em auditoria).
- `schema_fingerprint` — SHA-256 de `{ state, expected_head, applied_head, verified[] }`, isto é, do **estado verificado** de cada migration. Deliberadamente **não** é a lista de ids: essa produzia o MESMO valor para um schema íntegro e para um schema com migration `dirty` ou checksum divergente — exatamente o par que o carimbo de auditoria da ativação existe para distinguir.

## A saga

```
created → tenant_ready → admin_ready → agent_draft → profile_ready →
capabilities_ready → policy_ready → channel_declared → pairing_pending →
channel_ready → ready_for_activation → activating → active
```

Laterais: `readiness_failed`, `failed_retryable`, `failed_terminal`, `cancelled`.

**Desvio documentado da lista da issue.** A issue sugere `policy_ready → channel_declared`, mas `channel_policies.channel_id` é `NOT NULL` — a política não pode existir antes do canal. Então `configure_role` leva a `policy_ready` significando "o papel de governança existe, está ativo e é o default", e `declare_channel` materializa o canal **e** a política que o vincula àquele papel, na mesma transação. O nome do estado foi preservado (é contrato da issue).

### Idempotência: duas defesas, para dois modos de falha

1. **Mesma chave, retry** → o ledger (`onboarding_step_results`) devolve o resultado persistido. Cobre o crash entre o commit e a resposta.
2. **Chave diferente** (double-click com duas requisições) → a máquina de estados recusa: o passo só é legal a partir do seu estado de origem, e o commit anterior já avançou a run. As duas requisições serializam no `FOR UPDATE` e a segunda vê `invalid_transition`.

Por isso **não** existe unique em `(run_id, step)`: passos re-executáveis (`evaluate_readiness`, retomada de pareamento) precisam poder rodar de novo, e quem impede o provisionamento duplicado é o **estado**, não o ledger.

#### Todo comando mutável é idempotente — inclusive abrir e cancelar a run

`startOnboardingRun` e `cancelOnboardingRun` exigem `idempotency_key` como
qualquer passo. Não é simetria estética: sem isso, o comando que **abre** a saga
inseria outra run (e outra trilha) a cada retry, e o retry de um cancelamento
pós-commit encontrava a run já `cancelled` e devolvia `run_terminal` — um erro
para uma operação que tinha dado certo.

| Comando | Onde mora o ledger | Chave |
|---|---|---|
| `startOnboardingRun` | a própria run (`onboarding_runs.creation_idempotency_key_hash` + `creation_payload_hash`) — não há tabela filha antes de a run existir | `(kind, COALESCE(tenant_id,''), hash)`, índice `onboarding_runs_creation_key_uq` |
| `executeOnboardingStep` | `onboarding_step_results` | `(run_id, step, hash)` |
| `cancelOnboardingRun` | `onboarding_step_results`, sob o pseudo-passo `cancel_run` | `(run_id, 'cancel_run', hash)` |

O escopo entra na chave de criação de propósito: a idempotency key é opaca e
escolhida pelo cliente, então deduplicá-la globalmente devolveria a run de
**outro tenant** para quem fizesse retry — um vazamento horizontal criado pela
própria idempotência.

#### Unicidade do escopo inicial

`onboarding_runs_one_live_per_agent_uq` tem predicado `agent_id IS NOT NULL` e
por isso **não cobria** a fase em que a run ainda não criou o agente — de
`created` até `provision_agent`, metade da saga. Duas runs `tenant_onboarding`
em `created` para o mesmo tenant coexistiam e provisionavam árvores de
governança diferentes (dois admins, dois agentes, dois papéis padrão).

`onboarding_runs_one_live_per_tenant_uq` (migration 113) é o espelho para esse
intervalo: **uma** run viva sem agente por tenant. Assim que a run adquire
`agent_id`, ela sai deste índice e entra no de par completo — dois agentes do
mesmo tenant continuam podendo ser onboardados em paralelo a partir daí. Abrir
uma segunda saga viva com outra chave devolve `duplicate_tenant` ("retome ou
cancele"), nunca uma segunda run.

#### Resultados CONCLUSIVOS, não só sucessos

`onboarding_step_results.outcome_kind` (migration 113) é `success | denied |
cancelled`. Enquanto só sucessos entravam no ledger, uma **negativa** avançava
versão e estado sem deixar rastro replayável: o retry da mesma chave recebia
`version_conflict` (a versão já era outra) em vez da negativa anterior, e a
proteção contra reciclagem de chave (`idempotency_payload_mismatch`) sumia justo
no caminho de recusa. Hoje a negativa é gravada **antes** de a versão/estado
mudarem, e o replay devolve o mesmo código e a mesma mensagem — marcado como
replay, para não contar duas recusas na métrica.

#### `failed_retryable` guarda o PONTO DE RETOMADA

O estado dizia "reexecute o mesmo passo" mas não guardava **qual** passo falhou,
e toda definição aceitava `failed_retryable` como origem. Depois de uma negativa
em `start_pairing`, o backend autorizava `provision_tenant`, `provision_admin`,
`declare_channel` ou `evaluate_readiness` — passos que rebobinam o estado
materializado ou criam recursos adicionais.

Agora a negativa que leva a `failed_retryable` grava `failed_step` (o passo) e
`resume_state` (de onde ele partiu). `planTransition` resolve a origem
`failed_retryable` **contra esse ponto persistido**, lido da row travada:

- o retry do próprio passo é legal;
- as remediações declaradas em `RETRY_REMEDIATIONS` são legais — hoje só
  `confirm_channel_ready → start_pairing` (refazer o pareamento da MESMA linha;
  ambos `repeatable`, nenhum provisiona nada);
- **tudo o mais é `invalid_transition`**, e sem ponto de retomada gravado nada é
  legal (fail-closed; a migration 113 impede que essa combinação seja gravada).

`allowedStepsFrom(state, retry_point)` devolve exatamente esse conjunto, então o
console não desenha botões que o backend recusaria. Um passo que commita limpa
`failed_step`/`resume_state`.

### Atomicidade — o que acontece se um passo morre no meio

`onboardingRunsRepo.commitStep` faz, numa transação SQL curta: trava a run (`FOR UPDATE`) → confere `version` → consulta o ledger → valida a transição **contra o estado travado** → executa a escrita do passo **no mesmo `tx`** → grava ledger + evento + `admin_audit_log` + novo estado.

- **Crash ANTES do commit** → nada aconteceu. A run continua no estado anterior; o retry com a mesma chave refaz o passo.
- **Crash DEPOIS do commit, antes da resposta** → o retry com a mesma chave encontra o ledger e devolve o resultado persistido (`replayed: true`), sem re-executar a escrita.

Não há estado intermediário que exija inspeção manual do banco.

**Não há exceção — nem para `start_pairing`.** A fila de comandos Admin→runtime
de #518 (`channel_line_state`, `migrations/103`) é o **outbox durável** desse
efeito, e ela vive no mesmo Postgres. Então o enfileiramento entra no `tx` do
passo, via `channelLineStateRepo.requestCommandWithAuditInTx` — junto do ledger,
do evento, da auditoria e do novo estado.

Isto corrige uma violação direta de "backend decide, caller propõe": o comando
era enfileirado **antes** de `commitStep` travar a run e conferir expiração,
ledger, `expected_version` e transição. Um pedido velho, terminal ou inválido
produzia efeito de runtime e **só então** recebia conflito; e o `command_id`
derivado só protege o retry da MESMA chave — a mesma ação sob chave diferente
enfileirava um segundo comando. Hoje o commit decide primeiro, sempre.

Efeito colateral desejável: uma recusa da fila (`pairing_in_progress`) passou a
ser uma **negativa de governança** como qualquer outra — a run vai para
`failed_retryable` (de onde `start_pairing` é legal de novo) e a decisão deixa
evento + `admin_audit_log`. Antes ela era devolvida fora da transação e não
deixava rastro nenhum.

### Concorrência

Optimistic: todo comando informa `expected_version`; o `UPDATE` casa com `version = $expected` **e** a run está travada com `FOR UPDATE`. Dois operadores no mesmo passo ⇒ um avança, o outro recebe `version_conflict`.

### Ativação

A ativação **reavalia** o readiness sob a trava da run — readiness verde há cinco minutos não autoriza ativar agora. Reprovando, a run vai para `readiness_failed` e a auditoria registra `agent_activation_denied`. Aprovando, o agente vira `active`, **exatamente os canais que o readiness aprovou** (`activatable_channel_ids` — política + papel ativo + posse, cada um satisfeito pelo MESMO canal) passam a rotear, e a auditoria registra `agent_activation_approved` com os dois fingerprints. `applyActivate` re-deriva esse conjunto contra o banco sob os locks e **recusa** (`deny`) se ele divergir do aprovado: a decisão é do avaliador (foi ela que o operador viu), a re-derivação é a segunda opinião, e nenhuma das duas sozinha basta.

#### O retrato precisa ser o MESMO que as escritas enxergam

Reavaliar não basta se a reavaliação lê por fora da transação. O avaliador
default lia pelo handle global `db`: só a row de `onboarding_runs` estava
travada, e profile, grant, papel, política ou canal podiam mudar entre o retrato
e o `applyActivate`. Uma política removida nessa janela produzia **zero canais
ativados com a run concluindo assim mesmo** — um agente "ativo" que não roteia
em lugar nenhum.

São duas defesas, e as duas são necessárias:

1. **Lock + leitura pelo `tx`.** `lockReadinessSnapshot(tx, scope)` trava, em
   ordem FIXA, tudo de que o veredito depende: `FOR SHARE` no que é só lido
   (tenant, profile, grant, papéis, políticas, estado de linha, drift) e
   `FOR UPDATE` no que será escrito (`agents`, `channels` — pegar o lock forte
   já na leitura evita o upgrade tardio, fonte clássica de deadlock). Só então o
   readiness é carregado, **pelo `tx`**. Um `DELETE` concorrente de política
   bloqueia até o commit.
2. **Verificação do efeito.** `FOR SHARE` não é predicate lock: uma linha NOVA
   inserida concorrentemente não é travada por nada. Por isso `applyActivate`
   **lê o conjunto governado primeiro** (se vazio ⇒ `deny`, com zero escritas —
   um `deny` commita a transição, então escrever antes de decidir deixaria o
   agente `active` numa run que não concluiu) e depois **confere** que ambos os
   `UPDATE` casaram exatamente com o esperado; divergência lança e o rollback
   leva tudo.

`evaluate_readiness` lê pelo `tx` mas **não** trava: é observação, não escrita, e
segurar `FOR SHARE` sobre a configuração do agente a cada refresh de dashboard
seria contenção gratuita.

### Métricas

As séries deste módulo saem por [`@/observability/metrics`](../../../src/observability/metrics.ts) — allowlist de chave, guarda de PII, budget de cardinalidade e atribuição `tenant_id`/`agent_id` — e **nunca** por `@/lib/metrics` direto. Emitir direto punha `reason_code` (texto arbitrário do console), código de erro e código de check em labels crus: PII possível e cardinalidade ilimitada.

Os valores vêm de **vocabulários fechados** declarados em `src/observability/taxonomy.ts` (`ONBOARDING_STEP_VALUES`, `ONBOARDING_REASONS`, `READINESS_CHECK_CODE_VALUES`); `closedVocabulary()` colapsa qualquer coisa fora do contrato em `other`. O motivo original continua inteiro em `onboarding_runs.last_error_code`, no evento append-only e na auditoria — texto livre pertence à trilha, não a um label.

| Série | Labels |
|---|---|
| `maia_onboarding_run_started_total` / `_completed_total` | `kind` |
| `maia_onboarding_run_cancelled_total` | `reason` |
| `maia_onboarding_step_completed_total` / `maia_onboarding_idempotency_replay_total` | `step` |
| `maia_onboarding_step_failed_total` | `step`, `reason` |
| `maia_onboarding_step_duration_ms` | `step` |
| `maia_agent_readiness_failed_total` | `check_code` |

Todas carregam `tenant_id` + `agent_id` (bucket `system` enquanto a run ainda não resolveu o escopo). `tests/unit/onboarding/metrics-taxonomy.spec.ts` pina os vocabulários contra `ONBOARDING_STEPS`, `ONBOARDING_ERROR_CODES` e `READINESS_CHECK_CODES`, e `wizard.spec.ts` lê o registro renderizado para provar que um `reason_code` com telefone não vira série.

O operador precisa **confirmar o par exato** (`confirm_tenant_id` / `confirm_agent_id`); divergência é recusada. É a defesa contra ativar o agente errado a partir de uma aba antiga do console.

## Patterns it follows

- **Escopo fail-closed antes de tudo** — `scope.ts` rejeita `'default'` e `'system'` como ALVO de provisionamento. `'primary'` é um tenant ordinário e passa. As mesmas regras existem como `CHECK` na migration 108: o guard devolve erro tipado, o banco é a última linha.
- **Auditoria atômica** — a trilha completa vai para `admin_audit_log` **no mesmo `tx`** do passo (mesmo desenho de `tenantsRepo.createWithAuditAtomic`). `audit_log` não serve para todos os passos: sua coluna `agent_id` é FK para `agents`, e metade da saga roda antes do agente existir. As decisões agente-escopadas (`agent_readiness_evaluated`, `agent_activation_approved|denied`) emitem **também** `audit()` pós-commit sob o ALS do par real — com `alvo_id: null`, porque `audit_log.alvo_id` é coluna `uuid` e `agents.id` é TEXT; o agente é atribuído pela coluna `agent_id` e por `metadata`.
- **O bucket `system` quando o alvo ainda não existe** — `admin_audit_log.tenant_id` é `REFERENCES tenants(id)` (`migrations/047_admin_audit_log.sql:10`), e a saga audita **antes** de `provision_tenant` criar o tenant. `resolveAuditTenant` (`src/db/repositories/onboarding-repos.ts`) resolve, no mesmo `tx`, se o tenant-alvo já existe: existindo, a linha vai para ele; não existindo, vai para o bucket `system` (semeado por `migrations/014_p0_seed_system_tenant.sql`) com o alvo preservado em `change_summary.target_tenant_id`. A trilha nunca some e continua atribuível — buscar por `change_summary->>'target_tenant_id'` responde "quem iniciou/cancelou o onboarding do tenant X". Como o SELECT roda dentro do `tx`, do passo `provision_tenant` em diante a auditoria já usa o tenant real.
- **Vocabulário de enum vem do schema, não do módulo** — os literais que a saga escreve em coluna com `CHECK` moram em constantes nomeadas (`SAGA_ENUM_WRITES` em `provisioning.ts`), e `tests/unit/onboarding/schema-constraint-compatibility.spec.ts` confronta cada um com o `CHECK` efetivo lido de `migrations/*.sql` — **sem banco**. Foi assim que `agents.status='provisioning'` (fora do `CHECK` de 007 até a migration 110) e `channel_policies.switch_behavior='fixed'` (vocabulário paralelo inventado; o real é `locked|prefer_handoff|free_with_trigger|by_context`) deixaram de ser possíveis de reintroduzir sem um teste vermelho.
- **Backend decide** — todo payload passa por Zod antes de qualquer escrita; a UI propõe.
- **Nada sensível persistido, e a entrada é FECHADA** — `sanitize.ts` redige por denylist de CHAVE (determinístico e auditável) em `metadata`, `summary` e `result`. Mas a denylist decide pelo NOME do campo e nunca olha o valor, então ela **não fecha texto livre**: `{ note: '…telefone…' }` atravessava inteiro, e `reason_code` de cancelamento ia cru para `last_error_code`, para o evento e para `admin_audit_log`. Por isso as duas superfícies livres viraram contratos tipados — `runMetadataSchema` (`.strict()`, vocabulários fechados, `ticket_ref` com formato `ABC-123`) e `ONBOARDING_CANCEL_REASONS` (subconjunto de `ONBOARDING_REASONS`, para que o valor persistido seja o MESMO que vira label). Só campos aprovados são projetados; o que não está no contrato é **recusado**, não redigido.

## How to extend

| Need | Where |
|---|---|
| Novo check de readiness | Adicione o código a `READINESS_CHECK_CODES`, o fato a `ReadinessFacts`, o check a `evaluateReadinessFacts` e a leitura a `readiness-facts.ts`. O teste de contrato exige um check por código |
| Novo passo da saga | `ONBOARDING_STEPS` + `STEP_DEFINITIONS` (state-machine), schema em `STEP_PAYLOAD_SCHEMAS`, `apply*` em `provisioning.ts`, `case` no `switch` de `wizard.ts` |
| Novo estado | `ONBOARDING_STATES` **e** o `CHECK` de uma migration NOVA (109 está mergeada — migrations são append-only) |
| Novo literal de status/enum em coluna com `CHECK` | Declare a constante e registre em `SAGA_ENUM_WRITES` (`provisioning.ts`). Se o `CHECK` não o admitir, `schema-constraint-compatibility.spec.ts` falha **sem banco** e a correção é uma migration nova alargando o `CHECK` (padrão `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`, como a 110) — nunca editar a migration mergeada |
| Trocar a fonte dos fatos | Injete `deps.loadFacts` em `evaluateAgentReadiness` |

## Public surface

| Consumed by | What |
|---|---|
| `maia doctor` (#517) | `evaluateAgentReadiness` — a fonte canônica de prontidão |
| `scripts/setup.ts` | mesma função, para reportar o readiness de `primary` no fim do seed |
| Console administrativo (a construir) | `startOnboardingRun`, `executeOnboardingStep`, `cancelOnboardingRun`, `getOnboardingRun`, `listOnboardingRuns` |
| `src/db/repositories/channel-line-state-repos.ts` | via `PairingPort` — o wizard enfileira o pareamento de #518, não o reimplementa |

## Known gaps

Verifique contra as issues antes de confiar nesta lista.

- **Bootstrap global (`kind='global_bootstrap'`) não implementado.** A coluna e o `CHECK` existem (migrations são append-only e adiar custaria outra migration), mas `startOnboardingRun` recusa esse kind com `kind_not_implemented`. Falta a credencial de uso único, o endpoint restrito e a invalidação atômica — a criação do primeiro admin ainda é a via documentada em `docs/admin-ui-deploy.md`.
- **Sem superfície de UI.** Não há router tRPC nem telas; o módulo é backend puro.
- **Compensação é conservadora.** O cancelamento encerra a run e preserva tudo; não desprovisiona. Nenhum recurso criado pela saga é exclusivo dela (um tenant/agente/canal pode já estar em uso por outro caminho), e compensação cega sobre recurso compartilhado é explicitamente proibida pela issue.
- **`tests/integration/onboarding-leak.spec.ts` ainda não está no script `test:leak`** — `package.json` estava fora do escopo da entrega que criou o módulo.

---

| | |
|---|---|
| Last verified | 2026-08-08 |
| Against `main` HEAD | `ce1f0f69` (branch `claude/leva-agentes-2026-08-04` @ `6bf0fa27` + 2ª rodada de review do PR #541) |
| Re-verify when | Older than 30 days; OR `src/onboarding/**` muda; OR uma migration nova toca `onboarding_*`; OR #517/#518 mudam o contrato consumido aqui |
