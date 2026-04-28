# Spec 05 — Identity Resolver & Onboarding

**Status:** MVP Core • **Phase:** 1 • **Depends on:** 00, 02, 03, 04

---

## 1. Purpose

Define how Maia answers three questions for every inbound message:

1. **Who is sending this?** (phone → `pessoa`)
2. **What is their scope?** (`pessoa` → entities + profile + status)
3. **Which conversation?** (find or create the `conversa` row)

This spec also owns the entire **onboarding flow**: the bootstrap wizard, the WhatsApp-driven addition of new people, the quarantine state, and duplicate-number detection.

## 2. Goals

- Resolve identity in O(1) via phone-number index.
- Reject unknown numbers cleanly without engaging the LLM.
- Quarantine every newly cadastrada pessoa until owner confirmation on first contact.
- Detect duplicate or recycled phone numbers before persisting.
- Provide both CLI and WhatsApp-driven onboarding flows.

## 3. Non-goals

- Identity providers, OAuth, or third-party verification.
- SMS-based two-factor authentication.
- Self-service person registration.

## 4. Architecture

### 4.1 Resolution path

```
WhatsAppInbound (from gateway)
       │
       ▼
[1] Lookup pessoas by telefone_whatsapp
       │
       ├── not found ──► UnknownPersonHandler (spec 04 §9)
       │
       └── found
             │
             ▼
[2] Check pessoas.status
       │
       ├── 'inativa' or 'bloqueada' ──► Silent drop + alert owners
       │
       ├── 'quarentena'              ──► QuarantineHandler (§6)
       │
       └── 'ativa'
             │
             ▼
[3] Recompute escopo_entidades from permissoes (status='ativa')
       │
       ▼
[4] Find or create conversas row for this pessoa with status='ativa'
       │
       ▼
[5] Update mensagens.conversa_id (filling the NULL from gateway)
       │
       ▼
Identity resolved → forward to agent worker
```

### 4.2 Conversation lifecycle

`conversas` is **per pessoa**, not per phone session. A pessoa has at most one conversa with `status='ativa'` at any time. New activity after `> 7d` of silence creates a new conversa (and the old one transitions to `'encerrada'` with `contexto_resumido` filled by a worker — see spec 12).

## 5. Resolution function — canonical signature

```typescript
type ResolvedIdentity = {
  pessoa: Pessoa;                    // from pessoas
  scope: {
    entidades: string[];             // UUIDs
    profile_by_entidade: Map<string, ProfilePermissions>;
  };
  conversa: Conversa;
  is_quarantined: boolean;
};

async function resolveIdentity(input: {
  telefone_whatsapp: string;
}): Promise<ResolvedIdentity | { kind: 'unknown' } | { kind: 'blocked'; reason: string }>;
```

Cache: identity resolution may be cached in Redis with key `identity:<phone>` and TTL 60s, invalidated by any change to `pessoas` or `permissoes` rows for that phone.

## 6. Quarantine handler

### 6.1 When it triggers

A pessoa has `pessoas.status = 'quarentena'` immediately after creation (CLI or WhatsApp flow). The status persists until the owner confirms identity on her first contact.

### 6.2 First-contact flow

```
[Joana sends first message]
   │
   ▼
Identity resolver finds pessoa Joana with status='quarentena'
   │
   ▼
Maia replies to Joana: "Oi! Antes de eu poder te atender, preciso confirmar com 
                        Mendes que é você mesmo. Aguenta 1 minutinho?"
   │
   ▼
Maia sends to owner (out-of-band conversation): 
   "Joana mandou primeira mensagem (+55 11 99999-9999). Confirma que é ela mesmo?
    [sim] [não, bloqueia]"
   │
   ▼
Owner: "sim"
   │
   ▼
Backend: UPDATE pessoas SET status='ativa' WHERE id=Joana
         INSERT audit_log acao='owner_confirmed_identity'
   │
   ▼
Maia replies to Joana with profile-specific welcome:
   "Oi Joana, sou a Maia, assistente do Mendes. Vou te ajudar com relatórios das 
    Empresas 1 e 3. Posso começar?"
```

If the owner says "não, bloqueia", the pessoa goes to `status='bloqueada'`, and Joana receives a polite generic message: "Não consigo te atender no momento."

### 6.3 Quarantine timeout

If the owner does not respond to the identity confirmation within **24 hours**, the pessoa stays `'quarentena'` and Joana receives: "Ainda aguardando confirmação. Tenta de novo mais tarde." A reminder is sent to the owner once per day.

## 7. Unknown-number handler

(Refer to spec 04 §9 for the gateway side; this section formalizes the handler.)

```
[Unknown number message]
  → mensagens row inserted with conversa_id=NULL
  → audit_log: 'unknown_number_message_received'
  → if same unknown number sends >5 messages in 1h:
       → still no reply (no escalation)
       → second alert to owner
  → owner can run CLI or WhatsApp command to onboard, or ignore
```

## 8. Duplicate-number detection

Before any `INSERT INTO pessoas`, `validatePhoneNumber(tel)` checks:

```typescript
async function validatePhoneNumber(tel: string): Promise<
  | { kind: 'ok' }
  | { kind: 'invalid_format' }
  | { kind: 'belongs_to_active_person'; pessoa: Pessoa }
  | { kind: 'belongs_to_revoked_person'; pessoa: Pessoa; revoked_at: Date }
  | { kind: 'is_owner_or_co_owner' }
> {
  if (!/^\+\d{10,15}$/.test(tel)) return { kind: 'invalid_format' };

  const existing = await pessoasRepo.findByPhone(tel);
  if (existing) {
    if (existing.tipo === 'dono' || existing.tipo === 'co_dono')
      return { kind: 'is_owner_or_co_owner' };
    if (existing.status === 'ativa' || existing.status === 'quarentena')
      return { kind: 'belongs_to_active_person', pessoa: existing };
    return {
      kind: 'belongs_to_revoked_person',
      pessoa: existing,
      revoked_at: existing.updated_at,
    };
  }
  return { kind: 'ok' };
}
```

Decision matrix for the caller:

| Result | Behavior |
|---|---|
| `ok` | Proceed |
| `invalid_format` | Reject with explanation |
| `belongs_to_active_person` | Hard block. "Esse número já é da Joana." |
| `belongs_to_revoked_person` | Warn + require 4-eyes. "Era da Joana (revogada em DD/MM). Continua?" |
| `is_owner_or_co_owner` | Hard block with strong message. |

## 9. Onboarding flows

### 9.1 Bootstrap wizard — `npm run setup`

A single interactive script (no separate `setup:owner`, `setup:entities`, etc.) that:

1. Verifies `.env` is present and valid.
2. Tests DB and Redis connectivity.
3. Asks: "Importar de arquivo? (inventario.md / entities.json / não)" — proceeds either way.
4. Creates the owner: `nome`, `telefone_whatsapp` (regex-checked), assigns `tipo='dono'`, status `'ativa'` directly (the owner does not go through quarantine).
5. Creates entities (PF + PJs) with names, documents, status.
6. Creates `permission_profiles` seed (idempotent).
7. Creates `permissoes` rows for owner: `dono_total` on every entity.
8. Optionally creates one or more `contas_bancarias` per entity.
9. Optionally cadastra co-owner (spouse) — same as owner but `tipo='co_dono'`. Goes to `'quarentena'` until first contact, like everyone else.
10. Prints a final summary and instructs to run `npm run dev`.

### 9.2 Import file shapes

`entities.json`:

```json
{
  "owner": {
    "nome": "Mendes",
    "telefone_whatsapp": "+5511999999999"
  },
  "co_owner": {
    "nome": "Joana",
    "telefone_whatsapp": "+5511988888888"
  },
  "entities": [
    { "nome": "Mendes (PF)", "tipo": "pf", "documento": "123.456.789-00", "cor": "#1E88E5" },
    { "nome": "Empresa 1",   "tipo": "pj", "documento": "12.345.678/0001-00" }
  ],
  "contas_bancarias": [
    { "entidade": "Mendes (PF)", "banco": "Inter", "apelido": "Inter PF",   "tipo": "cc" },
    { "entidade": "Empresa 1",   "banco": "Itaú",  "apelido": "Itaú E1",    "tipo": "cc" }
  ]
}
```

`inventario.md`: parsed using a deterministic markdown parser; tables for entities, contas, pessoas. Missing fields default to placeholders that the wizard prompts for.

### 9.3 Add-pessoa via WhatsApp (Option C)

Owner sends a natural-language request. The flow is the one described in spec 03 §13.1 and re-iterated here for completeness:

1. LLM emits `ChangePermissionIntent` with `pessoa_target.kind = 'new'`.
2. Backend runs `validatePhoneNumber(tel)`.
3. On `ok`, render preview, send to owner.
4. Owner confirms → backend creates `pending_questions` for **dual approval** (since `change_permission` is critical).
5. Co-owner approves → backend creates pessoa with `status='quarentena'` and the `permissoes` rows with `status='ativa'`.
6. When the new person sends her first message, quarantine handler runs.

### 9.4 Add-pessoa via CLI

```bash
npm run pessoa:add -- \
  --nome="Joana" \
  --telefone="+55 11 99999-9999" \
  --profile=contador_leitura \
  --entidades=E1,E3 \
  --limite=0
```

Same backend path but **bypasses the WhatsApp confirmation by the owner** — the CLI proves possession of the VPS, treated as owner-level. **Still requires 4-eyes** when the action is `change_permission`. The CLI prints a code that the co-owner approves via WhatsApp:

```
Created dual-approval request DA-71fa4. Co-owner must reply 'aprova DA-71fa4' to Maia.
```

## 10. LLM Boundaries

The LLM may:

- Read identity context (pessoa name, profile id, scope) for prompt building.
- Emit a `ChangePermissionIntent` for new pessoa cadastro.

The LLM may not:

- Look up pessoas by phone directly.
- Set `pessoas.status`. Only the backend transitions status.
- Issue identity confirmations to owner. Backend formulates the deterministic confirmation message; LLM does not paraphrase.

## 11. Behavior & Rules

### 11.1 Phone normalization

All phone storage and comparison uses E.164 (`+5511999999999`). Inputs from CLI and WhatsApp commands are normalized via:

```typescript
function normalizePhone(input: string): string {
  const stripped = input.replace(/[^\d+]/g, '');
  if (!stripped.startsWith('+')) {
    if (stripped.startsWith('55')) return `+${stripped}`;
    return `+55${stripped}`;
  }
  return stripped;
}
```

Validation against E.164 happens after normalization.

### 11.2 Conversation reuse

If the resolved pessoa already has an active conversation, reuse it. If the most recent message is older than 7 days, close that one (`status='encerrada'`) and create a new conversa. The 7-day cutoff is configurable.

### 11.3 Scope refresh on conversation start

`conversas.escopo_entidades` is recomputed at conversation start (spec 02 §8.1). Mid-conversation permission changes (e.g., owner suspends Joana's access to E3 during the chat) take effect on the **next** message — Maia does not retroactively forget what was already shown.

### 11.4 Bot detection (basic)

If a number sends > 50 messages in 1 minute (well above the rate limit), automatic action:

- Set `pessoas.status='bloqueada'`.
- Audit log `acao='auto_blocked_anomalous_volume'`.
- Alert owner.

The owner can manually reinstate.

## 12. Error cases

| Failure | Behavior |
|---|---|
| Phone in DB exists with multiple owners (data corruption) | Throw `IdentityCorruption`; halt; alert |
| Conversation creation race (two messages arrive simultaneously) | Use INSERT ... ON CONFLICT to ensure single row |
| Quarantine confirmation fails to deliver to owner | Retry once; then DLQ; pessoa stays in quarantine |
| Wizard run twice | All inserts are idempotent (UNIQUE constraints); existing rows are reported, not overwritten |

## 13. Acceptance criteria

- [ ] `resolveIdentity` returns in < 50ms p95 (single phone lookup + scope recompute).
- [ ] First message from a quarantined pessoa never reaches the agent loop.
- [ ] Owner sees confirmation prompt within 5s of new pessoa's first message.
- [ ] CLI and WhatsApp paths produce identical row state when used to onboard the same person.
- [ ] Duplicate-number detection blocks all five matrix cases correctly.

## 14. References

- Spec 02 — `pessoas`, `permissoes`, `conversas`
- Spec 03 — profiles, dual approval triggers
- Spec 04 — gateway, group/unknown handling
- Spec 11 — workflows (dual_approval flow)
- Spec 12 — proactive workers (conversation summarization on close)
