# Maia v2 — P4 Identidade Operacional Versionada + Drift Detector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Implementar **governança de comportamento** versionada do agente — não autobiografia. 4 camadas (núcleo imutável / perfil operacional aprendido / memória episódica temporária / backlog de crescimento aprovado), append-only com status `{proposed, active, frozen, rolled_back}` em que `proposed` **NUNCA** entra em runtime. Drift detector roda assíncrono, classifica em 7 tipos × 4 severidades, decide auto-aprovação / fila humana / freeze / rollback. Tudo coexiste com `self_state` legado via feature flag `FEATURE_OPERATIONAL_PROFILE_V2` — rollback é flip da flag (<1min, sem deploy).

**Architecture:** 2 tabelas novas (`agent_operational_profile_versions` append-only, `agent_drift_alerts` audit) + 7 drift detectores especializados em `src/cognition/drift/` + 1 decision engine que classifica severidade e decide ação + worker `drift-monitor` (semanal, async) + proposal generator que semeia versão `active` inicial a partir de `self_state` + `maia-prompt.md`. Prompt-builder ganha branch dual-read: quando flag ON, lê da nova tabela (active version) e renderiza as 4 camadas; quando flag OFF, mantém comportamento atual (self_state). **Status `proposed` NUNCA é injetado no prompt** — validação em runtime.

**Regra dura inviolável (spec §4.3):** *"A Maia pode gerar evidências sobre como está performando, mas não pode alterar sozinha quem ela é."*

**Tech Stack:** TypeScript, Drizzle, PostgreSQL, vitest, Anthropic SDK (Sonnet para drift detection conforme spec §10 Model tiers + spec linha 359). Builds on P0 (tenant_guard) + P1 (cognitive_module_log + runner) + P2 (memory + behavioral hint) + P3a/b/c (procedures).

**Reference:** Spec §4.3 (identidade operacional), §7.3 (migration paralela P4.1-P4.6), §9 P4 (linhas 597-601 done criteria), §6.1 P4 (tabelas), §10.1 (DriftType/DriftSeverity enums), §10.9 (feature flag `FEATURE_OPERATIONAL_PROFILE_V2`).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `migrations/025_p4_agent_operational_profile_versions.sql` + down | Create | Append-only versões do perfil |
| `migrations/026_p4_agent_drift_alerts.sql` + down | Create | Audit das decisões do drift detector |
| `src/db/schema.ts` | Modify | 2 tabelas + types |
| `src/db/repositories.ts` | Modify | 2 repos novos |
| `src/types/enums.ts` | Modify | `DriftType`, `DriftSeverity`, `ProfileStatus` + `FeatureFlagName.OPERATIONAL_PROFILE_V2` |
| `src/config/env.ts` | Modify | Schema env: `FEATURE_OPERATIONAL_PROFILE_V2` |
| `src/config/feature-flags.ts` | Modify | Registrar `OPERATIONAL_PROFILE_V2` na inicialização do singleton (linha 42-44) — `[FeatureFlagName.OPERATIONAL_PROFILE_V2]: config.FEATURE_OPERATIONAL_PROFILE_V2`. Sem essa entrada, `featureFlags.isEnabled(...)` SEMPRE retorna false (fallback do `??` na linha 18). |
| `src/identity/proposal-generator.ts` | Create | Seed: gera primeira versão `active` a partir de self_state + maia-prompt.md |
| `src/identity/profile-renderer.ts` | Create | Renderiza as 4 camadas em texto para o prompt |
| `src/agent/prompt-builder.ts` | Modify | Branch dual-read sob flag; valida que status != 'proposed' |
| `src/cognition/drift/types.ts` | Create | `DriftEvidence`, `DriftAlert`, `DriftDetector` interface |
| `src/cognition/drift/tom.ts` | Create | Tom (LLM-as-judge vs descritor de voz do núcleo) |
| `src/cognition/drift/valores.ts` | Create | Valores (LLM verifica proposta vs valores do núcleo) |
| `src/cognition/drift/confianca.ts` | Create | Confiança (cross-check com self-model real) |
| `src/cognition/drift/vies.ts` | Create | Viés (regex + LLM busca generalizações) |
| `src/cognition/drift/escopo.ts` | Create | Escopo (promete o que não tem em `agent_capabilities`?) |
| `src/cognition/drift/linguagem.ts` | Create | Linguagem (vocabulário vs corpus de referência) |
| `src/cognition/drift/procedimento.ts` | Create | Procedimento novo de 1-2 evidências = drift |
| `src/cognition/drift/decision-engine.ts` | Create | Classifica severidade e decide ação (auto/queue/freeze/rollback) |
| `src/cognition/drift/index.ts` | Create | Orquestrador que invoca os 7 detectores em paralelo |
| `src/workers/drift-monitor.ts` | Create | Worker semanal: roda drift detection por tenant, persiste alerts, aplica decisões críticas |
| `src/workers/index.ts` | Modify | Registra `drift_monitor` (cron semanal) |
| `tests/unit/identity-proposal-generator.spec.ts` | Create | Testa seed inicial |
| `tests/unit/identity-profile-renderer.spec.ts` | Create | Testa rendering 4 camadas |
| `tests/unit/identity-prompt-builder-flag.spec.ts` | Create | Testa branch dual-read sob flag + bloqueio de `proposed` |
| `tests/unit/drift-detector-{tom,valores,confianca,vies,escopo,linguagem,procedimento}.spec.ts` | Create | 7 specs (1 por tipo) |
| `tests/unit/drift-decision-engine.spec.ts` | Create | Testa 4 severidades × ações |
| `tests/unit/drift-monitor.spec.ts` | Create | Testa worker |
| `tests/integration/p4-operational-identity.spec.ts` | Create | End-to-end: seed inicial → drift CRÍTICO → rollback automático → flag flip restaura legado |
| `scripts/p4-acceptance-gates.sh` | Create | Bateria de gates |
| `docs/runbooks/p4-operational-identity.md` | Create | Runbook |

---

## Task 1: Enums novos (`DriftType`, `DriftSeverity`, `ProfileStatus`) + feature flag

**Files:**
- Modify: `src/types/enums.ts`
- Modify: `src/config/env.ts`
- Test: `tests/unit/enums-p4.spec.ts` (NEW)

**Scene:** Toda decisão tipada de P4 puxa enum dessa fonte. Spec §10.1 lista esses nomes. Status `proposed`/`active`/`frozen`/`rolled_back` espelham os de `procedure_definitions` (P3a) para consistência.

### Enums to add (em `src/types/enums.ts`)

```typescript
export const DriftType = {
  TOM: 'tom',
  VALORES: 'valores',
  CONFIANCA: 'confianca',
  VIES: 'vies',
  ESCOPO: 'escopo',
  LINGUAGEM: 'linguagem',
  PROCEDIMENTO: 'procedimento',
} as const;
export type DriftType = typeof DriftType[keyof typeof DriftType];

export const DriftSeverity = {
  BAIXO: 'baixo',
  MEDIO: 'medio',
  ALTO: 'alto',
  CRITICO: 'critico',
} as const;
export type DriftSeverity = typeof DriftSeverity[keyof typeof DriftSeverity];

export const ProfileStatus = {
  PROPOSED: 'proposed',
  ACTIVE: 'active',
  FROZEN: 'frozen',
  ROLLED_BACK: 'rolled_back',
} as const;
export type ProfileStatus = typeof ProfileStatus[keyof typeof ProfileStatus];

export const DriftDecision = {
  AUTO_APPROVED: 'auto_approved',
  QUEUED_HUMAN: 'queued_human',
  FROZEN: 'frozen',
  ROLLBACK: 'rollback',
} as const;
export type DriftDecision = typeof DriftDecision[keyof typeof DriftDecision];
```

E adicionar a `FeatureFlagName`:
```typescript
export const FeatureFlagName = {
  // ... existing
  OPERATIONAL_PROFILE_V2: 'OPERATIONAL_PROFILE_V2',
} as const;
```

### Env (em `src/config/env.ts`)

```typescript
FEATURE_OPERATIONAL_PROFILE_V2: z
  .string()
  .default('false')
  .transform((v) => v === 'true'),
```

### TDD Steps

- [ ] **Step 1: Write failing test** `tests/unit/enums-p4.spec.ts`
   ```typescript
   import { describe, it, expect } from 'vitest';
   import { DriftType, DriftSeverity, ProfileStatus, DriftDecision, FeatureFlagName } from '@/types/enums.js';
   import { featureFlags } from '@/config/feature-flags.js';

   describe('P4 enums', () => {
     it('DriftType has 7 values', () => {
       expect(Object.values(DriftType)).toHaveLength(7);
     });
     it('DriftSeverity has 4 values', () => {
       expect(Object.values(DriftSeverity)).toHaveLength(4);
     });
     it('ProfileStatus = proposed/active/frozen/rolled_back', () => {
       expect(Object.values(ProfileStatus).sort()).toEqual(['active', 'frozen', 'proposed', 'rolled_back']);
     });
     it('DriftDecision has 4 values', () => {
       expect(Object.values(DriftDecision)).toHaveLength(4);
     });
     it('FeatureFlagName.OPERATIONAL_PROFILE_V2 defined', () => {
       expect(FeatureFlagName.OPERATIONAL_PROFILE_V2).toBe('OPERATIONAL_PROFILE_V2');
     });
     it('featureFlags singleton respects FEATURE_OPERATIONAL_PROFILE_V2 default off', () => {
       expect(featureFlags.isEnabled(FeatureFlagName.OPERATIONAL_PROFILE_V2)).toBe(false);
     });
   });
   ```

- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Add enums to `src/types/enums.ts` and env var to `src/config/env.ts`.**
- [ ] **Step 4: Register flag in singleton** — in `src/config/feature-flags.ts` (lines 42-44), add:
   ```typescript
   export const featureFlags = new FeatureFlags({
     [FeatureFlagName.P0_TENANT_GUARD_ENFORCED]: config.FEATURE_P0_TENANT_GUARD_ENFORCED,
     [FeatureFlagName.OPERATIONAL_PROFILE_V2]: config.FEATURE_OPERATIONAL_PROFILE_V2,  // NEW
   });
   ```
- [ ] **Step 5: Run, pass.**
- [ ] **Step 6: Typecheck (`npx tsc --noEmit`).**
- [ ] **Step 7: Commit**

```bash
git add src/types/enums.ts src/config/env.ts src/config/feature-flags.ts tests/unit/enums-p4.spec.ts
git commit -m "feat(p4): enums DriftType/DriftSeverity/ProfileStatus/DriftDecision + flag OPERATIONAL_PROFILE_V2 registrada"
```

---

## Task 2: Migration `agent_operational_profile_versions`

**Files:**
- Create: `migrations/025_p4_agent_operational_profile_versions.sql` + down
- Modify: `src/db/schema.ts`
- Test: `tests/unit/db-schema-p4.spec.ts` (NEW)

**Scene:** Append-only. Cada versão guarda as 4 camadas + status + audit. Mais que uma `active` por (tenant, agent) é proibido por unique partial index. `proposed` é incremental — gerado por drift workflow ou por owner via interface; só vira `active` por gate humano (exceto a primeira `active` semeada por proposal generator).

### SQL UP

```sql
-- P4: agent_operational_profile_versions — append-only, 4 camadas + status
-- proposed NUNCA entra em runtime. active vai pro prompt quando flag on.
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE agent_operational_profile_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('proposed', 'active', 'frozen', 'rolled_back')
  ),
  -- 4 camadas (jsonb por flexibilidade; schema validado em app code)
  core_immutable JSONB NOT NULL DEFAULT '{}'::jsonb,
  operational_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  episodic_temp JSONB NOT NULL DEFAULT '{}'::jsonb,
  growth_backlog JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- audit
  proposed_by TEXT NOT NULL,             -- 'system_seed' | 'drift_detector' | 'owner' | 'capability_proposal' etc.
  proposed_reason TEXT,
  approved_by TEXT,                      -- 'auto' | operator_id
  approved_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  frozen_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  rollback_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, version)
);

CREATE INDEX agent_op_profile_tenant_agent_status_idx
  ON agent_operational_profile_versions(tenant_id, agent_id, status, version DESC);

-- Partial unique: no máximo 1 active por (tenant, agent)
CREATE UNIQUE INDEX agent_op_profile_unique_active_idx
  ON agent_operational_profile_versions(tenant_id, agent_id)
  WHERE status = 'active';
```

### SQL DOWN

```sql
DROP INDEX IF EXISTS agent_op_profile_unique_active_idx;
DROP INDEX IF EXISTS agent_op_profile_tenant_agent_status_idx;
DROP TABLE IF EXISTS agent_operational_profile_versions;
```

### Drizzle (em `src/db/schema.ts`, junto com outras tabelas P0+)

```typescript
export const agent_operational_profile_versions = pgTable(
  'agent_operational_profile_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull(),
    core_immutable: jsonb('core_immutable').notNull().default(sql`'{}'::jsonb`),
    operational_profile: jsonb('operational_profile').notNull().default(sql`'{}'::jsonb`),
    episodic_temp: jsonb('episodic_temp').notNull().default(sql`'{}'::jsonb`),
    growth_backlog: jsonb('growth_backlog').notNull().default(sql`'{}'::jsonb`),
    proposed_by: text('proposed_by').notNull(),
    proposed_reason: text('proposed_reason'),
    approved_by: text('approved_by'),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    activated_at: timestamp('activated_at', { withTimezone: true }),
    frozen_at: timestamp('frozen_at', { withTimezone: true }),
    rolled_back_at: timestamp('rolled_back_at', { withTimezone: true }),
    rollback_reason: text('rollback_reason'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentStatusIdx: index('agent_op_profile_tenant_agent_status_idx').on(t.tenant_id, t.agent_id, t.status, t.version),
    versionUq: uniqueIndex('agent_op_profile_version_uq').on(t.tenant_id, t.agent_id, t.version),
  }),
);

export type AgentOperationalProfileVersion = typeof agent_operational_profile_versions.$inferSelect;
export type NewAgentOperationalProfileVersion = typeof agent_operational_profile_versions.$inferInsert;
```

**Note:** Drizzle's `pgTable` doesn't directly express the partial unique index on `status='active'`. The Drizzle definition omits it; the SQL migration enforces it at the DB layer. The repo `transitionToActive` method (Task 4) must respect this — refuse if there's already an active version.

### TDD Steps

- [ ] **Step 1: Write failing test** `tests/unit/db-schema-p4.spec.ts`
   ```typescript
   import { describe, it, expect } from 'vitest';
   import * as schema from '@/db/schema.js';

   describe('P4 schema', () => {
     it('exports agent_operational_profile_versions table', () => {
       expect(schema.agent_operational_profile_versions).toBeDefined();
     });
     it('has 4 camada columns + status + audit', () => {
       const cols = Object.keys(schema.agent_operational_profile_versions);
       expect(cols).toContain('core_immutable');
       expect(cols).toContain('operational_profile');
       expect(cols).toContain('episodic_temp');
       expect(cols).toContain('growth_backlog');
       expect(cols).toContain('status');
       expect(cols).toContain('proposed_by');
       expect(cols).toContain('rollback_reason');
     });
   });
   ```

- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Create migration files (UP + DOWN). Add Drizzle.**
- [ ] **Step 4: Run, pass.**
- [ ] **Step 5: Typecheck.**
- [ ] **Step 6: Commit**

```bash
git add migrations/025_p4_agent_operational_profile_versions.sql migrations/025_p4_agent_operational_profile_versions_down.sql src/db/schema.ts tests/unit/db-schema-p4.spec.ts
git commit -m "feat(p4): agent_operational_profile_versions table (append-only, 4 camadas, 1 active por (tenant,agent))"
```

---

## Task 3: Migration `agent_drift_alerts`

**Files:**
- Create: `migrations/026_p4_agent_drift_alerts.sql` + down
- Modify: `src/db/schema.ts`
- Test: extend `tests/unit/db-schema-p4.spec.ts`

**Scene:** Cada execução do drift detector pode gerar 0..N alerts. Cada alert carrega evidência tipada, severidade classificada, decisão tomada e auditoria de quem decidiu. Append-only.

### SQL UP

```sql
-- P4: agent_drift_alerts — audit das execuções do drift detector
-- Cada alert = 1 tipo de drift detectado + severidade + decisão + audit
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE agent_drift_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  profile_version_id UUID REFERENCES agent_operational_profile_versions(id),
  drift_type TEXT NOT NULL CHECK (
    drift_type IN ('tom', 'valores', 'confianca', 'vies', 'escopo', 'linguagem', 'procedimento')
  ),
  severity TEXT NOT NULL CHECK (
    severity IN ('baixo', 'medio', 'alto', 'critico')
  ),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  detected_by TEXT NOT NULL,              -- module name (e.g. 'drift_detector_tom')
  decision TEXT NOT NULL CHECK (
    decision IN ('auto_approved', 'queued_human', 'frozen', 'rollback')
  ),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by TEXT NOT NULL,               -- 'decision_engine' | operator_id
  resolution_note TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agent_drift_tenant_agent_severity_idx
  ON agent_drift_alerts(tenant_id, agent_id, severity, created_at DESC);
CREATE INDEX agent_drift_profile_version_idx
  ON agent_drift_alerts(profile_version_id);
CREATE INDEX agent_drift_unresolved_idx
  ON agent_drift_alerts(tenant_id, agent_id, created_at DESC)
  WHERE resolved_at IS NULL;
```

### SQL DOWN

```sql
DROP INDEX IF EXISTS agent_drift_unresolved_idx;
DROP INDEX IF EXISTS agent_drift_profile_version_idx;
DROP INDEX IF EXISTS agent_drift_tenant_agent_severity_idx;
DROP TABLE IF EXISTS agent_drift_alerts;
```

### Drizzle

```typescript
export const agent_drift_alerts = pgTable(
  'agent_drift_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    profile_version_id: uuid('profile_version_id'),
    drift_type: text('drift_type').notNull(),
    severity: text('severity').notNull(),
    evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
    detected_by: text('detected_by').notNull(),
    decision: text('decision').notNull(),
    decided_at: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    decided_by: text('decided_by').notNull(),
    resolution_note: text('resolution_note'),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
    resolved_by: text('resolved_by'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentSeverityIdx: index('agent_drift_tenant_agent_severity_idx').on(t.tenant_id, t.agent_id, t.severity, t.created_at),
    profileVersionIdx: index('agent_drift_profile_version_idx').on(t.profile_version_id),
  }),
);

export type AgentDriftAlert = typeof agent_drift_alerts.$inferSelect;
export type NewAgentDriftAlert = typeof agent_drift_alerts.$inferInsert;
```

### TDD Steps

- [ ] **Step 1: Extend test** in `tests/unit/db-schema-p4.spec.ts`:
   ```typescript
   it('exports agent_drift_alerts table', () => {
     expect(schema.agent_drift_alerts).toBeDefined();
   });
   it('drift alerts has drift_type, severity, decision, evidence', () => {
     const cols = Object.keys(schema.agent_drift_alerts);
     expect(cols).toContain('drift_type');
     expect(cols).toContain('severity');
     expect(cols).toContain('decision');
     expect(cols).toContain('evidence');
     expect(cols).toContain('profile_version_id');
   });
   ```

- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Create migration files. Add Drizzle.**
- [ ] **Step 4: Run, pass. Typecheck.**
- [ ] **Step 5: Commit**

```bash
git add migrations/026_p4_agent_drift_alerts.sql migrations/026_p4_agent_drift_alerts_down.sql src/db/schema.ts tests/unit/db-schema-p4.spec.ts
git commit -m "feat(p4): agent_drift_alerts table (audit 7 tipos x 4 severidades + decisão)"
```

---

## Task 4: Repos `operationalProfileVersionsRepo` + `driftAlertsRepo`

**Files:**
- Modify: `src/db/repositories.ts`
- Test: `tests/unit/operational-profile-versions-repo.spec.ts` (NEW)
- Test: `tests/unit/drift-alerts-repo.spec.ts` (NEW)

**Scene:** Pattern já estabelecido em P3a/b/c: `applyTenantGuard` no insert; reads filtram por `getCurrentTenant()` + `getCurrentAgent()`. Tests mockam `@/db/repositories.js` à la P3 (sem DB local). Refletindo as regras do spec.

### Signatures

```typescript
export const operationalProfileVersionsRepo = {
  // Cria nova versão (sempre status=proposed por padrão, OU 'active' apenas no seed inicial)
  async create(input: {
    core_immutable: unknown;
    operational_profile: unknown;
    episodic_temp?: unknown;
    growth_backlog?: unknown;
    proposed_by: string;
    proposed_reason?: string;
    status?: ProfileStatus;  // default 'proposed'
  }): Promise<AgentOperationalProfileVersion>,

  async getActive(): Promise<AgentOperationalProfileVersion | null>,

  async getById(id: string): Promise<AgentOperationalProfileVersion | null>,

  async listByStatus(status: ProfileStatus): Promise<AgentOperationalProfileVersion[]>,

  // Transition (validated): proposed -> active | frozen | rolled_back, active -> frozen | rolled_back
  // Falha se: target='active' E já existe outro active no mesmo (tenant,agent)
  // Falha se: source não tem status compatível
  async transition(args: {
    id: string;
    to: ProfileStatus;
    approved_by?: string;
    rollback_reason?: string;
  }): Promise<{ ok: true; updated: AgentOperationalProfileVersion } | { ok: false; reason: string }>,

  // Helper: próximo número de version para (tenant, agent) — usado pelo create antes de gravar
  async nextVersion(): Promise<number>,
};

export const driftAlertsRepo = {
  async create(input: {
    profile_version_id?: string;
    drift_type: DriftType;
    severity: DriftSeverity;
    evidence: unknown;
    detected_by: string;
    decision: DriftDecision;
    decided_by: string;
  }): Promise<AgentDriftAlert>,

  async listUnresolved(): Promise<AgentDriftAlert[]>,
  async listByProfileVersion(profile_version_id: string): Promise<AgentDriftAlert[]>,

  async resolve(args: {
    id: string;
    resolution_note: string;
    resolved_by: string;
  }): Promise<void>,
};
```

### TDD Steps

- [ ] **Step 1: Inspect existing repos** (`procedureDefinitionsRepo`, `procedureTestsRepo`) for style.
- [ ] **Step 2: Write failing tests** — mock-DB pattern. Critical scenarios:
  - Cannot insert a second `active` version (transition fails with `reason='already_has_active'`)
  - `transition('proposed' → 'active')` validates current status
  - `nextVersion()` returns `max(version)+1` per (tenant, agent)
  - `transition('active' → 'rolled_back')` populates `rolled_back_at` + `rollback_reason`
- [ ] **Step 3: Run, fail.**
- [ ] **Step 4: Implement both repos in `src/db/repositories.ts`.**
- [ ] **Step 5: Run, pass.**
- [ ] **Step 6: Typecheck.**
- [ ] **Step 7: Commit**

```bash
git add src/db/repositories.ts tests/unit/operational-profile-versions-repo.spec.ts tests/unit/drift-alerts-repo.spec.ts
git commit -m "feat(p4): operationalProfileVersionsRepo + driftAlertsRepo"
```

---

## Task 5: Proposal Generator (seed inicial)

**Files:**
- Create: `src/identity/proposal-generator.ts`
- Test: `tests/unit/identity-proposal-generator.spec.ts`

**Scene:** Spec §7.3 P4.2: "proposal generator gera primeira versão `active` a partir de self_state + maia-prompt.md". É um seed determinístico — lê o conteúdo atual e decompõe em 4 camadas:
- **core_immutable** ← seção "## Identidade" + "## Princípios" do `maia-prompt.md` (intocável, é a identidade que o owner definiu)
- **operational_profile** ← seção "## Como você fala" + thresholds derivados de self_state (tom, vocabulário)
- **episodic_temp** ← {} inicial (preenchido com TTL conforme conversa rola)
- **growth_backlog** ← [] inicial

**IMPORTANT:** Esta é a ÚNICA situação em que cria-se diretamente como `status='active'` (seed). Toda outra criação é `status='proposed'`. Idempotente — se já existe versão `active` para o (tenant, agent), retorna a existente sem criar.

### Signature

```typescript
export type ProposalGeneratorResult =
  | { created: true; version: AgentOperationalProfileVersion }
  | { created: false; existing: AgentOperationalProfileVersion; reason: 'already_active' };

export async function seedInitialOperationalProfile(args: {
  source_self_state?: SelfState | null;
  source_prompt_path?: string;   // default '@/identity/maia-prompt.md'
}): Promise<ProposalGeneratorResult>;
```

### Implementation outline

1. Check if `operationalProfileVersionsRepo.getActive()` returns non-null → return `{ created: false, ... reason: 'already_active' }`.
2. Read `maia-prompt.md` (use the path passed or default to `src/identity/maia-prompt.md`).
3. Parse into sections:
   - **core_immutable**: { identity_block: "<conteúdo de ## Identidade>", principles: [<lista de princípios extraídos>] }
   - **operational_profile**: { voice_descriptor: "<conteúdo de ## Como você fala>", thresholds: { ... derivados de self_state.resumo_aprendizados se existir ... } }
   - **episodic_temp**: {}
   - **growth_backlog**: []
4. **Two-step creation** (preserves repo invariant that `create` defaults to `status='proposed'`):
   1. `created = await operationalProfileVersionsRepo.create({ ..., proposed_by: 'system_seed', proposed_reason: 'initial seed from self_state + maia-prompt.md' })`  → defaults to `status='proposed'`.
   2. `await operationalProfileVersionsRepo.transition({ id: created.id, to: 'active', approved_by: 'system_seed' })` → atomically activates and sets `activated_at`.
5. Re-fetch with `getById(created.id)` to return the active row.

**Rationale:** keeps `create()` simple and prevents accidental `status='active'` inserts elsewhere. The seed path is just `create+transition`. Repo's partial unique index (Task 2 SQL) guarantees idempotency: if another active already exists, the `transition` step fails — the proposal is then dropped or marked `frozen` for human review (return `{ created: false, existing: <active>, reason: 'already_active' }` after detecting the collision).

**Parsing approach:** Use regex `/^## ([^\n]+)\n([\s\S]*?)(?=^## |\Z)/gm` para extrair seções. Não usa LLM (determinístico).

### TDD Steps

- [ ] **Step 1: Write failing test** — 4 scenarios:
  - First seed creates version with status='active', `proposed_by='system_seed'`, all 4 camadas populated
  - Idempotency: chamada quando active já existe retorna `{ created: false }`
  - `maia-prompt.md` ausente → fallback razoável (versão vazia mas válida) ou erro tipado
  - self_state nulo OK — episodic_temp = {}, growth_backlog = []
- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement `src/identity/proposal-generator.ts`.**
- [ ] **Step 4: Run, pass.**
- [ ] **Step 5: Typecheck.**
- [ ] **Step 6: Commit**

```bash
git add src/identity/proposal-generator.ts tests/unit/identity-proposal-generator.spec.ts
git commit -m "feat(p4): proposal-generator (seed v1 active a partir de self_state + maia-prompt.md)"
```

---

## Task 6: Profile Renderer (4 camadas → texto prompt)

**Files:**
- Create: `src/identity/profile-renderer.ts`
- Test: `tests/unit/identity-profile-renderer.spec.ts`

**Scene:** Converte a versão `active` (registro do repo) em blocos de texto que o prompt-builder injeta. Determinístico — não chama LLM. Toda saída é validada: se `episodic_temp` tem itens marcados como `mention_allowed=false` (de P2), eles entram como hint ao invés de texto bruto.

### Signature

```typescript
export type RenderedProfile = {
  system_prompt_block: string;       // identidade + princípios + voz (vai em system)
  growth_hints_block: string | null; // backlog se houver
  episodic_summary_block: string | null; // sumário curto de episódios não-sensíveis
};

export function renderOperationalProfile(args: {
  version: AgentOperationalProfileVersion;
}): RenderedProfile;
```

### Implementation outline

1. **system_prompt_block:**
   ```
   ${core_immutable.identity_block}
   
   ## Princípios
   ${core_immutable.principles.map(p => '- ' + p).join('\n')}
   
   ## Voz operacional
   ${operational_profile.voice_descriptor}
   
   ## Parâmetros calibrados
   ${formatThresholds(operational_profile.thresholds)}
   ```

2. **growth_hints_block** (apenas se `growth_backlog.length > 0`):
   ```
   ## Capacidades em desenvolvimento (aprovadas, ainda não consolidadas)
   ${growth_backlog.map(g => '- ' + g.descricao).join('\n')}
   ```

3. **episodic_summary_block** — itera `episodic_temp.entries` (se houver) e filtra apenas `mention_allowed=true`. Se nenhuma → null.

**Defesa anti-vazamento:** se uma entrada de `episodic_temp` tem campo `proactive_use=false`, NUNCA inclui — nem hint nem sumário.

### TDD Steps

- [ ] **Step 1: Write failing test** — 5 scenarios:
  - Rende um profile completo com 4 camadas: 3 blocos não-null
  - growth_backlog vazio → growth_hints_block = null
  - episodic_temp vazio → episodic_summary_block = null
  - entrada de episodic com `mention_allowed=false` é OMITIDA do summary
  - entrada com `proactive_use=false` é OMITIDA mesmo se `mention_allowed=true` (defesa em camada)
- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement `src/identity/profile-renderer.ts`.**
- [ ] **Step 4: Run, pass.**
- [ ] **Step 5: Typecheck.**
- [ ] **Step 6: Commit**

```bash
git add src/identity/profile-renderer.ts tests/unit/identity-profile-renderer.spec.ts
git commit -m "feat(p4): profile-renderer (4 camadas -> blocos texto; respeita mention_allowed e proactive_use)"
```

---

## Task 7: Prompt-builder dual-read sob feature flag

**Files:**
- Modify: `src/agent/prompt-builder.ts`
- Test: `tests/unit/identity-prompt-builder-flag.spec.ts`

**Scene:** Quando flag `FEATURE_OPERATIONAL_PROFILE_V2` está ON, prompt-builder lê `operationalProfileVersionsRepo.getActive()` e renderiza via `renderOperationalProfile`. Quando OFF, mantém comportamento atual lendo `selfStateRepo.getActive()`. **Defesa absoluta:** se a versão retornada tem `status !== 'active'`, **NUNCA** injeta — fallback pro self_state legado e loga warning. Isso garante que `proposed` jamais entra em runtime mesmo se algo escapar.

### Substituição precisa

O `buildPrompt` atual compõe um system block com várias seções (`LLM_BOUNDARIES + sobre-você + escopo + facts + rules + memorySection + hintsSection + selfAwarenessSection + procedureSection`). O profile V2 substitui **apenas a seção "sobre-você"** (que hoje vem de `self?.system_prompt`).

Quando flag ON e profile válido:
- `systemBlock` (anteriormente `self?.system_prompt`) ← `rendered.system_prompt_block`
- Adicionar APÓS as seções existentes (após `procedureSection`): `rendered.growth_hints_block` (se !== null) e `rendered.episodic_summary_block` (se !== null).
- `selfVersionLabel` (usado em logs/audit) ← `op_profile_v${profile.version}`.

Demais seções (`LLM_BOUNDARIES`, escopo, facts, rules, memory, hints, self-awareness, procedure) **permanecem intactas** — V2 governa identidade/voz, não os blocos contextuais. Isso evita regressão em features de P1/P2/P3 já validadas.

Encontrar o local em `src/agent/prompt-builder.ts` (linha ~89) onde lê `selfStateRepo.getActive()`. Substituir por:

```typescript
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';
import { operationalProfileVersionsRepo } from '@/db/repositories.js';
import { renderOperationalProfile } from '@/identity/profile-renderer.js';
import { logger } from '@/lib/logger.js';

// ... existing imports

let systemBlock: string;
let growthHint: string | null = null;
let episodicSummary: string | null = null;
let selfVersionLabel: string;

if (featureFlags.isEnabled(FeatureFlagName.OPERATIONAL_PROFILE_V2)) {
  const profile = await operationalProfileVersionsRepo.getActive();
  if (profile && profile.status === 'active') {
    const rendered = renderOperationalProfile({ version: profile });
    systemBlock = rendered.system_prompt_block;
    growthHint = rendered.growth_hints_block;
    episodicSummary = rendered.episodic_summary_block;
    selfVersionLabel = `op_profile_v${profile.version}`;
  } else {
    logger.warn(
      { has_profile: !!profile, status: profile?.status },
      'identity.profile_v2_invalid_fallback_to_legacy',
    );
    const self = await selfStateRepo.getActive();
    systemBlock = self?.system_prompt ?? '';
    selfVersionLabel = `self_state_v${self?.versao ?? 0}`;
  }
} else {
  const self = await selfStateRepo.getActive();
  systemBlock = self?.system_prompt ?? '';
  selfVersionLabel = `self_state_v${self?.versao ?? 0}`;
}
```

(Pseudocódigo; ajustar para o flow exato em `prompt-builder.ts`. O ponto crítico é o branch + fallback de segurança.)

### TDD Steps

- [ ] **Step 1: Read full `src/agent/prompt-builder.ts`** to understand current `selfStateRepo.getActive()` usage.
- [ ] **Step 2: Write failing test** — 5 scenarios with `vi.mock` for both repos + feature-flags module:
  - Flag OFF → usa self_state legado (sanity: comportamento original preservado)
  - Flag ON + profile active → usa renderOperationalProfile, prompt contém o bloco do profile
  - Flag ON + profile proposed → **fallback para legacy + warning logado**
  - Flag ON + profile frozen → **fallback para legacy + warning logado**
  - Flag ON + nenhum profile (null) → fallback para legacy
- [ ] **Step 3: Run, fail.**
- [ ] **Step 4: Modify `src/agent/prompt-builder.ts`.**
- [ ] **Step 5: Run, pass.**
- [ ] **Step 6: Run existing prompt-builder tests** — não devem quebrar (flag OFF é o default).
- [ ] **Step 7: Typecheck.**
- [ ] **Step 8: Commit**

```bash
git add src/agent/prompt-builder.ts tests/unit/identity-prompt-builder-flag.spec.ts
git commit -m "feat(p4): prompt-builder dual-read (flag on -> profile v2 active; fallback seguro a self_state)"
```

---

## Task 8: Drift Detectors (7 tipos)

**Files:**
- Create: `src/cognition/drift/types.ts`
- Create: `src/cognition/drift/{tom,valores,confianca,vies,escopo,linguagem,procedimento}.ts`
- Create: `src/cognition/drift/index.ts`
- Test: `tests/unit/drift-detector-{tom,valores,confianca,vies,escopo,linguagem,procedimento}.spec.ts`

**Scene:** 7 módulos independentes, cada um implementa interface `DriftDetector`. Cada detector é chamado via `runCognitiveModule` (timeout + fallback + audit). Detector retorna `null` se não detectou drift, ou um `DriftEvidence` com tipo + payload de evidência.

### `types.ts`

```typescript
import type { DriftType } from '@/types/enums.js';
import type { AgentOperationalProfileVersion } from '@/db/schema.js';

export type DriftEvidence = {
  drift_type: DriftType;
  detected_by: string;       // module name
  payload: unknown;          // evidence-specific
  evidence_summary: string;  // human-readable short
};

export type DriftDetectionInput = {
  profile_active: AgentOperationalProfileVersion;
  recent_messages: Array<{ id: string; from: 'agent' | 'user'; text: string; created_at: Date }>;
  // additional context fetched outside (capabilities, self-model, procedures count)
  capabilities?: unknown;     // for escopo detector
  self_model_skills?: unknown; // for confianca detector
  recent_procedures?: unknown; // for procedimento detector
};

export interface DriftDetector {
  type: DriftType;
  detect(input: DriftDetectionInput): Promise<DriftEvidence | null>;
}
```

### Detector implementations (concise; full TDD per detector)

**`tom.ts`** — LLM-as-judge compara recent agent messages vs `core_immutable.identity_block + voice_descriptor`. Sonnet returns `{drift_detected: bool, severity_hint, examples[]}`. **NOT wrapped in `runCognitiveModule` here** — the orquestrador in `index.ts` does the wrapping (avoids double-wrapping; keeps detectors testable in isolation).

**`valores.ts`** — LLM verifica se mensagens do agente em N turnos contradizem `core_immutable.principles`. Sonnet.

**`confianca.ts`** — Cross-check com self-model: dado tópico que agente "disse saber", busca em `agent_capabilities_skill` → se confidence < 0.5 mas agente afirmou com firmeza, alerta. **Determinístico** (não usa LLM — usa scores).

**`vies.ts`** — Regex pattern set + LLM busca generalizações ("todos os clientes ...", "sempre que pessoa de X faz Y..."). Sonnet com lista de gatilhos pré-definidos.

**`escopo.ts`** — Para cada agent message recente, extrai promessas/compromissos (LLM); checa contra `agent_capabilities` se a capability existe. Se promete o que não tem, drift.

**`linguagem.ts`** — Vocabulário/registro vs `operational_profile.voice_descriptor`. Sonnet detecta tom desviante (gírias inadequadas, formalidade excessiva).

**`procedimento.ts`** — **Determinístico** (sem LLM). Conta procedures criadas nos últimos N dias com `evidência_count <= 2` E status `proposed` ou `active`. Se > threshold (1 por mês default), alert.

### `index.ts` — Orquestrador

**IMPORTANT API NOTES** (verified against actual codebase):
- `runCognitiveModule` returns `RunModuleResult<TOut> = { output: TOut|null, status, fallback_triggered, latency_ms }` — NOT the raw value. Filter via `r.output`.
- `triggered_by` accepts only `'sync_required' | 'sync_conditional' | 'async_event'`. **Use `'async_event'`** (not `'async_scheduled'`, which doesn't exist).
- Detectors are imported **directly** from each file (not via a separate `all-detectors.ts` — that file is NOT in the File Structure).

```typescript
import { runCognitiveModule } from '../runner.js';
import { tomDetector } from './tom.js';
import { valoresDetector } from './valores.js';
import { confiancaDetector } from './confianca.js';
import { viesDetector } from './vies.js';
import { escopoDetector } from './escopo.js';
import { linguagemDetector } from './linguagem.js';
import { procedimentoDetector } from './procedimento.js';
import type { DriftDetector, DriftDetectionInput, DriftEvidence } from './types.js';

const DETECTORS: DriftDetector[] = [
  tomDetector,
  valoresDetector,
  confiancaDetector,
  viesDetector,
  escopoDetector,
  linguagemDetector,
  procedimentoDetector,
];

export async function runAllDriftDetectors(
  input: DriftDetectionInput,
): Promise<DriftEvidence[]> {
  const results = await Promise.all(
    DETECTORS.map((d) =>
      runCognitiveModule<DriftEvidence | null>(
        { name: `drift_detector_${d.type}`, timeoutMs: 8000, triggered_by: 'async_event', fallback: null },
        () => d.detect(input),
      ),
    ),
  );
  return results
    .map((r) => r.output)
    .filter((o): o is DriftEvidence => o !== null);
}
```

Each detector module exports a named const, e.g.:
```typescript
// src/cognition/drift/tom.ts
import type { DriftDetector } from './types.js';

export const tomDetector: DriftDetector = {
  type: 'tom',
  async detect(input) { /* ... */ return null; },
};
```

### TDD Steps (per detector — repeat for all 7)

For each detector:
1. Write 2-3 failing tests:
   - happy path: drift detectado retorna evidence
   - no drift: retorna null
   - error/timeout (where applicable): fallback retorna null
2. Mock external deps (Anthropic for LLM ones, repos for `confianca`/`escopo`/`procedimento`).
3. Implement detector.
4. Pass.

**Commit grouping** — ORDEM IMPORTA porque `index.ts` orquestrador importa de TODOS os 7 detectors. Para evitar estado parcial que quebra build entre commits:

**Cluster 1 — types + 2 detectores LLM:** types + tom + valores. Sem `index.ts` ainda.
```bash
git add src/cognition/drift/types.ts src/cognition/drift/tom.ts src/cognition/drift/valores.ts tests/unit/drift-detector-tom.spec.ts tests/unit/drift-detector-valores.spec.ts
git commit -m "feat(p4): drift types + detectores tom/valores (LLM-as-judge)"
```

**Cluster 2 — 2 detectores mistos:** confianca + vies.
```bash
git add src/cognition/drift/confianca.ts src/cognition/drift/vies.ts tests/unit/drift-detector-confianca.spec.ts tests/unit/drift-detector-vies.spec.ts
git commit -m "feat(p4): drift detectores confianca (determinístico) + vies (regex+LLM)"
```

**Cluster 3 — 3 detectores restantes + orquestrador (fecha o conjunto):** escopo + linguagem + procedimento + `index.ts` + suas specs. Só agora o `index.ts` é introduzido — todos os 7 detectores existem.
```bash
git add src/cognition/drift/escopo.ts src/cognition/drift/linguagem.ts src/cognition/drift/procedimento.ts src/cognition/drift/index.ts tests/unit/drift-detector-escopo.spec.ts tests/unit/drift-detector-linguagem.spec.ts tests/unit/drift-detector-procedimento.spec.ts
git commit -m "feat(p4): drift detectores escopo/linguagem/procedimento + orquestrador runAllDriftDetectors"
```

**Build invariant:** após cada commit, `npx tsc --noEmit` precisa exit 0. Cluster 3 introduz `index.ts` exatamente quando todos os imports resolvem.

## Task 9: Decision Engine (severidade + ação)

**Files:**
- Create: `src/cognition/drift/decision-engine.ts`
- Test: `tests/unit/drift-decision-engine.spec.ts`

**Scene:** Recebe lista de `DriftEvidence` (output de Task 8) e decide para cada uma: severidade + ação. Spec §4.3 linha 152:
- `BAIXO` → `auto_approved` (registra alert mas não bloqueia)
- `MEDIO` → `queued_human` (alert criado, dashboard mostra para revisão)
- `ALTO` → `frozen` (versão `active` atual é **congelada**: status `active` → `frozen`, prompt-builder fallback para self_state)
- `CRITICO` → `rollback` (status `active` → `rolled_back`, registra `rollback_reason`)

**Severity classification:** baseada no `payload` da evidence + tipo do drift. Cada drift type tem regra própria (algumas LLM-derived no Task 8 já trazem `severity_hint`, outras determinísticas).

### Signature

```typescript
export type DriftDecisionResult = {
  drift_type: DriftType;
  severity: DriftSeverity;
  decision: DriftDecision;
  evidence: DriftEvidence;
  applied: boolean;       // true se a ação (freeze/rollback) foi aplicada no repo
  applied_error?: string; // se applied=false e tinha que ser
};

export async function decideAndApply(args: {
  evidences: DriftEvidence[];
  active_profile_id: string;
}): Promise<DriftDecisionResult[]>;
```

### Logic outline

```typescript
for (const ev of evidences) {
  const severity = classifySeverity(ev); // determinístico baseado em payload
  let decision: DriftDecision;
  let applied = false;
  let applied_error: string | undefined;

  switch (severity) {
    case 'baixo': decision = 'auto_approved'; break;
    case 'medio': decision = 'queued_human'; break;
    case 'alto':
      decision = 'frozen';
      try {
        const r = await operationalProfileVersionsRepo.transition({
          id: active_profile_id,
          to: 'frozen',
          approved_by: 'auto:drift_alto',
        });
        applied = r.ok;
        if (!r.ok) applied_error = r.reason;
      } catch (e) { applied_error = String(e); }
      break;
    case 'critico':
      decision = 'rollback';
      try {
        const r = await operationalProfileVersionsRepo.transition({
          id: active_profile_id,
          to: 'rolled_back',
          approved_by: 'auto:drift_critico',
          rollback_reason: ev.evidence_summary,
        });
        applied = r.ok;
        if (!r.ok) applied_error = r.reason;
      } catch (e) { applied_error = String(e); }
      break;
  }

  // Always persist alert
  await driftAlertsRepo.create({
    profile_version_id: active_profile_id,
    drift_type: ev.drift_type,
    severity,
    evidence: { ...ev.payload, summary: ev.evidence_summary },
    detected_by: ev.detected_by,
    decision,
    decided_by: 'decision_engine',
  });

  results.push({ drift_type: ev.drift_type, severity, decision, evidence: ev, applied, applied_error });
}
```

### Severity classification rules (per type)

```typescript
function classifySeverity(ev: DriftEvidence): DriftSeverity {
  switch (ev.drift_type) {
    case 'tom':
      // payload.examples.length: 1 → baixo, 2 → medio, 3+ → alto, with explicit_norm_violation → critico
      // ...
    case 'valores':
      // explicit principle contradiction → critico (sempre); soft contradiction → alto
    case 'confianca':
      // (asserted_confidence - actual) >= 0.5 → alto; >= 0.7 → critico; senão medio
    case 'vies':
      // generalization with regex_match → alto; soft generalization → medio; LLM-only → baixo
    case 'escopo':
      // promised what doesn't exist → alto (sempre); promised + acted → critico
    case 'linguagem':
      // single drift → baixo; recurring → medio; offensive → critico
    case 'procedimento':
      // procedure created with <=2 evidences → medio; <=1 evidence + active → alto
  }
}
```

Os números exatos são derivados do payload de cada detector. Plano define a tabela de decisão; implementação ajusta nas TDD passes.

### TDD Steps

- [ ] **Step 1: Write failing tests** — 8+ scenarios:
  - baixo → auto_approved, applied=false, alert criado
  - medio → queued_human, applied=false, alert criado
  - alto → frozen, applied=true (mock repo retorna ok)
  - critico → rollback, applied=true
  - alto mas repo retorna `{ok:false, reason:'no_active'}` → applied=false, applied_error set, alert ainda criado
  - múltiplas evidences processadas em loop independente (uma alto não impede a próxima ser tratada)
  - critico com payload['rollback_reason'] propaga para repo
  - severidade unknown → fallback baixo + alert created (defensivo)
- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement `decision-engine.ts`.**
- [ ] **Step 4: Run, pass.**
- [ ] **Step 5: Typecheck.**
- [ ] **Step 6: Commit**

```bash
git add src/cognition/drift/decision-engine.ts tests/unit/drift-decision-engine.spec.ts
git commit -m "feat(p4): drift decision engine (severidade -> ação: auto/queue/freeze/rollback)"
```

---

## Task 10: Worker `drift-monitor`

**Files:**
- Create: `src/workers/drift-monitor.ts`
- Modify: `src/workers/index.ts`
- Test: `tests/unit/drift-monitor.spec.ts`

**Scene:** Worker semanal (cron `0 3 * * 0` — domingo 03h). Para cada tenant × agent:
1. Carrega `operationalProfileVersionsRepo.getActive()`. Se null → skip (não há baseline para comparar).
2. Carrega `recent_messages` (N=200) dos últimos 7 dias, capabilities, self-model, procedures recentes.
3. Chama `runAllDriftDetectors(input)` → lista de evidences.
4. Chama `decideAndApply({ evidences, active_profile_id })` → results.
5. Loga sumário: total alerts, breakdown por severity.

### Implementation outline

```typescript
import { logger } from '@/lib/logger.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { tenantsRepo, operationalProfileVersionsRepo, /* etc */ } from '@/db/repositories.js';
import { runAllDriftDetectors } from '@/cognition/drift/index.js';
import { decideAndApply } from '@/cognition/drift/decision-engine.js';

export async function runDriftMonitor(): Promise<void> {
  const tenants = await tenantsRepo.list();
  let total_alerts = 0;
  const by_severity = { baixo: 0, medio: 0, alto: 0, critico: 0 };

  for (const t of tenants) {
    await runWithTenantContext({ tenant_id: t.id, agent_id: 'default' }, async () => {
      const active = await operationalProfileVersionsRepo.getActive();
      if (!active) {
        logger.info({ tenant_id: t.id }, 'drift_monitor.no_active_profile_skip');
        return;
      }

      const input = await assembleDriftInput(active);
      const evidences = await runAllDriftDetectors(input);
      if (evidences.length === 0) {
        logger.info({ tenant_id: t.id }, 'drift_monitor.no_drift');
        return;
      }

      const results = await decideAndApply({ evidences, active_profile_id: active.id });
      total_alerts += results.length;
      for (const r of results) by_severity[r.severity]++;
    });
  }

  logger.info({ total_alerts, by_severity }, 'drift_monitor.done');
}

async function assembleDriftInput(active: AgentOperationalProfileVersion): Promise<DriftDetectionInput> {
  // fetch from repos: recent_messages (mensagensRepo.recentByAgent),
  // capabilities (capabilitiesRepo.listByAgent),
  // self-model skills (selfModelRepo.listSkills),
  // recent_procedures (procedureDefinitionsRepo.listRecent)
  // ... cada repo já existe em fases anteriores; verificar signatures
}
```

### Schedule (em `src/workers/index.ts`)

```typescript
import { runDriftMonitor } from './drift-monitor.js';
// ...
{ name: 'drift_monitor', cron: '0 3 * * 0', fn: runDriftMonitor, phase: 4 },
```

### TDD Steps

- [ ] **Step 1: Write failing test** — mock repos + drift detectors + decision-engine:
  - Tenant com active profile + evidences vazias → no alert
  - Tenant com active profile + 2 evidences (1 baixo, 1 critico) → 2 alerts persistidos, summary logado
  - Tenant sem active profile → skip (assert no detector calls)
  - Múltiplos tenants iterados isoladamente
- [ ] **Step 2: Run, fail.**
- [ ] **Step 3: Implement worker.**
- [ ] **Step 4: Register job.**
- [ ] **Step 5: Run, pass.**
- [ ] **Step 6: Typecheck.**
- [ ] **Step 7: Commit**

```bash
git add src/workers/drift-monitor.ts src/workers/index.ts tests/unit/drift-monitor.spec.ts
git commit -m "feat(p4): worker drift-monitor (semanal: detect -> decide -> persist)"
```

---

## Task 11: Integration test end-to-end P4

**Files:**
- Create: `tests/integration/p4-operational-identity.spec.ts`

**Scene:** Cenário completo, mocked end-to-end. 6 cenários:

1. **Seed inicial**: `seedInitialOperationalProfile` cria v1 active. Idempotência: segunda chamada retorna `created: false`.
2. **Prompt-builder flag OFF** ignora profile, lê self_state.
3. **Prompt-builder flag ON + active válido** lê profile v2 e renderiza 4 camadas no system prompt.
4. **Prompt-builder flag ON + profile proposed** fallback para self_state + warning. (regra dura: `proposed` jamais entra em runtime.)
5. **Drift CRÍTICO disparado** pelo decision engine → active vira `rolled_back` no repo + alert persistido com `decision='rollback'`.
6. **Rollback via feature flag (killSwitch path)**: após cenário 5, invocar `featureFlags.killSwitch(FeatureFlagName.OPERATIONAL_PROFILE_V2)` → próxima chamada de prompt-builder usa self_state legado **sem restart**. Este é o caminho real <1min documentado na Acceptance #3. Cenário valida que kill switch toma efeito imediatamente.

Mock pattern como em P3c integration test: `vi.mock` para repos + Anthropic + feature flag override.

### TDD Steps

- [ ] **Step 1: Write 6 cenários.**
- [ ] **Step 2: Run, iterate** até todos passarem.
- [ ] **Step 3: Não modificar production code** (se descobrir bug, reportar DONE_WITH_CONCERNS).
- [ ] **Step 4: Typecheck.**
- [ ] **Step 5: Commit**

```bash
git add tests/integration/p4-operational-identity.spec.ts
git commit -m "test(p4): integration test operational identity (6 cenários mocked)"
```

---

## Task 12: Acceptance gates + runbook

**Files:**
- Create: `scripts/p4-acceptance-gates.sh`
- Create: `docs/runbooks/p4-operational-identity.md`

### Gates script (espelha P3c style)

7 gates:
1. Migrations 025 + 026 + downs existem; `grep` para `CREATE TABLE agent_operational_profile_versions` e `CREATE TABLE agent_drift_alerts`.
2. Vitest run sobre todas as specs P4 exits 0.
3. `npx tsc --noEmit` exits 0.
4. 7 detectores presentes: `ls src/cognition/drift/{tom,valores,confianca,vies,escopo,linguagem,procedimento}.ts` retorna 7 arquivos.
5. Worker `drift_monitor` registrado em `src/workers/index.ts`.
6. Feature flag `OPERATIONAL_PROFILE_V2` registrada em `src/types/enums.ts` e `src/config/env.ts`.
7. `grep "status === 'active'" src/agent/prompt-builder.ts` retorna ≥1 match (defesa anti-proposed validada).

### Runbook (espelha P3c style)

Sections:
- Overview P4 + escopo + dependências
- Feature flag operação: `FEATURE_OPERATIONAL_PROFILE_V2=true|false`
- Seed inicial: `npm run seed:operational-profile` (ou snippet de Node ad-hoc invocando `seedInitialOperationalProfile`)
- Como inspecionar versões: SQL `SELECT version, status, proposed_by FROM agent_operational_profile_versions WHERE tenant_id = $1 ORDER BY version DESC;`
- Como rodar drift detection manualmente (ad-hoc): invocar `runDriftMonitor()`
- Como aprovar `proposed → active` manualmente (operador): chamada a `operationalProfileVersionsRepo.transition`
- Como resolver alert: `driftAlertsRepo.resolve({ id, resolution_note, resolved_by })`
- **Rollback completo <1min (incidente)**: `featureFlags.killSwitch(FeatureFlagName.OPERATIONAL_PROFILE_V2)` via admin endpoint/REPL. Toma efeito imediato — sem restart. Para reverter o kill: `featureFlags.unkillSwitch(...)`.
- **Rollback persistente (pós-incidente)**: `FEATURE_OPERATIONAL_PROFILE_V2=false` no `.env` + `pm2 restart all` ou equivalente (~30s).
- Troubleshooting: profile não aparece no prompt? checar status active + flag on; drift detector falhando? checar `cognitive_module_log`; rollback automático disparou? consultar `agent_drift_alerts WHERE decision='rollback'`.
- Rollback de migration: 026 down primeiro (drift_alerts FK profile), depois 025 down.

### Steps

- [ ] **Step 1: Write script** (`bash -n` syntax check).
- [ ] **Step 2: Write runbook**.
- [ ] **Step 3: Commit**

```bash
git add scripts/p4-acceptance-gates.sh docs/runbooks/p4-operational-identity.md
git commit -m "docs(p4): acceptance gates script + runbook operational identity"
```

---

## Acceptance Criteria (P4 done — spec §9 linhas 597-601)

1. **`agent_operational_profile_versions` ativa com `status=proposed` NUNCA entra em runtime** — defesa em camadas:
   - DB: unique partial index permite só 1 `active`, validado no repo.
   - App: prompt-builder valida `status === 'active'` antes de injetar, com fallback + warning para qualquer outro estado.
   - Test: integration cenário 4 prova fallback.

2. **Drift detector classifica em 7 tipos × 4 severidades, com decisões auditadas** — 7 detectores + decision-engine + alerts persistidos.

3. **Rollback via feature flag funciona em < 1 minuto (sem deploy)** — **dois caminhos**:
   - **Caminho real <1min (recomendado em incidente):** `featureFlags.killSwitch(FeatureFlagName.OPERATIONAL_PROFILE_V2)` em runtime (admin endpoint ou REPL). Não requer restart — toma efeito na próxima chamada de `isEnabled()`. Spec §9 P4 é cumprido por essa via.
   - **Caminho persistente (pós-incidente):** flip `FEATURE_OPERATIONAL_PROFILE_V2=false` no `.env` + restart do processo (~30s). Necessário porque o singleton lê `config.*` em module-load. Runbook (Task 12) documenta isto explicitamente.

4. **self_state legado continua funcional em paralelo (não foi quebrado)** — Cenários flag-OFF preservados.

---

## Riscos & Mitigations

| Risco | Mitigação |
|---|---|
| `proposed` versão escapa para runtime | Defesa em 3 camadas: DB index único, repo transition validation, prompt-builder runtime check + log. |
| Drift detector LLM derruba performance do worker | `runCognitiveModule` aplica timeout 8s e fallback null. 7 detectores rodam em paralelo (`Promise.all`). Cron semanal não pressiona online path. |
| Decisão CRÍTICO automática prejudica usuário (rollback wrongful) | Severity classifier é determinístico (não LLM). Alerts persistidos com evidence completa → owner pode reverter manualmente. Flag OFF é escape rápido. |
| `maia-prompt.md` parsing quebra em variação de markdown | Parser usa regex robusta + fallback (versão vazia válida). Test seed cobre ausência. |
| `core_immutable` perdido em rollback acidental | Append-only — todas versões anteriores persistem. Rollback é nova transição, não delete. |
| flag flip não é instantâneo em produção | Runbook documenta procedimento exato. Worker pode cachear flag → invalidação necessária. |

---

## Notas finais

- **Migrations 025 + 026** entram em ordem (drift_alerts FK para profile_versions).
- **NÃO MERGEAR P4** sem P3c (#85) merged — sem dependências de schema, mas para manter ordem.
- **Quando rodar gates:** após DB up + 025/026 aplicadas + seed inicial executado.
- **P5 depende de P4** — drift detector escopo cross-checks com `agent_capabilities`, e gap-escalation P5 pode consumir alerts de drift como sinal.
- **Próximo passo após P4:** flag default ON após 2+ semanas estáveis em produção (spec §7.3 P4.5).
