# Spec 07 — Tools: Registry, Contracts & Idempotency

**Status:** MVP Core • **Phase:** 1 • **Depends on:** 00, 02, 03, 06, 09

---

## 1. Purpose

Define the contract every Tool must satisfy, the structure of the registry, the idempotency-key formula, and the per-tool specifications for the 13 Phase 1–2 tools. Tools are the **only** way the LLM can produce side effects.

## 2. Goals

- A single, typed registry exposing all tools with their schemas, permissions, and side-effect profile.
- Uniform pre-execution pipeline: validate → check permissions → check limits → check audit mode → idempotency check → execute → write audit log.
- Per-tool Zod input and output schemas.
- Stable idempotency keys per spec 09.
- Tools are **pure functions** of input + database state; no hidden ambient context.

## 3. Non-goals

- Long-running tools that span multiple turns (use workflows, spec 11).
- Tools that call other tools internally (use workflows).
- Streaming tools.

## 4. Architecture

### 4.1 Tool definition

```typescript
type Tool<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
  name: string;                            // 'register_transaction'
  description: string;                     // shown to LLM
  input_schema: I;
  output_schema: O;
  required_actions: ReadonlyArray<ActionKey>;
  side_effect: 'none' | 'read' | 'write' | 'communication';
  redis_required: boolean;                  // if false, allowed in Redis-down mode
  operation_type: 'create'|'correct'|'cancel'|'update_meta'|'parse_only'|'read'|'communicate';
  audit_action: AuditAction;                // string from the taxonomy
  handler: (input: z.infer<I>, ctx: ToolContext) => Promise<z.infer<O>>;
};

type ToolContext = {
  pessoa: Pessoa;
  scope: EntityScope;
  conversa: Conversa;
  mensagem_id: string;
  effective_limits: EffectiveLimits;
  audit_mode_active: boolean;
  redis_available: boolean;
  idempotency_key: string;
  request_id: string;                       // correlation id
};
```

### 4.2 Registry

```typescript
// src/tools/_registry.ts
export const REGISTRY: Record<string, AnyTool> = {
  register_transaction: registerTransactionTool,
  query_balance:        queryBalanceTool,
  list_transactions:    listTransactionsTool,
  classify_transaction: classifyTransactionTool,
  identify_entity:      identifyEntityTool,
  parse_boleto:         parseBoletoTool,
  transcribe_audio:     transcribeAudioTool,
  schedule_reminder:    scheduleReminderTool,
  send_proactive_message: sendProactiveMessageTool,
  compare_entities:     compareEntitiesTool,
  recall_memory:        recallMemoryTool,
  save_fact:            saveFactTool,
  save_rule:            saveRuleTool,
};

export function getToolsForScope(scope: EntityScope, profile: Profile): AnyTool[] {
  return Object.values(REGISTRY).filter(t =>
    t.required_actions.every(a => profile.acoes.includes(a) || profile.acoes.includes('*'))
  );
}
```

### 4.3 Pre-execution pipeline

```
LLM emits tool_call { tool, args, id }
   │
   ▼
[1] Lookup tool in REGISTRY        ──► not found → error 'unknown_tool'
   │
   ▼
[2] Validate args via tool.input_schema (Zod) ──► fail → error 'invalid_args'
   │
   ▼
[3] Check ctx.profile has required_actions ──► fail → error 'forbidden'
   │
   ▼
[4] Check ctx.effective_limits          ──► fail → require single-sig confirm
   │
   ▼
[5] Check requiresDualApproval(intent)  ──► true → create dual_approval workflow
   │
   ▼
[6] Check audit_mode_active             ──► true → return preview (no execution)
   │
   ▼
[7] Compute idempotency_key (spec 09)   ──► hit → return cached result
   │
   ▼
[8] Check redis_required vs redis_available ──► degraded → reject if redis_required
   │
   ▼
[9] Execute tool.handler(args, ctx)
   │
   ▼
[10] Validate output via tool.output_schema
   │
   ▼
[11] Persist to idempotency_keys
   │
   ▼
[12] Write audit_log (tool.audit_action)
   │
   ▼
[13] Return result to LLM
```

## 5. Idempotency key formula (per spec 09)

```typescript
function computeIdempotencyKey(input: {
  pessoa_id: string;
  entity_id: string;
  tool_name: string;
  operation_type: string;
  payload: unknown;
  file_sha256?: string;
  timestamp: Date;
}): string {
  const normalized = normalizePayload(input.payload);
  if (input.file_sha256) {
    return sha256([
      input.pessoa_id, input.entity_id, input.tool_name,
      input.operation_type, input.file_sha256
    ].join('|'));
  }
  const bucket = bucket5min(input.timestamp);
  return sha256([
    input.pessoa_id, input.entity_id, input.tool_name,
    input.operation_type, normalized, bucket
  ].join('|'));
}

function normalizePayload(p: unknown): string {
  // Currency to cents, dates to ISO, descriptions trimmed/lowercase/no diacritics,
  // category as id, deterministic JSON key order.
  const o = canonicalize(p);
  return sha256(JSON.stringify(o));
}
```

## 6. Tool specifications

The following sections define each tool's contract. Schemas use Zod-style annotations; full TypeScript files live under `src/tools/`.

### 6.1 `register_transaction`

| Field | Value |
|---|---|
| Required actions | `create_transaction` |
| Side effect | write |
| Operation type | `create` |
| Audit action | `transaction_created` |
| Redis required | false |

Input:

```typescript
{
  entidade_id: string,
  conta_id: string,
  natureza: 'receita' | 'despesa' | 'movimentacao',
  valor: number,                            // BRL, positive
  data_competencia: string,                 // ISO YYYY-MM-DD
  data_pagamento?: string,                  // ISO; null for pendente/agendada
  status: 'pendente' | 'agendada' | 'paga' | 'recebida',
  descricao: string,                        // 1..280 chars
  categoria_id?: string,
  contraparte_id?: string,
  contraparte_nome?: string,                // free-form fallback if no contraparte_id
  metadata?: { tipo?: 'pix'|'ted'|'boleto'|'cartao'|'dinheiro'; endToEndId?: string; linha_digitavel?: string },
  origem: 'whatsapp' | 'manual',
}
```

Output: `{ transacao_id: string, saldo_apos: number }`.

Behavior:

- Validates `conta.entidade_id == entidade_id`.
- Updates `contas_bancarias.saldo_atual` atomically.
- Triggers semantic dedup check (spec 09 layer 3): if a similar transaction exists in the last 2 hours, returns a `duplicate_suspected` outcome instead of creating; LLM must surface this to the user.
- Triggers dual approval if value or `metadata.tipo` matches critical-actions list.

### 6.2 `query_balance`

| Field | Value |
|---|---|
| Required actions | `read_balance` |
| Side effect | read |
| Audit action | `balance_queried` |

Input: `{ entidade_id?: string; conta_id?: string }`. At least one required.
Output: `{ entidade_id, conta_id?, saldo: number, atualizado_em: string, contas: Array<{id,apelido,saldo}> }`.

### 6.3 `list_transactions`

| Field | Value |
|---|---|
| Required actions | `read_transactions` |
| Side effect | read |

Input:

```typescript
{
  entidade_id: string,
  date_from?: string,
  date_to?: string,
  categoria_id?: string,
  natureza?: 'receita'|'despesa'|'movimentacao',
  status?: ('pendente'|'agendada'|'paga'|'recebida'|'cancelada')[],
  search?: string,                          // ILIKE on descricao/contraparte
  limit?: number,                           // default 50, max 200
  offset?: number,
}
```

Output: `{ items: Transacao[]; total: number }`. The items list contains DTOs (no raw rows).

### 6.4 `classify_transaction`

| Field | Value |
|---|---|
| Required actions | `read_transactions` |
| Side effect | read |
| Audit action | `classification_suggested` |

Input: `{ entidade_id: string, descricao: string, contraparte?: string }`.
Output: `{ categoria_id?: string; categoria_nome?: string; confianca: number; rules_applied: string[]; suggestions: Array<{categoria_id; confianca}> }`.

Implementation: scans `learned_rules` for matches first; falls back to category similarity; never modifies state.

### 6.5 `identify_entity`

| Field | Value |
|---|---|
| Required actions | `read_balance` (any read) |
| Side effect | read |

Input: `{ texto: string }`. The user said something like "lança no aluguel". The tool figures out which entity.
Output: `{ entidade_id?: string; confianca: number; alternativas: Array<{entidade_id; razao}>; ambiguous: boolean }`.

If `ambiguous=true`, the LLM must ask the user which entity. Not allowed to pick on its own.

### 6.6 `parse_boleto`

| Field | Value |
|---|---|
| Required actions | `read_balance` (preview only) |
| Side effect | read |
| Operation type | `parse_only` |
| Redis required | false |
| Audit action | `boleto_parsed` |

Input: `{ media_local_path: string, file_sha256: string }`.
Output: `{ valor: number; vencimento: string; beneficiario: string; linha_digitavel: string; cnpj_emissor?: string; confianca: number }`.

Implementation: Claude Vision extracts the linha digitável; spec 14 validates it. The result is **not** persisted as a transaction; the LLM surfaces it and requires explicit `register_transaction` to save.

### 6.7 `transcribe_audio`

| Field | Value |
|---|---|
| Required actions | `read_balance` |
| Side effect | read |
| Operation type | `parse_only` |
| Redis required | true |
| Audit action | `audio_transcribed` |

Input: `{ media_local_path: string, file_sha256: string }`.
Output: `{ texto: string; idioma: string; duracao_segundos: number; confianca: number }`.

Implementation: spec 10. Idempotent on `file_sha256`.

### 6.8 `schedule_reminder`

| Field | Value |
|---|---|
| Required actions | `schedule_reminder` |
| Side effect | write |
| Audit action | `reminder_scheduled` |

Input: `{ entidade_id?: string; quando: string /* ISO */; texto: string; canal?: 'whatsapp' }`.
Output: `{ reminder_id: string }`.

### 6.9 `send_proactive_message`

| Field | Value |
|---|---|
| Required actions | `send_proactive_message` |
| Side effect | communication |
| Audit action | `proactive_message_sent` |
| Critical | yes — always 4-eyes (Phase 1–2) |

Input: `{ pessoa_id_destino: string; texto: string; reason: string }`.
Output: `{ mensagem_id: string }`.

The tool is gated by `requiresDualApproval` returning true. Phase 1: never used directly; only invoked by approved workflows.

### 6.10 `compare_entities`

| Field | Value |
|---|---|
| Required actions | `read_reports` |
| Side effect | read |

Input: `{ entidade_ids: string[]; period: { from: string; to: string }; metrics: Array<'receita'|'despesa'|'lucro'|'caixa'> }`.
Output: `{ rows: Array<{ entidade_id; entidade_nome; receita; despesa; lucro; caixa_final }>; consolidado: { ... } }`.

Implementation: pure read across the union of `scope.entidades ∩ entidade_ids`. Permission filter trims to allowed entities.

### 6.11 `recall_memory`

| Field | Value |
|---|---|
| Required actions | `read_transactions` (or `read_balance`) |
| Side effect | read |

Input: `{ query: string; escopo?: string; tipos?: string[]; k?: number /* default 5 */ }`.
Output: `{ items: Array<{ conteudo: string; tipo: string; created_at: string; score: number; ref?: { tabela: string; id: string } }> }`.

Implementation: spec 08. Vector search filtered by `escopo`.

### 6.12 `save_fact`

| Field | Value |
|---|---|
| Required actions | `*` (any) — but the **fact** is scoped |
| Side effect | write |
| Audit action | `fact_saved` |

Input: `{ escopo: string /* 'global' | 'entidade:UUID' | 'pessoa:UUID' */; chave: string; valor: unknown; fonte: 'configurado'|'aprendido'|'inferido' }`.
Output: `{ fact_id: string }`.

UPSERTs into `agent_facts`. The LLM proposes facts; backend rejects if `escopo` violates the caller's permissions.

### 6.13 `save_rule`

| Field | Value |
|---|---|
| Required actions | implicit (called by reflection) |
| Side effect | write |
| Audit action | `rule_learned` |

Input: see `ReflectionRule` schema in spec 06 §7.1.
Output: `{ rule_id: string; status: 'probatoria' }`.

Cannot create `'firme'` rules directly — only via promotion (spec 09 §rule lifecycle) or owner command.

## 7. LLM Boundaries

The LLM may:

- Call any tool whose `required_actions` are satisfied by the interlocutor's profile.
- Read tool descriptions and input schemas as published in the prompt.

The LLM may not:

- Define new tools.
- Bypass the pre-execution pipeline.
- Modify input args after backend validation.
- See or reason about idempotency keys directly. The keys are computed by the backend.

## 8. Behavior & Rules

### 8.1 Tool descriptions in the prompt

Tool descriptions are constructed from the `description` and `input_schema` fields. Examples are baked in to reduce hallucination on first use. Descriptions are reviewed quarterly.

### 8.2 Tool errors as feedback

Every error is returned to the LLM as a `tool_result` block with `is_error: true` and a structured payload:

```typescript
type ToolError =
  | { kind: 'invalid_args'; details: ZodIssue[] }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'limit_exceeded'; required_action: 'single_sig'|'dual_approval' }
  | { kind: 'audit_mode_preview'; preview: object }
  | { kind: 'redis_unavailable_blocked'; allowed_alternatives: string[] }
  | { kind: 'duplicate_suspected'; existing: object }
  | { kind: 'execution_failed'; cause: string };
```

The LLM uses this to phrase a polite, accurate response.

### 8.3 Output validation

If `output_schema.parse(result)` fails, the tool is in a bug state. The error is captured, alerted, and the LLM is told `kind: 'execution_failed'` with a generic message. We do not return malformed output to the LLM.

## 9. Error cases

| Failure | Behavior |
|---|---|
| Tool handler throws unexpected exception | Captured; logged with full stack; LLM gets `execution_failed`; alert if rate > 1/min |
| Idempotency cache hit but persisted result is malformed | Treat as miss; re-execute; correct the cache |
| Backend cannot resolve `entidade_id` from args | LLM gets `invalid_args` with a clear message |

## 10. Acceptance criteria

- [ ] Every tool has unit tests covering: valid args (happy), missing required, forbidden by profile, limit exceeded, idempotency hit.
- [ ] Tool descriptions and input schemas are in sync with implementations (linted).
- [ ] No tool reads `process.env` (caught by lint).
- [ ] No tool issues SQL outside its declared repository (caught by review).
- [ ] LLM cannot invoke a tool absent from `getToolsForScope`.

## 11. References

- Spec 02 — repositories
- Spec 03 — profiles, action keys, dual approval triggers
- Spec 06 — agent loop and dispatcher
- Spec 09 — idempotency and audit mode
- Spec 11 — workflows (long-running)
