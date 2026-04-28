# Spec 11 — Workflows: Engine, Confirmation State Machine, Dual Approval

**Status:** MVP Core (engine) + Phase 2/3 (specific workflows) • **Depends on:** 00, 02, 06, 09

---

## 1. Purpose

Define the workflow engine — Maia's Plan-and-Execute layer for tasks that span multiple steps, parties, or days. This spec also owns the formal **confirmation state machine** (the system that tracks "Maia asked something and is waiting for an answer") and the canonical implementation of the `dual_approval` workflow type.

## 2. Goals

- Persistent, resumable workflows: surviving restarts, partial failures, and time gaps.
- DAG-based step execution with explicit dependencies.
- A single, typed state machine for "pending answer" tracked across `pending_questions` and `conversas.metadata`.
- Deterministic intent extraction: LLM proposes, backend decides whether the user's reply resolves a pending question.
- 4-eyes implementation as a workflow, not a special case.

## 3. Non-goals

- General-purpose BPMN. We do exactly what we need.
- Cross-session human-task forms. WhatsApp is the only UI.

## 4. Architecture

### 4.1 Workflow model

```
workflow
  ├── tipo                   ('dual_approval', 'fechamento_mes', 'cobranca_balancete', ...)
  ├── status                 ('pendente','em_andamento','aguardando_humano','aguardando_terceiro','concluido','cancelado','falhou')
  ├── contexto               JSONB — workflow-specific state
  ├── entidade_id            (optional)
  ├── pessoa_envolvida       (optional)
  ├── proxima_acao_em        TIMESTAMPTZ — when the worker should look at this again
  └── steps[]
        ├── ordem
        ├── descricao
        ├── status            ('pendente','em_andamento','concluido','pulado','falhou')
        └── resultado          JSONB
```

### 4.2 Step DAG

Steps may declare dependencies via `metadata.depends_on: number[]` (array of `ordem`). A step becomes **eligible** when all dependencies are `'concluido'`. The engine picks the first eligible step in `ordem` order.

### 4.3 Engine loop

A worker (`workflows/engine.ts`) runs every 30s and on event triggers:

```
loop:
  pending_workflows = SELECT ... WHERE status IN ('pendente','em_andamento','aguardando_humano','aguardando_terceiro')
                       AND (proxima_acao_em IS NULL OR proxima_acao_em <= now())
  for wf in pending_workflows:
     advance(wf)
```

`advance(wf)` is type-specific. For `dual_approval`, see §6.

## 5. Confirmation state machine

### 5.1 State storage strata

| Stratum | Storage | TTL | Use cases |
|---|---|---|---|
| Lightweight in-conversation | `conversas.metadata.pending_question` | 2h (`PENDING_QUESTION_TTL_MINUTES`) | "E3 ou PF?", "qual conta?" |
| Medium action-confirmation | `conversas.metadata.pending_action` | 6h (`PENDING_ACTION_TTL_HOURS`) | "Confirma R$ 4.500 em E3?" |
| Multi-party / long-running | `pending_questions` table | 6h–days, per type | dual approval, cobrar balancete |

The agent prefers the lightest applicable stratum.

### 5.2 Lightweight pending_question (metadata)

```typescript
type PendingQuestion = {
  id: string;                            // 'PQ-' + short uuid
  pergunta: string;
  acao_proposta?: { tool: string; args: unknown };
  opcoes_validas: Array<{ key: string; label: string }>;
  expira_em: string;                     // ISO
  created_at: string;
};

// Stored at: conversas.metadata.pending_question = PendingQuestion | null
```

### 5.3 Resolution flow (LLM extracts → backend decides)

When a new message arrives in a conversation with an active pending question:

```
[1] Backend detects pending_question is not null and not expired
   │
   ▼
[2] Prompt includes pending question schema and the new message
   │
   ▼
[3] LLM emits IntentResolution (constrained schema):
   {
     resolves_pending: boolean,
     option_chosen?: string,
     confidence: number,                // 0..1
     reason?: string,
     is_topic_change?: boolean,
     is_cancellation?: boolean,
   }
   │
   ▼
[4] Backend evaluates:
   - resolves_pending && confidence >= 0.7 && option_chosen ∈ opcoes_validas
       → execute acao_proposta with the chosen option as the deciding arg
       → mark pending_question resolved, audit 'pending_resolved'
   - is_cancellation
       → clear pending_question, audit 'pending_cancelled'
   - is_topic_change && !resolves_pending
       → keep pending_question; LLM responds: "antes de [novo tópico], 
          ainda preciso saber [pergunta]; se quiser, manda 'esquece' pra cancelar"
   - low confidence
       → re-ask the same question with rephrasing
   │
   ▼
[5] Audit log + response sent
```

### 5.4 Auto-expire

A worker scans every minute:

```sql
UPDATE pending_questions SET status='expirada' WHERE status='aberta' AND expira_em < now();
```

Expired questions trigger an outbound message *only* if:

- Stratum is `pending_action` and the user explicitly cared about the operation.
- For lightweight `pending_question`, expiration is silent (the user can re-engage if they want).

For `pending_action` expiration:

```
"Cancelei o lançamento de R$ 4.500 (aluguel) — você não respondeu sobre 
 a entidade. Manda de novo se ainda quiser registrar."
```

### 5.5 Manual commands

```
"Maia, esquece a pergunta anterior"            → clear current pending in this conversation
"Maia, o que tá pendente comigo?"              → list this person's pendings
"Maia, o que tá pendente pra todo mundo?"       → owner only — list all open pending_questions
```

## 6. The `dual_approval` workflow

### 6.1 Lifecycle

```
[start]
   │
   ▼
status = 'aguardando_terceiro'
contexto = { intent, requester_pessoa_id, signatures: [], ... }
proxima_acao_em = now() + DUAL_APPROVAL_TIMEOUT_HOURS * 1h
   │
   ▼
[create pending_questions for requester first]
   │
   ▼
on requester 'sim':
   signatures.push({ pessoa_id: requester, at: now })
   create pending_questions for any other dono/co_dono
   │
   ▼
on second approver 'sim' (different pessoa_id):
   signatures.push(...)
   workflow.status = 'em_andamento'
   advance: execute the original tool with dual_approval_granted = true
   workflow.status = 'concluido'
   audit dual_approval_executed
   notify both approvers
   │
   ▼
on any 'não':
   workflow.status = 'cancelado'
   audit dual_approval_denied
   notify
   │
   ▼
on timeout (engine sees proxima_acao_em <= now):
   workflow.status = 'cancelado'
   audit dual_approval_timeout
   notify requester
```

### 6.2 Approver selection

Eligible approvers: `pessoas WHERE tipo IN ('dono','co_dono') AND status='ativa'`. On critical actions involving a specific entity, all eligible approvers are asked (not just one); first valid `'sim'` after the requester counts.

### 6.3 Idempotency on execution

The original intent's idempotency key is computed at workflow creation and reused at execution. If the same operation was attempted (and approved) before, the key hits and re-executes only the audit/notification path.

## 7. Other workflow types (Phase 2+)

### 7.1 `fechamento_mes`

Steps (typical):

```
1. Reconcile bank statements per account (per spec 13 OFX import)
2. Categorize unclassified transactions (LLM)
3. Generate balance summary
4. Identify recurrences without latest occurrence
5. Email contador with the report (after dual approval)
```

Triggered by user command or by cron on the 1st of each month.

### 7.2 `cobranca_balancete`

Periodic follow-up with accountants. Each step is a delayed message; user feedback may end early.

```
Step 1 (Day 5):  Maia → Carlos: "Bom dia, balancete da E1?"
Step 2 (Day 10): if no answer, polite reminder
Step 3 (Day 15): if still no answer, escalate to owner
```

### 7.3 `consolidacao_caixa`

Cross-entity cash flow consolidation. Reads, no writes. Steps:

```
1. For each entity in scope: read saldos
2. Aggregate with shared structures (intercompany loans)
3. Produce summary
4. Save to agent_memories for recall
```

## 8. LLM Boundaries

The LLM may:

- Decide that the current turn is a workflow request (`workflow_new`).
- Propose the workflow type and an initial step plan.
- Adapt step args based on prior step results.
- Emit `IntentResolution` for pending question resolution.

The LLM may not:

- Skip steps marked critical.
- Mark a workflow `'concluido'` while steps are pending.
- Bypass the dual-approval workflow when triggers fire.
- Choose approvers; the backend selects based on rules.

## 9. Behavior & Rules

### 9.1 Resumability

Every worker invocation re-loads workflow state from the database. There is **no in-memory state** that is not also durable. A SIGTERM in the middle of a step transitions that step back to `'pendente'` on the next pass (workers wrap each step in a TX with `SELECT ... FOR UPDATE SKIP LOCKED`).

### 9.2 Step retries

A step that fails increments `metadata.attempts`. Three failures → workflow `status='falhou'`, alert owner. Human can mark `'retry'` to reset.

### 9.3 Cross-workflow lock

If two workflows would mutate the same entity simultaneously (e.g., `fechamento_mes` and a manual `register_transaction`), Maia serializes via `entity_states.flags.fechamento_em_andamento`. Manual writes during this window are blocked with a polite message.

## 10. Error cases

| Failure | Behavior |
|---|---|
| Step has unresolved `depends_on` indefinitely | After 24h alert; manual intervention |
| LLM emits `IntentResolution` with option_chosen not in opcoes_validas | Backend ignores; treats as unrecognized; re-asks |
| Pending question with no expira_em | Treated as expired immediately (defensive) |
| Two approvers reply simultaneously | UNIQUE on `(workflow_id, approver_pessoa_id)`; second insertion ignored |

## 11. Acceptance criteria

- [ ] Killing the worker mid-step resumes the workflow correctly on restart.
- [ ] Dual-approval flow exact happy-path test passes.
- [ ] Pending question correctly identifies a topic change vs. an answer (LLM accuracy spot-tested).
- [ ] Expired `pending_action` produces a cancellation message; expired `pending_question` is silent.
- [ ] Workflow steps execute in DAG order; concurrent eligible steps are serialized when same entity.

## 12. References

- Spec 02 — `workflows`, `workflow_steps`, `pending_questions`
- Spec 06 — agent loop dispatch into workflow_new
- Spec 07 — tool dispatcher (idempotency, dual_approval gate)
- Spec 09 — governance (dual approval rules, audit)
- Spec 13 — OFX import (used by fechamento_mes)
