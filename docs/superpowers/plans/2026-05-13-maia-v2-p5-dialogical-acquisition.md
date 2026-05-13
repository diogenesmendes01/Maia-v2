# Maia v2 — P5 Aquisição Dialógica de Capacidades — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Implementar **aquisição dialógica de capacidades** — a Maia detecta limitações, escala-as por critério determinístico (silent → dashboard → mentionable → proposed), gera proposta formal apenas no nível 4 (LLM), e roda **teste automatizado** quando a capability é ativada. Se o teste falha, agente reverte o uso e abre gap técnico. Maia **propõe specs e testa**; **nunca decide prioridade nem ativa capacity crítica sozinha**.

**Frase-chave inviolável (spec §4.6 linha 225):**
> *"A Maia deve participar da própria evolução, mas não comandar a evolução."*

**Architecture:** 3 tabelas novas — `gap_escalation_rules` (thresholds tuning por tenant), `capability_proposals` (specs formais geradas no nível 4), `capability_test_results` (auditoria de testes pós-ativação). 1 engine determinístico (`gap-escalation-engine` — calcula transição de nível de gap a partir de `frequency_score + severity_score + contexto_match`, **nunca LLM**). 1 módulo cognitivo `capability-proposer` (Sonnet, async, único módulo LLM da fase — só dispara quando gap atinge `proposed` por regra determinística). 1 worker `gap-escalation-monitor` (a cada 30min). Loop fechado: `capability_acquired` event consumido por `capability-test-runner` (auto-test antes de ativar). Test falha → registra `capability_test_result` com `revert=true`, agente "esquece" a capability (gap volta a `mentionable` + abre gap técnico apontando o erro).

**Tech Stack:** TypeScript, Drizzle, PostgreSQL, vitest, Anthropic SDK (Sonnet para propose; ZERO LLM para escalation), BullMQ/node-cron. Builds on P0 (tenant_guard) + P1 (cognitive_event INTERNAL_GAP + gap-detector) + P2 (`agent_capability_gaps` table com current_level/frequency/severity) + P3 (procedures) + P4 (drift alerts feed gap technical).

**Reference:** Spec §4.6 (aquisição dialógica), §6.1 P5 (`gap_escalation_rules` + `capability_proposals` + `capability_test_results`), §9 P5 (linhas 603-607 done criteria), §10.9 (flag `FEATURE_DIALOGICAL_ACQUISITION`), §10.1 enums (`GapLevel`, `ProposalStatus`).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `migrations/027_p5_gap_escalation_rules.sql` + down | Create | Thresholds por (tenant,agent) — tune de escalation |
| `migrations/028_p5_capability_proposals.sql` + down | Create | Specs formais geradas em nível 4 |
| `migrations/029_p5_capability_test_results.sql` + down | Create | Auditoria de testes pós-ativação |
| `migrations/030_p5_extend_capability_gap_tipo.sql` + down | Create | Estende CHECK de `agent_capability_gaps.tipo` pra incluir `'technical'` (revert cria gaps deste tipo) |
| `src/db/schema.ts` | Modify | 3 tabelas + types |
| `src/db/repositories.ts` | Modify | 3 repos novos |
| `src/types/enums.ts` | Modify | `GapLevel` (4 values), `ProposalStatus` (5 values), `CapabilityTestResult` (3 values), `FeatureFlagName.DIALOGICAL_ACQUISITION` |
| `src/config/env.ts` | Modify | Schema env: `FEATURE_DIALOGICAL_ACQUISITION` |
| `src/config/feature-flags.ts` | Modify | Registrar `DIALOGICAL_ACQUISITION` no singleton |
| `src/cognition/gap-escalation/engine.ts` | Create | **Determinístico:** calcula novo `current_level` a partir de freq+sev+contexto+rules. ZERO LLM. |
| `src/cognition/gap-escalation/types.ts` | Create | `EscalationDecision`, `EscalationInput`, `EscalationRule` |
| `src/cognition/capability-proposer.ts` | Create | Sonnet-based: gera `capability_proposal` quando gap entra em `proposed`. ÚNICO LLM da fase. |
| `src/cognition/capability-test-runner.ts` | Create | Executa teste automatizado pós-ativação; emite `revert` se falha |
| `src/workers/gap-escalation-monitor.ts` | Create | Worker periódico (a cada 30min): escala gaps; aciona proposer no nível 4 |
| `src/workers/index.ts` | Modify | Registra `gap_escalation_monitor` cron |
| `src/agent/notification-adapter.ts` | Create | Determinístico: gap em `silent` NÃO notifica; `dashboard` registra; `mentionable` autoriza prompt-builder a mencionar limitação; `proposed` notifica owner via dashboard + queue |
| `src/agent/prompt-builder.ts` | Modify | Lê gaps em `mentionable` e injeta como behavioral hint ("se perguntarem sobre X, posso explicar a limitação atual"). NUNCA injeta gaps `silent`/`dashboard`. |
| `src/agent/capability-revert.ts` | Create | Quando teste falha, "esquece" a capability — marca como `revert_pending`, abre gap técnico, agente para de usá-la |
| `tests/unit/gap-escalation-engine.spec.ts` | Create | Testa as 4 transições determinísticas + edge cases |
| `tests/unit/capability-proposer.spec.ts` | Create | Testa que proposer só dispara em `proposed` + mocked Sonnet |
| `tests/unit/capability-test-runner.spec.ts` | Create | Testa auto-test e revert path |
| `tests/unit/gap-escalation-monitor.spec.ts` | Create | Worker tests |
| `tests/unit/notification-adapter.spec.ts` | Create | Testa que SILENT não notifica |
| `tests/unit/capability-revert.spec.ts` | Create | Testa revert + gap técnico criado |
| `tests/unit/prompt-builder-gap-mention.spec.ts` | Create | Testa que `mentionable` é injetado e `silent`/`dashboard` não |
| `tests/integration/p5-dialogical-acquisition.spec.ts` | Create | E2E: gap detected → escalado → proposed → owner aprova → activated → tested → ok/revert |
| `scripts/p5-acceptance-gates.sh` | Create | Bateria de gates |
| `docs/runbooks/p5-dialogical-acquisition.md` | Create | Runbook |

---

## Task 1: Enums (`GapLevel`, `ProposalStatus`, `CapabilityTestResult`) + flag `DIALOGICAL_ACQUISITION`

**Files:**
- Modify: `src/types/enums.ts`
- Modify: `src/config/env.ts`
- Modify: `src/config/feature-flags.ts` (register in singleton — critical!)
- Test: `tests/unit/enums-p5.spec.ts` (NEW)

**Scene:** Spec §10.1 lista `GapLevel` e `ProposalStatus` como enums obrigatórios. Valores em snake_case (§10.10). `silent` é o padrão pra novos gaps (alinhado com `agent_capability_gaps.current_level default 'silent'` de P2).

### Enums (em `src/types/enums.ts`)

```typescript
export const GapLevel = {
  SILENT: 'silent',           // 1ª ocorrência — registra apenas
  DASHBOARD: 'dashboard',     // freq alta — visível no dashboard
  MENTIONABLE: 'mentionable', // severity alta — Maia pode mencionar
  PROPOSED: 'proposed',       // padrão claro — gera capability_proposal
} as const;
export type GapLevel = typeof GapLevel[keyof typeof GapLevel];

export const ProposalStatus = {
  DRAFT: 'draft',             // proposer escreveu, ainda não submitted
  SUBMITTED: 'submitted',     // owner foi notificado, aguarda decisão
  APPROVED: 'approved',       // owner aprovou, dev pode implementar
  REJECTED: 'rejected',       // owner rejeitou (com motivo)
  DELIVERED: 'delivered',     // implementação entregue, aguardando teste
} as const;
export type ProposalStatus = typeof ProposalStatus[keyof typeof ProposalStatus];

export const CapabilityTestOutcome = {
  PASS: 'pass',
  FAIL: 'fail',
  ERROR: 'error',             // teste não rodou (infra failed); não bloqueia mas requer investigação
} as const;
export type CapabilityTestOutcome = typeof CapabilityTestOutcome[keyof typeof CapabilityTestOutcome];
```

Adicionar a `FeatureFlagName`:
```typescript
DIALOGICAL_ACQUISITION: 'DIALOGICAL_ACQUISITION',
```

### Env (em `src/config/env.ts`)

```typescript
FEATURE_DIALOGICAL_ACQUISITION: z
  .string()
  .default('false')
  .transform((s) => s === 'true' || s === '1'),
```

### Feature-flags singleton (em `src/config/feature-flags.ts`)

```typescript
export const featureFlags = new FeatureFlags({
  [FeatureFlagName.P0_TENANT_GUARD_ENFORCED]: config.FEATURE_P0_TENANT_GUARD_ENFORCED,
  [FeatureFlagName.OPERATIONAL_PROFILE_V2]: config.FEATURE_OPERATIONAL_PROFILE_V2,
  [FeatureFlagName.DIALOGICAL_ACQUISITION]: config.FEATURE_DIALOGICAL_ACQUISITION,  // NEW
});
```

### TDD Steps

- [ ] **Step 1: Write failing test** `tests/unit/enums-p5.spec.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { GapLevel, ProposalStatus, CapabilityTestOutcome, FeatureFlagName } from '@/types/enums.js';
import { featureFlags } from '@/config/feature-flags.js';

describe('P5 enums', () => {
  it('GapLevel has 4 values', () => {
    expect(Object.values(GapLevel).sort()).toEqual(['dashboard', 'mentionable', 'proposed', 'silent']);
  });
  it('ProposalStatus has 5 values', () => {
    expect(Object.values(ProposalStatus)).toHaveLength(5);
  });
  it('CapabilityTestOutcome has 3 values', () => {
    expect(Object.values(CapabilityTestOutcome).sort()).toEqual(['error', 'fail', 'pass']);
  });
  it('FeatureFlagName.DIALOGICAL_ACQUISITION defined', () => {
    expect(FeatureFlagName.DIALOGICAL_ACQUISITION).toBe('DIALOGICAL_ACQUISITION');
  });
  it('featureFlags singleton respects FEATURE_DIALOGICAL_ACQUISITION default off', () => {
    expect(featureFlags.isEnabled(FeatureFlagName.DIALOGICAL_ACQUISITION)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Add enums + env + singleton entry.**
- [ ] **Step 4: Run, pass.**
- [ ] **Step 5: Typecheck.**
- [ ] **Step 6: Commit**

```bash
git add src/types/enums.ts src/config/env.ts src/config/feature-flags.ts tests/unit/enums-p5.spec.ts
git commit -m "feat(p5): enums GapLevel/ProposalStatus/CapabilityTestOutcome + flag DIALOGICAL_ACQUISITION registrada"
```

---

## Task 2: Migration `gap_escalation_rules`

**Files:**
- Create: `migrations/027_p5_gap_escalation_rules.sql` + down
- Modify: `src/db/schema.ts`
- Test: `tests/unit/db-schema-p5.spec.ts` (NEW)

**Scene:** Thresholds determinísticos por (tenant, agent). Permite tuning sem deploy. Defaults em código; row no banco override seletivamente. **Não** armazena lógica — armazena números.

### SQL UP

```sql
-- P5: gap_escalation_rules — thresholds por (tenant, agent) para escalation determinística
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE gap_escalation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  dashboard_freq_threshold INTEGER NOT NULL DEFAULT 3,
  mentionable_severity_threshold INTEGER NOT NULL DEFAULT 5,
  proposed_combined_threshold INTEGER NOT NULL DEFAULT 8,
  proposed_min_distinct_contexts INTEGER NOT NULL DEFAULT 2,
  cooldown_days_proposed_to_proposed INTEGER NOT NULL DEFAULT 14,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id)
);
```

### SQL DOWN

```sql
DROP TABLE IF EXISTS gap_escalation_rules;
```

### Drizzle

```typescript
export const gap_escalation_rules = pgTable(
  'gap_escalation_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    dashboard_freq_threshold: integer('dashboard_freq_threshold').notNull().default(3),
    mentionable_severity_threshold: integer('mentionable_severity_threshold').notNull().default(5),
    proposed_combined_threshold: integer('proposed_combined_threshold').notNull().default(8),
    proposed_min_distinct_contexts: integer('proposed_min_distinct_contexts').notNull().default(2),
    cooldown_days_proposed_to_proposed: integer('cooldown_days_proposed_to_proposed').notNull().default(14),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentUq: uniqueIndex('gap_escalation_rules_tenant_agent_uq').on(t.tenant_id, t.agent_id),
  }),
);

export type GapEscalationRule = typeof gap_escalation_rules.$inferSelect;
export type NewGapEscalationRule = typeof gap_escalation_rules.$inferInsert;
```

### TDD

```typescript
import * as schema from '@/db/schema.js';

describe('P5 schema', () => {
  it('exports gap_escalation_rules table', () => {
    expect(schema.gap_escalation_rules).toBeDefined();
  });
  it('has thresholds + cooldown', () => {
    const cols = Object.keys(schema.gap_escalation_rules);
    expect(cols).toContain('dashboard_freq_threshold');
    expect(cols).toContain('mentionable_severity_threshold');
    expect(cols).toContain('proposed_combined_threshold');
    expect(cols).toContain('proposed_min_distinct_contexts');
    expect(cols).toContain('cooldown_days_proposed_to_proposed');
  });
});
```

### Steps

- [ ] **Steps 1-5:** Standard TDD (write test → fail → create SQL + Drizzle → pass → typecheck).
- [ ] **Step 6: Commit**

```bash
git add migrations/027_p5_gap_escalation_rules.sql migrations/027_p5_gap_escalation_rules_down.sql src/db/schema.ts tests/unit/db-schema-p5.spec.ts
git commit -m "feat(p5): gap_escalation_rules table (thresholds determinísticos por tenant/agent)"
```

---

## Task 3: Migration `capability_proposals`

**Files:**
- Create: `migrations/028_p5_capability_proposals.sql` + down
- Modify: `src/db/schema.ts`
- Extend: `tests/unit/db-schema-p5.spec.ts`

**Scene:** Spec formal gerada pelo proposer LLM quando gap escala a `proposed`. Owner decide via dashboard. Append-only; status transita `draft → submitted → approved | rejected → delivered`. `delivered` é estado externo (dev marca após implementar) — gatilho do `capability-test-runner`.

### SQL UP

```sql
-- P5: capability_proposals — propostas formais (spec gerada por LLM no nível 'proposed')
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE capability_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  gap_id UUID REFERENCES agent_capability_gaps(id),
  capability_type TEXT NOT NULL CHECK (
    capability_type IN ('tool', 'knowledge', 'procedure', 'integration', 'other')
  ),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  proposed_spec JSONB NOT NULL DEFAULT '{}'::jsonb,
  motivation TEXT NOT NULL,
  expected_impact TEXT,
  test_scenarios JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'submitted', 'approved', 'rejected', 'delivered')
  ),
  submitted_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  decided_by TEXT,
  decision_reason TEXT,
  delivered_at TIMESTAMPTZ,
  delivery_artifact_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cap_proposals_tenant_agent_status_idx
  ON capability_proposals(tenant_id, agent_id, status, created_at DESC);
CREATE INDEX cap_proposals_gap_idx
  ON capability_proposals(gap_id);
```

### SQL DOWN

```sql
DROP INDEX IF EXISTS cap_proposals_gap_idx;
DROP INDEX IF EXISTS cap_proposals_tenant_agent_status_idx;
DROP TABLE IF EXISTS capability_proposals;
```

### Drizzle

```typescript
export const capability_proposals = pgTable(
  'capability_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    gap_id: uuid('gap_id'),
    capability_type: text('capability_type').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    proposed_spec: jsonb('proposed_spec').notNull().default(sql`'{}'::jsonb`),
    motivation: text('motivation').notNull(),
    expected_impact: text('expected_impact'),
    test_scenarios: jsonb('test_scenarios').notNull().default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('draft'),
    submitted_at: timestamp('submitted_at', { withTimezone: true }),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    decided_by: text('decided_by'),
    decision_reason: text('decision_reason'),
    delivered_at: timestamp('delivered_at', { withTimezone: true }),
    delivery_artifact_ref: text('delivery_artifact_ref'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index('cap_proposals_tenant_agent_status_idx').on(t.tenant_id, t.agent_id, t.status, t.created_at),
    gapIdx: index('cap_proposals_gap_idx').on(t.gap_id),
  }),
);

export type CapabilityProposal = typeof capability_proposals.$inferSelect;
export type NewCapabilityProposal = typeof capability_proposals.$inferInsert;
```

### TDD extension

```typescript
it('exports capability_proposals table', () => {
  expect(schema.capability_proposals).toBeDefined();
});
it('has spec + status + audit', () => {
  const cols = Object.keys(schema.capability_proposals);
  expect(cols).toContain('proposed_spec');
  expect(cols).toContain('motivation');
  expect(cols).toContain('test_scenarios');
  expect(cols).toContain('status');
  expect(cols).toContain('delivered_at');
  expect(cols).toContain('gap_id');
});
```

### Steps

```bash
git add migrations/028_p5_capability_proposals.sql migrations/028_p5_capability_proposals_down.sql src/db/schema.ts tests/unit/db-schema-p5.spec.ts
git commit -m "feat(p5): capability_proposals table (specs formais, status draft->submitted->approved->delivered)"
```

---

## Task 4: Migration `capability_test_results`

**Files:**
- Create: `migrations/029_p5_capability_test_results.sql` + down
- Modify: `src/db/schema.ts`
- Extend: `tests/unit/db-schema-p5.spec.ts`

**Scene:** Auditoria do **loop fechado**. Cada test run (post `delivered`) gera 1 row com `outcome ∈ {pass, fail, error}`. Vincula proposta e gap. Failure → trigger de revert + novo gap técnico.

### SQL UP

```sql
-- P5: capability_test_results — auditoria de testes pós-ativação (loop fechado)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE capability_test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  proposal_id UUID NOT NULL REFERENCES capability_proposals(id) ON DELETE CASCADE,
  gap_id UUID REFERENCES agent_capability_gaps(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'error')),
  scenarios_run JSONB NOT NULL DEFAULT '[]'::jsonb,
  scenarios_passed INTEGER NOT NULL DEFAULT 0,
  scenarios_failed INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  triggered_revert BOOLEAN NOT NULL DEFAULT false,
  technical_gap_id UUID REFERENCES agent_capability_gaps(id),
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cap_test_results_proposal_idx
  ON capability_test_results(proposal_id, ran_at DESC);
CREATE INDEX cap_test_results_outcome_idx
  ON capability_test_results(tenant_id, agent_id, outcome, ran_at DESC);
```

### SQL DOWN

```sql
DROP INDEX IF EXISTS cap_test_results_outcome_idx;
DROP INDEX IF EXISTS cap_test_results_proposal_idx;
DROP TABLE IF EXISTS capability_test_results;
```

### Drizzle

```typescript
export const capability_test_results = pgTable(
  'capability_test_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    proposal_id: uuid('proposal_id').notNull(),
    gap_id: uuid('gap_id'),
    outcome: text('outcome').notNull(),
    scenarios_run: jsonb('scenarios_run').notNull().default(sql`'[]'::jsonb`),
    scenarios_passed: integer('scenarios_passed').notNull().default(0),
    scenarios_failed: integer('scenarios_failed').notNull().default(0),
    details: jsonb('details').notNull().default(sql`'{}'::jsonb`),
    triggered_revert: boolean('triggered_revert').notNull().default(false),
    technical_gap_id: uuid('technical_gap_id'),
    ran_at: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    proposalIdx: index('cap_test_results_proposal_idx').on(t.proposal_id, t.ran_at),
    outcomeIdx: index('cap_test_results_outcome_idx').on(t.tenant_id, t.agent_id, t.outcome, t.ran_at),
  }),
);

export type CapabilityTestResult = typeof capability_test_results.$inferSelect;
export type NewCapabilityTestResult = typeof capability_test_results.$inferInsert;
```

### TDD extension

```typescript
it('exports capability_test_results table', () => {
  expect(schema.capability_test_results).toBeDefined();
});
it('has outcome + revert tracking + technical gap link', () => {
  const cols = Object.keys(schema.capability_test_results);
  expect(cols).toContain('outcome');
  expect(cols).toContain('scenarios_run');
  expect(cols).toContain('triggered_revert');
  expect(cols).toContain('technical_gap_id');
  expect(cols).toContain('proposal_id');
});
```

### Steps

```bash
git add migrations/029_p5_capability_test_results.sql migrations/029_p5_capability_test_results_down.sql src/db/schema.ts tests/unit/db-schema-p5.spec.ts
git commit -m "feat(p5): capability_test_results table (auditoria loop fechado + revert tracking)"
```

---

## Task 4b: Migration `extend_capability_gap_tipo` (CHECK constraint pra `'technical'`)

**Files:**
- Create: `migrations/030_p5_extend_capability_gap_tipo.sql` + down

**Scene:** P2 migration `016_p2_self_model.sql` declarou `tipo TEXT NOT NULL CHECK (tipo IN ('tool', 'knowledge', 'procedure'))` em `agent_capability_gaps`. P5 revert path (Task 8) cria gaps com `tipo='technical'`. Sem essa migration, o INSERT viola o CHECK. Solução: DROP + recreate constraint ampliando o conjunto.

### SQL UP

```sql
-- P5: estende CHECK constraint de agent_capability_gaps.tipo para incluir 'technical'
-- (usado pelo revert path quando capability falha pós-ativação)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

ALTER TABLE agent_capability_gaps DROP CONSTRAINT IF EXISTS agent_capability_gaps_tipo_check;

ALTER TABLE agent_capability_gaps ADD CONSTRAINT agent_capability_gaps_tipo_check
  CHECK (tipo IN ('tool', 'knowledge', 'procedure', 'technical'));
```

### SQL DOWN

```sql
-- Cuidado: ao reverter, qualquer row com tipo='technical' viola o constraint antigo.
-- DOWN remove rows 'technical' antes de restaurar o constraint.
DELETE FROM agent_capability_gaps WHERE tipo = 'technical';

ALTER TABLE agent_capability_gaps DROP CONSTRAINT IF EXISTS agent_capability_gaps_tipo_check;

ALTER TABLE agent_capability_gaps ADD CONSTRAINT agent_capability_gaps_tipo_check
  CHECK (tipo IN ('tool', 'knowledge', 'procedure'));
```

### Steps

- [ ] **Step 1: Create both files.**
- [ ] **Step 2: Optionally extend `tests/unit/db-schema-p5.spec.ts`** with a comment-only note (no test — CHECK is DB-level, not schema-introspectable from Drizzle).
- [ ] **Step 3: Typecheck (no source changes here).**
- [ ] **Step 4: Commit**

```bash
git add migrations/030_p5_extend_capability_gap_tipo.sql migrations/030_p5_extend_capability_gap_tipo_down.sql
git commit -m "feat(p5): estende capability_gap.tipo CHECK pra incluir 'technical' (usado pelo revert path)"
```

---

## Task 5: Repos (`gapEscalationRulesRepo` + `capabilityProposalsRepo` + `capabilityTestResultsRepo`)

**Files:**
- Modify: `src/db/repositories.ts`
- Test: `tests/unit/capability-proposals-repo.spec.ts` (NEW)
- Test: `tests/unit/capability-test-results-repo.spec.ts` (NEW)

**Scene:** Pattern P3/P4 — `applyTenantGuard` no insert; reads via `getCurrentTenant() + getCurrentAgent()`. Tests mockam `@/db/repositories.js`.

### Signatures

```typescript
export const gapEscalationRulesRepo = {
  async getForCurrentAgent(): Promise<GapEscalationRule | null>,
  async upsert(input: Partial<NewGapEscalationRule>): Promise<GapEscalationRule>,
};

export const capabilityProposalsRepo = {
  async create(input: {
    gap_id?: string;
    capability_type: 'tool' | 'knowledge' | 'procedure' | 'integration' | 'other';
    title: string;
    description: string;
    proposed_spec: unknown;
    motivation: string;
    expected_impact?: string;
    test_scenarios: unknown[];
  }): Promise<CapabilityProposal>,
  async getById(id: string): Promise<CapabilityProposal | null>,
  async listByStatus(status: ProposalStatus): Promise<CapabilityProposal[]>,
  async listByGap(gap_id: string): Promise<CapabilityProposal[]>,
  // Validated transitions:
  // draft -> submitted (sets submitted_at)
  // submitted -> approved | rejected (sets decided_at, decided_by, decision_reason)
  // approved -> delivered (sets delivered_at, delivery_artifact_ref)
  async transition(args: {
    id: string;
    to: ProposalStatus;
    decided_by?: string;
    decision_reason?: string;
    delivery_artifact_ref?: string;
  }): Promise<
    | { ok: true; updated: CapabilityProposal }
    | { ok: false; reason: 'not_found' | 'invalid_transition' }
  >,
};

export const capabilityTestResultsRepo = {
  async record(input: {
    proposal_id: string;
    gap_id?: string;
    outcome: 'pass' | 'fail' | 'error';
    scenarios_run: unknown[];
    scenarios_passed: number;
    scenarios_failed: number;
    details?: unknown;
    triggered_revert?: boolean;
    technical_gap_id?: string;
  }): Promise<CapabilityTestResult>,
  async listByProposal(proposal_id: string): Promise<CapabilityTestResult[]>,
  async latestByProposal(proposal_id: string): Promise<CapabilityTestResult | null>,
};
```

### Valid transitions (matrix)

| from \ to | submitted | approved | rejected | delivered |
|---|---|---|---|---|
| draft | ✓ (set submitted_at) | — | — | — |
| submitted | — | ✓ (decided_at) | ✓ (decided_at) | — |
| approved | — | — | — | ✓ (delivered_at) |
| rejected/delivered | — | — | — | — (terminal) |

### TDD scenarios

**capability-proposals-repo.spec.ts:**
- `create` defaults to `status='draft'`
- `transition(draft → submitted)` sets `submitted_at`
- `transition(submitted → approved)` sets `decided_at + decided_by`
- `transition(submitted → delivered)` returns `{ ok: false, reason: 'invalid_transition' }`
- `transition(rejected → *)` returns invalid_transition (terminal)
- `transition(unknown_id)` returns `not_found`
- `listByStatus('submitted')` filters correctly

**capability-test-results-repo.spec.ts:**
- `record` insert with outcome='pass'
- `record` with `triggered_revert=true + technical_gap_id`
- `latestByProposal` returns most recent
- `listByProposal` ordered by ran_at DESC

### Steps

```bash
git add src/db/repositories.ts tests/unit/capability-proposals-repo.spec.ts tests/unit/capability-test-results-repo.spec.ts
git commit -m "feat(p5): repos gapEscalationRules + capabilityProposals + capabilityTestResults"
```

---

## Task 6: Gap Escalation Engine (determinístico — ZERO LLM)

**Files:**
- Create: `src/cognition/gap-escalation/types.ts`
- Create: `src/cognition/gap-escalation/engine.ts`
- Test: `tests/unit/gap-escalation-engine.spec.ts`

**Scene:** Núcleo da governança P5 — **determinístico**. Recebe um gap (current_level + frequency_score + severity_score + contexto histórico) + rules e devolve o novo nível. Regras:

```
silent     → dashboard:    frequency >= dashboard_freq_threshold
dashboard  → mentionable:  severity >= mentionable_severity_threshold
mentionable → proposed:    (frequency + severity) >= proposed_combined_threshold
                           AND distinct_contexts >= proposed_min_distinct_contexts
                           AND days_since_last_proposed >= cooldown_days_proposed_to_proposed
```

**Sem regressão automática** — se gap "esfria" não desce nível sozinho (P6+ pode adicionar).

### `types.ts`

```typescript
import type { GapLevel } from '@/types/enums.js';
import type { AgentCapabilityGap, GapEscalationRule } from '@/db/schema.js';

export type EscalationInput = {
  gap: AgentCapabilityGap;
  rules: GapEscalationRule;
  distinct_contexts_count: number;
  days_since_last_proposed_in_tenant: number | null;  // null = never proposed
};

export type EscalationDecision = {
  current_level: GapLevel;       // before
  new_level: GapLevel;            // after
  changed: boolean;
  reason: string;                 // human-readable explanation
};

export const DEFAULT_RULES: Pick<
  GapEscalationRule,
  'dashboard_freq_threshold' | 'mentionable_severity_threshold' | 'proposed_combined_threshold' | 'proposed_min_distinct_contexts' | 'cooldown_days_proposed_to_proposed'
> = {
  dashboard_freq_threshold: 3,
  mentionable_severity_threshold: 5,
  proposed_combined_threshold: 8,
  proposed_min_distinct_contexts: 2,
  cooldown_days_proposed_to_proposed: 14,
};
```

### `engine.ts`

```typescript
import { GapLevel } from '@/types/enums.js';
import { DEFAULT_RULES, type EscalationInput, type EscalationDecision } from './types.js';

export function decideEscalation(input: EscalationInput): EscalationDecision {
  const current = input.gap.current_level as GapLevel;
  const rules = input.rules;
  const freq = input.gap.frequency_score;
  const sev = input.gap.severity_score;

  // silent → dashboard
  if (current === GapLevel.SILENT) {
    if (freq >= rules.dashboard_freq_threshold) {
      return { current_level: current, new_level: GapLevel.DASHBOARD, changed: true, reason: `freq ${freq} >= ${rules.dashboard_freq_threshold}` };
    }
    return { current_level: current, new_level: current, changed: false, reason: `freq ${freq} < ${rules.dashboard_freq_threshold}` };
  }

  // dashboard → mentionable
  if (current === GapLevel.DASHBOARD) {
    if (sev >= rules.mentionable_severity_threshold) {
      return { current_level: current, new_level: GapLevel.MENTIONABLE, changed: true, reason: `severity ${sev} >= ${rules.mentionable_severity_threshold}` };
    }
    return { current_level: current, new_level: current, changed: false, reason: `severity ${sev} < ${rules.mentionable_severity_threshold}` };
  }

  // mentionable → proposed (combined + contexts + cooldown)
  if (current === GapLevel.MENTIONABLE) {
    const combined = freq + sev;
    if (combined < rules.proposed_combined_threshold) {
      return { current_level: current, new_level: current, changed: false, reason: `combined ${combined} < ${rules.proposed_combined_threshold}` };
    }
    if (input.distinct_contexts_count < rules.proposed_min_distinct_contexts) {
      return { current_level: current, new_level: current, changed: false, reason: `distinct_contexts ${input.distinct_contexts_count} < ${rules.proposed_min_distinct_contexts}` };
    }
    if (
      input.days_since_last_proposed_in_tenant !== null &&
      input.days_since_last_proposed_in_tenant < rules.cooldown_days_proposed_to_proposed
    ) {
      return { current_level: current, new_level: current, changed: false, reason: `cooldown ${input.days_since_last_proposed_in_tenant}d < ${rules.cooldown_days_proposed_to_proposed}d` };
    }
    return { current_level: current, new_level: GapLevel.PROPOSED, changed: true, reason: `all conditions met (combined=${combined}, contexts=${input.distinct_contexts_count})` };
  }

  // proposed = terminal (proposer dispara, owner decide)
  return { current_level: current, new_level: current, changed: false, reason: 'already_at_proposed_terminal_for_this_engine' };
}
```

### TDD scenarios (10+)

1. silent + freq<threshold → no change
2. silent + freq=threshold → dashboard
3. silent + freq>threshold → dashboard
4. dashboard + severity<threshold → no change
5. dashboard + severity>=threshold → mentionable
6. mentionable + combined<threshold → no change (reason mentions combined)
7. mentionable + combined>=threshold + contexts<min → no change (reason mentions contexts)
8. mentionable + combined>=threshold + contexts>=min + cooldown not met → no change (reason mentions cooldown)
9. mentionable + combined>=threshold + contexts>=min + never proposed before → proposed
10. mentionable + all conditions met after cooldown → proposed
11. proposed → no change (terminal)
12. Custom rules: tenant overrides default freq_threshold to 5; gap with freq=4 stays silent

### Steps

```bash
git add src/cognition/gap-escalation/types.ts src/cognition/gap-escalation/engine.ts tests/unit/gap-escalation-engine.spec.ts
git commit -m "feat(p5): gap escalation engine (determinístico: silent->dashboard->mentionable->proposed)"
```

---

## Task 7: Capability Proposer (Sonnet, único LLM da fase)

**Files:**
- Create: `src/cognition/capability-proposer.ts`
- Test: `tests/unit/capability-proposer.spec.ts`

**Scene:** ÚNICO LLM da fase, e só dispara quando gap entra em `proposed` por critério determinístico (Task 6). Recebe gap + contexto histórico, devolve spec estruturada que vira `capability_proposals.proposed_spec`. Wrapped em `runCognitiveModule` (timeout 15s + fallback `null`).

**Spec §10 Model tiers:** Sonnet para reasoning.

### Signature

```typescript
import { runCognitiveModule } from '@/cognition/runner.js';
import { capabilityProposalsRepo } from '@/db/repositories.js';
import type { AgentCapabilityGap } from '@/db/schema.js';

export type ProposalDraft = {
  capability_type: 'tool' | 'knowledge' | 'procedure' | 'integration' | 'other';
  title: string;
  description: string;
  proposed_spec: Record<string, unknown>;
  motivation: string;
  expected_impact: string;
  test_scenarios: Array<{ name: string; given: string; when: string; then: string }>;
};

export type ProposeResult =
  | { ok: true; proposal_id: string; draft: ProposalDraft }
  | { ok: false; reason: 'llm_unavailable' | 'parse_failed' | 'repo_failed'; message?: string };

export async function proposeCapabilityForGap(args: {
  gap: AgentCapabilityGap;
  recent_evidence?: Array<{ context: string; created_at: Date }>;
}): Promise<ProposeResult>;
```

### Implementation outline

```typescript
// Flag gate — sem flag, não consumimos Sonnet sem governance ativa.
if (!featureFlags.isEnabled(FeatureFlagName.DIALOGICAL_ACQUISITION)) {
  return { ok: false, reason: 'llm_unavailable', message: 'flag_off' };
}

const draft = await runCognitiveModule<ProposalDraft | null>(
  {
    name: 'capability_proposer',
    timeoutMs: 15000,
    triggered_by: 'async_event',
    fallback: null,
  },
  async () => {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
    const system = [
      'Você é o agente analisando uma lacuna recorrente na sua capacidade.',
      'Proponha uma especificação técnica para resolver. Você propõe; o owner decide.',
      'Devolva JSON estrito com {capability_type, title, description, proposed_spec, motivation, expected_impact, test_scenarios}.',
      'IMPORTANTE: NÃO inclua julgamento de prioridade. Apenas a spec técnica.',
    ].join('\n');
    const user = [
      `LACUNA: ${args.gap.capability_description}`,
      `TIPO PROVÁVEL: ${args.gap.tipo}`,
      `CONTEXTO RECORRENTE: ${args.gap.contexto ?? '(sem detalhe)'}`,
      `FREQUÊNCIA: ${args.gap.frequency_score} ocorrências`,
      `SEVERIDADE: ${args.gap.severity_score}/10`,
      args.recent_evidence ? `EVIDÊNCIAS RECENTES:\n${args.recent_evidence.slice(0, 5).map((e) => `- ${e.context}`).join('\n')}` : '',
      'Devolva JSON estrito conforme estrutura definida.',
    ].filter(Boolean).join('\n\n');

    const completion = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = completion.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as ProposalDraft;
    // Light validation: required keys
    if (!parsed.title || !parsed.description || !parsed.motivation) return null;
    return parsed;
  },
);

if (!draft.output) {
  return { ok: false, reason: draft.status === 'timeout' ? 'llm_unavailable' : 'parse_failed' };
}

try {
  const proposal = await capabilityProposalsRepo.create({
    gap_id: args.gap.id,
    capability_type: draft.output.capability_type,
    title: draft.output.title,
    description: draft.output.description,
    proposed_spec: draft.output.proposed_spec,
    motivation: draft.output.motivation,
    expected_impact: draft.output.expected_impact,
    test_scenarios: draft.output.test_scenarios,
  });
  return { ok: true, proposal_id: proposal.id, draft: draft.output };
} catch (e) {
  return { ok: false, reason: 'repo_failed', message: e instanceof Error ? e.message : String(e) };
}
```

### TDD scenarios

1. Happy path: Sonnet returns valid JSON → repo creates proposal with `status='draft'`, returns `{ok: true, proposal_id, draft}`.
2. Sonnet returns JSON missing required field → `{ok: false, reason: 'parse_failed'}`.
3. Sonnet throws/timeout → `{ok: false, reason: 'llm_unavailable'}` (via runCognitiveModule fallback).
4. Sonnet returns unparseable text → `{ok: false, reason: 'parse_failed'}`.
5. Repo insert fails → `{ok: false, reason: 'repo_failed', message: ...}`.

### Steps

```bash
git add src/cognition/capability-proposer.ts tests/unit/capability-proposer.spec.ts
git commit -m "feat(p5): capability-proposer (Sonnet, dispara apenas em 'proposed', wrapped em runCognitiveModule)"
```

---

## Task 8: Capability Test Runner (loop fechado + revert)

**Files:**
- Create: `src/cognition/capability-test-runner.ts`
- Create: `src/agent/capability-revert.ts`
- Test: `tests/unit/capability-test-runner.spec.ts`
- Test: `tests/unit/capability-revert.spec.ts`

**Scene:** Quando `capability_proposals.status='delivered'` (dev marcou após implementar), o `capability-test-runner` executa cada `test_scenarios[i]` da proposta e registra resultado em `capability_test_results`. Se outcome=`fail` → chama `capability-revert.revert(proposal, reason)` que:
1. Marca `triggered_revert=true` no result
2. Cria novo `agent_capability_gaps` row do tipo `technical` com description=`"capability X falhou em produção: <reason>"`, frequency_score=1 (será escalado normalmente)
3. Vincula `technical_gap_id` no test result

Cenário de teste é estruturado como `{ given, when, then }` (BDD). O runner é simples: executa o `when` no ambiente, captura output, compara contra `then` (string match / regex).

**Importante:** Em P5, o runner é **adapter pluggable** — diferentes capability_types podem precisar diferentes execution strategies (tool call simulation vs knowledge query vs procedure step). P5 entrega 2 strategies básicos (`echo_test`, `knowledge_match`). P6+ pode estender.

### `capability-test-runner.ts`

```typescript
import { capabilityProposalsRepo, capabilityTestResultsRepo, capabilityGapsRepo } from '@/db/repositories.js';
import { revertCapability } from '@/agent/capability-revert.js';
import { logger } from '@/lib/logger.js';

export type TestScenario = {
  name: string;
  given: string;
  when: string;
  then: string;
};

export type TestStrategyResult = { passed: boolean; observed: string; reason?: string };

export type TestStrategy = (scenario: TestScenario) => Promise<TestStrategyResult>;

// P5 ships 2 strategies; type → strategy
export const TEST_STRATEGIES: Record<string, TestStrategy> = {
  echo_test: async (s) => {
    // Trivial smoke: scenario's `when` is echoed back, compared to `then`
    return { passed: s.when.toLowerCase().includes(s.then.toLowerCase()), observed: s.when };
  },
  knowledge_match: async (s) => {
    // P5 placeholder: assume always passes (P6+ wires real knowledge lookup)
    return { passed: true, observed: 'knowledge_match_stub' };
  },
};

export async function runCapabilityTests(args: {
  proposal_id: string;
  strategy_key?: string;     // default 'echo_test'
}): Promise<{ outcome: 'pass' | 'fail' | 'error'; result_id: string }> {
  const proposal = await capabilityProposalsRepo.getById(args.proposal_id);
  if (!proposal) throw new Error('proposal_not_found');
  if (proposal.status !== 'delivered') {
    logger.warn({ proposal_id: args.proposal_id, status: proposal.status }, 'capability_test_runner.skip_not_delivered');
    return { outcome: 'error', result_id: '' };
  }

  const scenarios = (proposal.test_scenarios as TestScenario[]) ?? [];
  if (scenarios.length === 0) {
    const r = await capabilityTestResultsRepo.record({
      proposal_id: proposal.id,
      gap_id: proposal.gap_id ?? undefined,
      outcome: 'error',
      scenarios_run: [],
      scenarios_passed: 0,
      scenarios_failed: 0,
      details: { error: 'no_scenarios' },
    });
    return { outcome: 'error', result_id: r.id };
  }

  const strategy = TEST_STRATEGIES[args.strategy_key ?? 'echo_test'] ?? TEST_STRATEGIES.echo_test;
  let passed = 0;
  let failed = 0;
  const scenarios_run: Array<TestScenario & TestStrategyResult> = [];
  for (const s of scenarios) {
    try {
      const r = await strategy(s);
      scenarios_run.push({ ...s, ...r });
      if (r.passed) passed++;
      else failed++;
    } catch (e) {
      scenarios_run.push({ ...s, passed: false, observed: 'strategy_threw', reason: e instanceof Error ? e.message : String(e) });
      failed++;
    }
  }

  const outcome: 'pass' | 'fail' = failed === 0 ? 'pass' : 'fail';

  let technical_gap_id: string | undefined;
  let triggered_revert = false;
  if (outcome === 'fail') {
    triggered_revert = true;
    const failingScenario = scenarios_run.find((s) => !s.passed);
    const reason = `capability "${proposal.title}" failed: ${failingScenario?.reason ?? failingScenario?.observed ?? 'unknown'}`;
    const revertResult = await revertCapability({ proposal, reason });
    technical_gap_id = revertResult.technical_gap_id;
  }

  const result = await capabilityTestResultsRepo.record({
    proposal_id: proposal.id,
    gap_id: proposal.gap_id ?? undefined,
    outcome,
    scenarios_run,
    scenarios_passed: passed,
    scenarios_failed: failed,
    details: { strategy_key: args.strategy_key ?? 'echo_test' },
    triggered_revert,
    technical_gap_id,
  });

  logger.info({ proposal_id: proposal.id, outcome, passed, failed, triggered_revert }, 'capability_test_runner.done');
  return { outcome, result_id: result.id };
}
```

### `capability-revert.ts`

```typescript
import { capabilityGapsRepo } from '@/db/repositories.js';
import type { CapabilityProposal } from '@/db/schema.js';

export async function revertCapability(args: {
  proposal: CapabilityProposal;
  reason: string;
}): Promise<{ technical_gap_id: string }> {
  // Create a NEW gap of type 'technical' so escalation engine picks it up normally
  const newGap = await capabilityGapsRepo.create({
    capability_description: `[técnica] ${args.proposal.title} falhou pós-ativação`,
    tipo: 'technical',
    contexto: args.reason,
  });
  return { technical_gap_id: newGap.id };
}
```

(NOTE: `capabilityGapsRepo.create` may or may not exist with that exact shape. Check the actual repo signature in `src/db/repositories.ts` and adapt — P2 created the table, so a repo exists. If it doesn't expose a `create` method, add one (small extension, document in the commit).)

### TDD scenarios

**capability-test-runner.spec.ts:**
1. Proposal status='delivered', 2 scenarios, echo_test passes both → outcome='pass', `triggered_revert=false`.
2. Proposal status='delivered', 2 scenarios, 1 fails echo_test → outcome='fail', `triggered_revert=true`, `technical_gap_id` set.
3. Proposal status='approved' (not delivered) → outcome='error', skip log emitted.
4. Proposal not found → throws.
5. Empty scenarios → outcome='error', details.error='no_scenarios'.
6. Strategy throws → individual scenario marked failed, runs the next.

**capability-revert.spec.ts:**
1. Creates new technical gap with description prefix `[técnica]` and tipo='technical'.
2. Returns the new gap_id.

### Steps

```bash
git add src/cognition/capability-test-runner.ts src/agent/capability-revert.ts tests/unit/capability-test-runner.spec.ts tests/unit/capability-revert.spec.ts
git commit -m "feat(p5): capability test runner + revert (loop fechado pós-delivered)"
```

---

## Task 9: Worker `gap-escalation-monitor`

**Files:**
- Create: `src/workers/gap-escalation-monitor.ts`
- Modify: `src/workers/index.ts`
- Test: `tests/unit/gap-escalation-monitor.spec.ts`

**Scene:** Worker periódico (cron `*/30 * * * *` — a cada 30min). Para cada tenant × agent:
1. Carrega `gapEscalationRulesRepo.getForCurrentAgent()` (ou DEFAULT_RULES se null).
2. Lista gaps em `current_level ∈ {silent, dashboard, mentionable}`.
3. Para cada gap, monta `EscalationInput` (precisa derivar `distinct_contexts_count` de gap_evidence — em P5 ainda não há essa tabela; use proxy via `contexto` field do gap + `severity_score` como segunda dimensão).
4. Chama `decideEscalation(input)`. Se `changed=true`, atualiza gap (set `current_level`, `last_level_change_at`).
5. Se novo nível é `proposed`, dispara `proposeCapabilityForGap(gap)` (Task 7) async.
6. Loga sumário.

**Importante:** `proposeCapabilityForGap` é fire-and-forget — worker não trava esperando Sonnet retornar. Se falhar, próximo run pode retentar.

### Implementation outline

```typescript
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  tenantsRepo,
  capabilityGapsRepo,
  gapEscalationRulesRepo,
} from '@/db/repositories.js';
import { decideEscalation } from '@/cognition/gap-escalation/engine.js';
import { DEFAULT_RULES } from '@/cognition/gap-escalation/types.js';
import { proposeCapabilityForGap } from '@/cognition/capability-proposer.js';
import { GapLevel } from '@/types/enums.js';

export async function runGapEscalationMonitor(): Promise<void> {
  const tenants = await tenantsRepo.list();
  let total_changed = 0;
  let total_proposed_triggered = 0;

  for (const t of tenants) {
    await runWithTenantContext({ tenant_id: t.id, agent_id: 'default' }, async () => {
      const customRules = await gapEscalationRulesRepo.getForCurrentAgent();
      const rules = customRules ?? {
        ...DEFAULT_RULES,
        id: '', tenant_id: t.id, agent_id: 'default', created_at: new Date(), updated_at: new Date(),
      };

      const gaps = await capabilityGapsRepo.listByLevels([GapLevel.SILENT, GapLevel.DASHBOARD, GapLevel.MENTIONABLE]);
      const daysSinceLastProposedInTenant = await capabilityGapsRepo.daysSinceLastProposed();

      for (const gap of gaps) {
        // P5 simplification: distinct_contexts_count proxy = 2 if contexto present, else 1
        const distinct_contexts_count = gap.contexto && gap.contexto.length > 0 ? 2 : 1;
        const decision = decideEscalation({
          gap,
          rules: rules as Awaited<ReturnType<typeof gapEscalationRulesRepo.getForCurrentAgent>> extends infer R ? NonNullable<R> : never,
          distinct_contexts_count,
          days_since_last_proposed_in_tenant: daysSinceLastProposedInTenant,
        });
        if (!decision.changed) continue;

        await capabilityGapsRepo.updateLevel({
          id: gap.id,
          new_level: decision.new_level,
        });
        total_changed++;

        logger.info({ tenant_id: t.id, gap_id: gap.id, from: decision.current_level, to: decision.new_level, reason: decision.reason }, 'gap_escalation.changed');

        if (decision.new_level === GapLevel.PROPOSED) {
          // Fire-and-forget proposer; don't await to avoid blocking worker on Sonnet latency
          void proposeCapabilityForGap({ gap: { ...gap, current_level: decision.new_level } }).then((r) => {
            if (r.ok) {
              logger.info({ proposal_id: r.proposal_id, gap_id: gap.id }, 'gap_escalation.proposal_created');
            } else {
              logger.warn({ gap_id: gap.id, reason: r.reason }, 'gap_escalation.proposal_failed');
            }
          });
          total_proposed_triggered++;
        }
      }
    });
  }

  logger.info({ total_changed, total_proposed_triggered }, 'gap_escalation_monitor.done');
}
```

**Extend existing `capabilityGapsRepo`** (verified — it lives at `src/db/repositories.ts:1460`; current methods: `upsert`, `listByLevel` singular, `escalateLevel`). P5 adds:
- `listByLevels(levels: GapLevel[]): Promise<AgentCapabilityGap[]>` — plural variant. Use `inArray(agent_capability_gaps.current_level, levels)`.
- `updateLevel({ id, new_level }): Promise<void>` — sets `current_level` + `last_level_change_at = now()`. Distinct from existing `escalateLevel` which may have different semantics; use a new name.
- `daysSinceLastProposed(): Promise<number | null>` — **TENANT-WIDE** (not per-gap). SQL:
  ```sql
  SELECT EXTRACT(DAY FROM (now() - MAX(last_level_change_at)))::int AS days
  FROM agent_capability_gaps
  WHERE tenant_id = $1 AND agent_id = $2 AND current_level = 'proposed';
  ```
  Returns `null` if no row exists (never proposed in this tenant/agent). Used by cooldown gate so worker doesn't spawn proposals more frequently than `cooldown_days_proposed_to_proposed`.
- `create({ capability_description, tipo, contexto }): Promise<AgentCapabilityGap>` — straight insert with `applyTenantGuard`. Sets `current_level='silent'`, `frequency_score=1`, `severity_score=1` defaults. Used by Task 8 revert (`tipo='technical'`).

### Schedule

```typescript
{ name: 'gap_escalation_monitor', cron: '*/30 * * * *', fn: runGapEscalationMonitor, phase: 5 },
```

### TDD scenarios

1. **Gap silent, freq=3 (threshold reached)** → escalado para dashboard, log emitted, proposer NOT called.
2. **Gap mentionable, all conditions met** → escalado para proposed + `proposeCapabilityForGap` called (mock).
3. **Gap mentionable, cooldown not met** → no change.
4. **Empty gaps list** → no action.
5. **Custom rules: tenant overrides freq_threshold=5; gap with freq=4 stays silent.**
6. **Multi-tenant** → iterates each in its context.

### Steps

```bash
git add src/workers/gap-escalation-monitor.ts src/workers/index.ts src/db/repositories.ts tests/unit/gap-escalation-monitor.spec.ts
git commit -m "feat(p5): worker gap-escalation-monitor (a cada 30min: escala -> dispara proposer)"
```

---

## Task 10: Notification Adapter + Prompt-Builder Mention Injection

**Files:**
- Create: `src/agent/notification-adapter.ts`
- Modify: `src/agent/prompt-builder.ts`
- Test: `tests/unit/notification-adapter.spec.ts`
- Test: `tests/unit/prompt-builder-gap-mention.spec.ts`

**Scene:** Spec §9 P5 done criterion #1: *"Gap em nível SILENT não notifica owner"*. Implementar adapter que, **dado um gap level**, decide o canal de notificação:

| Level | Owner notification | Prompt injection |
|---|---|---|
| silent | none | none |
| dashboard | dashboard only (read on demand) | none |
| mentionable | dashboard | yes — adiciona hint "se perguntarem sobre X, mencione limitação" |
| proposed | dashboard + queue (alerta dedicado) | yes — mesmo hint |

Em P5, `dashboard only` é registro silencioso (já temos via `agent_capability_gaps`). `queue (alerta dedicado)` é um INSERT em uma tabela existente (cognitive_module_log via `runCognitiveModule(name='owner_notification_proposed', ...)` ou um log estruturado dedicado — implementação simples por enquanto). Owner cria UI/notifier externo para consumir.

### `notification-adapter.ts`

```typescript
import { GapLevel } from '@/types/enums.js';
import { logger } from '@/lib/logger.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import type { AgentCapabilityGap } from '@/db/schema.js';

export type NotifyResult = {
  channel: 'none' | 'dashboard' | 'dashboard_plus_queue';
  notified: boolean;
};

export async function notifyOwnerForGap(args: { gap: AgentCapabilityGap }): Promise<NotifyResult> {
  const level = args.gap.current_level as GapLevel;

  if (level === GapLevel.SILENT) {
    return { channel: 'none', notified: false };
  }

  if (level === GapLevel.DASHBOARD) {
    // Dashboard read on demand; nothing to notify proactively
    return { channel: 'dashboard', notified: true };
  }

  if (level === GapLevel.MENTIONABLE) {
    // Same — dashboard-only; prompt-builder handles user-side mention
    return { channel: 'dashboard', notified: true };
  }

  if (level === GapLevel.PROPOSED) {
    // Queue dedicated alert via cognitive_module_log
    await runCognitiveModule(
      { name: 'owner_notification_proposed', triggered_by: 'async_event', timeoutMs: 1000, fallback: null },
      async () => {
        logger.info(
          {
            gap_id: args.gap.id,
            capability_description: args.gap.capability_description,
            frequency_score: args.gap.frequency_score,
            severity_score: args.gap.severity_score,
          },
          'owner_notification.queued_for_proposed_gap',
        );
        return { queued: true };
      },
    );
    return { channel: 'dashboard_plus_queue', notified: true };
  }

  return { channel: 'none', notified: false };
}
```

### Prompt-builder modification (mention injection)

Encontrar local em `src/agent/prompt-builder.ts` onde injetamos behavioral hints (P2). Adicionar nova section que lê gaps `mentionable`/`proposed` e renderiza como hint:

```typescript
// New helper inside prompt-builder.ts
import { capabilityGapsRepo } from '@/db/repositories.js';
import { GapLevel, FeatureFlagName } from '@/types/enums.js';
import { featureFlags } from '@/config/feature-flags.js';

async function buildGapMentionSection(): Promise<string | null> {
  if (!featureFlags.isEnabled(FeatureFlagName.DIALOGICAL_ACQUISITION)) return null;
  const gaps = await capabilityGapsRepo.listByLevels([GapLevel.MENTIONABLE, GapLevel.PROPOSED]);
  if (gaps.length === 0) return null;
  const lines = gaps.slice(0, 5).map((g) => `- Se o usuário perguntar sobre ${g.capability_description}, você pode explicar honestamente que isso é uma limitação atual${g.current_level === GapLevel.PROPOSED ? ' (proposta de melhoria já enviada).' : '.'}`);
  return `## Limitações conhecidas (mencionar com transparência se vier à tona)\n${lines.join('\n')}`;
}
```

Inserir o output (se non-null) no system prompt, junto com outras hint sections (após selfAwareness e antes de procedureSection — local exato a definir lendo o código).

### TDD scenarios

**notification-adapter.spec.ts:**
1. Gap silent → channel='none', notified=false.
2. Gap dashboard → channel='dashboard', notified=true.
3. Gap mentionable → channel='dashboard', notified=true.
4. Gap proposed → channel='dashboard_plus_queue', notified=true, runCognitiveModule called with name='owner_notification_proposed'.

**prompt-builder-gap-mention.spec.ts:**
1. Flag OFF → no mention section.
2. Flag ON + zero gaps mentionable/proposed → no mention section.
3. Flag ON + 2 gaps mentionable → mention section present with both.
4. Flag ON + 1 gap proposed → mention section with "(proposta de melhoria já enviada)" suffix.
5. Flag ON + only silent/dashboard gaps → no mention section.

### Steps

```bash
git add src/agent/notification-adapter.ts src/agent/prompt-builder.ts tests/unit/notification-adapter.spec.ts tests/unit/prompt-builder-gap-mention.spec.ts
git commit -m "feat(p5): notification-adapter (silent=no notify; proposed=queue) + prompt-builder mention injection"
```

---

## Task 11: Integration test end-to-end P5

**Files:**
- Create: `tests/integration/p5-dialogical-acquisition.spec.ts`

**Scene:** Cenário completo, mocked end-to-end. 6 cenários:

1. **Gap escalation chain**: criar gap `silent` (freq=1) → bump freq=3 → roda monitor → vira `dashboard`. Bump severity=6 → monitor → `mentionable`. Bump combined=10 + contexto → monitor → `proposed` + proposer disparado (mocked Sonnet retorna spec válida) → capability_proposal `status='draft'` criada.
2. **Owner aprova proposta**: transition `draft → submitted → approved → delivered`.
3. **Test loop pass**: scenarios echo_test passam → outcome='pass', `triggered_revert=false`, nenhum gap técnico criado.
4. **Test loop fail**: scenario echo_test falha → outcome='fail', `triggered_revert=true`, novo gap técnico criado com `tipo='technical'` e descrição inclui "[técnica]".
5. **Silent não notifica**: gap silent → `notifyOwnerForGap` retorna `channel='none', notified=false`. Confirma defesa hard.
6. **Flag OFF**: feature flag desligada → prompt-builder não injeta gap mention; monitor ainda atualiza scores (não há damage), mas proposer NÃO dispara mesmo em proposed (porque flag governa o consumo, não a coleta; verificar comportamento esperado contra spec).

**Wait — cenário 6 questão de design.** Spec §9 P5 done criteria não menciona explicit comportamento da flag em proposer trigger. Decisão de design pra plan: **flag controla EXPOSIÇÃO ao usuário (prompt mention) e disparo de proposer**. Quando OFF: monitor segue escalando levels (pra coletar dados em dev/staging), mas proposer não é chamado, evitando consumo de Sonnet sem governance ativa.

### TDD steps

1. Write 6 cenários (mock infrastructure via `vi.mock` repos + Anthropic + feature-flags).
2. Iterate until all pass. Don't modify production code; report DONE_WITH_CONCERNS if bug surfaces.
3. Typecheck clean.
4. Commit:
```bash
git add tests/integration/p5-dialogical-acquisition.spec.ts
git commit -m "test(p5): integration test dialogical acquisition (6 cenários mocked)"
```

---

## Task 12: Acceptance gates + runbook

**Files:**
- Create: `scripts/p5-acceptance-gates.sh`
- Create: `docs/runbooks/p5-dialogical-acquisition.md`

### Gates script

7 gates (espelha P4 style):

1. **Migrations 027+028+029 exist with UP/DOWN files** + grep for `CREATE TABLE gap_escalation_rules`, `capability_proposals`, `capability_test_results`.
2. **Vitest:** all P5 specs + integration.
3. **Typecheck:** `npx tsc --noEmit`.
4. **Engine determinístico:** `grep -E "from .*anthropic|Anthropic\(" src/cognition/gap-escalation/engine.ts` deve retornar 0 matches — provando que o engine NÃO usa LLM.
5. **Worker `gap_escalation_monitor` registrado:** `grep "gap_escalation_monitor" src/workers/index.ts`.
6. **Feature flag registrada no singleton:** `grep "DIALOGICAL_ACQUISITION" src/config/feature-flags.ts`.
7. **Silent-no-notify check:** `grep -E "GapLevel.SILENT|level === 'silent'" src/agent/notification-adapter.ts` retorna ≥1 match.

### Runbook (espelha P4)

Sections:
- Overview P5 + escopo + dependências (P0-P4)
- Feature flag `FEATURE_DIALOGICAL_ACQUISITION`
- Como gaps são detectados (P1 gap-detector reuso)
- Escalation rules — tabela `gap_escalation_rules` com defaults; como customizar por tenant
- Como inspecionar gaps por nível: `SELECT * FROM agent_capability_gaps WHERE current_level = $1`
- Como ver propostas pendentes: `SELECT * FROM capability_proposals WHERE status='submitted'`
- Como aprovar/rejeitar (dev workflow + dashboard placeholder)
- Como marcar `delivered` após dev implementar
- Como o test runner roda e como inspecionar `capability_test_results`
- Como o revert path funciona (novo gap técnico criado)
- Rollback completo: flag OFF (monitor ainda coleta dados; proposer não dispara — sem consumo Sonnet)
- Troubleshooting: gap não escalou? checar `gap_escalation_rules` thresholds. Proposer falhando? checar `cognitive_module_log`. Test runner stuck? proposal precisa `status='delivered'`.
- Rollback de migrations: 029 → 028 → 027.

### Steps

```bash
git add scripts/p5-acceptance-gates.sh docs/runbooks/p5-dialogical-acquisition.md
git commit -m "docs(p5): acceptance gates script + runbook dialogical acquisition"
```

---

## Acceptance Criteria (P5 done — spec §9 linhas 603-607)

1. **Gap em nível SILENT não notifica owner** — `notification-adapter` retorna `channel='none', notified=false` para silent (Task 10). Integration cenário 5.
2. **Gap atinge nível PROPOSED só por critério determinístico (freq + sev + contexto), nunca por LLM** — `gap-escalation/engine.ts` é puro/sem imports de Anthropic; acceptance gate #4 verifica via grep.
3. **`capability_acquired` event dispara teste automatizado antes de ativar** — em P5, `capability_acquired` é representado pela transição `approved → delivered` da proposta. `capability-test-runner` corre nesse momento (Task 8). Integration cenário 3.
4. **Tool falha pós-ativação abre novo gap técnico, agente reverte uso** — `capability-test-runner` falha → `capability-revert` cria novo gap `tipo='technical'`. Integration cenário 4.

---

## Riscos & Mitigations

| Risco | Mitigação |
|---|---|
| Engine determinístico desalinhado com julgamento humano | Thresholds tunáveis por tenant via `gap_escalation_rules` row. Defaults conservadores (combined=8, contexts>=2, cooldown 14d). |
| Proposer dispara em loop por gap não-resolvido | Cooldown `cooldown_days_proposed_to_proposed=14d` no engine. Gap fica em `proposed` (terminal pra engine) até owner agir. |
| Revert errado bloqueia capability legítima | `capability-test-runner` registra todos os scenarios em `scenarios_run`; owner pode auditar e re-deliver com proposal updated. |
| Sonnet falha repetidamente no proposer | `runCognitiveModule` retorna `null`; worker loga mas não trava. Próximo run retenta. Cooldown protege contra spam. |
| Flag OFF mas dados de escalation poluem analytics | Monitor segue rodando — mas isso é intencional pra detectar padrões antes de ativar a fase em prod. |
| Test runner falha por strategy ausente | `TEST_STRATEGIES[strategy_key] ?? echo_test` — sempre tem fallback. |
| `capability-revert` cria loops infinitos (revert → gap → propose → revert) | Cooldown 14d entre propostas evita o loop curto. Gap técnico é separado do gap original (`tipo='technical'`), tratado em pipeline distinta. |

---

## Notas finais

- **Migrations 027+028+029** entram em ordem (test_results FK proposals; proposals FK gaps de P2).
- **NÃO MERGEAR P5** sem P4 (#86) merged.
- **Quando rodar gates:** após DB up + 027/028/029 aplicadas + worker reaper habilitado.
- **Próxima fase candidata:** P6 (Channel/Role/Policy + Role Engine) — refactor estrutural do gateway.
