# Spec 09 — Governance: Rules, Limits, Audit, Idempotency, Lockdown

**Status:** MVP Core • **Phase:** 1 • **Depends on:** 00, 02, 03, 06, 07, 11

---

## 1. Purpose

Governance is the ensemble of rules that prevent Maia from doing the wrong thing, even when the LLM "thinks" it's fine. This spec consolidates: constitutional hard rules, the dual-approval (4-eyes) mechanism, audit mode (dry-run preview), the emergency lockdown, idempotency, the rule-learning lifecycle, and audit logging.

## 2. Goals

- Hard, deterministic rules that the LLM cannot override.
- Dual approval for any critical action.
- Audit mode (sticky 24h) for previewing every side effect before execution.
- Emergency lockdown reachable in one command, undoable with 4-eyes.
- Idempotency at the tool layer with a stable, content-addressed key.
- Comprehensive audit log with a closed taxonomy.

## 3. Non-goals

- LGPD compliance frameworks. Personal use, scope-out per discussion.
- Anti-fraud machine learning. Heuristic rules only.

## 4. Constitutional rules — the hard "thou shalt nots"

Encoded in `governance/rules.ts`. These run **after** the tool's profile/limit checks and **before** execution. Each rule may abort the tool call with a typed reason.

```typescript
const CONSTITUTIONAL_RULES: ReadonlyArray<Rule> = [
  // 1. No transaction above the hard limit, regardless of approver.
  {
    id: 'C-001',
    applies_to: ['register_transaction', 'correct_transaction'],
    check: (intent, ctx) => intent.args.valor <= config.VALOR_LIMITE_DURO,
    on_fail: { kind: 'forbidden', reason: 'Acima do limite duro do sistema' },
  },
  // 2. No deletion of transactions; only cancellation.
  {
    id: 'C-002',
    applies_to: ['delete_transaction'],   // tool does not exist by design
    check: () => false,
    on_fail: { kind: 'forbidden', reason: 'Transações são canceladas, nunca deletadas' },
  },
  // 3. No proactive message without dual approval (Phase 1–2).
  {
    id: 'C-003',
    applies_to: ['send_proactive_message'],
    check: (intent, ctx) => ctx.dual_approval_granted === true,
    on_fail: { kind: 'limit_exceeded', required_action: 'dual_approval' },
  },
  // 4. No cross-entity data leak.
  {
    id: 'C-004',
    applies_to: ['*'],
    check: (intent, ctx) => intentEntities(intent).every(e => ctx.scope.entidades.includes(e)),
    on_fail: { kind: 'forbidden', reason: 'Acesso fora do escopo' },
  },
  // 5. No autonomous decision in 'estratégica' actions.
  {
    id: 'C-005',
    applies_to: ['create_transaction'],
    check: (intent, ctx) => intent.args.metadata?.tipo !== 'investimento_estratégico',
    on_fail: { kind: 'forbidden', reason: 'Decisões estratégicas exigem confirmação humana explícita' },
  },
];
```

Constitutional rules cannot be bypassed by anyone, including the owner with 4-eyes. Modifying the list requires a code change reviewed by the owner.

## 5. Dual approval (4-eyes)

### 5.1 Triggers

Reproduced from spec 03 §6 for clarity:

```typescript
function requiresDualApproval(intent: Intent, ctx: ToolContext): boolean {
  if (CRITICAL_ACTIONS.find(c => c.action === intent.tool && c.condition(intent, ctx))) return true;
  if (intent.tool === 'register_transaction' && intent.args.valor > config.VALOR_DUAL_APPROVAL) return true;
  return false;
}
```

### 5.2 Workflow

When `requiresDualApproval` returns true, the tool dispatcher does **not** execute. Instead:

1. Create `workflows` row with `tipo='dual_approval'`, `status='aguardando_terceiro'`.
2. Create `workflow_steps` snapshot of the intended action.
3. Create `pending_questions` row addressed to the **first** approver (the requester) summarizing the intent.
4. On first approver's `'sim'`: update workflow with first signature; create a second `pending_questions` for any other `dono`/`co_dono`.
5. On second approver's `'sim'`: backend calls the tool with the original args, marking `ctx.dual_approval_granted = true` and `ctx.dual_approval_id = workflow.id`.
6. On any `'não'` or timeout (`DUAL_APPROVAL_TIMEOUT_HOURS`, default 6): workflow → `'cancelado'`, both approvers notified.

### 5.3 Approver rules

- Approvers must be `pessoas.tipo IN ('dono','co_dono')`.
- The same person cannot count as both signatures (UNIQUE on `(workflow_id, approver_pessoa_id)`).
- The owner is **not** automatically the first approver; the requester is.
- A `co_dono` requesting an action still needs a second `dono` or `co_dono`.
- An owner-initiated `emergency_lockdown` is single-sig (more restrictive); the corresponding `unlock` is dual.

### 5.4 Audit trail

Each workflow writes events:

- `dual_approval_requested`
- `dual_approval_granted` (per approver)
- `dual_approval_executed` or `dual_approval_denied` or `dual_approval_timeout`

## 6. Audit mode (dry-run)

### 6.1 Activation

```
"Maia, ativa modo auditoria"  → preferencias.modo_auditoria_ate = now() + 24h
"Maia, desativa modo auditoria"
"Maia, ativa modo auditoria pra Joana por 1 semana"  (owner only)
```

Persistence: `pessoas.preferencias.modo_auditoria_ate` (TIMESTAMPTZ).

### 6.2 Behavior

When `audit_mode_active` is true for the calling pessoa, every tool with `side_effect != 'read'` returns a **preview** rather than executing. The preview is rendered by the backend deterministically; the LLM presents it.

Preview shape:

```typescript
type Preview = {
  tool: string;
  operation_type: string;
  fields: Array<{ key: string; before?: unknown; after: unknown }>;
  side_effects_summary: string[];
  idempotency_key: string;        // surfaced so user knows confirmation is keyed
};
```

User confirms with "sim" → backend executes the same intent (same key) → behaves like an idempotent retry.

### 6.3 Auto-expire

A nightly worker scans `pessoas.preferencias.modo_auditoria_ate`; expired rows have the field cleared and an audit event `audit_mode_deactivated_auto` is written.

## 7. Emergency lockdown

### 7.1 Activation (single-sig)

```
"Maia, trava todos os acessos externos"
```

Effect, atomic:

1. Snapshot affected `permissoes.status` into `entity_states.flags.lockdown_snapshot`.
2. `UPDATE permissoes SET status='suspensa' WHERE pessoa_id IN (SELECT id FROM pessoas WHERE tipo NOT IN ('dono','co_dono'))`.
3. Notify `dono` and `co_dono` via Telegram.
4. Audit log `emergency_lockdown_activated` with actor, timestamp, count of suspended permissions.

### 7.2 Lift (dual-sig)

```
"Maia, destrava acessos externos"
```

Triggers a `dual_approval` workflow. On both signatures, restore from snapshot:

```sql
UPDATE permissoes p
SET status = s.status_before
FROM unnest($snapshot::text[]) WITH ORDINALITY AS s(status_before, idx)
WHERE p.id = ($snapshot_ids)[s.idx];
```

Audit `emergency_lockdown_lifted`.

### 7.3 Behavior during lockdown

`canAct()` returns false for all suspended permissions. Affected pessoas receive a polite generic reply on any incoming message:

```
"Manutenção temporária. Volto a operar logo. — Maia"
```

(no leak about the lockdown itself.)

## 8. Idempotency (the algorithm)

### 8.1 Layer 1 — Message dedup (gateway)

Per spec 04 §6.2: by `whatsapp_id` in Redis cache + `mensagens` table. Hit → drop, audit `duplicate_message_dropped`.

### 8.2 Layer 2 — Tool idempotency keys

Per spec 07 §5. Key formula:

**Textual operations:**
```
sha256( pessoa_id | entity_id | tool_name | operation_type | normalized_payload_hash | bucket_5min(timestamp) )
```

**Attachment-based operations (no time bucket):**
```
sha256( pessoa_id | entity_id | tool_name | operation_type | file_sha256 )
```

`normalized_payload_hash` rules:

```typescript
function canonicalize(o: object): object {
  const sorted = Object.fromEntries(Object.entries(o).sort(([a],[b]) => a.localeCompare(b)));
  // recurse on nested objects
  // for known financial fields:
  if ('valor' in sorted) sorted.valor = Math.round(Number(sorted.valor) * 100); // cents
  if ('data_competencia' in sorted) sorted.data_competencia = isoDate(sorted.data_competencia);
  if ('descricao' in sorted) sorted.descricao = stripDiacritics(String(sorted.descricao).trim().toLowerCase());
  return sorted;
}
```

### 8.3 Layer 3 — Semantic dedup

Before creating a transaction, check `transacoes` for matches in last 2 hours by:

```
same pessoa registrante (registrado_por)
AND same entidade_id
AND same valor
AND descricao similarity (trigram) > 0.85
```

If hit, the tool returns `{ kind: 'duplicate_suspected', existing }`. The LLM asks the user to confirm intent.

### 8.4 Retention

`idempotency_keys` rows kept 30 days. Nightly cleanup job:

```sql
DELETE FROM idempotency_keys WHERE created_at < now() - interval '30 days';
```

## 9. Rule-learning lifecycle (procedural memory)

Reproduced from spec 08 §8 with governance-layer responsibilities:

| Event | Effect on `learned_rules` |
|---|---|
| Reflection trigger A or B creates rule | `INSERT` with `confianca=0.50, status='probatoria', ativa=true` |
| Probationary rule applied successfully (no correction within 30 min) | `acertos++`, `confianca += 0.10` |
| Probationary rule applied and corrected | `erros++`, `confianca -= 0.20`; if `erros >= 2`, demote |
| Promotion triggers met (4 acertos seguidos OR 10 days since creation, no errors) | `status='ativa_firme'`, `confianca = max(confianca, 0.80)` |
| Owner: "marca como firme" | `status='ativa_firme'`, `confianca=1.00` |
| Owner: "desativa pra sempre" | `status='banida'`, `ativa=false` |
| Owner: "esquece o que aprendeu hoje" | All rules with `created_at >= today` → `status='desativada'` |

### 9.1 Conflict resolution

Two rules may match the same descricao. Selection order:

1. `ativa_firme` over `probatoria`.
2. Higher `confianca`.
3. Newer `updated_at`.

When a probationary rule is applied, the LLM announces it (spec 08 §12.2). When firm, silent.

## 10. Rate limits & cooldowns

Per spec 03 §9. Implementation:

```typescript
async function rateCheck(pessoa_id: string, kind: 'message' | 'tool_error'): Promise<RateResult> {
  const key = `rate:${pessoa_id}:${kind}:${currentHour()}`;
  const count = await redis.incr(key);
  await redis.expire(key, 3600);
  if (kind === 'message' && count > config.RATE_LIMIT_MSGS_PER_HOUR) {
    return { allowed: false, reason: 'rate_exceeded' };
  }
  return { allowed: true };
}
```

Cooldown after errors: distinct key with TTL 5 min. While cooldown active, `tool_call` returns a polite error.

## 11. Anomaly detection (heuristic, Phase 1)

Workers (spec 12) scan recent activity:

| Pattern | Threshold | Action |
|---|---|---|
| User asked about entity outside scope | 1+ event | audit `unauthorized_access_attempt`; alert owner |
| Person making >5 tool errors in 1h | yes | audit `excessive_errors`; cooldown |
| Sudden burst of identical-amount transactions | 3 in 10 min | flag for owner review |
| Large transfer > 24h after a permission change for the actor | yes | review flag |

ML-based detection is out of scope.

## 12. Audit log — taxonomy

`audit_log.acao` values are constrained to a closed list defined in `governance/audit-actions.ts`. Insertion paths use a typed helper:

```typescript
async function audit(params: {
  acao: AuditAction;
  pessoa_id?: string;
  entidade_alvo?: string;
  alvo_id?: string;
  conversa_id?: string;
  mensagem_id?: string;
  diff?: { before?: unknown; after?: unknown };
  metadata?: Record<string, unknown>;
}): Promise<void>;
```

Full taxonomy in spec 17 §audit-actions. Examples used here: `transaction_created`, `permission_changed`, `dual_approval_*`, `audit_mode_*`, `emergency_lockdown_*`, `rule_learned`, `rule_promoted`, `rule_demoted`, `rule_banned`, `unauthorized_access_attempt`, `unknown_number_message_received`.

## 13. LLM Boundaries

The LLM may:

- Ask whether a proposed action requires dual approval (informational).
- Detect signals that a user is correcting a prior action and propose a `learned_rule`.
- Surface previews to the user when in audit mode.

The LLM may not:

- Bypass any constitutional rule (the backend re-checks regardless of LLM output).
- Decide that an action does not need dual approval. The backend decides.
- Activate or deactivate audit mode for itself or others. Owner commands only.
- Lift a lockdown. Owner commands only, with 4-eyes.

## 14. Behavior & Rules

### 14.1 Order of checks per tool call

```
profile.acoes ⊇ tool.required_actions     → 'forbidden'
constitutional rules                       → 'forbidden' (per rule)
limits per pessoa                          → 'limit_exceeded' (single-sig)
requiresDualApproval                       → 'limit_exceeded' (dual approval)
audit_mode_active                          → preview, no execution
idempotency key hit                        → cached result
constitutional rule (last gate)            → 'forbidden'
execute
```

The constitutional rules are checked **twice** intentionally — once early (for clarity to the LLM) and once just before execution (defense in depth).

### 14.2 Backend always wins

If at any point the LLM produces output inconsistent with backend state (e.g., claims it executed something the backend did not), the backend reply overrides. The LLM is the messenger, not the source of truth.

## 15. Error cases

| Failure | Behavior |
|---|---|
| Audit mode TTL passed mid-turn | Treat as inactive; subsequent confirmations execute live |
| Lockdown active and owner messages an external person via `send_proactive_message` | Blocked by C-003 + lockdown; only direct internal messages between owners pass |
| Dual approval timeout | Cancel; notify; user can retry from scratch |
| Constitutional rule check throws | Treat as `'forbidden'` for safety; alert |

## 16. Acceptance criteria

- [ ] Constitutional rule C-004 prevents reading transactions of an entity outside scope (verified by leak test, spec 16).
- [ ] Dual approval workflow completes happy path in < 30s with two `'sim'` replies.
- [ ] Dual approval timeout fires after `DUAL_APPROVAL_TIMEOUT_HOURS` precisely.
- [ ] Audit mode preview matches the executed result byte-for-byte after confirmation.
- [ ] Lockdown activation suspends all non-owner permissions atomically.
- [ ] Lockdown lift restores prior `permissoes.status` exactly (snapshot test).
- [ ] Probationary rule promotes after 4 acertos seguidos.

## 17. References

- Spec 03 — closed profiles, action keys
- Spec 06 — agent loop integration
- Spec 07 — tool dispatcher pipeline
- Spec 08 — rule lifecycle and self-state
- Spec 11 — workflows (dual_approval implementation)
- Spec 17 — audit taxonomy and observability
