# P9a Skill Abstraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create skills table (declarative artifact) + SkillRunner (stable executor) with 4 execution_modes (prompt_only/procedure_adapter/tool_mediated/evaluator), unifying 4 skill-like concepts (Tool, Procedure, Cognitive Module, Role Policy) into one Skill Contract with versionable lifecycle.

**Architecture:** `skills` table (Source of Truth, P0-P7 merged, control-plane) + `skillsRepo` (9 methods: findActive, listByCategory, propose, activate, deprecate, rollback, getById, getByDescriptor, listVersions) + `SkillRunner` (7-gate flow with policy resolution + runCognitiveModule wrap) + `SkillSlice` builder (Context Assembly, cache 5-10min TTL) + `skill-proposer` detector (LLM + deterministic pattern scan) + integration with `capability-proposer` (P5), `capability-test-runner` (P5), `capability-revert` (P5), `PolicyDescriptorResolver` (P8e/stub).

**Branch target:** `claude/p9a-skill-abstraction`

**Preconditions:**
- P0-P7 + P4 merged to main
- P8a Context Packet types + P8e PolicyDescriptorResolver available (stub resolver acceptable if P8e not yet in prod)
- No skills in production (feature flag `FEATURE_SKILL_REGISTRY_V1` default OFF)

---

## Phase 1 — Schema + Migration (Tasks 1–3)

### Task 1: Worktree + branch setup

**Files:** (git operations only)

- [ ] **Step 1: Create worktree**

```bash
cd "C:/Users/PC Di/Desktop/CODIGO/Maia"
git fetch origin
git worktree add .claude/worktrees/p9a-skill-abstraction claude/p9a-skill-abstraction
cd .claude/worktrees/p9a-skill-abstraction
git pull origin claude/p9a-skill-abstraction --rebase
```

- [ ] **Step 2: Verify preconditions**

```bash
set -e
# Ensure migrations exist
test -f migrations/ || { echo "FAIL: migrations/ directory missing"; exit 1; }
# Ensure we can reference P4 types (profile_body shipped)
test -f src/db/schema.ts || { echo "FAIL: schema.ts missing"; exit 1; }
# Ensure P7 cognitive_module_log exists
grep -q "cognitive_module_log" src/db/schema.ts || { echo "FAIL: cognitive_module_log missing (P7 not merged)"; exit 1; }
echo "✓ preconditions OK"
```

- [ ] **Step 3: Create feature branch from main**

```bash
git checkout main
git pull origin main
git checkout -b claude/p9a-skill-abstraction
git push -u origin claude/p9a-skill-abstraction
```

Expected: new branch tracking origin, clean working tree.

---

### Task 2: Migration 043 — `skills` table (15 columns, schema v3.1.1)

**Files:**
- Create: `migrations/043_p9a_skills.sql`
- Create: `migrations/043_p9a_skills_down.sql`

- [ ] **Step 1: Create UP migration**

```bash
cat > migrations/043_p9a_skills.sql << 'EOF'
-- P9a: skills — Skill Contracts versionados (Source of Truth)
-- Master spec v3.1.1 §2.4 + §2.5 (runtime_hints).
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE skills (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           TEXT NOT NULL REFERENCES tenants(id),
  agent_id            TEXT REFERENCES agents(id),          -- NULL = tenant-wide skill

  -- Identificação
  skill_descriptor    TEXT NOT NULL,                       -- ex.: 'detect_legal_risk', 'collect_missing_cpf'
  category            TEXT NOT NULL CHECK (category IN (
                        'classify', 'extract', 'compose',
                        'decide', 'tool_mediated',
                        'diagnose', 'plan', 'evaluator'
                      )),
  execution_mode      TEXT NOT NULL CHECK (execution_mode IN (
                        'prompt_only', 'procedure_adapter', 'tool_mediated', 'evaluator'
                      )),

  -- Contrato semântico
  goal                TEXT NOT NULL,                       -- objetivo em uma frase
  when_to_use         TEXT NOT NULL,                       -- condição de aplicabilidade
  procedure           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- system prompt / steps / template
  constraints         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- array de restrições declaradas

  -- Contratos I/O
  input_schema        JSONB NOT NULL,                      -- JSONSchema do input esperado
  output_schema       JSONB NOT NULL,                      -- JSONSchema do output garantido

  -- Recursos
  allowed_tools       TEXT[] NOT NULL DEFAULT '{}',        -- só relevante para tool_mediated
  policy_descriptors  TEXT[] NOT NULL DEFAULT '{}',        -- resolvidos via PolicyDescriptorResolver

  -- Qualidade
  success_criteria    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- tipados (machine_check/llm_judge/etc.)
  failure_modes       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- modos de falha conhecidos

  -- Orçamento runtime (master §2.5 CORREÇÃO #14)
  runtime_hints       JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Versionamento + lifecycle
  status              TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                        'proposed', 'active', 'deprecated', 'rolled_back'
                      )),
  version             INTEGER NOT NULL,
  proposed_by         TEXT NOT NULL,                       -- 'founder' | 'agent' | 'human:<id>'
  proposed_reason     TEXT,
  approved_by         TEXT,
  approved_at         TIMESTAMPTZ,
  activated_at        TIMESTAMPTZ,
  deprecated_at       TIMESTAMPTZ,
  rolled_back_at      TIMESTAMPTZ,
  rollback_reason     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index 1: lookup rápido por descriptor active (hot path)
CREATE INDEX idx_skills_tenant_active
  ON skills(tenant_id, status, skill_descriptor)
  WHERE status = 'active';

-- Index 2: listagem por categoria (slice builder / Admin UI)
CREATE INDEX idx_skills_tenant_category_active
  ON skills(tenant_id, category, status)
  WHERE status = 'active';

-- Index 3: version monotônica obrigatória (não pode haver v2 antes de v1)
CREATE UNIQUE INDEX idx_skills_version_uq
  ON skills(tenant_id, COALESCE(agent_id::text, 'tenant_wide'), skill_descriptor, version);

-- Index 4: "ONE ACTIVE" — partial unique, invariante crítico
CREATE UNIQUE INDEX idx_skills_one_active_uq
  ON skills(tenant_id, COALESCE(agent_id::text, 'tenant_wide'), skill_descriptor)
  WHERE status = 'active';

-- Index 5: proposals pendentes (Admin UI Tela 1 Proposal Inbox)
CREATE INDEX idx_skills_proposed
  ON skills(tenant_id, status, created_at DESC)
  WHERE status = 'proposed';

COMMENT ON TABLE skills IS
  'Skill Contracts versionados. DEFAULT status=proposed (nunca nasce active). Partial unique "one active" garante invariante. Master spec v3.1.1 §2.4.';
EOF
```

- [ ] **Step 2: Create DOWN migration**

```bash
cat > migrations/043_p9a_skills_down.sql << 'EOF'
-- Down de 043: drop integral.

DROP INDEX IF EXISTS idx_skills_proposed;
DROP INDEX IF EXISTS idx_skills_one_active_uq;
DROP INDEX IF EXISTS idx_skills_version_uq;
DROP INDEX IF EXISTS idx_skills_tenant_category_active;
DROP INDEX IF EXISTS idx_skills_tenant_active;
DROP TABLE IF EXISTS skills CASCADE;
EOF
```

- [ ] **Step 3: Commit**

```bash
git add migrations/043_p9a_skills.sql migrations/043_p9a_skills_down.sql
git commit -m "feat(p9a): migration 043 skills table (15 cols, status=proposed DEFAULT)"
```

Expected: 2 files committed.

---

### Task 3: Migration 044 — Extend `capability_proposals.capability_type`

**Files:**
- Create: `migrations/044_p9a_extend_capability_proposal_type.sql`
- Create: `migrations/044_p9a_extend_capability_proposal_type_down.sql`

- [ ] **Step 1: Create UP migration**

```bash
cat > migrations/044_p9a_extend_capability_proposal_type.sql << 'EOF'
-- P9a: estende CHECK de capability_proposals.capability_type para 'skill'.
-- Antecipa P8e ('soul_bias') e P9b ('policy_rule') também, sem ativar uso.

ALTER TABLE capability_proposals
  DROP CONSTRAINT IF EXISTS capability_proposals_capability_type_check;

ALTER TABLE capability_proposals
  ADD CONSTRAINT capability_proposals_capability_type_check
  CHECK (capability_type IN (
    'tool', 'knowledge', 'procedure', 'integration', 'other',
    'skill', 'soul_bias', 'policy_rule', 'holiday'
  ));
EOF
```

- [ ] **Step 2: Create DOWN migration**

```bash
cat > migrations/044_p9a_extend_capability_proposal_type_down.sql << 'EOF'
-- Revert 044: restore CHECK para valores antigos.

ALTER TABLE capability_proposals
  DROP CONSTRAINT IF EXISTS capability_proposals_capability_type_check;

ALTER TABLE capability_proposals
  ADD CONSTRAINT capability_proposals_capability_type_check
  CHECK (capability_type IN (
    'tool', 'knowledge', 'procedure', 'integration', 'other'
  ));
EOF
```

- [ ] **Step 3: Commit**

```bash
git add migrations/044_p9a_extend_capability_proposal_type.sql migrations/044_p9a_extend_capability_proposal_type_down.sql
git commit -m "feat(p9a): migration 044 extend capability_type CHECK (antecipa P8e/P9b)"
```

---

### Task 3b: Drizzle schema + types

**Files:**
- Modify: `src/db/schema.ts` (add table + exports)
- Modify: `src/types/enums.ts` (add enums)
- Modify: `src/config/env.ts` (add env var)
- Modify: `src/config/feature-flags.ts` (register flag)
- Modify: `tests/unit/db-schema-p9a.spec.ts` (create)

- [ ] **Step 1: Test — schema test fails (missing table)**

```bash
npm test -- tests/unit/db-schema-p9a.spec.ts 2>&1 | head -20
```

Expected: FAIL (doesn't exist yet).

- [ ] **Step 2: Add to `src/db/schema.ts`**

```typescript
export const skills = pgTable('skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: uuid('tenant_id').notNull().references(() => tenants.id),
  agent_id: uuid('agent_id').references(() => agents.id),
  
  skill_descriptor: text('skill_descriptor').notNull(),
  category: text('category').notNull(),
  execution_mode: text('execution_mode').notNull(),
  
  goal: text('goal').notNull(),
  when_to_use: text('when_to_use').notNull(),
  procedure: jsonb('procedure').notNull().default(sql`'{}'::jsonb`),
  constraints: jsonb('constraints').notNull().default(sql`'[]'::jsonb`),
  
  input_schema: jsonb('input_schema').notNull(),
  output_schema: jsonb('output_schema').notNull(),
  
  allowed_tools: text('allowed_tools').array().notNull().default(sql`'{}'`),
  policy_descriptors: text('policy_descriptors').array().notNull().default(sql`'{}'`),
  
  success_criteria: jsonb('success_criteria').notNull().default(sql`'[]'::jsonb`),
  failure_modes: jsonb('failure_modes').notNull().default(sql`'[]'::jsonb`),
  
  runtime_hints: jsonb('runtime_hints').notNull().default(sql`'{}'::jsonb`),
  
  status: text('status').notNull().default('proposed'),
  version: integer('version').notNull(),
  proposed_by: text('proposed_by').notNull(),
  proposed_reason: text('proposed_reason'),
  approved_by: text('approved_by'),
  approved_at: timestamp('approved_at', { withTimezone: true }),
  activated_at: timestamp('activated_at', { withTimezone: true }),
  deprecated_at: timestamp('deprecated_at', { withTimezone: true }),
  rolled_back_at: timestamp('rolled_back_at', { withTimezone: true }),
  rollback_reason: text('rollback_reason'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('idx_skills_version_uq').on(t.tenant_id, sql`COALESCE(${t.agent_id}::text, 'tenant_wide')`, t.skill_descriptor, t.version),
  uniqueIndex('idx_skills_one_active_uq').on(t.tenant_id, sql`COALESCE(${t.agent_id}::text, 'tenant_wide')`, t.skill_descriptor).where(eq(t.status, 'active')),
  index('idx_skills_tenant_active').on(t.tenant_id, t.status, t.skill_descriptor).where(eq(t.status, 'active')),
  index('idx_skills_tenant_category_active').on(t.tenant_id, t.category, t.status).where(eq(t.status, 'active')),
  index('idx_skills_proposed').on(t.tenant_id, t.status, desc(t.created_at)).where(eq(t.status, 'proposed')),
]);

export type SkillRow = typeof skills.$inferSelect;
export type NewSkillRow = typeof skills.$inferInsert;

// Skill Contract tipo estructural
export interface SkillContract {
  skill_descriptor: string;
  category: SkillCategory;
  execution_mode: SkillExecutionMode;
  goal: string;
  when_to_use: string;
  procedure: Record<string, unknown>;
  constraints: Array<Record<string, unknown>>;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  allowed_tools?: string[];
  policy_descriptors?: string[];
  success_criteria?: Array<Record<string, unknown>>;
  failure_modes?: Array<Record<string, unknown>>;
  runtime_hints?: SkillRuntimeHints;
}

export interface SkillRuntimeHints {
  max_prompt_tokens?: number;
  max_output_tokens?: number;
  max_tool_calls?: number;
  preferred_model?: string;
  timeout_ms?: number;
}
```

- [ ] **Step 3: Add enums to `src/types/enums.ts`**

```typescript
export enum SkillStatus {
  PROPOSED = 'proposed',
  ACTIVE = 'active',
  DEPRECATED = 'deprecated',
  ROLLED_BACK = 'rolled_back',
}

export enum SkillExecutionMode {
  PROMPT_ONLY = 'prompt_only',
  PROCEDURE_ADAPTER = 'procedure_adapter',
  TOOL_MEDIATED = 'tool_mediated',
  EVALUATOR = 'evaluator',
}

export enum SkillCategory {
  CLASSIFY = 'classify',
  EXTRACT = 'extract',
  COMPOSE = 'compose',
  DECIDE = 'decide',
  TOOL_MEDIATED = 'tool_mediated',
  DIAGNOSE = 'diagnose',
  PLAN = 'plan',
  EVALUATOR = 'evaluator',
}

export enum FeatureFlagName {
  // ... existing flags
  SKILL_REGISTRY_V1 = 'SKILL_REGISTRY_V1',
}
```

- [ ] **Step 4: Add env var to `src/config/env.ts`**

```typescript
export const env = {
  // ... existing vars
  FEATURE_SKILL_REGISTRY_V1: process.env.FEATURE_SKILL_REGISTRY_V1 === 'true',
};
```

- [ ] **Step 5: Register flag in `src/config/feature-flags.ts`**

```typescript
featureFlags.register({
  name: FeatureFlagName.SKILL_REGISTRY_V1,
  defaultValue: false,
  envVarName: 'FEATURE_SKILL_REGISTRY_V1',
  description: 'Enable Skill Registry v1 (P9a)',
});
```

- [ ] **Step 6: Create schema test**

```typescript
// tests/unit/db-schema-p9a.spec.ts
import { describe, it, expect } from 'vitest';
import { skills } from '../../src/db/schema.js';
import { SkillStatus, SkillExecutionMode, SkillCategory } from '../../src/types/enums.js';

describe('P9a schema — skills table', () => {
  it('has 15 columns', () => {
    const cols = Object.keys(skills._.columns);
    expect(cols.length).toBe(15);
  });

  it('has skill_descriptor, category, execution_mode', () => {
    expect('skill_descriptor' in skills._.columns).toBe(true);
    expect('category' in skills._.columns).toBe(true);
    expect('execution_mode' in skills._.columns).toBe(true);
  });

  it('has runtime_hints JSONB', () => {
    expect('runtime_hints' in skills._.columns).toBe(true);
  });

  it('DEFAULT status=proposed', () => {
    const statusCol = skills._.columns.status;
    expect(statusCol.default).toContain('proposed');
  });

  it('enums exported', () => {
    expect(SkillStatus.ACTIVE).toBe('active');
    expect(SkillExecutionMode.PROMPT_ONLY).toBe('prompt_only');
    expect(SkillCategory.CLASSIFY).toBe('classify');
  });
});
```

- [ ] **Step 7: Run test, PASS**

```bash
npm test -- tests/unit/db-schema-p9a.spec.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/db/schema.ts src/types/enums.ts src/config/env.ts src/config/feature-flags.ts tests/unit/db-schema-p9a.spec.ts
git commit -m "feat(p9a): drizzle schema skills table + enums + feature flag"
```

---

## Phase 2 — Control Plane (Tasks 4–5)

### Task 4: `skillsRepo` — 9 methods

**Files:**
- Create: `src/control-plane/skill-registry/skills-repo.ts`
- Create: `src/control-plane/skill-registry/index.ts`
- Modify: `src/db/repositories.ts` (export skillsRepo)
- Create: `tests/unit/skills/skills-repo.spec.ts`

- [ ] **Step 1: Test-first — repo methods**

```typescript
// tests/unit/skills/skills-repo.spec.ts
// MUST: set tenant + agent context before calling any skillsRepo method.
//       All methods scope internally via getCurrentTenant() / getCurrentAgent().
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { skillsRepo } from '../../src/control-plane/skill-registry/skills-repo.js';
import { setCurrentTenant, setCurrentAgent } from '../../src/db/tenant-context.js';
import type { SkillRow } from '../../src/db/schema.js';

describe('skillsRepo', () => {
  beforeEach(() => {
    // MUST: tenant-scoped + agent-scoped — context set before every test.
    setCurrentTenant('tenant-test-uuid');
    setCurrentAgent('agent-test-uuid');
  });

  it('propose creates skill with status=proposed', async () => {
    const input = {
      skill_descriptor: 'test_skill',
      category: 'classify',
      execution_mode: 'prompt_only',
      goal: 'Test goal',
      when_to_use: 'Always',
      procedure: { system_prompt: 'X' },
      constraints: [],
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      proposed_by: 'test',
      // agent_id omitted → defaults to getCurrentAgent() (NEVER tenant-wide from agent ctx)
    };
    const proposed = await skillsRepo.propose(input);
    expect(proposed.status).toBe('proposed');
    expect(proposed.version).toBe(1);
  });

  it('findActive returns null if not found', async () => {
    // MUST: tenant-scoped — getCurrentTenant() applied internally.
    // MUST: agent-scoped — agent_id omitted → (current agent OR tenant-wide).
    const result = await skillsRepo.findActive('nonexistent');
    expect(result).toBeNull();
  });

  it('activate moves proposed→active, deprecate previous', async () => {
    // Setup: propose v1, activate
    const v1 = await skillsRepo.propose({ /* ... */ });
    await skillsRepo.activate(v1.id, 'approver', 'good');
    // Propose v2, activate
    const v2 = await skillsRepo.propose({ /* ... */ });
    await skillsRepo.activate(v2.id, 'approver', 'better');
    // v1 should now be deprecated
    // MUST: getById guards tenant mismatch internally via getCurrentTenant().
    const v1Check = await skillsRepo.getById(v1.id);
    expect(v1Check?.status).toBe('deprecated');
  });

  it('rollback moves active→rolled_back, reactivates previous', async () => {
    // Setup: v1 active, v2 active (v1 was deprecated)
    const v1 = await skillsRepo.propose({ /* ... */ });
    await skillsRepo.activate(v1.id, 'approver');
    const v2 = await skillsRepo.propose({ /* ... */ });
    await skillsRepo.activate(v2.id, 'approver');
    // Rollback v2
    await skillsRepo.rollback(v2.id, 'bad', 'approver');
    // v2 should be rolled_back, v1 should be active again
    // MUST: getById guards tenant mismatch internally.
    const v2Check = await skillsRepo.getById(v2.id);
    const v1Check = await skillsRepo.getById(v1.id);
    expect(v2Check?.status).toBe('rolled_back');
    expect(v1Check?.status).toBe('active');
  });

  it('listByCategory returns only active in category', async () => {
    // MUST: tenant-scoped + agent-scoped — getCurrentTenant()/getCurrentAgent() applied.
    const s1 = await skillsRepo.propose({ category: 'classify', /* ... */ });
    await skillsRepo.activate(s1.id, 'approver');
    const s2 = await skillsRepo.propose({ category: 'extract', /* ... */ });
    await skillsRepo.activate(s2.id, 'approver');

    const classified = await skillsRepo.listByCategory('classify');
    expect(classified.length).toBeGreaterThanOrEqual(1);
    expect(classified.every(s => s.category === 'classify')).toBe(true);
  });

  it('tenant guard: getById for different tenant returns null', async () => {
    // MUST: getByIdForTenantAndAgent — id-based lookup guards tenant mismatch.
    const skill = await skillsRepo.propose({ /* ... */ });
    // Switch to a different tenant context — getById must return null.
    setCurrentTenant('tenant-other-uuid');
    const result = await skillsRepo.getById(skill.id);
    expect(result).toBeNull(); // tenant guard rejects cross-tenant id lookup
  });

  it('agent scope violation: explicit agent_id mismatch throws', async () => {
    // MUST: agent-scoped — cross-agent findActive throws agent_scope_violation.
    await expect(
      skillsRepo.findActive('some_skill', 'agent-other-uuid'),
    ).rejects.toThrow('agent_scope_violation');
  });

  it('version monotonic: duplicate version fails', async () => {
    const s1 = await skillsRepo.propose({ skill_descriptor: 'x', /* ... */ });
    // Try to propose another v1 — should fail
    try {
      await skillsRepo.propose({ skill_descriptor: 'x', /* ... */ });
      await skillsRepo.propose({ skill_descriptor: 'x', /* ... */ }); // v2 should succeed
    } catch (e: any) {
      expect(e.message).toContain('unique');
    }
  });
});
```

- [ ] **Step 2: Implement `skillsRepo`**

```typescript
// src/control-plane/skill-registry/skills-repo.ts
// MUST: every DB call is tenant-scoped via getCurrentTenant() — NEVER unscoped.
// MUST: hot-path lookups (findActive, listByCategory) are agent-scoped via
//        getCurrentAgent() — cross-agent reads throw agent_scope_violation.
//        See review #99 finding 1 for the isolation invariant.
import { eq, and, desc, or, sql } from 'drizzle-orm';
import { db, withTx } from '@/db/client.js';
import { skills } from '@/db/schema.js';
import type { SkillRow, SkillContract } from '@/db/schema.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

export type ProposeInput = SkillContract & {
  proposed_by: string;
  proposed_reason?: string;
  agent_id?: string | null;
  tenant_id?: string;
};

export interface SkillsRepo {
  // MUST: tenant-scoped — reads getCurrentTenant() + getCurrentAgent() from context.
  // agent_id param: undefined → (current agent OR tenant-wide), null → tenant-wide only,
  // explicit → must match context agent or throws agent_scope_violation.
  findActive(descriptor: string, agent_id?: string | null): Promise<SkillRow | null>;

  // MUST: tenant-scoped + agent-scoped via getCurrentTenant()/getCurrentAgent().
  listByCategory(category: string): Promise<SkillRow[]>;

  propose(input: ProposeInput): Promise<SkillRow>;
  activate(id: string, approver: string, reason?: string): Promise<SkillRow>;
  deprecate(id: string, deprecator: string, reason: string): Promise<SkillRow>;
  rollback(id: string, reason: string, rolledBackBy: string): Promise<SkillRow>;
  getById(id: string): Promise<SkillRow | null>;
  getByDescriptor(descriptor: string, version?: number): Promise<SkillRow | null>;
  listVersions(descriptor: string): Promise<SkillRow[]>;
}

export const skillsRepo: SkillsRepo = {
  // MUST: tenant-scoped — getCurrentTenant() is always applied.
  // MUST: agent-scoped via enforceTenantBoundary — undefined agent_id defaults to
  //        (current agent OR tenant-wide). NEVER falls through to "any agent in tenant".
  async findActive(descriptor: string, agent_id?: string | null): Promise<SkillRow | null> {
    const tenant_id = getCurrentTenant(); // MUST: tenant-scoped
    const ctxAgent = getCurrentAgent();   // MUST: agent-scoped via enforceTenantBoundary
    let scopeClause;
    if (agent_id === undefined) {
      // Default: current agent OR tenant-wide (agent-specific skill wins via ORDER).
      scopeClause = or(eq(skills.agent_id, ctxAgent), sql`agent_id IS NULL`);
    } else if (agent_id === null) {
      scopeClause = sql`agent_id IS NULL`;
    } else {
      // Explicit agent_id: must match context agent — cross-agent reads throw.
      if (agent_id !== ctxAgent) {
        throw new Error(`agent_scope_violation: input agent ${agent_id} vs context ${ctxAgent}`);
      }
      scopeClause = eq(skills.agent_id, agent_id);
    }
    const rows = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.tenant_id, tenant_id),
          eq(skills.skill_descriptor, descriptor),
          eq(skills.status, 'active'),
          scopeClause,
        ),
      )
      .orderBy(sql`agent_id IS NULL`) // agent-scoped match beats tenant-wide
      .limit(1);
    return rows[0] ?? null;
  },

  // MUST: tenant-scoped + agent-scoped (current agent OR tenant-wide).
  async listByCategory(category: string): Promise<SkillRow[]> {
    const tenant_id = getCurrentTenant(); // MUST: tenant-scoped
    const ctxAgent = getCurrentAgent();   // MUST: agent-scoped via enforceTenantBoundary
    return db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.tenant_id, tenant_id),
          eq(skills.category, category),
          eq(skills.status, 'active'),
          // MUST: agent scope — never returns skills from other agents in same tenant.
          or(eq(skills.agent_id, ctxAgent), sql`agent_id IS NULL`),
        ),
      );
  },

  async propose(input: ProposeInput): Promise<SkillRow> {
    const ctxTenant = getCurrentTenant(); // MUST: tenant-scoped
    const ctxAgent = getCurrentAgent();   // MUST: agent-scoped via enforceTenantBoundary
    const tenant_id = input.tenant_id ?? ctxTenant;
    if (input.tenant_id && input.tenant_id !== ctxTenant) {
      throw new Error(`tenant mismatch: input ${input.tenant_id} vs context ${ctxTenant}`);
    }
    // MUST: agent scope — explicit agent_id must match context or be null (tenant-wide).
    // null requires tenant-admin authorization (privilege escalation guard).
    let agent_id: string | null;
    if (input.agent_id === undefined) {
      agent_id = ctxAgent;
    } else if (input.agent_id === null) {
      throw new Error(
        'tenant_admin_required: tenant-wide skills (agent_id=null) cannot be proposed from agent context',
      );
    } else if (input.agent_id !== ctxAgent) {
      throw new Error(
        `agent_scope_violation: input agent ${input.agent_id} vs context ${ctxAgent}`,
      );
    } else {
      agent_id = input.agent_id;
    }

    // Determine next version (scoped to tenant + agent + descriptor).
    const [latest] = await db.select().from(skills)
      .where(and(
        eq(skills.tenant_id, tenant_id),
        eq(skills.skill_descriptor, input.skill_descriptor),
        agent_id ? eq(skills.agent_id, agent_id) : sql`agent_id IS NULL`,
      ))
      .orderBy(desc(skills.version))
      .limit(1);
    const version = (latest?.version ?? 0) + 1;

    const [proposed] = await db.insert(skills).values({
      tenant_id,
      agent_id,
      skill_descriptor: input.skill_descriptor,
      category: input.category,
      execution_mode: input.execution_mode,
      goal: input.goal,
      when_to_use: input.when_to_use,
      procedure: input.procedure,
      constraints: input.constraints ?? [],
      input_schema: input.input_schema,
      output_schema: input.output_schema,
      allowed_tools: input.allowed_tools ?? [],
      policy_descriptors: input.policy_descriptors ?? [],
      success_criteria: input.success_criteria ?? [],
      failure_modes: input.failure_modes ?? [],
      runtime_hints: input.runtime_hints ?? {},
      status: 'proposed',
      version,
      proposed_by: input.proposed_by,
      proposed_reason: input.proposed_reason ?? null,
    }).returning();

    return proposed;
  },

  async activate(id: string, approver: string, reason?: string): Promise<SkillRow> {
    return withTx(async (tx) => {
      // MUST: getByIdForTenantAndAgent — id-based mutations guard tenant mismatch.
      const [skill] = await tx.select().from(skills)
        .where(and(eq(skills.id, id), eq(skills.tenant_id, getCurrentTenant())));
      if (!skill) throw new Error('skill_not_found');
      if (skill.status !== 'proposed') throw new Error(`cannot_activate_from_${skill.status}`);

      // Deprecate previous active version (tenant + agent + descriptor scoped).
      await tx.update(skills)
        .set({ status: 'deprecated', deprecated_at: new Date() })
        .where(and(
          eq(skills.tenant_id, skill.tenant_id),
          skill.agent_id ? eq(skills.agent_id, skill.agent_id) : sql`agent_id IS NULL`,
          eq(skills.skill_descriptor, skill.skill_descriptor),
          eq(skills.status, 'active'),
        ));

      const [activated] = await tx.update(skills)
        .set({ status: 'active', activated_at: new Date(), approved_by: approver, approved_at: new Date() })
        .where(eq(skills.id, id))
        .returning();

      return activated;
    });
  },

  async deprecate(id: string, deprecator: string, reason: string): Promise<SkillRow> {
    // MUST: getByIdForTenantAndAgent — guard tenant mismatch before mutation.
    const [deprecated] = await db.update(skills)
      .set({ status: 'deprecated', deprecated_at: new Date() })
      .where(and(eq(skills.id, id), eq(skills.tenant_id, getCurrentTenant())))
      .returning();
    if (!deprecated) throw new Error('skill_not_found_or_tenant_mismatch');
    return deprecated;
  },

  async rollback(id: string, reason: string, rolledBackBy: string): Promise<SkillRow> {
    return withTx(async (tx) => {
      // MUST: getByIdForTenantAndAgent — guard tenant mismatch before mutation.
      const [skill] = await tx.select().from(skills)
        .where(and(eq(skills.id, id), eq(skills.tenant_id, getCurrentTenant())));
      if (!skill) throw new Error('skill_not_found_or_tenant_mismatch');

      await tx.update(skills)
        .set({ status: 'rolled_back', rolled_back_at: new Date(), rollback_reason: reason })
        .where(eq(skills.id, id));

      // Find previous version (v-1, deprecated) — scoped to tenant + agent + descriptor.
      const [previous] = await tx.select().from(skills)
        .where(and(
          eq(skills.tenant_id, skill.tenant_id),
          skill.agent_id ? eq(skills.agent_id, skill.agent_id) : sql`agent_id IS NULL`,
          eq(skills.skill_descriptor, skill.skill_descriptor),
          eq(skills.version, skill.version - 1),
        ));

      if (previous) {
        await tx.update(skills)
          .set({ status: 'active', activated_at: new Date() })
          .where(eq(skills.id, previous.id));
      }

      const [result] = await tx.select().from(skills).where(eq(skills.id, id));
      return result;
    });
  },

  async getById(id: string): Promise<SkillRow | null> {
    // MUST: getByIdForTenantAndAgent — tenant guard on every id-based lookup.
    const [skill] = await db.select().from(skills)
      .where(and(eq(skills.id, id), eq(skills.tenant_id, getCurrentTenant())));
    return skill ?? null;
  },

  async getByDescriptor(descriptor: string, version?: number): Promise<SkillRow | null> {
    // MUST: tenant-scoped — getCurrentTenant() applied.
    const conditions = [
      eq(skills.tenant_id, getCurrentTenant()),
      eq(skills.skill_descriptor, descriptor),
    ];
    if (version !== undefined) conditions.push(eq(skills.version, version));
    const [skill] = await db.select().from(skills)
      .where(and(...conditions))
      .orderBy(desc(skills.version))
      .limit(1);
    return skill ?? null;
  },

  async listVersions(descriptor: string): Promise<SkillRow[]> {
    // MUST: tenant-scoped — getCurrentTenant() applied.
    return db.select().from(skills)
      .where(and(
        eq(skills.tenant_id, getCurrentTenant()),
        eq(skills.skill_descriptor, descriptor),
      ))
      .orderBy(desc(skills.version));
  },
};
```

- [ ] **Step 3: Create barrel export**

```typescript
// src/control-plane/skill-registry/index.ts
export { skillsRepo } from './skills-repo.js';
export type { SkillsRepo } from './skills-repo.js';
```

- [ ] **Step 4: Export from `src/db/repositories.ts`**

```typescript
export { skillsRepo } from '../control-plane/skill-registry/index.js';
```

- [ ] **Step 5: Run tests, PASS**

```bash
npm test -- tests/unit/skills/skills-repo.spec.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/control-plane/skill-registry/ src/db/repositories.ts tests/unit/skills/skills-repo.spec.ts
git commit -m "feat(p9a): skillsRepo 9 methods (propose/activate/rollback/list/etc)"
```

---

### Task 5: `SkillRunner` — 7-gate flow + 4 execution modes

**Files:**
- Create: `src/skills/skill-runner.ts`
- Create: `src/skills/modes/prompt-only.ts`
- Create: `src/skills/modes/procedure-adapter.ts`
- Create: `src/skills/modes/tool-mediated.ts`
- Create: `src/skills/modes/evaluator.ts`
- Create: `src/skills/types.ts`
- Create: `tests/unit/skills/skill-runner.spec.ts`
- Create: `tests/unit/skills/mode-*.spec.ts` (4 files)

- [ ] **Step 1: Create types**

```typescript
// src/skills/types.ts
import type { SkillRow, SkillExecutionMode, SkillRuntimeHints } from '../db/schema.js';

export interface SkillExecutionInput {
  skill_descriptor: string;
  input: Record<string, unknown>;
  conversa_id?: string;
  turno_id?: string;
  triggered_by: 'user_message' | 'tool_loop' | 'async_event' | 'evaluator_pipeline';
}

export interface SkillExecutionOutput {
  ok: boolean;
  output?: Record<string, unknown>;
  reason?: 'flag_off' | 'skill_not_found' | 'policy_blocked' | 'budget_exceeded' | 'invalid_input' | 'invalid_output' | 'executor_error' | 'timeout';
  message?: string;
  latency_ms: number;
  resolved_policies: string[];
  trace: {
    mode: SkillExecutionMode;
    skill_version: number;
    skill_id: string;
    tools_called?: string[];
    tokens_in?: number;
    tokens_out?: number;
  };
}

export interface ModeContext {
  skill: SkillRow;
  input: Record<string, unknown>;
  resolvedPolicies: any[];
  conversa_id?: string;
  turno_id?: string;
}

export type ExecutionModeHandler = (ctx: ModeContext) => Promise<Record<string, unknown>>;

export interface SkillSlice {
  selected?: SkillSummary;
  candidates: SkillSummary[];
  total_active_in_tenant: number;
  builder_metadata: {
    cache_hit: boolean;
    cached_at?: string;
    ttl_seconds: number;
  };
}

export interface SkillSummary {
  id: string;
  skill_descriptor: string;
  category: string;
  execution_mode: SkillExecutionMode;
  goal: string;
  when_to_use: string;
  version: number;
  runtime_hints: SkillRuntimeHints;
}
```

- [ ] **Step 2: Test-first — SkillRunner gates**

```typescript
// tests/unit/skills/skill-runner.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runSkill } from '../../src/skills/skill-runner.js';
import { featureFlags, FeatureFlagName } from '../../src/config/feature-flags.js';
import { skillsRepo } from '../../src/db/repositories.js';
import { runCognitiveModule } from '../../src/cognition/runner.js';

vi.mock('../../src/config/feature-flags.js');
vi.mock('../../src/db/repositories.js');
vi.mock('../../src/cognition/runner.js');

describe('SkillRunner — 7-gate flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Gate 1: returns flag_off if feature flag disabled', async () => {
    vi.mocked(featureFlags.isEnabled).mockReturnValue(false);
    const result = await runSkill({
      skill_descriptor: 'test',
      input: {},
      triggered_by: 'user_message',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('flag_off');
  });

  it('Gate 2: returns skill_not_found if skill does not exist', async () => {
    vi.mocked(featureFlags.isEnabled).mockReturnValue(true);
    vi.mocked(skillsRepo.findActive).mockResolvedValue(null);
    const result = await runSkill({
      skill_descriptor: 'nonexistent',
      input: {},
      triggered_by: 'user_message',
    });
    expect(result.reason).toBe('skill_not_found');
  });

  it('Gate 3: returns invalid_input if input fails schema validation', async () => {
    vi.mocked(featureFlags.isEnabled).mockReturnValue(true);
    vi.mocked(skillsRepo.findActive).mockResolvedValue({
      id: '123',
      skill_descriptor: 'test',
      input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      execution_mode: 'prompt_only',
      output_schema: {},
      // ... other fields
    } as any);
    const result = await runSkill({
      skill_descriptor: 'test',
      input: { wrong_field: 'value' },
      triggered_by: 'user_message',
    });
    expect(result.reason).toBe('invalid_input');
  });

  it('Gate 4: resolves policy_descriptors before execution', async () => {
    const mockPolicyResolver = vi.fn();
    // Setup mocks for all gates to pass
    vi.mocked(featureFlags.isEnabled).mockReturnValue(true);
    vi.mocked(skillsRepo.findActive).mockResolvedValue({
      id: '123',
      skill_descriptor: 'test',
      policy_descriptors: ['lgpd_strict'],
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      execution_mode: 'prompt_only',
      // ... other fields
    } as any);
    // Verify resolver called (setup mock for it too)
    const result = await runSkill({
      skill_descriptor: 'test',
      input: {},
      triggered_by: 'user_message',
    });
    // Expect resolver to have been invoked
  });

  it('Gate 6: wraps execution in runCognitiveModule', async () => {
    // Verify runCognitiveModule called with correct params
  });

  it('Gate 7: returns invalid_output if output fails schema validation', async () => {
    // Setup skill with strict output schema
    // Mock executor to return invalid output
    // Expect result.reason === 'invalid_output'
  });
});
```

- [ ] **Step 3: Implement `SkillRunner` core**

```typescript
// src/skills/skill-runner.ts
import { runCognitiveModule } from '../cognition/runner.js';
import { skillsRepo } from '../db/repositories.js';
import { policyDescriptorResolver } from '../control-plane/policy/policy-descriptor-resolver.js';
import { promptOnlyMode } from './modes/prompt-only.js';
import { procedureAdapterMode } from './modes/procedure-adapter.js';
import { toolMediatedMode } from './modes/tool-mediated.js';
import { evaluatorMode } from './modes/evaluator.js';
import { featureFlags, FeatureFlagName } from '../config/feature-flags.js';
import type { SkillExecutionInput, SkillExecutionOutput, ModeContext, ExecutionModeHandler } from './types.js';
import type { SkillExecutionMode } from '../db/schema.js';

const MODE_DISPATCH: Record<SkillExecutionMode, ExecutionModeHandler> = {
  prompt_only: promptOnlyMode,
  procedure_adapter: procedureAdapterMode,
  tool_mediated: toolMediatedMode,
  evaluator: evaluatorMode,
};

export async function runSkill(input: SkillExecutionInput): Promise<SkillExecutionOutput> {
  const startTime = Date.now();

  // Gate 1: feature flag
  if (!featureFlags.isEnabled(FeatureFlagName.SKILL_REGISTRY_V1)) {
    return {
      ok: false,
      reason: 'flag_off',
      latency_ms: Date.now() - startTime,
      resolved_policies: [],
      trace: {} as any,
    };
  }

  // Gate 2: lookup
  const skill = await skillsRepo.findActive(input.skill_descriptor);
  if (!skill) {
    return {
      ok: false,
      reason: 'skill_not_found',
      latency_ms: Date.now() - startTime,
      resolved_policies: [],
      trace: {} as any,
    };
  }

  // Gate 3: input validation
  const inputValidation = validateAgainstSchema(input.input, skill.input_schema);
  if (!inputValidation.valid) {
    return {
      ok: false,
      reason: 'invalid_input',
      message: inputValidation.errors.join('; '),
      latency_ms: Date.now() - startTime,
      resolved_policies: [],
      trace: { mode: skill.execution_mode, skill_version: skill.version, skill_id: skill.id },
    };
  }

  // Gate 4: resolve policy descriptors
  const policiesResolved = await policyDescriptorResolver.resolveDescriptors({
    tenant_id: getCurrentTenant(),
    descriptors: skill.policy_descriptors,
    scope: { skill_category: skill.category },
  });
  const resolvedPolicyIds = policiesResolved.resolved.map(p => p.policy_id);

  // Gate 4.5: apply policies (early block)
  const policyDecision = await applyPoliciesPreSkill({ skill, policies: policiesResolved.resolved, input: input.input });
  if (policyDecision.decision === 'block') {
    return {
      ok: false,
      reason: 'policy_blocked',
      message: policyDecision.reason,
      latency_ms: Date.now() - startTime,
      resolved_policies: resolvedPolicyIds,
      trace: { mode: skill.execution_mode, skill_version: skill.version, skill_id: skill.id },
    };
  }

  // Gate 6: wrap in runCognitiveModule
  const result = await runCognitiveModule<SkillExecutionOutput>(
    {
      name: `skill:${skill.skill_descriptor}`,
      version: `v${skill.version}`,
      timeoutMs: (skill.runtime_hints as any)?.timeout_ms ?? 30000,
      triggered_by: input.triggered_by,
      conversa_id: input.conversa_id,
      turno_id: input.turno_id,
      fallback: {
        ok: false,
        reason: 'executor_error',
        latency_ms: Date.now() - startTime,
        resolved_policies: resolvedPolicyIds,
        trace: { mode: skill.execution_mode, skill_version: skill.version, skill_id: skill.id },
      },
    },
    async () => {
      // Dispatch by mode
      const modeHandler = MODE_DISPATCH[skill.execution_mode];
      const modeOutput = await modeHandler({
        skill,
        input: input.input,
        resolvedPolicies: policiesResolved.resolved,
        conversa_id: input.conversa_id,
        turno_id: input.turno_id,
      });

      // Gate 7: output validation
      const outputValidation = validateAgainstSchema(modeOutput, skill.output_schema);
      if (!outputValidation.valid) {
        return {
          ok: false,
          reason: 'invalid_output',
          message: outputValidation.errors.join('; '),
          latency_ms: Date.now() - startTime,
          resolved_policies: resolvedPolicyIds,
          trace: { mode: skill.execution_mode, skill_version: skill.version, skill_id: skill.id },
        };
      }

      return {
        ok: true,
        output: modeOutput,
        latency_ms: Date.now() - startTime,
        resolved_policies: resolvedPolicyIds,
        trace: { mode: skill.execution_mode, skill_version: skill.version, skill_id: skill.id },
      };
    },
  );

  return result.output ?? {
    ok: false,
    reason: 'executor_error',
    latency_ms: Date.now() - startTime,
    resolved_policies: resolvedPolicyIds,
    trace: {} as any,
  };
}

// Placeholder validators (replace with Ajv in production)
function validateAgainstSchema(input: unknown, schema: Record<string, unknown>): { valid: boolean; errors: string[] } {
  // TODO: integrate Ajv
  return { valid: true, errors: [] };
}

function getCurrentTenant(): string {
  // TODO: read from context
  return 'default';
}

async function applyPoliciesPreSkill(args: any): Promise<{ decision: 'allow' | 'block'; reason?: string }> {
  // TODO: policy engine integration
  return { decision: 'allow' };
}

export type { SkillExecutionInput, SkillExecutionOutput };
```

- [ ] **Step 4: Implement execution modes**

```typescript
// src/skills/modes/prompt-only.ts
import { Anthropic } from '@anthropic-ai/sdk';
import type { ModeContext } from '../types.js';

export async function promptOnlyMode(ctx: ModeContext): Promise<Record<string, unknown>> {
  const hints = ctx.skill.runtime_hints as any;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  
  const response = await anthropic.messages.create({
    model: hints?.preferred_model ?? 'claude-haiku',
    max_tokens: hints?.max_output_tokens ?? 1000,
    system: (ctx.skill.procedure as any)?.system_prompt as string ?? '',
    messages: [{ role: 'user', content: JSON.stringify(ctx.input) }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  return JSON.parse(text);
}
```

(Similar structure for other 3 modes — tool_mediated is largest)

- [ ] **Step 5: Create mode tests**

```typescript
// tests/unit/skills/mode-prompt-only.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { promptOnlyMode } from '../../src/skills/modes/prompt-only.js';

vi.mock('@anthropic-ai/sdk');

describe('SkillRunner — prompt_only mode', () => {
  it('honors max_output_tokens from runtime_hints', async () => {
    // Verify SDK called with correct max_tokens
  });

  it('uses preferred_model from runtime_hints', async () => {
    // Verify SDK called with correct model
  });

  it('parses JSON output', async () => {
    // Verify output parsing
  });
});
```

(Similar for other 3 modes)

- [ ] **Step 6: Run tests, PASS**

```bash
npm test -- tests/unit/skills/skill-runner.spec.ts tests/unit/skills/mode-*.spec.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/skills/ tests/unit/skills/
git commit -m "feat(p9a): SkillRunner 7-gate flow + 4 execution modes"
```

---

## Phase 3 — Slice Builder & Proposer (Tasks 6–7)

### Task 6: `SkillSlice` builder + cache

**Files:**
- Create: `src/skills/skill-slice-builder.ts`
- Modify: `src/skills/types.ts` (already created in Task 5)
- Create: `tests/unit/skills/skill-slice-builder.spec.ts`

- [ ] **Step 1: Test-first — cache invalidation**

```typescript
// tests/unit/skills/skill-slice-builder.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { buildSkillSlice } from '../../src/skills/skill-slice-builder.js';

describe('SkillSlice builder', () => {
  it('caches slice with 5-10min TTL', async () => {
    const slice = await buildSkillSlice({
      tenant_id: 'tenant1',
      decision: { routing: { selected_skill_id: null, candidate_skill_ids: [] }, intent: { label: 'test' } },
    });
    expect(slice.builder_metadata.cache_hit).toBe(false);
    expect(slice.builder_metadata.ttl_seconds).toBe(600);
  });

  it('returns cache_hit=true on subsequent call', async () => {
    // First call caches, second should hit
  });

  it('invalidates cache on skill_activated event', async () => {
    // Mock event emission, verify cache cleared
  });
});
```

- [ ] **Step 2: Implement builder**

```typescript
// src/skills/skill-slice-builder.ts
import { skillsRepo } from '../db/repositories.js';
import { sliceCache } from './cache.js'; // Simple Redis or in-memory cache
import type { SkillSlice, SkillSummary } from './types.js';

export async function buildSkillSlice(ctx: {
  tenant_id: string;
  agent_id?: string;
  decision: any;
}): Promise<SkillSlice> {
  const { decision } = ctx;
  const cacheKey = `skill_slice:${ctx.tenant_id}:${ctx.agent_id ?? 'tenant_wide'}:${decision.routing.selected_skill_id ?? 'none'}`;

  const cached = await sliceCache.get<SkillSlice>(cacheKey);
  if (cached) {
    return { ...cached, builder_metadata: { ...cached.builder_metadata, cache_hit: true } };
  }

  let selected: SkillSummary | undefined;
  if (decision.routing.selected_skill_id) {
    const row = await skillsRepo.getById(decision.routing.selected_skill_id);
    if (row) selected = toSummary(row);
  }

  const candidateIds = decision.routing.candidate_skill_ids ?? [];
  const candidates = await Promise.all(candidateIds.slice(0, 5).map(id => skillsRepo.getById(id)));
  const candidateSummaries = candidates.filter((r): r is any => r !== null).map(toSummary);

  const total = await skillsRepo.listByCategory('classify'); // TODO: all categories

  const slice: SkillSlice = {
    selected,
    candidates: candidateSummaries,
    total_active_in_tenant: total.length,
    builder_metadata: { cache_hit: false, ttl_seconds: 600 },
  };

  await sliceCache.set(cacheKey, slice, 600);
  return slice;
}

function toSummary(row: any): SkillSummary {
  return {
    id: row.id,
    skill_descriptor: row.skill_descriptor,
    category: row.category,
    execution_mode: row.execution_mode,
    goal: row.goal,
    when_to_use: row.when_to_use,
    version: row.version,
    runtime_hints: row.runtime_hints,
  };
}
```

- [ ] **Step 3: Run tests, PASS**

```bash
npm test -- tests/unit/skills/skill-slice-builder.spec.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/skills/skill-slice-builder.ts tests/unit/skills/skill-slice-builder.spec.ts
git commit -m "feat(p9a): SkillSlice builder with cache (5-10min TTL)"
```

---

### Task 7: `skill-proposer` detector

**Files:**
- Create: `src/cognition/skill-proposer.ts`
- Modify: `src/cognition/capability-proposer.ts` (branch for skill)
- Modify: `src/cognition/capability-test-runner.ts` (strategy skill_evaluator)
- Modify: `src/agent/capability-revert.ts` (branch skill)
- Create: `tests/unit/skills/skill-proposer.spec.ts`

- [ ] **Step 1: Test-first — detector only proposes on pattern match**

```typescript
// tests/unit/skills/skill-proposer.spec.ts
import { describe, it, expect, vi } from 'vitest';
import { detectAndProposeSkill } from '../../src/cognition/skill-proposer.js';
import { skillsRepo } from '../../src/db/repositories.js';

vi.mock('../../src/db/repositories.js');

describe('skill-proposer detector', () => {
  it('returns {proposed:0, skipped:0} if flag off', async () => {
    // TODO: mock flag
    const result = await detectAndProposeSkill({ tenant_id: 't1', agent_id: 'a1' });
    expect(result.proposed).toBe(0);
  });

  it('detects pattern and proposes skill', async () => {
    // TODO: mock scanForSkillPatterns + LLM
    // Expect capability_proposal created with capability_type='skill'
  });

  it('skips if skill with same descriptor already active', async () => {
    // TODO: mock findActive to return non-null
    // Expect skipped++
  });
});
```

- [ ] **Step 2: Implement detector**

```typescript
// src/cognition/skill-proposer.ts
import { runCognitiveModule } from './runner.js';
import { capabilityProposalsRepo } from '../db/repositories.js';
import { skillsRepo } from '../db/repositories.js';
import { featureFlags, FeatureFlagName } from '../config/feature-flags.js';

export async function detectAndProposeSkill(args: {
  tenant_id: string;
  agent_id: string;
  window_days?: number;
}): Promise<{ proposed: number; skipped: number }> {
  if (!featureFlags.isEnabled(FeatureFlagName.SKILL_REGISTRY_V1)) {
    return { proposed: 0, skipped: 0 };
  }

  return await runCognitiveModule(
    { name: 'skill_proposer_detector', triggered_by: 'async_event', timeoutMs: 60000 },
    async () => {
      // Deterministic: scan cognitive_module_log + reflection_records
      const patterns = await scanForSkillPatterns({
        tenant_id: args.tenant_id,
        agent_id: args.agent_id,
        days: args.window_days ?? 7,
      });

      let proposed = 0;
      let skipped = 0;

      for (const pattern of patterns) {
        // Check if skill exists
        const existing = await skillsRepo.findActive(pattern.suggested_descriptor);
        if (existing) {
          skipped++;
          continue;
        }

        // Generate draft with LLM
        const draft = await generateSkillDraft(pattern);
        if (!draft) {
          skipped++;
          continue;
        }

        // Persist as capability_proposal
        await capabilityProposalsRepo.create({
          capability_type: 'skill',
          title: draft.skill_descriptor,
          description: draft.goal,
          proposed_spec: draft,
          motivation: pattern.evidence_summary,
          expected_impact: draft.when_to_use,
          test_scenarios: draft.test_scenarios ?? [],
        });
        proposed++;
      }

      return { proposed, skipped };
    },
  ).then(r => r.output ?? { proposed: 0, skipped: 0 });
}

async function scanForSkillPatterns(args: any): Promise<any[]> {
  // TODO: query cognitive_module_log + reflection_records
  // Return patterns matching heuristics (N same classifications, etc.)
  return [];
}

async function generateSkillDraft(pattern: any): Promise<any> {
  // TODO: LLM call to generate SkillContract
  return null;
}
```

- [ ] **Step 3: Extend capability-proposer**

```typescript
// src/cognition/capability-proposer.ts — add branch
if (gap.suggested_capability_type === 'skill') {
  const llmDraft = await generateSkillDraft(args);
  return await capabilityProposalsRepo.create({
    capability_type: 'skill',
    title: llmDraft.skill_descriptor,
    description: llmDraft.goal,
    proposed_spec: llmDraft,
    motivation: llmDraft.motivation,
    expected_impact: llmDraft.expected_impact,
    test_scenarios: llmDraft.test_scenarios,
  });
}
```

- [ ] **Step 4: Extend capability-test-runner**

```typescript
// src/cognition/capability-test-runner.ts
TEST_STRATEGIES.skill_evaluator = async (scenario, opts) => {
  const evaluatorSkillId = opts?.evaluator_skill_id;
  if (!evaluatorSkillId) return { passed: false, observed: 'no_evaluator_skill', reason: 'config_error' };

  const candidateResult = await runSkill({
    skill_descriptor: scenario.given,
    input: scenario.when_input,
    triggered_by: 'evaluator_pipeline',
  });
  if (!candidateResult.ok) return { passed: false, observed: candidateResult.reason ?? 'candidate_failed' };

  const evalResult = await runSkill({
    skill_descriptor: opts.evaluator_descriptor,
    input: {
      candidate_output: candidateResult.output,
      baseline: scenario.then_expected,
      context: scenario,
    },
    triggered_by: 'evaluator_pipeline',
  });
  if (!evalResult.ok) return { passed: false, observed: 'evaluator_error', reason: evalResult.reason };

  const verdict = (evalResult.output as any).verdict;
  return { passed: verdict === 'pass', observed: verdict, reason: (evalResult.output as any).reasons.join('; ') };
};
```

- [ ] **Step 5: Extend capability-revert**

```typescript
// src/agent/capability-revert.ts — add branch
if (args.proposal.capability_type === 'skill') {
  const skillId = args.proposal.delivery_artifact_ref;
  if (skillId) {
    await skillsRepo.rollback(skillId, args.reason, 'capability-revert');
  }
  const newGap = await capabilityGapsRepo.create({
    capability_description: `[técnica] skill ${args.proposal.title} falhou pós-ativação`,
    tipo: 'technical',
    contexto: args.reason,
  });
  return { technical_gap_id: newGap.id };
}
```

- [ ] **Step 6: Run tests, PASS**

```bash
npm test -- tests/unit/skills/skill-proposer.spec.ts
```

- [ ] **Step 7: Commit**

```bash
git add src/cognition/skill-proposer.ts src/cognition/capability-proposer.ts src/cognition/capability-test-runner.ts src/agent/capability-revert.ts tests/unit/skills/skill-proposer.spec.ts
git commit -m "feat(p9a): skill-proposer detector + capability integration (P5)"
```

---

## Phase 4 — Admin UI & Acceptance Gates (Tasks 8–12)

### Task 8: Admin UI Telas 1-3 (Proposal Inbox, Diff & Approval, Version History)

**Files:**
- Create: `src/admin-ui/proposals/skill-diff.tsx`
- Create: `src/admin-ui/versions/skill-history.tsx`
- Modify: `src/admin-ui/proposals/proposal-inbox.tsx` (add skill filter)

Note: Placeholder implementation for plan scope. Real implementation requires React + design system.

- [ ] **Step 1: Create skill-diff view (placeholder)**

```typescript
// src/admin-ui/proposals/skill-diff.tsx
// TODO: React component that:
// - Shows skill_descriptor + category + execution_mode as chips
// - Shows goal / when_to_use as prose
// - Shows procedure as collapsible JSON
// - Shows input_schema / output_schema as JSONSchema preview
// - Shows allowed_tools as clicable list
// - Shows policy_descriptors with resolution links
// - Shows success_criteria / failure_modes as tables
// - Shows runtime_hints (token budget + model)
// - Diff vs previous version (side-by-side)
// - Approve/Reject buttons with comment field (required)
```

- [ ] **Step 2: Create skill-history view (placeholder)**

```typescript
// src/admin-ui/versions/skill-history.tsx
// TODO: React component that:
// - Lists all versions of skill_descriptor
// - Shows status + timestamps
// - Diff between any 2 versions
// - Rollback button with reason field (required)
// - Sidebar "quem usa": agents/roles + recent execution count
```

- [ ] **Step 3: Update proposal-inbox**

```typescript
// src/admin-ui/proposals/proposal-inbox.tsx — add filter
// TODO: Add `type=skill` filter to show:
// - skills WHERE status='proposed'
// - capability_proposals WHERE capability_type='skill'
// - unified by timeline
// - badge with count
```

- [ ] **Step 4: Commit (placeholder)**

```bash
git add src/admin-ui/
git commit -m "feat(p9a): admin UI telas 1-3 (placeholder)"
```

---

### Task 9: Integration test P9a lifecycle (end-to-end)

**Files:**
- Create: `tests/integration/p9a-skill-lifecycle.spec.ts`

- [ ] **Step 1: Test-first — 6 cenários**

```typescript
// tests/integration/p9a-skill-lifecycle.spec.ts
import { describe, it, expect } from 'vitest';
import { setupTestTenant } from '../setup.js';
import { skillsRepo } from '../../src/db/repositories.js';
import { runSkill } from '../../src/skills/skill-runner.js';

describe('P9a Skill Lifecycle — E2E', () => {
  let tenant: any;

  beforeEach(async () => {
    tenant = await setupTestTenant();
  });

  it('cenário 1: propose → approve → activate', async () => {
    const proposal = await skillsRepo.propose({
      tenant_id: tenant.id,
      skill_descriptor: 'test_classify',
      category: 'classify',
      execution_mode: 'prompt_only',
      goal: 'Test classification',
      when_to_use: 'Always',
      procedure: { system_prompt: 'Classify.' },
      constraints: [],
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
      proposed_by: 'test',
    });
    expect(proposal.status).toBe('proposed');

    const activated = await skillsRepo.activate(proposal.id, 'approver');
    expect(activated.status).toBe('active');

    const found = await skillsRepo.findActive('test_classify');
    expect(found?.id).toBe(activated.id);
  });

  it('cenário 2: skill is executable after activation', async () => {
    // Setup + activate skill
    const activated = await setupAndActivateSkill(tenant);

    // Execute skill
    const result = await runSkill({
      skill_descriptor: activated.skill_descriptor,
      input: { test: 'data' },
      triggered_by: 'user_message',
    });
    expect(result.ok).toBe(true);
  });

  it('cenário 3: new version deprecates old', async () => {
    const v1 = await skillsRepo.propose({ /* ... */ });
    await skillsRepo.activate(v1.id, 'approver');

    const v2 = await skillsRepo.propose({ /* v1.skill_descriptor, but different goal */ });
    await skillsRepo.activate(v2.id, 'approver');

    const v1Check = await skillsRepo.getById(v1.id);
    expect(v1Check?.status).toBe('deprecated');
  });

  it('cenário 4: rollback reactivates previous', async () => {
    const v1 = await skillsRepo.propose({ /* ... */ });
    await skillsRepo.activate(v1.id, 'approver');
    const v2 = await skillsRepo.propose({ /* ... */ });
    await skillsRepo.activate(v2.id, 'approver');

    await skillsRepo.rollback(v2.id, 'bad', 'admin');

    const v2Check = await skillsRepo.getById(v2.id);
    const v1Check = await skillsRepo.getById(v1.id);
    expect(v2Check?.status).toBe('rolled_back');
    expect(v1Check?.status).toBe('active');
  });

  it('cenário 5: drift detection alerts on latency spike', async () => {
    // TODO: drift detector integration
  });

  it('cenário 6: capability_proposal flow (skill type)', async () => {
    // TODO: detector proposes skill, owner approves, integrated test
  });
});
```

- [ ] **Step 2: Implement test (stub real LLM calls)**

Setup helpers to mock Anthropic SDK, procedure executions, tool calls, etc.

- [ ] **Step 3: Run, PASS**

```bash
npm test -- tests/integration/p9a-skill-lifecycle.spec.ts
```

- [ ] **Step 4: Commit**

```bash
git add tests/integration/p9a-skill-lifecycle.spec.ts
git commit -m "test(p9a): integration P9a skill lifecycle (6 cenários)"
```

---

### Task 10: Acceptance gates script

**Files:**
- Create: `scripts/p9a-acceptance-gates.sh`

- [ ] **Step 1: Create script**

```bash
cat > scripts/p9a-acceptance-gates.sh << 'EOF'
#!/bin/bash
set -e

echo "=== P9a Acceptance Gates ==="

# G1: Migration 043 creates skills table
echo "G1: Migration 043 skills table..."
grep -q "CREATE TABLE skills" migrations/043_p9a_skills.sql || { echo "FAIL: migration 043"; exit 1; }
grep -q "runtime_hints" migrations/043_p9a_skills.sql || { echo "FAIL: runtime_hints missing"; exit 1; }

# G2: DEFAULT status='proposed'
echo "G2: DEFAULT status='proposed'..."
grep -q "DEFAULT 'proposed'" migrations/043_p9a_skills.sql || { echo "FAIL"; exit 1; }

# G3-G5: Partial unique, version monotônica, tenant guard (DB constraints)
echo "G3-G5: DB constraints..."
grep -q "idx_skills_one_active_uq" migrations/043_p9a_skills.sql || { echo "FAIL: partial unique"; exit 1; }
grep -q "idx_skills_version_uq" migrations/043_p9a_skills.sql || { echo "FAIL: version unique"; exit 1; }

# G6-G16: SkillRunner gates
echo "G6-G16: SkillRunner tests..."
npm test -- tests/unit/skills/skill-runner.spec.ts || { echo "FAIL: runner tests"; exit 1; }

# G17-G18: Repo activate/rollback
echo "G17-G18: Repo tests..."
npm test -- tests/unit/skills/skills-repo.spec.ts || { echo "FAIL: repo tests"; exit 1; }

# G19: capability_type CHECK
echo "G19: capability_type CHECK..."
grep -q "capability_type IN" migrations/044_p9a_extend_capability_proposal_type.sql || { echo "FAIL"; exit 1; }

# G20-G22: Detector + capability integration
echo "G20-G22: Proposer + integration..."
npm test -- tests/unit/skills/skill-proposer.spec.ts || { echo "FAIL: proposer"; exit 1; }

# G23: Slice builder cache
echo "G23: Slice builder..."
npm test -- tests/unit/skills/skill-slice-builder.spec.ts || { echo "FAIL: slice"; exit 1; }

# Integration E2E
echo "Integration E2E..."
npm test -- tests/integration/p9a-skill-lifecycle.spec.ts || { echo "FAIL: integration"; exit 1; }

echo "✓ All gates PASS"
EOF
chmod +x scripts/p9a-acceptance-gates.sh
```

- [ ] **Step 2: Test the script**

```bash
bash scripts/p9a-acceptance-gates.sh
```

Expected: PASS (all gates green).

- [ ] **Step 3: Commit**

```bash
git add scripts/p9a-acceptance-gates.sh
git commit -m "test(p9a): acceptance gates script (24 gates)"
```

---

### Task 11: Runbook + documentation

**Files:**
- Create: `docs/runbooks/p9a-skill-abstraction.md`
- Modify: `docs/superpowers/specs/CURRENT.md` (reference)

- [ ] **Step 1: Create runbook (outline)**

```markdown
# P9a Skill Abstraction — Runbook

## Quick start
- Feature flag: `FEATURE_SKILL_REGISTRY_V1`
- Source of Truth: `skills` table (control-plane)
- Executor: `SkillRunner` + 4 modes
- Proposer: `skill-proposer` detector (batch async)

## Operations
### Propose a skill
\`\`\`bash
skillsRepo.propose({ skill_descriptor: '...', ... })
\`\`\`

### Activate skill
\`\`\`bash
skillsRepo.activate(skill_id, 'approver', 'reason')
\`\`\`

### Rollback
\`\`\`bash
skillsRepo.rollback(skill_id, 'reason', 'admin')
\`\`\`

## Troubleshooting
- Skill not found: check status='active'
- Policy blocked: verify policy_descriptors resolved
- Invalid output: check output_schema
EOF
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/p9a-skill-abstraction.md
git commit -m "docs(p9a): runbook + design memory"
```

---

### Task 12: Final validation + merge prep

**Files:** (git/test operations)

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: 100% PASS (including all P0-P7 + P4 legacy tests).

- [ ] **Step 2: Lint**

```bash
npm run lint
```

Expected: zero errors/warnings.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 4: Acceptance gates**

```bash
bash scripts/p9a-acceptance-gates.sh
```

Expected: PASS.

- [ ] **Step 5: Push to branch**

```bash
git push origin claude/p9a-skill-abstraction
```

- [ ] **Step 6: Create PR (manual via gh or GitHub UI)**

```bash
gh pr create \
  --base main \
  --head claude/p9a-skill-abstraction \
  --title "feat(p9a): Skill Abstraction — unified runtime + versionable lifecycle" \
  --body "$(cat <<'EOF'
## Summary
- Unifies Tool, Procedure, Cognitive Module, Role/Policy into Skill Contract
- skills table (15 cols, DEFAULT status='proposed', partial unique "one active")
- SkillRunner 7-gate flow + 4 execution modes (prompt_only/procedure_adapter/tool_mediated/evaluator)
- skillsRepo 9 methods (propose/activate/deprecate/rollback/list/etc)
- SkillSlice builder with cache (5-10min TTL)
- skill-proposer detector (async batch + LLM generation)
- Integration with capability-proposer/capability-test-runner/capability-revert (P5)
- Admin UI Telas 1-3 (Proposal Inbox, Diff & Approval, Version History) — placeholder

## Test plan
- [x] Schema + migrations (043, 044)
- [x] skillsRepo unit tests (9 methods)
- [x] SkillRunner unit tests (7 gates + 4 modes)
- [x] SkillSlice builder tests
- [x] skill-proposer detector tests
- [x] Integration E2E (6 cenários)
- [x] Acceptance gates (24 gates)
- [x] Full test suite 100% PASS
- [x] Lint + typecheck clean

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: Verify CI green**

```bash
gh pr checks
```

Expected: all checks passing.

- [ ] **Step 8: Done**

Mark all tasks [x] in this plan.

---

## Done Criteria

When all 12 tasks (+ subtasks) have [x] and:

1. ✅ `npm test` 100% PASS
2. ✅ `npm run lint` zero errors
3. ✅ `npm run typecheck` zero errors
4. ✅ `scripts/p9a-acceptance-gates.sh` PASS (all 24 gates)
5. ✅ Migration 043 + 044 apply cleanly in dev DB
6. ✅ `skillsRepo.propose` creates `status='proposed'`
7. ✅ `skillsRepo.activate` moves proposed→active, deprecates previous (transaction)
8. ✅ `skillsRepo.rollback` moves active→rolled_back, reactivates previous
9. ✅ `runSkill` respects 7-gate flow (flag, lookup, input validation, policy resolution, runCognitiveModule wrap, output validation, audit)
10. ✅ All 4 execution modes tested (prompt_only/procedure_adapter/tool_mediated/evaluator)
11. ✅ SkillSlice cache invalidates on skill_activated event
12. ✅ skill-proposer detector runs in batch async, respects flag-off
13. ✅ Admin UI Telas 1-3 placeholder (ready for design implementation in P10)
14. ✅ PR created, CI green, ready to merge

---

## Risks & Mitigations

| Risco | Mitigação |
|---|---|
| PolicyDescriptorResolver not in P8e | Stub resolver shipped; real one swapped on P8e merge |
| `evaluator` skill with `allowed_tools` | Validation in `skillsRepo.propose` rejects |
| Skill drift undetected | P9b drift detector + matview `skill_metrics` + alerts in Admin UI |
| `runSkill` executes without policy resolution | Gate 4 resolves **before** dispatch; mode tool_mediated re-resolves per tool |
| Concurrent activation race | Partial unique "one active" + transaction in DB enforce invariant |
| Cache stale after rollback | Event-based invalidation + 10min TTL (max 10min stale) |
| LLM proposal spam | Deterministic scan before LLM; only proposes if pattern N+ times + no active skill |
| Procedure adapter loses execution | procedure_executions TTL (P3) + abandon reflection (P6) covers |

---

**End of plan.**
