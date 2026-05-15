# Maia v2 — P3b Procedures: Runtime Execution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Procedimentos passam a **executar em runtime** com estado stateful entre turnos. Event-sourced (verdade nos events; execution state derivado). Selector decide qual procedure aplicar; Step Evaluator avança passos quando critério é cumprido (suporta `machine_check` e `tool_result` em P3b; `llm_judge`/`user_signal`/`human_confirmed` ficam pra P3c).

**Architecture:** 3 tabelas novas — `procedure_executions` (estado atual derivado), `procedure_execution_events` (verdade, event sourcing), `procedure_selector_decisions` (audit do selector). Selector module em cada turno decide: start nova execução, continuar atual, switch, escalate, ou none. Step evaluator roda após resposta verificando critérios do passo atual. State persiste entre turnos — conversa retomada continua de onde parou.

**Tech Stack:** TypeScript, Drizzle, PostgreSQL, vitest. Builds on P3a (procedure_definitions/assignments) + P0+P1+P2 foundation.

**Reference:** Spec §4.4 (procedures executáveis), §10.6 (selector_decisions separation), §10.8 (schemas dormentes — P3b ativa estes 3).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `migrations/020_p3b_procedure_executions.sql` + down | Create | Estado atual (derivado) |
| `migrations/021_p3b_procedure_execution_events.sql` + down | Create | Event sourcing (verdade) |
| `migrations/022_p3b_procedure_selector_decisions.sql` + down | Create | Log de decisões do selector |
| `src/db/schema.ts` | Modify | 3 tabelas + types |
| `src/db/repositories.ts` | Modify | 3 repos |
| `src/cognition/procedure-selector.ts` | Create | Decide qual procedure ativar no turno (LLM + policy) |
| `src/cognition/step-evaluator.ts` | Create | Avalia critério do passo atual (machine_check + tool_result) |
| `src/procedures/engine.ts` | Create | Runtime stateful: start/advance/abort + replay events |
| `src/agent/prompt-builder.ts` | Modify | Injetar execution state ("você está executando X, passo Y") |
| `src/agent/react-loop.ts` ou `core.ts` | Modify | Selector check no início do turno; Step evaluator no fim |
| `tests/unit/procedure-selector.spec.ts` | Create | Testa selector com mocks |
| `tests/unit/step-evaluator.spec.ts` | Create | Testa machine_check + tool_result paths |
| `tests/unit/procedure-engine.spec.ts` | Create | Testa engine: start, advance, abort, replay |
| `tests/integration/p3b-procedure-runtime.spec.ts` | Create | Cenário end-to-end: turn → select → execute → advance |
| `scripts/p3b-acceptance-gates.sh` | Create | Bateria |
| `docs/runbooks/p3b-procedure-runtime.md` | Create | Runbook |

---

## Task 1: Migration `procedure_executions`

**Files:** `migrations/020_p3b_procedure_executions.sql` + down, `src/db/schema.ts`

### SQL UP

```sql
-- P3b: procedure_executions — estado atual (derivado de events)
CREATE TABLE procedure_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversa_id UUID,
  definition_id UUID NOT NULL REFERENCES procedure_definitions(id),
  definition_version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (
    status IN ('in_progress', 'completed', 'aborted', 'escalated', 'abandoned')
  ),
  current_step_id TEXT,
  execution_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  completed_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  outcome TEXT CHECK (outcome IN ('success', 'failure', 'partial', 'escalated', 'no_response')),
  notes TEXT
);

CREATE INDEX procedure_exec_tenant_agent_status_idx 
  ON procedure_executions(tenant_id, agent_id, status, last_activity_at DESC);
CREATE INDEX procedure_exec_conversa_idx 
  ON procedure_executions(conversa_id) WHERE conversa_id IS NOT NULL;
CREATE INDEX procedure_exec_in_progress_idx 
  ON procedure_executions(tenant_id, agent_id, conversa_id, last_activity_at) 
  WHERE status = 'in_progress';
```

### Drizzle

```typescript
export const procedure_executions = pgTable(
  'procedure_executions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    conversa_id: uuid('conversa_id'),
    definition_id: uuid('definition_id').notNull(),
    definition_version: integer('definition_version').notNull(),
    status: text('status').notNull().default('in_progress'),
    current_step_id: text('current_step_id'),
    execution_state: jsonb('execution_state').notNull().default(sql`'{}'::jsonb`),
    completed_steps: jsonb('completed_steps').notNull().default(sql`'[]'::jsonb`),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    last_activity_at: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    ended_at: timestamp('ended_at', { withTimezone: true }),
    outcome: text('outcome'),
    notes: text('notes'),
  },
  (t) => ({
    tenantAgentStatusIdx: index('procedure_exec_tenant_agent_status_idx').on(t.tenant_id, t.agent_id, t.status, t.last_activity_at),
    conversaIdx: index('procedure_exec_conversa_idx').on(t.conversa_id),
    inProgressIdx: index('procedure_exec_in_progress_idx').on(t.tenant_id, t.agent_id, t.conversa_id, t.last_activity_at),
  }),
);
export type ProcedureExecution = typeof procedure_executions.$inferSelect;
```

Commit: `feat(p3b): procedure_executions table (estado atual stateful entre turnos)`

---

## Task 2: Migration `procedure_execution_events` (event sourcing)

### SQL UP

```sql
CREATE TABLE procedure_execution_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  execution_id UUID NOT NULL REFERENCES procedure_executions(id) ON DELETE CASCADE,
  step_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'execution_started', 'step_started', 'input_received', 'decision_made',
    'tool_called', 'tool_result', 'criterion_checked', 'step_completed',
    'step_failed', 'branch_taken', 'state_updated', 'execution_completed',
    'execution_aborted', 'execution_escalated', 'execution_abandoned'
  )),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC(4,3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX procedure_events_execution_idx 
  ON procedure_execution_events(execution_id, created_at);
CREATE INDEX procedure_events_type_idx 
  ON procedure_execution_events(event_type, created_at DESC);
```

### Drizzle similar pattern.

Commit: `feat(p3b): procedure_execution_events (event sourcing — verdade do runtime)`

---

## Task 3: Migration `procedure_selector_decisions`

### SQL UP

```sql
CREATE TABLE procedure_selector_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversa_id UUID,
  turno_id UUID,
  current_execution_id UUID REFERENCES procedure_executions(id) ON DELETE SET NULL,
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
  decision TEXT NOT NULL CHECK (decision IN ('start', 'continue', 'switch', 'escalate', 'none')),
  selected_procedure_id UUID REFERENCES procedure_definitions(id),
  decided_by TEXT NOT NULL CHECK (decided_by IN ('selector_llm', 'human_override', 'policy_default', 'rule')),
  reason TEXT,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX procedure_selector_conversa_idx 
  ON procedure_selector_decisions(conversa_id, decided_at DESC);
```

### Drizzle

Standard. Plus 3 repos in Task 4.

Commit: `feat(p3b): procedure_selector_decisions (log auditável de toda decisão)`

---

## Task 4: 3 Repos

**File:** `src/db/repositories.ts`

- `procedureExecutionsRepo`: `create`, `findActiveForConversa`, `findById`, `updateState`, `complete`, `abort`
- `procedureExecutionEventsRepo`: `record(event)`, `listByExecution`, `replay(execution_id)` (replays events to reconstruct state)
- `procedureSelectorDecisionsRepo`: `record(decision)`, `recentByConversa`

Commit: `feat(p3b): 3 repos (executions, events, selector_decisions)`

---

## Task 5: procedure-selector module (TDD)

**Files:** `src/cognition/procedure-selector.ts` + `tests/unit/procedure-selector.spec.ts`

### Goal

`selectProcedure({ conversa_id, current_message, current_execution })` retorna:

```typescript
{
  decision: 'start' | 'continue' | 'switch' | 'escalate' | 'none',
  selected_procedure_id?: string,
  candidates: Array<{ procedure_id, confidence, reason }>,
  conflicts: Array<...>,
  reason: string,
}
```

Lógica:
1. Se há `current_execution`: por default `continue` (a menos que LLM sinalize switch forte)
2. Se não há current: lista procedures `active` assigned ao agent (via `procedureAssignmentsRepo.listForTarget`)
3. Filtra por `when_apply` matching (LLM call leve avalia tags/conditions vs current_message)
4. Se ≥1 candidate com confidence > threshold: `decision = 'start'` com top candidate
5. Senão: `decision = 'none'`

Tests:
- Sem procedures assigned → decision='none'
- 1 procedure match → decision='start' com selected_procedure_id
- Em execution atual → decision='continue' por default

Commit: `feat(p3b): procedure-selector module (LLM + policy decide procedure ativa)`

---

## Task 6: step-evaluator module (TDD — P3b: machine_check + tool_result apenas)

**Files:** `src/cognition/step-evaluator.ts` + tests

### Goal

`evaluateCurrentStep(execution, response_context)` retorna:

```typescript
{
  step_completed: boolean,
  criterion_results: Array<{ id, type, passed, evidence }>,
  next_step_id: string | null, // null = procedure completed
  failure_detected: boolean,
}
```

Lógica:
1. Lê `current_step_id` + `success_criteria` da definition
2. Pra cada criterion ligado ao step:
   - Se `type === 'machine_check'`: avalia `expression` contra `response_context` (regex/expression eval simples)
   - Se `type === 'tool_result'`: verifica se tool foi chamada no turno + resultado bate `expected`
   - Outros tipos: skip em P3b (P3c adiciona)
3. Se TODOS critérios passaram → step_completed=true, next_step_id = próximo step com dependência satisfeita
4. Se algum critério matches failure_modes → failure_detected=true

Tests cover machine_check, tool_result, multi-criterion AND logic.

Commit: `feat(p3b): step-evaluator (machine_check + tool_result; outros tipos em P3c)`

---

## Task 7: procedure engine (TDD)

**Files:** `src/procedures/engine.ts` + tests

### Goal

Engine API:

- `startExecution({ definition_id, conversa_id })` → creates execution + emits `execution_started` event
- `recordTurn({ execution_id, response_context })` → emits `step_started`, `input_received` events
- `evaluateAndAdvance({ execution_id, response_context })` → calls step-evaluator, advances state, emits `step_completed` or `step_failed`
- `abortExecution({ execution_id, reason })` → status=aborted + event
- `replayState(execution_id)` → reconstructs execution_state from events (event sourcing)

Each operation:
1. Emits event to `procedure_execution_events`
2. Updates `procedure_executions.execution_state` accordingly
3. Both in transaction-ish flow (best effort — single PG conn)

Commit: `feat(p3b): procedure engine (event-sourced runtime stateful)`

---

## Task 8: Prompt builder — inject execution state

**File:** `src/agent/prompt-builder.ts`

### Goal

Se há `procedure_executions` ativa pra conversa atual:
1. Carrega definition + current step
2. Adiciona ao system prompt:

```
## Procedimento em execução
Você está executando "{nome}" v{version}, passo atual: "{step.id}".
Intenção do passo: {step.intencao}.
Como executar: {step.como}.
Critério de sucesso: {step.sucesso_criteria}.
Armadilhas comuns: {step.armadilhas}.

Estado coletado até agora:
{execution_state}
```

Wrap em try/catch — se repo falha, prompt continua sem essa seção.

Commit: `feat(p3b): prompt-builder injeta execution state ativo`

---

## Task 9: Wire selector + engine no agent loop

**File:** `src/agent/core.ts` ou `src/agent/react-loop.ts`

### Goal

No início de cada turno (`runAgentForMensagemInner`):
1. Chamar `selectProcedure({ conversa_id, current_message, current_execution })`
2. Conforme decision:
   - `start`: chama `engine.startExecution(...)` → seta current_execution
   - `continue`: usa current_execution existente
   - `switch`: aborts current, starts new
   - `none`: prossegue sem procedure
3. Continua com ReAct loop normal (com state injetado no prompt — Task 8)

Após o turno (após `dispatchOutput`), se houve execução ativa:
1. Chama `engine.evaluateAndAdvance({ execution_id, response_context })`
2. Se completou todos os passos → `engine.completeExecution(...)`

Fire-and-forget pattern pra não bloquear resposta.

Commit: `feat(p3b): wire selector + engine no agent loop`

---

## Task 10: Integration test runtime

**File:** `tests/integration/p3b-procedure-runtime.spec.ts`

### Cenários (mocked LLM + repos com in-memory state)

1. Cenário 1: Sem procedure assigned → selector decision=none → ReAct normal
2. Cenário 2: Procedure assigned, current_message match `when_apply` → selector=start → execution criada com current_step_id=primeiro
3. Cenário 3: Execution ativa + critério machine_check passa → step advances
4. Cenário 4: Replay reconstrói state a partir de events
5. Cenário 5: Aborto em qualquer step funciona

Commit: `test(p3b): integration test procedure runtime (5 cenários)`

---

## Task 11: Acceptance gates + runbook + PR

Standard pattern. Script + runbook + PR open.

Commit: `docs(p3b): acceptance gates + runbook procedure runtime`

---

## P3b Acceptance Summary

1. ✅ 3 tabelas (executions/events/selector_decisions)
2. ✅ Selector decide qual procedure ativar (com audit log)
3. ✅ Step evaluator avança quando machine_check/tool_result passa
4. ✅ Engine event-sourced (replay reconstrói state)
5. ✅ Execution stateful entre turnos (conversa retomada continua)
6. ✅ Prompt builder injeta state ativo
7. ❌ llm_judge/user_signal/human_confirmed (P3c)
8. ❌ Métricas + reaper (P3c)
