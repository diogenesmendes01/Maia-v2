# Maia v2 — P2 Memory Scoping + Self-Model — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir memória escopada por **integridade contextual** (6 controles: memory_type/scope_type/sensitivity/proactive_use/mention_allowed/ttl_days + needs_review) e self-model com confidence determinística (fórmula sobre evidência, nunca LLM). Conecta com P1: candidates de tipo `lacuna` consumidos em `agent_capability_gaps`; `fato` classificados via memory_classifier antes de virar `memory_entry`.

**Architecture:** 4 tabelas novas (`memory_entry`, `behavioral_hint`, `agent_capabilities_domain`, `agent_capabilities_skill`, `agent_capability_gaps`), migration conservadora de `agent_facts` legado pra `memory_entry` com `needs_review=true` (bloqueia uso no prompt). Memory classifier roteia fato em runtime; behavioral_hint deriva de memória sensível e é único derivado que entra no prompt. Self-model atualizado por reflection events (P1).

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, vitest, Anthropic SDK (Haiku para classifier; Sonnet para reflector).

**Reference:** Spec — [docs/superpowers/specs/2026-05-11-maia-v2-cognitive-architecture-design.md](../specs/2026-05-11-maia-v2-cognitive-architecture-design.md) §4.7 (memory), §4.2 (self-model), §9 P2 (acceptance gates).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `migrations/014_p2_memory_entry.sql` (+ down) | Create | `memory_entry` table com 6 controls + needs_review |
| `migrations/015_p2_behavioral_hint.sql` (+ down) | Create | `behavioral_hint` derivado de memórias sensíveis |
| `migrations/016_p2_self_model.sql` (+ down) | Create | `agent_capabilities_domain`, `agent_capabilities_skill`, `agent_capability_gaps` |
| `migrations/017_p2_migrate_legacy_facts.sql` (+ down) | Create | Migra `agent_facts` → `memory_entry` com `needs_review=true` |
| `src/db/schema.ts` | Modify | Adicionar 5 tabelas novas + types |
| `src/db/repositories.ts` | Modify | `memoryEntryRepo`, `behavioralHintRepo`, `capabilitiesRepo`, `capabilityGapsRepo` |
| `src/cognition/memory-classifier.ts` | Create | Tipa fato em operational/preference/personal/sensitive + 6 controls |
| `src/cognition/behavioral-hint-deriver.ts` | Create | Deriva hint de memória sensível (sem revelar conteúdo) |
| `src/cognition/self-model.ts` | Create | Cálculo determinístico de confidence + update on outcome |
| `src/cognition/persister.ts` | Modify | Estender pra: fato → memory_classifier → memory_entry; lacuna → agent_capability_gaps |
| `src/agent/prompt-builder.ts` | Modify | Injetar memória respeitando visibility + self-awareness |
| `src/workers/legacy-memory-reclassifier.ts` | Create | Processa `memory_entry` com `needs_review=true` |
| `src/workers/confidence-recompute.ts` | Create | Recalcula confidence periodicamente |
| `src/workers/behavioral-hint-validator.ts` | Create | LLM-as-judge: hint não revela conteúdo bruto |
| `src/workers/index.ts` | Modify | Registrar novos workers |
| `tests/unit/memory-classifier.spec.ts` | Create | Testa classificação de fato em 4 memory_types |
| `tests/unit/self-model.spec.ts` | Create | Testa fórmula determinística de confidence |
| `tests/unit/behavioral-hint-deriver.spec.ts` | Create | Testa derivação sem vazamento |
| `tests/integration/p2-memory-scoping.spec.ts` | Create | Cenário: sensível não verbaliza; influência indireta via hint |
| `tests/integration/p2-self-model.spec.ts` | Create | Cenário: capability cresce com sucessos, decresce com falhas |
| `scripts/p2-acceptance-gates.sh` | Create | Bateria de gates |
| `docs/runbooks/p2-memory-self-model.md` | Create | Runbook operacional |

---

## Task 1: Migration `memory_entry` table

**Files:** `migrations/014_p2_memory_entry.sql` + down, `src/db/schema.ts`

- [ ] **Step 1: Migration UP**

```sql
-- P2: memory_entry table com 6 controles + needs_review
CREATE TABLE memory_entry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  interlocutor_id UUID,
  conversa_id UUID,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL CHECK (
    memory_type IN ('operational', 'preference', 'personal', 'sensitive', 'unknown')
  ),
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('conversation', 'interlocutor', 'channel', 'role', 'agent', 'tenant')
  ),
  subject_id TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'low' CHECK (
    sensitivity IN ('low', 'medium', 'high')
  ),
  proactive_use BOOLEAN NOT NULL DEFAULT false,
  mention_allowed BOOLEAN NOT NULL DEFAULT false,
  ttl_days INTEGER,
  needs_review BOOLEAN NOT NULL DEFAULT false,
  source_event_id UUID,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX memory_entry_tenant_agent_idx ON memory_entry(tenant_id, agent_id, created_at DESC);
CREATE INDEX memory_entry_interlocutor_idx ON memory_entry(interlocutor_id) WHERE interlocutor_id IS NOT NULL;
CREATE INDEX memory_entry_scope_idx ON memory_entry(scope_type, subject_id);
CREATE INDEX memory_entry_needs_review_idx ON memory_entry(needs_review) WHERE needs_review = true;
CREATE INDEX memory_entry_expires_idx ON memory_entry(expires_at) WHERE expires_at IS NOT NULL;
```

- [ ] **Step 2: Migration DOWN**

```sql
DROP TABLE IF EXISTS memory_entry CASCADE;
```

- [ ] **Step 3: Drizzle schema entry**

```typescript
export const memory_entry = pgTable(
  'memory_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    interlocutor_id: uuid('interlocutor_id'),
    conversa_id: uuid('conversa_id'),
    content: text('content').notNull(),
    memory_type: text('memory_type').notNull(),
    scope_type: text('scope_type').notNull(),
    subject_id: text('subject_id'),
    sensitivity: text('sensitivity').notNull().default('low'),
    proactive_use: boolean('proactive_use').notNull().default(false),
    mention_allowed: boolean('mention_allowed').notNull().default(false),
    ttl_days: integer('ttl_days'),
    needs_review: boolean('needs_review').notNull().default(false),
    source_event_id: uuid('source_event_id'),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentIdx: index('memory_entry_tenant_agent_idx').on(t.tenant_id, t.agent_id, t.created_at),
    interlocutorIdx: index('memory_entry_interlocutor_idx').on(t.interlocutor_id),
    scopeIdx: index('memory_entry_scope_idx').on(t.scope_type, t.subject_id),
    needsReviewIdx: index('memory_entry_needs_review_idx').on(t.needs_review),
    expiresIdx: index('memory_entry_expires_idx').on(t.expires_at),
  }),
);
export type MemoryEntry = typeof memory_entry.$inferSelect;
```

- [ ] **Step 4: tsc + commit**

```bash
npx tsc --noEmit
git add migrations/014_p2_memory_entry.sql migrations/014_p2_memory_entry_down.sql src/db/schema.ts
git commit -m "feat(p2): memory_entry table com 6 controls + needs_review"
```

---

## Task 2: Migration `behavioral_hint` table

**Files:** `migrations/015_p2_behavioral_hint.sql` + down, `src/db/schema.ts`

- [ ] **Step 1: Migration UP**

```sql
-- P2: behavioral_hint derivado de memórias sensíveis (único que entra no prompt)
CREATE TABLE behavioral_hint (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  scope_type TEXT NOT NULL CHECK (
    scope_type IN ('conversation', 'interlocutor', 'channel', 'role', 'agent', 'tenant')
  ),
  subject_id TEXT,
  hint_text TEXT NOT NULL,
  derived_from_memory_id UUID REFERENCES memory_entry(id) ON DELETE SET NULL,
  derived_sensitivity TEXT NOT NULL CHECK (
    derived_sensitivity IN ('low', 'medium', 'high')
  ),
  ttl_days INTEGER,
  extension_reason TEXT,
  extension_approved_by TEXT,
  extension_approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX behavioral_hint_tenant_scope_idx ON behavioral_hint(tenant_id, agent_id, scope_type, subject_id);
CREATE INDEX behavioral_hint_active_idx ON behavioral_hint(revoked_at, expires_at);
```

- [ ] **Step 2: Migration DOWN**

```sql
DROP TABLE IF EXISTS behavioral_hint CASCADE;
```

- [ ] **Step 3: Drizzle schema entry**

```typescript
export const behavioral_hint = pgTable(
  'behavioral_hint',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    scope_type: text('scope_type').notNull(),
    subject_id: text('subject_id'),
    hint_text: text('hint_text').notNull(),
    derived_from_memory_id: uuid('derived_from_memory_id'),
    derived_sensitivity: text('derived_sensitivity').notNull(),
    ttl_days: integer('ttl_days'),
    extension_reason: text('extension_reason'),
    extension_approved_by: text('extension_approved_by'),
    extension_approved_at: timestamp('extension_approved_at', { withTimezone: true }),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantScopeIdx: index('behavioral_hint_tenant_scope_idx').on(t.tenant_id, t.agent_id, t.scope_type, t.subject_id),
    activeIdx: index('behavioral_hint_active_idx').on(t.revoked_at, t.expires_at),
  }),
);
export type BehavioralHint = typeof behavioral_hint.$inferSelect;
```

- [ ] **Step 4: Commit**

```bash
npx tsc --noEmit
git add migrations/015_p2_behavioral_hint.sql migrations/015_p2_behavioral_hint_down.sql src/db/schema.ts
git commit -m "feat(p2): behavioral_hint table (derivado seguro de memórias sensíveis)"
```

---

## Task 3: Migration self-model tables (3 tabelas)

**Files:** `migrations/016_p2_self_model.sql` + down, `src/db/schema.ts`

- [ ] **Step 1: Migration UP**

```sql
-- P2: self-model — capabilities por domínio/skill + gaps

CREATE TABLE agent_capabilities_domain (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  domain TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success TIMESTAMPTZ,
  last_failure TIMESTAMPTZ,
  failure_modes JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, domain)
);

CREATE TABLE agent_capabilities_skill (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  domain TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_success TIMESTAMPTZ,
  last_failure TIMESTAMPTZ,
  failure_modes JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, domain, skill_name)
);

CREATE TABLE agent_capability_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  capability_description TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('tool', 'knowledge', 'procedure')),
  contexto TEXT,
  frequency_score INTEGER NOT NULL DEFAULT 1,
  severity_score INTEGER NOT NULL DEFAULT 1,
  current_level TEXT NOT NULL DEFAULT 'silent' CHECK (
    current_level IN ('silent', 'dashboard', 'mentionable', 'proposed')
  ),
  source_candidate_id UUID,
  last_observed TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_level_change_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX caps_domain_idx ON agent_capabilities_domain(tenant_id, agent_id, domain);
CREATE INDEX caps_skill_idx ON agent_capabilities_skill(tenant_id, agent_id, domain, skill_name);
CREATE INDEX caps_gaps_level_idx ON agent_capability_gaps(tenant_id, agent_id, current_level);
```

- [ ] **Step 2: Migration DOWN**

```sql
DROP TABLE IF EXISTS agent_capability_gaps CASCADE;
DROP TABLE IF EXISTS agent_capabilities_skill CASCADE;
DROP TABLE IF EXISTS agent_capabilities_domain CASCADE;
```

- [ ] **Step 3: Drizzle schema (3 tables, types)**

Add `agent_capabilities_domain`, `agent_capabilities_skill`, `agent_capability_gaps` em `src/db/schema.ts` seguindo padrão. Adicionar types: `AgentCapabilityDomain`, `AgentCapabilitySkill`, `AgentCapabilityGap`.

- [ ] **Step 4: tsc + commit**

```bash
npx tsc --noEmit
git add migrations/016_p2_self_model.sql migrations/016_p2_self_model_down.sql src/db/schema.ts
git commit -m "feat(p2): self-model tables (capabilities domain+skill + gaps)"
```

---

## Task 4: Migration legacy `agent_facts` → `memory_entry`

**Files:** `migrations/017_p2_migrate_legacy_facts.sql` + down

- [ ] **Step 1: Migration UP — conservadora (needs_review=true)**

```sql
-- P2: migra agent_facts legados pra memory_entry com needs_review=true
-- Migration CONSERVADORA: tudo nasce como 'unknown' + needs_review=true, BLOQUEIA uso no prompt
-- até classifier reprocessar e classificar.

INSERT INTO memory_entry (
  tenant_id, agent_id, interlocutor_id, content, memory_type, scope_type,
  subject_id, sensitivity, proactive_use, mention_allowed, needs_review, created_at
)
SELECT 
  af.tenant_id,
  af.agent_id,
  NULL,  -- interlocutor_id desconhecido em legacy
  CONCAT(af.chave, ': ', af.valor::text) AS content,
  'unknown' AS memory_type,
  CASE af.escopo
    WHEN 'global' THEN 'agent'
    WHEN 'role' THEN 'role'
    WHEN 'conversation' THEN 'conversation'
    ELSE 'agent'
  END AS scope_type,
  af.escopo AS subject_id,
  'medium' AS sensitivity,  -- conservador: medium até classifier verificar
  false AS proactive_use,    -- bloqueado até classifier
  false AS mention_allowed,  -- bloqueado até classifier
  true AS needs_review,
  af.created_at
FROM agent_facts af;
```

- [ ] **Step 2: Migration DOWN — vazio (não dá pra reverter sem perder info)**

```sql
-- Backfill é UPDATE/INSERT de NULL→default. Não dá pra reverter sem perder informação.
-- Em prática: drop de memory_entry (migration 014) torna esse rollback irrelevante.
SELECT 'no-op: migration de agent_facts legados pra memory_entry é irreversível por design' AS note;
```

- [ ] **Step 3: Commit (sem aplicar DB — será aplicado em batch pelo usuário)**

```bash
git add migrations/017_p2_migrate_legacy_facts.sql migrations/017_p2_migrate_legacy_facts_down.sql
git commit -m "feat(p2): migra agent_facts legados pra memory_entry (needs_review=true)"
```

---

## Task 5: Repos novos

**Files:** `src/db/repositories.ts` (modify)

Adicionar `memoryEntryRepo`, `behavioralHintRepo`, `capabilitiesDomainRepo`, `capabilitiesSkillRepo`, `capabilityGapsRepo`. Cada repo segue padrão dos existentes — `applyTenantGuard` em writes, `getCurrentTenant/Agent` em reads.

### memoryEntryRepo

- `create(input)` — insert com tenant_guard
- `findRelevant({ interlocutor_id, role_id, conversa_id, currentMessage })` — retorna memórias relevantes filtrando por scope_type/subject_id + needs_review=false + não expired
- `markReviewed(id, updates)` — atualiza memory_type/visibility após classifier processar
- `expireOldEntries()` — soft-expire baseado em ttl_days

### behavioralHintRepo

- `create(input)` — após behavioral_hint_validator aprovar
- `findActiveForScope({ scope_type, subject_id })` — retorna hints ativos (não revoked, não expired)
- `revoke(id, reason)`

### capabilitiesDomainRepo + capabilitiesSkillRepo

- `findByDomain(domain)`, `findBySkill(domain, skill_name)`
- `recordSuccess({ domain, skill_name? })` — incrementa success_count + atualiza last_success
- `recordFailure({ domain, skill_name?, failure_mode })` — incrementa failure_count + last_failure + push failure_mode
- `recomputeConfidence(domain, skill_name?)` — aplica fórmula determinística

### capabilityGapsRepo

- `upsert(input)` — se gap similar existe, incrementa frequency_score; senão cria
- `escalateLevel(id, new_level)` — atualiza current_level + last_level_change_at

**Steps:**

- [ ] Implementar 5 repos
- [ ] tsc clean
- [ ] Commit: `feat(p2): repos pra memory_entry, behavioral_hint, capabilities, capability_gaps`

---

## Task 6: Memory classifier

**Files:** `src/cognition/memory-classifier.ts` (create), `tests/unit/memory-classifier.spec.ts` (create — TDD)

Classifica conteúdo de fato em `memory_type` + sugere os 6 controles (scope_type, sensitivity, proactive_use, mention_allowed, ttl_days).

Defaults por type (do spec §4.7):
- operational: scope=agent, sensitivity=low, proactive=true, mention=true, ttl=null
- preference: scope=interlocutor (default), sensitivity=low, proactive=true, mention=true, ttl=null
- personal: scope=role, sensitivity=medium, proactive=false, mention=false, ttl=30
- sensitive: scope=conversation, sensitivity=high, proactive=false, mention=false, ttl=7

LLM call (Haiku, temperatura 0): recebe content, retorna JSON com {memory_type, scope_type, sensitivity, ttl_days}. Engine aplica defaults restantes (proactive_use, mention_allowed).

### Tests (TDD)

```typescript
describe('classifyMemory', () => {
  it('CNPJ → operational', async () => { ... });
  it('"prefere matutino" → preference', async () => { ... });
  it('"comentou divórcio" → personal com mention_allowed=false', async () => { ... });
  it('"filha doente" → sensitive com mention_allowed=false', async () => { ... });
  it('conservadora: na dúvida, classifica como personal+restricted', async () => { ... });
});
```

- [ ] Tests → fail → implement → pass → commit
- [ ] `feat(p2): memory-classifier (tipa fato em 4 memory_types + 6 controls)`

---

## Task 7: Behavioral hint deriver

**Files:** `src/cognition/behavioral-hint-deriver.ts` (create), `tests/unit/behavioral-hint-deriver.spec.ts` (create — TDD)

Recebe `memory_entry` com `memory_type='sensitive'`, gera `hint_text` que **NÃO revela conteúdo bruto**.

Regras invioláveis:
- Hint nunca menciona pessoas, doenças, valores específicos, eventos
- Hint é instrução comportamental genérica ("usar tom mais paciente", "evitar pressão por decisão rápida")

LLM call (Haiku): recebe memory_entry.content, retorna hint_text + derived_sensitivity. Validator (Task 8 worker) verifica antes de persistir.

### Tests

```typescript
describe('deriveBehavioralHint', () => {
  it('memória "filha doente" → hint "usar tom mais paciente"', async () => {
    // mock LLM retornar hint genérico
    // verifica hint NÃO menciona "filha" ou "doença"
  });
  it('rejeita hint que vazaria conteúdo', async () => {
    // mock LLM retornar hint ruim ("evitar falar de doença")
    // verifica rejeição
  });
});
```

- [ ] Tests + impl
- [ ] Commit: `feat(p2): behavioral-hint-deriver (gera hint sem vazar conteúdo)`

---

## Task 8: Behavioral hint validator worker

**Files:** `src/workers/behavioral-hint-validator.ts` (create)

Sync ao criar hint (chamado pelo deriver). Worker LLM-as-judge:
- Recebe `hint_text` + `memory_entry.content`
- Pergunta: "esse hint revela direta ou indiretamente o conteúdo da memória?"
- Se sim → rejeita
- Se não → aprova

- [ ] Implementar
- [ ] Commit: `feat(p2): behavioral-hint-validator (LLM-as-judge anti-vazamento)`

---

## Task 9: Self-model — confidence formula

**Files:** `src/cognition/self-model.ts` (create), `tests/unit/self-model.spec.ts` (create — TDD)

Fórmula determinística:

```typescript
function computeConfidence(args: {
  success_count: number;
  failure_count: number;
  evidence_count: number;
  days_since_last_failure: number;
}): number {
  const N_MIN = 10;
  const LAMBDA = 30;
  const successRate = args.success_count / Math.max(1, args.success_count + args.failure_count);
  const maturityFactor = Math.min(1, Math.sqrt(args.evidence_count / N_MIN));
  const recencyFactor = Math.exp(-args.days_since_last_failure / LAMBDA);
  return Math.min(1, successRate * maturityFactor * recencyFactor);
}
```

NUNCA chama LLM. Retorna 0..1.

### Tests

```typescript
describe('computeConfidence', () => {
  it('zero evidence → confidence ≈ 0', () => { ... });
  it('all success, mature, recent → confidence ≈ 1', () => { ... });
  it('failure recente puxa pra baixo', () => { ... });
  it('maturity factor saturates at evidence_count >= N_MIN', () => { ... });
});
```

- [ ] Tests + impl
- [ ] Commit: `feat(p2): self-model com fórmula determinística de confidence`

---

## Task 10: Persister extension — fato → memory_classifier → memory_entry

**Files:** `src/cognition/persister.ts` (modify)

Quando `ClassifiedCandidate.type === 'fato'`:
1. Chamar `memoryClassifier(candidate.content)` pra obter `memory_type` + controls
2. Se `memory_type === 'sensitive'`, chamar `behavioralHintDeriver` pra gerar hint
3. Persistir `memory_entry` com classificação
4. Se hint gerado e aprovado pelo validator, persistir `behavioral_hint`

Manter back-compat: continuar populando `agent_facts` legado também (P2 transition; P3+ removerá após confirmar funcionamento).

Quando `ClassifiedCandidate.type === 'lacuna'`:
1. Persistir em `agent_capability_gaps` (upsert por similaridade)
2. Também continuar inserindo em `cognitive_candidates` (queue compat)

- [ ] Estender persister
- [ ] tsc clean
- [ ] Commit: `feat(p2): Persister roteia fato→memory_classifier; lacuna→capability_gaps`

---

## Task 11: Prompt builder — injetar memória respeitando visibility

**Files:** `src/agent/prompt-builder.ts` (modify)

Em `buildPrompt`, antes de enviar pro LLM:

1. **Carregar memórias relevantes** via `memoryEntryRepo.findRelevant({...})`:
   - Filtra por scope_type/subject_id correto pra contexto atual (interlocutor, role, conversa)
   - Exclui `needs_review=true`
   - Exclui expirados

2. **Filtrar por proactive_use**:
   - Se `proactive_use=false`, só entra se conversa atual tocou no tema (heurística: keyword match contra mensagem)

3. **Decidir verbalização**:
   - `mention_allowed=true` → conteúdo entra literal no contexto
   - `mention_allowed=false` → conteúdo NÃO entra; em vez disso, busca behavioral_hint correspondente

4. **Injetar hints**: `behavioralHintRepo.findActiveForScope({...})` → hints viram instrução genérica no system prompt ("Nesta conversa, usar tom mais paciente")

5. **Self-awareness**: query top-N skills da Maia + capability_gaps mentionable+ → injeta "Você é boa em X, está aprendendo Y, ainda não domina Z"

- [ ] Modificar prompt-builder
- [ ] tsc clean
- [ ] Verify existing tests pass
- [ ] Commit: `feat(p2): prompt-builder respeita visibility + injeta self-awareness`

---

## Task 12: Worker `legacy-memory-reclassifier`

**Files:** `src/workers/legacy-memory-reclassifier.ts` (create)

Worker batch (cron diário). Processa `memory_entry` com `needs_review=true`:
1. Lê em batch (100 por vez)
2. Chama `memoryClassifier` pra obter classificação real
3. Update `memory_entry` com novos controls + `needs_review=false`
4. Se classificado como `sensitive`, gera `behavioral_hint`

- [ ] Implementar worker
- [ ] Registrar em `src/workers/index.ts`
- [ ] Commit: `feat(p2): worker legacy-memory-reclassifier`

---

## Task 13: Worker `confidence-recompute`

**Files:** `src/workers/confidence-recompute.ts` (create)

Worker batch (cron diário). Recalcula `confidence` em todas as `agent_capabilities_*` via fórmula determinística. Necessário porque `recency_factor` é função do tempo.

- [ ] Implementar
- [ ] Registrar cron
- [ ] Commit: `feat(p2): worker confidence-recompute (cron diário)`

---

## Task 14: Capability tracker — update on outcome

**Files:** `src/cognition/capability-tracker.ts` (create) ou estender `src/cognition/self-model.ts`

Funções:
- `recordSuccess({ domain, skill?, evidence_event_id })` — chamado quando user dá SUCCESS_EXPLICIT
- `recordFailure({ domain, skill?, failure_mode })` — chamado quando user dá USER_CORRECTION

Wire em `src/agent/core.ts` e `src/agent/reflection.ts`:
- SUCCESS_EXPLICIT trigger (P1) → após persistir candidato, chama `recordSuccess`
- USER_CORRECTION trigger (P1) → chama `recordFailure`

Domain/skill são extraídos do contexto (heurística simples — tópico da conversa ou role atual; refinamento em P3).

- [ ] Implementar tracker
- [ ] Wire em core.ts + reflection.ts
- [ ] tsc clean
- [ ] Commit: `feat(p2): capability-tracker (success/failure update self-model)`

---

## Task 15: Integration test memory scoping

**Files:** `tests/integration/p2-memory-scoping.spec.ts` (create)

Cenários (mocked LLM + DB onde possível):
1. Memória `sensitive` NÃO aparece literal no prompt (mention_allowed=false respeitado)
2. `behavioral_hint` derivado SIM aparece no system prompt
3. Memória `personal` com scope_type=role NÃO atravessa pra outro role
4. Memória `operational` com scope_type=agent atravessa todos os roles
5. Memória `needs_review=true` bloqueada do prompt

- [ ] Escrever test
- [ ] Commit: `test(p2): integration test memory scoping (5 cenários)`

---

## Task 16: Integration test self-model

**Files:** `tests/integration/p2-self-model.spec.ts` (create)

Cenários:
1. 10 sucessos em domínio → confidence sobe pra ~0.8
2. 5 sucessos + 5 falhas → confidence ~0.5
3. Failure recente puxa confidence pra baixo mais que failure antiga
4. evidence_count<N_MIN → confidence cap baixo
5. Self-awareness injection: prompt contém top skills + gaps

- [ ] Escrever test
- [ ] Commit: `test(p2): integration test self-model com fórmula determinística`

---

## Task 17: Acceptance gates + runbook + PR

**Files:** `scripts/p2-acceptance-gates.sh` (create), `docs/runbooks/p2-memory-self-model.md` (create)

### Code-level gates

```bash
# Gate A: 4 novas tabelas no schema
grep -E "memory_entry|behavioral_hint|agent_capabilities_domain|agent_capabilities_skill|agent_capability_gaps" src/db/schema.ts | wc -l
# Expected: ≥ 5

# Gate B: unit tests
npx vitest tests/unit/memory-classifier.spec.ts tests/unit/self-model.spec.ts tests/unit/behavioral-hint-deriver.spec.ts

# Gate C: integration tests
npx vitest tests/integration/p2-memory-scoping.spec.ts tests/integration/p2-self-model.spec.ts

# Gate D: production build
npm run build
```

### DB-dependent gates (script)

```bash
#!/bin/bash
set -e

# Code gates above
# Plus DB validation:

psql "$DATABASE_URL" -c "SELECT to_regclass('public.memory_entry'), to_regclass('public.behavioral_hint'), to_regclass('public.agent_capabilities_domain'), to_regclass('public.agent_capabilities_skill'), to_regclass('public.agent_capability_gaps');"
# All non-null

psql "$DATABASE_URL" -c "
SELECT count(*) FROM memory_entry WHERE needs_review = true;
"
# Should match the count of legacy agent_facts that were migrated

echo "P2 gates green"
```

### Runbook

`docs/runbooks/p2-memory-self-model.md` documenta:
- Como inspecionar memórias por scope/visibility
- Como debug do classifier marcando muito como `sensitive`
- Como verificar self-model confidence
- Como deshabilitar (rollback) via feature flag

### Final commits + PR

```bash
git add scripts/p2-acceptance-gates.sh docs/runbooks/p2-memory-self-model.md
git commit -m "docs(p2): acceptance gates + runbook memory + self-model"
git push -u origin claude/p2-memory-self-model
gh pr create --title "feat(p2): Maia v2 — Memory scoping + Self-model" --body "..."
```

---

## P2 Acceptance Summary

1. ✅ Memory escopada por 6 controles (memory_type/scope_type/sensitivity/proactive_use/mention_allowed/ttl_days)
2. ✅ Memória sensível NÃO verbalizada (mention_allowed=false respeitado)
3. ✅ Behavioral hints derivados de sensible sem vazar conteúdo (validator anti-leak)
4. ✅ Self-model com confidence determinística (fórmula sobre evidência, NUNCA LLM)
5. ✅ Legacy `agent_facts` migrado conservadoramente (needs_review=true bloqueia uso)
6. ✅ P1 candidates type 'fato' roteados via memory_classifier
7. ✅ P1 candidates type 'lacuna' viram agent_capability_gaps
8. ✅ Prompt builder respeita visibility + injeta self-awareness
9. ✅ Workers de manutenção (legacy reclassifier, confidence recompute, hint validator)
