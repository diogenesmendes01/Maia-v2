# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Unreleased]

### Added
- **Spec 18** (`docs/specs/18-scheduling-and-recurring-workflows.md`)
  — design doc for proactive scheduling: reminders, recurring
  outreach, recurring payment confirmations.
- **Phase 1 — Reminder firer worker** (`src/workers/reminder-firer.ts`,
  cron `* * * * *`): scans `agent_facts.chave LIKE 'reminder.%'` for
  due rows, fires via WhatsApp, marks `fired_at` BEFORE the send so
  retries can't double-fire. Skips when Baileys is disconnected; the
  next tick drains the backlog. New `cancel_reminder` tool. New
  audit actions: `reminder_fired`, `reminder_send_failed`,
  `reminder_skipped`, `reminder_cancelled`.
- **Phase 2 — Recurring workflows** (`src/workflows/recurring.ts`,
  `src/workflows/rrule.ts`): two new `tickEngine` handlers gated by
  `FEATURE_RECURRING_WORKFLOWS`.
  - `outreach_recorrente` — sends a templated WhatsApp message to a
    third party on a recurrence (`FREQ=DAILY|WEEKLY|MONTHLY`,
    `BYDAY`, `BYMONTHDAY`, `BYHOUR`, `BYMINUTE`); waits up to N
    hours for response; optionally forwards to a second person;
    auto-schedules the next cycle as a NEW workflow row (auditable
    per cycle); escalates to the owner on no-response.
  - `payment_due` — fires a `pending_question` to the owner with
    `sim` / `nao` / `adiar` options; on `sim`, the existing
    pending-resolver dispatches `register_transaction` through the
    normal constitutional pipeline (limits, dual-approval). Money
    NEVER moves without owner confirmation. On `nao` skip + next
    cycle. On `adiar` postpone 2 days. On no-response within
    `escalate_after_hours`, alert via spec 17 channels and halt
    the chain — operator decides to resume.
  - `cancel_workflow` tool — stops a single workflow or the whole
    `chain_id` series in one call.
  - Constitutional rules **C-006** (`payment_due` above
    `VALOR_LIMITE_DURO` rejected at creation) and **C-007**
    (`outreach_recorrente` requires `dual_approval_granted` at
    creation).
  - Migration `007_scheduling.sql` adds `workflows.chain_id` +
    indexes for engine scan + reminder firer scan.

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
