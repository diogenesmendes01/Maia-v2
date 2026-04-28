# Spec 06 — Agent Loop, Prompt Builder & LLM Fallback

**Status:** MVP Core • **Phase:** 1 • **Depends on:** 00, 01, 02, 03, 05, 07, 08, 09

---

## 1. Purpose

Define the core reasoning loop of Maia: how an inbound message becomes a sequence of LLM turns, tool calls, and ultimately a response. This spec covers the ReAct loop for atomic turns, the dispatch into Plan-and-Execute via workflows for multi-step tasks, prompt assembly, the LLM provider abstraction, and the fallback chain when providers fail.

## 2. Goals

- Strict enforcement of *LLM proposes, backend disposes*: every tool intent is validated before execution.
- Single ReAct loop for atomic turns (~80% of messages); workflows for multi-step.
- Deterministic prompt assembly from typed context blocks.
- Provider-agnostic LLM client; fallback chain Sonnet → Haiku → (Phase 2) Ollama.
- Reflection triggered on three signals: corrections, workflow completion, nightly batch.
- Token and cost accounting per turn.

## 3. Non-goals

- Streaming responses to the user. WhatsApp delivery is single-shot.
- Multi-agent coordination. Single-agent design.
- Custom fine-tuning. Off-the-shelf models only.

## 4. Architecture

### 4.1 Top-level flow

```
mensagens.id (from queue)
   │
   ▼
[A] Load conversation context (mensagens, pessoa, scope, entity_states, facts, rules)
   │
   ▼
[B] Build prompt (typed assembly — see §6)
   │
   ▼
[C] Decide: atomic turn or workflow?
   │
   ├── Atomic ──► ReAct loop (§5.1)
   │
   └── Workflow ──► Plan-and-Execute (§5.2)
   │
   ▼
[D] Send response via gateway (spec 04 outbound)
   │
   ▼
[E] Reflection trigger evaluation (§7)
   │
   ▼
[F] Persist token / cost accounting (mensagens.tokens_usados + agent_facts)
```

### 4.2 Atomic vs. workflow decision

The agent classifies the inbound intent as one of:

```typescript
type TurnClass =
  | 'atomic'                  // single tool, < 3 LLM calls, no persistent state needed
  | 'workflow_existing'       // user is responding to / continuing an existing workflow
  | 'workflow_new'            // user request requires a new multi-step plan
  | 'meta_command'            // 'audit mode', 'lockdown', 'esquece a pergunta', ...
  | 'simple_qa';              // pure question, no tool needed
```

This classification is performed by the LLM in the **first** call of the turn, with a constrained output schema that forces one of the values above. The backend then dispatches accordingly.

## 5. The two execution modes

### 5.1 ReAct loop (atomic)

Pseudocode:

```
loop (max 5 iterations):
  intent = LLM.call(prompt + tool_descriptions)
  if intent.type == 'final_response':
     send(intent.text); return
  if intent.type == 'tool_call':
     validated = backend.validate(intent.tool, intent.args, scope, limits)
     if validated.allowed:
        result = backend.execute(intent.tool, validated.args)
     else:
        result = { error: validated.reason }
     prompt.push(tool_result_block(result))
     continue
exhausted_loop:
  send("Não consegui resolver isso agora. Tenta de novo?")
```

Hard cap at 5 iterations protects against runaway loops. If exhausted, the agent emits a graceful failure and the message is retained in `mensagens` with `processada_em IS NULL` for retry analysis.

### 5.2 Plan-and-Execute (workflow)

When `TurnClass = 'workflow_new'`:

1. LLM emits a **Plan** as a structured array of steps. Schema:
   ```typescript
   const PlanIntent = z.object({
     workflow_type: z.enum(['fechamento_mes', 'cobranca_balancete', 'consolidacao_caixa', /* ... */]),
     entidade_id: z.string().uuid().optional(),
     steps: z.array(z.object({
       descricao: z.string(),
       tool: z.string(),
       args_template: z.record(z.unknown()),
       depends_on: z.array(z.number()).default([]),
     })).min(1).max(20),
     reasoning: z.string().min(10),
   });
   ```
2. Backend validates each step: every `tool` must exist; every `args_template` must be a valid Zod-fragment for that tool; `depends_on` must form a DAG.
3. Backend creates `workflows` row + `workflow_steps`. Status `'em_andamento'`.
4. Worker (spec 11) executes steps in DAG order. After each step, the LLM is given the result and asked to **adapt** the next step's args (it may not change the structure).
5. On completion, `workflows.status='concluido'`; reflection trigger fires.

### 5.3 Continuing an existing workflow

When `TurnClass = 'workflow_existing'`, the agent resumes the workflow rather than starting a new one. User input may be:

- An answer to a `pending_questions` row (resolved via spec 11).
- Free-form input that the LLM interprets and converts into the next-step args.
- A request to abort: `"esquece"` → workflow → `'cancelado'`, audit logged.

## 6. Prompt builder

### 6.1 Layered context

The system prompt is assembled deterministically from blocks. Order matters: most stable on top, most volatile on bottom (better caching with Anthropic's prompt caching).

```
[SYSTEM]
  1. Maia identity (self_state.system_prompt — version pinned)
  2. Pattern reminders (LLM Boundaries — concise summary)
  3. Tool descriptions (read from registry, includes input schemas)
  4. Profile of interlocutor (pessoa.modelo_mental + permission profile id)
  5. Scope (entidade list with names; profile actions list)
  6. Limits (effective limits for this pessoa+entity+action)
  7. Audit/lockdown flags
  8. Recent learned rules relevant to this scope
  9. Recent semantic facts relevant to this scope
  10. Entity states (entity_states for in-scope entities)
  11. World snapshot (today's date in TZ, balances summary, upcoming dues)
  12. Pending questions affecting this conversation
[USER]
  13. Last N messages (working memory, default N=10)
  14. Vector recall (top-K agent_memories by similarity, K=5)
  15. The new inbound message
```

Blocks 1–7 are eligible for prompt caching. Blocks 8–14 vary per turn. Block 15 is always uncached.

### 6.2 Token budget

Default token budgets:

| Slice | Max tokens |
|-------|-----------|
| System (blocks 1–7) | 6000 |
| Memory (blocks 8–11) | 2500 |
| Recent + recall (blocks 12–14) | 2000 |
| User input (block 15) | 500 |
| **Total input** | **~11000** |
| Output target | 1000 |

When a block exceeds its allotment, it is **truncated** with a marker `[... truncated, X items omitted ...]`. The LLM can ask for more via a tool (`recall_memory`, `read_history`).

### 6.3 LLM Boundaries summary block (block 2)

A short, hard-coded reminder:

```
You are an interpretation layer. You may NOT:
- Choose entity, conta, or pessoa not explicitly named by the user or surfaced
  in your scope.
- Compose action lists beyond your interlocutor's profile_id.
- Bypass dual approval. The backend enforces 4-eyes regardless of your output.
- Invent values not present in tool results, recent context, or audit data.
You must emit structured INTENTS; the backend executes.
```

## 7. Reflection — three triggers

### 7.1 Trigger A — User correction (real-time)

Detection: a message that includes negation patterns relative to a previous Maia action ("não, era E3", "errado, isso é da PF", "cancela", "isso não é mercado, é restaurante").

Process:

1. Backend identifies the prior action (most recent transaction by this pessoa, or pending question).
2. LLM is asked, in a focused micro-prompt: *"What rule, if any, should be saved to avoid repeating this misclassification?"*
3. Output schema constrained to:
   ```typescript
   const ReflectionRule = z.object({
     applicable: z.boolean(),
     tipo: z.enum(['classificacao','identificacao_entidade','tom_resposta']).optional(),
     contexto_jsonb: z.record(z.unknown()).optional(),
     acoes_jsonb: z.record(z.unknown()).optional(),
     justificativa: z.string().optional(),
   });
   ```
4. Backend creates `learned_rules` row with `confianca=0.50, ativa=true`, status `probatoria`.
5. Maia announces the new rule on the next applicable use (spec 09 §rule lifecycle).

### 7.2 Trigger B — Workflow completion

When `workflows.status` transitions to `'concluido'`:

1. Worker pulls the workflow steps, results, and any user feedback.
2. LLM produces a reflection summary and a list of candidate rules.
3. Each candidate rule goes through the same probation as Trigger A.
4. The summary is written to `agent_memories` (vectorized) and to `self_state.resumo_aprendizados` (appended) — but **not** to `system_prompt`.

### 7.3 Trigger C — Nightly batch

Cron worker (default 02:00 in `config.TZ`):

1. Selects last 24h of `mensagens` and `transacoes`.
2. Groups by signal: corrections without rules yet, repeated patterns, anomalies.
3. For each group, generates candidate rules using Haiku (cheaper for batch).
4. Insert into `learned_rules` as probationary.

The batch is bounded to 200 LLM calls per night. Excess is queued for the next night.

## 8. LLM provider abstraction

### 8.1 Interface

```typescript
interface LLMProvider {
  name: 'anthropic' | 'openai' | 'ollama';
  modelMain: string;
  modelFast: string;

  call(params: {
    system: string;
    messages: LLMMessage[];
    tools?: ToolSchema[];
    output_schema?: ZodSchema;     // optional structured output constraint
    temperature?: number;
    max_tokens?: number;
    cache_breakpoints?: number[];   // indexes of blocks eligible for caching
  }): Promise<LLMResponse>;
}

type LLMResponse = {
  content: string | null;
  tool_uses: Array<{ tool: string; args: unknown; id: string }>;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
  usage: { input_tokens: number; output_tokens: number; cache_read?: number; cache_write?: number };
  raw: unknown;
};
```

### 8.2 Anthropic (primary)

Uses `@anthropic-ai/sdk`. Tool use via the native Tools API. Prompt caching is enabled by sending `cache_control: { type: 'ephemeral' }` on the system blocks 1–7.

### 8.3 OpenAI (Phase 2 cross-provider)

Uses `openai` SDK. Tool use via native Function Calling. Different message shape; the provider adapter translates. **Not used by default**; gated by `LLM_PROVIDER=openai`. Out of scope for Phase 1.

### 8.4 Ollama (Phase 2 local fallback)

Uses HTTP API to a local Ollama server. Llama 3.1 8B or 3.2 3B. Tool use via JSON-mode prompt engineering: tools are described in the system prompt, model output is parsed and Zod-validated. Quality is degraded; **only used in Redis-down-equivalent restricted mode** (read-only intents, no `create_*` actions).

## 9. Fallback chain

### 9.1 Phase 1 chain

```
attempt 1: Sonnet (CLAUDE_MODEL_MAIN)
  on error 429 / 5xx / timeout > CLAUDE_TIMEOUT_MS:
attempt 2: Sonnet retry with backoff (2s)
attempt 3: Sonnet retry with backoff (4s)
attempt 4: Haiku (CLAUDE_MODEL_FAST) — same prompt, same tools
  on error:
final:    enqueue to retry queue + reply to user
          "Estou com instabilidade técnica. Sua mensagem foi salva. Volto logo."
```

### 9.2 Phase 2 chain (`FEATURE_OLLAMA_FALLBACK=true`)

After attempt 4 (Haiku) fails, attempt Ollama in **restricted mode**: the prompt is injected with an additional constraint that limits intents to read-only. If Ollama also fails, fall back to the message above.

### 9.3 Circuit breaker

Per provider, a simple sliding-window failure counter:

- 5 failures in 60s → circuit `'open'` for 60s; calls skip to next provider directly.
- After 60s open, transition to `'half-open'` — one probe call.
- Probe success → `'closed'`. Probe failure → reset open for 60s.

Circuit state is per-process (single-instance deployment). State changes write to `system_health_events`.

## 10. LLM Boundaries

The LLM owns:

- Natural-language interpretation.
- Choosing which tool to call, from the registered set in scope.
- Composing the response text given a tool result.
- Classifying turn type (atomic/workflow/meta/qa).
- Proposing reflection rules.

The LLM does not own:

- Validating its own tool args. Backend does this.
- Deciding when to stop the loop (cap is hard-coded).
- Reading or writing any database row directly.
- Selecting a fallback model. Backend chooses.

## 11. Behavior & Rules

### 11.1 Idempotency hand-off

For tool calls, the agent loop computes `idempotency_key` per spec 09 and passes it into the tool. If the key is a hit, the tool returns the cached result without execution; the agent treats the result as if executed.

### 11.2 Audit mode interaction

When the calling pessoa has audit mode active (spec 09), the tool dispatcher returns a **preview** instead of executing, formatted as a `tool_result` block to the LLM. The LLM then replies to the user with the preview and the question "Confirma? (sim/não)". A confirmed preview is executed via the same idempotency key.

### 11.3 Cost accounting

After every LLM call:

- `mensagens.tokens_usados` updated for the inbound message (sum of all calls in the turn).
- `agent_facts` row with key `cost.daily.<pessoa>.<YYYY-MM-DD>` incremented (for cost monitoring per spec 17).

### 11.4 Cache breakpoints

Cache breakpoints (Anthropic) are placed at the boundaries of blocks 7 and 11 (a "stable" cache and a "semi-stable" cache). Cache hit ratio is logged per turn.

## 12. Error cases

| Failure | Behavior |
|---|---|
| LLM returns malformed tool args | Validation error returned to LLM as tool_result; LLM retries up to 2 times before user-visible failure |
| LLM exceeds 5 ReAct iterations | Polite failure to user; full transcript in `mensagens.metadata.debug` |
| Tool raises exception | Captured, returned to LLM as tool_result with error; reflexion may save a rule about avoiding it |
| Provider fallback exhausted | User-visible "instability" message; mensagem stays unprocessed for retry |

## 13. Acceptance criteria

- [ ] An atomic turn ("lança R$ 50 mercado") completes in ≤ 2 LLM calls and ≤ 1 tool call (no plan).
- [ ] A workflow request creates `workflows` and `workflow_steps`; resumes correctly after restart.
- [ ] User correction creates a `learned_rules` probationary row with `confianca=0.50`.
- [ ] Anthropic outage (simulated) triggers Haiku fallback within 30s; user is replied to.
- [ ] Cache hit ratio > 50% for the system blocks within a busy hour (manual measurement).
- [ ] Audit-mode-active pessoa never sees a side effect without confirmation in a separate turn.

## 14. References

- Spec 02 — schemas
- Spec 07 — tools and registry
- Spec 08 — memory layers and embeddings
- Spec 09 — governance, audit mode, dual approval
- Spec 11 — workflows engine and pending_questions
- Spec 17 — observability, fallback metrics
