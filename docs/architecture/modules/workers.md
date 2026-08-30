# workers

**Path:** `src/workers/`

**Purpose** — 33 background workers driven by cron and BullMQ. Each worker has one job: refresh a materialized view, drain a queue, reap zombies, monitor a budget, write a trace body, promote a knowledge state, etc. Workers enter `runWithTenantContext` per tenant (iteration, not a single global pass) and emit metrics + audit per iteration.

## Key files

| File | Role |
|---|---|
| `src/workers/index.ts` | Worker registry, startup orchestration and the cron **drain** (`stopWorkers`) |
| `src/workers/job-contract.ts` | **Contrato de concorrência** (#513 §9): grupos, classificação, `validateJobRegistry` |

### Contrato de concorrência dos jobs (issue #513 §9)

Todo job do registro DECLARA, além de nome e cadência:

| Campo | O que responde |
|---|---|
| `group` | qual grupo operacional liga/desliga o job (substitui `phase`) |
| `effect` | `read-only` \| `idempotent` \| `side-effectful` — o que acontece se duas réplicas rodarem o mesmo tick |
| `guard` | `none` (com `why`) \| `row-claim` \| `global-singleton` \| `per-tenant-singleton` — o que impede que isso seja um problema |
| `module` | onde o job vive; é por ele que o teste confere que o lock declarado EXISTE |
| `unguarded` | lacuna DECLARADA: efeito não idempotente ainda sem claim (ver abaixo) |
| `phase` | metadado histórico. **Nada no runtime lê** |

A regra da issue — "jobs não idempotentes têm single-flight/claim" — é
`validateJobRegistry()`, chamada por
[`tests/unit/workers/job-contract.spec.ts`](../../../tests/unit/workers/job-contract.spec.ts)
**e** por `startWorkers()`: um registro inválido para o boot, não a produção.
O teste também reprova um lock **declarado que não existe no módulo** — uma
declaração de single-flight sem código por trás é pior que nenhuma.

**Lacunas congeladas.** Quatorze jobs do baseline têm efeito não idempotente
sem guard (o mais visível: `briefing_morning` manda WhatsApp para todos os
donos sem claim). Elas estão tipadas em `unguarded`, dizem o que duplicam,
apontam para a issue, e o CONJUNTO está congelado no teste: um job novo não
entra nele. Fechar cada uma é trabalho de fatia própria — a maioria pede CAS
no repo ou advisory lock por tenant, mais os specs de isolamento que os cercam.

### Grupos, e o que aconteceu com `phase`

`phase: number` era o mecanismo operacional inteiro: `startWorkers(1)` — o único
call site de produção — descartava em silêncio todo job com `phase > 1`. O
efeito colateral já tinha mordido o projeto três vezes (`mcp_sync`,
`channel_pairing` e `synthetic_probe` foram REBAIXADOS para phase 1 "de
propósito" porque em phase 2 nunca rodavam e o console mostrava operação
pendente para sempre).

Quem decide agora é **`MAIA_SCHEDULER_GROUPS`** (lista separada por vírgula, ou
`all`). Nome desconhecido é **erro de boot**, nunca um grupo ignorado.

| Grupo | Default | Conteúdo |
|---|---|---|
| `turn-pipeline` | **on** | recuperação de inbound, debounce, pendências, workflows |
| `outbound` | **on** | outbox durável, sweeper do ledger legado, relayer de efeitos |
| `scheduling` | **on** | tick, drain do outbox, backfill de séries |
| `channel` | **on** | pareamento de linha, ponte MCP, sonda sintética |
| `monitoring` | **on** | saúde, audit watcher, DLQ, custo, runtime trace |
| `housekeeping` | **on** | idempotência, inatividade, onboarding vencido |
| `ops-backup` | **on** | backup, retenção, drill de restore, TTL de export |
| `console` | off | playground e work loop de objetivos |
| `cognition` | off | sumarização, reflexão, padrões, memória, confiança |
| `procedures` | off | reaper de execuções, matview de métricas |
| `proactive` | off | briefings e drift — **escrevem para o usuário** |
| `governance` | off | escalada de gaps, triagem de pedidos de tool |

O default **reproduz exatamente** o que `phase <= 1` agendava — há um teste que
compara os dois conjuntos job a job, para que a troca de mecanismo não ligue nem
desligue nada por acidente. Os cinco grupos `off` são os jobs que `phase > 1`
já descartava; a diferença é que agora eles aparecem no boot, com nome e
contagem, em vez de sumirem num `continue`.

### Inventário de boot

`startWorkers()` devolve (e loga) o inventário:

- `scheduler.inventory` — grupos ligados, grupos desligados **com contagem de
  jobs**, e a lista nominal do que foi agendado;
- `scheduler.unguarded_jobs_enabled` (**warn**) — os jobs habilitados que
  duplicam efeito com mais de uma réplica de scheduler. Quem escala precisa ver
  isso na primeira tela, não no post-mortem;
- `maia.starting` (em `src/index.ts`) traz o **role**, o que ele inicia
  (`owns`) e o que o `/readyz` exige dele (`requires`).

Métricas: `maia_scheduler_job_total{job,result}` (`ok` / `failed` /
`skipped_overlap`) e `maia_scheduler_job_lag_seconds{job}` — a **idade do
último sucesso**, não "atraso em relação ao horário agendado": o node-cron não
entrega o instante teórico do tick, então esse segundo número seria inventado.
Antes do primeiro sucesso o valor é a idade do processo, nunca zero.

### Cron drain and overlap (issue #512)

`startWorkers()` wraps every tick in a guard (`runTick`) that:

- **refuses new ticks once the drain started** — no side effect begins after `draining`;
- **skips a job whose previous run is still active** (`maia_worker_tick_skipped_total{worker,reason="overlap"}`). Every long-running job here is already single-flight via a DB lease, so skipping beats racing;
- tracks the in-flight promise so `stopWorkers(deadlineMs)` can **await** it.

`stopWorkers()` is `async` and returns `{ drained, pending }`. `pending` is the
honest list of jobs still executing when the deadline expired — it is logged
(`worker.drain_deadline_exceeded`) and surfaces in the shutdown outcome. Before
#512 it was a synchronous `task.stop()` loop, so `gracefulShutdown()` closed
the Redis/Postgres pools underneath a running cron.

Per-worker gauges: `maia_worker_active_jobs{worker}`,
`maia_worker_last_success_timestamp{worker}`,
`maia_worker_last_failure_timestamp{worker}`.

`health_monitor` also owns the **persistence** of the health timeline
(`recordHealthSnapshot`) since #512 — `/health` itself no longer writes.

### Worker categories

| Category | Files |
|---|---|
| **Reflection + cognition** | `reflection-batch.ts`, `confidence-recompute.ts`, `pattern-detector.ts`, `behavioral-hint-validator.ts`, `soul-bias-activator.ts`, `legacy-memory-reclassifier.ts` |
| **Knowledge state machine** | `knowledge-state-promoter.ts` |
| **Procedures** | `procedure-execution-reaper.ts`, `procedure-candidate-consumer.ts`, `procedure-metrics-refresh.ts` |
| **Drift + escalation** | `drift-monitor.ts`, `gap-escalation-monitor.ts` |
| **Scheduling** | `scheduling-tick.ts`, `series-next-scheduler.ts`, `outbox-drain-worker.ts` |
| **Pending questions** | `pending-expirer.ts`, `pending-reminder.ts` |
| **Trace (P10b)** | `trace-body-writer.ts`, `trace-body-recoverer.ts`, `trace-matview-refresh.ts` |
| **Conversation** | `conversation-summarizer.ts`, `inactivity-sweep.ts`, `message-recovery.ts` |
| **Briefings** | `briefings.ts` |
| **Governance** | `audit-mode-expirer.ts`, `audit-watcher.ts`, `idempotency-cleanup.ts` |
| **Onboarding (#519)** | `onboarding-expirer.ts` — varredura GLOBAL sob contexto `system` (a run vencida pode ainda não ter tenant), em lotes de `ONBOARDING_EXPIRER_BATCH_LIMIT`. A série de cancelamento é atribuída ao `tenant_id + agent_id` de cada run; o backlog é lido no scrape (`observability/onboarding-expiry-collector.ts`), não publicado pelo worker. Ver o cabeçalho do arquivo |
| **Operational** | `health-monitor.ts`, `cost-monitor.ts`, `dlq-monitor.ts`, `backup.ts`, `backup-s3.ts` |

## Patterns it follows

- [Tenant isolation](../concerns/tenant-isolation.md) — workers iterate per tenant via `runWithTenantContext`, never with a single global query
- [Governance + observability](../concerns/governance-observability.md) — every worker emits metrics with `tenant_id + agent_id` labels and audits its work
- One job per worker; complex flows split across multiple workers connected via queues or matviews

## How to extend

| Need | Where |
|---|---|
| Add a new worker | New file `src/workers/<name>.ts`; register in `index.ts` com `group`, `effect`, `guard` e `module` (o TypeScript não deixa esquecer); iterate per tenant via `runWithTenantContext`. Efeito não idempotente **exige** claim ou lock — a lista de exceções está congelada |
| Change a worker's schedule | Edit its cron expression in `index.ts` |
| Ligar/desligar um grupo de jobs | `MAIA_SCHEDULER_GROUPS` — **não** mexa em `phase`, que é metadado histórico |
| Add a new lock namespace | Constante no próprio módulo do worker (o teste confere que o `guard.lock` declarado aparece lá); reuse `OPS_LOCK_KEYS` para trabalho de operação |
| Add backpressure / batch limits | Per-worker config; document in the relevant runbook |
| Recover from a worker crash | Workers are restartable; DLQ catches failures (`dlq-monitor.ts` surfaces) |

## Public surface

Workers are leaves of the architecture — they import from many modules but are imported by nothing (except `index.ts`).

## Tests

| Test path | What it covers |
|---|---|
| `tests/unit/workers/job-contract.spec.ts` | **Teste de arquitetura** do registro: classificação obrigatória, lock declarado que existe no módulo, lacunas congeladas, grupos == `phase <= 1` |
| `tests/unit/workers/` | Per-worker contracts |
| `tests/integration/workers/` | Workers against real Postgres/Redis |
| `tests/integration/p10a-knowledge-lifecycle.spec.ts` | `knowledge-state-promoter` lifecycle |

## In-flight changes

At last verification (2026-05-28):

- KSM promoter per-row context wraps audit (#255 → #280 — open)
- Reflection memory cleanup for pre-fix pollution (#260 → #276 — open)
- Reflection-batch per-tenant context iteration (#240 → #251 — merged)

Verify: `gh pr list --state open --search "worker OR promoter OR reaper"`.

---

| | |
|---|---|
| Last verified | 2026-05-28 |
| Against `main` HEAD | `c49c3855` |
