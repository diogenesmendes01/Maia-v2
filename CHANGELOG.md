# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Unreleased]

### Added
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

### Fixed
- **WhatsApp privacy IDs (`@lid`)**: mensagens chegando de contas com
  privacy enabled vinham como `XXXXXXXXXXXXXX@lid` em vez de
  `5511...@s.whatsapp.net`. O código tratava o LID como telefone, o que
  fazia (a) `pessoasRepo.findByPhone` falhar e cair em `unknown`, e (b) a
  resposta da Maia ser enviada para `LID@s.whatsapp.net` — JID inexistente,
  mensagem ia pro vácuo. Fix em três pontos (commit `e94bb46`):
  - `src/gateway/baileys.ts` — quando `remote_jid` termina em `@lid`,
    extrai o telefone real de `msg.key.senderPn` / `participantPn` antes
    de gravar `metadata.telefone`. Fallback para o JID raw mantido com
    log `baileys.lid_without_real_phone` caso o Baileys não exponha o
    campo.
  - `src/agent/output-dispatch.ts` — `sendOutbound` e `sendOutboundPoll`
    agora resolvem o JID de envio via novo `resolveOutboundJid()`, que
    lê `mensagens.metadata.remote_jid` do inbound. Replies sempre saem
    pelo mesmo JID que entraram (preserva thread `@lid`). Mantém o
    fallback antigo (`telefone + @s.whatsapp.net`) para mensagens
    proativas sem `in_reply_to`.
  - `src/agent/core.ts` — o `jid` usado para typing indicator e envio
    de PDF/voz passa pelo mesmo critério (lê do inbound).

### Próxima entrega
- Gateway Baileys funcional
- Loop do agente com tool use (ReAct)
- 5 ferramentas iniciais
- Memória episódica + semântica + procedural
- Smoke test ponta a ponta

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
