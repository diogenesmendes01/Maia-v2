# Maia v2 — P0 Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir o alicerce multi-tenant da Maia v2 sem quebrar comportamento atual. Adiciona `tenants` + `agents` + colunas `tenant_id`/`agent_id` em tabelas relevantes, `tenant_guard` middleware nas queries, `cognitive_module_log` ativa, enums base e framework de feature flags. P0 termina com NOT NULL forçado em runtime — qualquer query sem `tenant_id` explícito falha.

**Architecture:** Sub-fases sequenciais com fail-closed em isolamento: (1) cria contratos estruturais (tenants/agents/cognitive_module_log/enums/feature-flags); (2) adiciona colunas nullable com default; (3) backfill em batch; (4) índices; (5) middleware guard; (6) flip NOT NULL. Cada sub-fase tem rollback testado. Schemas dormentes de P2-P6 NÃO entram aqui — vêm no início da fase proprietária.

**Tech Stack:** TypeScript, Drizzle ORM (`src/db/client.ts`, `src/db/schema.ts`, `src/db/repositories.ts`), PostgreSQL 16, vitest, BullMQ + Redis (workers existentes).

**Reference:** Spec — [docs/superpowers/specs/2026-05-11-maia-v2-cognitive-architecture-design.md](../specs/2026-05-11-maia-v2-cognitive-architecture-design.md) §7.1 (P0 sub-fases) e §9 P0 (acceptance gates).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/types/enums.ts` | Create | Enums base (TenantStatus, AgentStatus, CognitiveEventType, FeatureFlagName) — única fonte de verdade |
| `src/config/feature-flags.ts` | Create | Framework de feature flags com kill switch e override em runtime |
| `src/config/env.ts` | Modify | Adicionar variáveis `FEATURE_*` lidas pelo framework |
| `migrations/007_p0_tenants_agents.sql` | Create | Cria `tenants`, `agents`, seeds 'default' row em cada |
| `migrations/008_p0_cognitive_module_log.sql` | Create | Cria `cognitive_module_log` (ativa imediatamente) |
| `migrations/009_p0_add_tenant_agent_columns.sql` | Create | Adiciona `tenant_id`, `agent_id` nullable + default em tabelas relevantes |
| `migrations/010_p0_backfill_tenant_agent.sql` | Create | UPDATE em batch pra popular `tenant_id='default'`, `agent_id='default'` |
| `migrations/011_p0_tenant_agent_indexes.sql` | Create | Índices em `(tenant_id, agent_id, *)` em tabelas relevantes |
| `migrations/012_p0_force_not_null.sql` | Create | ALTER COLUMN SET NOT NULL em todas as colunas tenant_id/agent_id |
| `src/db/schema.ts` | Modify | Adicionar `tenants`, `agents`, `cognitive_module_log` + colunas `tenant_id`/`agent_id` |
| `src/db/repositories.ts` | Modify | Adicionar `tenantsRepo`, `agentsRepo`, `cognitiveModuleLogRepo`; aplicar `tenant_guard` em todos os repos existentes |
| `src/db/tenant-guard.ts` | Create | Middleware que injeta/valida `tenant_id` e `agent_id` em queries |
| `src/db/tenant-context.ts` | Create | AsyncLocalStorage pra contexto de tenant/agent em request-scope |
| `tests/unit/feature-flags.spec.ts` | Create | Cobre default, override em runtime, kill switch |
| `tests/unit/tenant-guard.spec.ts` | Create | Sem `tenant_id` → throws; com `tenant_id` → injeta na query |
| `tests/integration/tenant-isolation.spec.ts` | Create | Cria tenants A+B com dados próprios; prova zero leak via injeção |
| `tests/integration/p0-rollback.spec.ts` | Create | Roda migration NOT NULL, faz rollback, valida volta pra nullable sem perda |
| `docs/runbooks/p0-multi-tenant.md` | Create | Runbook de operação pós-P0: como criar tenant, como debugar tenant_guard, como rollback de emergência |

**Nada de schemas dormentes de P2-P6 entra em P0.** Eles nascem no início da fase proprietária (regra do §10.8 do spec).

---

## Task 1: Criar enums base

**Files:** `src/types/enums.ts` (create)

- [ ] **Step 1: Criar arquivo de enums**

```typescript
// src/types/enums.ts

/**
 * Single source of truth para enums do Maia v2.
 * Valores literais em snake_case (convention §10.10 do spec).
 * Importar daqui, nunca duplicar strings espalhadas.
 */

export const TenantStatus = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  ARCHIVED: 'archived',
} as const;
export type TenantStatus = typeof TenantStatus[keyof typeof TenantStatus];

export const AgentStatus = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ARCHIVED: 'archived',
} as const;
export type AgentStatus = typeof AgentStatus[keyof typeof AgentStatus];

/**
 * Eventos cognitivos consumidos por workers de reflexão (item 1 do spec).
 * Esse enum cresce em P1; em P0 ele nasce com o mínimo pra cognitive_module_log
 * já registrar eventos do Reflector existente.
 */
export const CognitiveEventType = {
  USER_CORRECTION: 'user_correction', // existente (reflection.ts)
} as const;
export type CognitiveEventType = typeof CognitiveEventType[keyof typeof CognitiveEventType];

/**
 * Nomes de feature flags conhecidas. Cresce conforme fases ativam.
 */
export const FeatureFlagName = {
  // P0 — flag de smoke test (validador do framework)
  P0_TENANT_GUARD_ENFORCED: 'P0_TENANT_GUARD_ENFORCED',
} as const;
export type FeatureFlagName = typeof FeatureFlagName[keyof typeof FeatureFlagName];
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (pre-existing errors aside).

- [ ] **Step 3: Commit**

```bash
git add src/types/enums.ts
git commit -m "feat(p0): enums base (TenantStatus, AgentStatus, CognitiveEventType, FeatureFlagName)"
```

---

## Task 2: Framework de feature flags

**Files:** `src/config/feature-flags.ts` (create), `src/config/env.ts` (modify), `tests/unit/feature-flags.spec.ts` (create)

- [ ] **Step 1: Adicionar entries de env**

Em `src/config/env.ts`, adicionar:

```typescript
// Feature flags do roadmap Maia v2
FEATURE_P0_TENANT_GUARD_ENFORCED: z
  .string()
  .default('false')
  .transform((s) => s === 'true' || s === '1'),
```

- [ ] **Step 2: Escrever teste do framework**

Em `tests/unit/feature-flags.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { FeatureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';

describe('FeatureFlags', () => {
  let flags: FeatureFlags;

  beforeEach(() => {
    flags = new FeatureFlags({
      [FeatureFlagName.P0_TENANT_GUARD_ENFORCED]: false,
    });
  });

  it('retorna valor da configuração inicial', () => {
    expect(flags.isEnabled(FeatureFlagName.P0_TENANT_GUARD_ENFORCED)).toBe(false);
  });

  it('permite override em runtime', () => {
    flags.override(FeatureFlagName.P0_TENANT_GUARD_ENFORCED, true);
    expect(flags.isEnabled(FeatureFlagName.P0_TENANT_GUARD_ENFORCED)).toBe(true);
  });

  it('kill switch desliga flag mesmo se override true', () => {
    flags.override(FeatureFlagName.P0_TENANT_GUARD_ENFORCED, true);
    flags.killSwitch(FeatureFlagName.P0_TENANT_GUARD_ENFORCED);
    expect(flags.isEnabled(FeatureFlagName.P0_TENANT_GUARD_ENFORCED)).toBe(false);
  });

  it('reset limpa overrides e kill switches', () => {
    flags.override(FeatureFlagName.P0_TENANT_GUARD_ENFORCED, true);
    flags.reset();
    expect(flags.isEnabled(FeatureFlagName.P0_TENANT_GUARD_ENFORCED)).toBe(false);
  });
});
```

- [ ] **Step 3: Rodar o teste — deve falhar**

Run: `npx vitest tests/unit/feature-flags.spec.ts`
Expected: FAIL — `FeatureFlags` não existe.

- [ ] **Step 4: Implementar o framework**

Em `src/config/feature-flags.ts`:

```typescript
import { FeatureFlagName } from '@/types/enums.js';

/**
 * Framework de feature flags com 3 níveis de override:
 * 1. Configuração inicial (env vars)
 * 2. Override em runtime (dashboard, testes)
 * 3. Kill switch (override forçado em false; precedência máxima)
 */
export class FeatureFlags {
  private overrides = new Map<FeatureFlagName, boolean>();
  private kills = new Set<FeatureFlagName>();

  constructor(private initial: Partial<Record<FeatureFlagName, boolean>>) {}

  isEnabled(name: FeatureFlagName): boolean {
    if (this.kills.has(name)) return false;
    if (this.overrides.has(name)) return this.overrides.get(name)!;
    return this.initial[name] ?? false;
  }

  override(name: FeatureFlagName, value: boolean): void {
    this.overrides.set(name, value);
  }

  killSwitch(name: FeatureFlagName): void {
    this.kills.add(name);
  }

  unkillSwitch(name: FeatureFlagName): void {
    this.kills.delete(name);
  }

  reset(): void {
    this.overrides.clear();
    this.kills.clear();
  }
}

// Instância singleton lida do config
import { config } from './env.js';

export const featureFlags = new FeatureFlags({
  [FeatureFlagName.P0_TENANT_GUARD_ENFORCED]: config.FEATURE_P0_TENANT_GUARD_ENFORCED,
});
```

- [ ] **Step 5: Rodar o teste — deve passar**

Run: `npx vitest tests/unit/feature-flags.spec.ts`
Expected: PASS (4/4 tests).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/config/feature-flags.ts src/config/env.ts tests/unit/feature-flags.spec.ts
git commit -m "feat(p0): feature flag framework com kill switch + override runtime"
```

---

## Task 3: Migration — criar tabelas `tenants` e `agents` + seed default

**Files:** `migrations/007_p0_tenants_agents.sql` (create), `src/db/schema.ts` (modify)

- [ ] **Step 1: Criar migration SQL**

Em `migrations/007_p0_tenants_agents.sql`:

```sql
-- P0: cria tenants e agents + seed da row 'default' pra preservar Maia atual
BEGIN;

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  nome TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX agents_tenant_id_idx ON agents(tenant_id);

-- Seed 'default' tenant + 'default' agent (representa a Maia atual)
INSERT INTO tenants (id, nome, status) VALUES ('default', 'Default Tenant (Maia legacy)', 'active');
INSERT INTO agents (id, tenant_id, nome, status) VALUES ('default', 'default', 'Maia (legacy)', 'active');

COMMIT;
```

- [ ] **Step 2: Adicionar tabelas ao Drizzle schema**

Em `src/db/schema.ts`, perto do final (antes dos `type` exports):

```typescript
export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  nome: text('nome').notNull(),
  status: text('status').notNull().default('active'),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    tenant_id: text('tenant_id').notNull(),
    nome: text('nome').notNull(),
    status: text('status').notNull().default('active'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantIdIdx: index('agents_tenant_id_idx').on(t.tenant_id),
  }),
);

export type Tenant = typeof tenants.$inferSelect;
export type Agent = typeof agents.$inferSelect;
```

- [ ] **Step 3: Rodar a migration localmente**

Run: `npm run db:migrate`
Expected: migration 007 aplicada; `psql` query `SELECT * FROM tenants` retorna 1 row 'default'; `SELECT * FROM agents` retorna 1 row 'default' com tenant_id='default'.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add migrations/007_p0_tenants_agents.sql src/db/schema.ts
git commit -m "feat(p0): tabelas tenants + agents + seed 'default' row pra Maia legacy"
```

---

## Task 4: Migration — criar `cognitive_module_log`

**Files:** `migrations/008_p0_cognitive_module_log.sql` (create), `src/db/schema.ts` (modify)

- [ ] **Step 1: Criar migration SQL**

Em `migrations/008_p0_cognitive_module_log.sql`:

```sql
-- P0: cria cognitive_module_log (ativa imediatamente — registra reflection.ts existente)
BEGIN;

CREATE TABLE cognitive_module_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'default' REFERENCES tenants(id),
  agent_id TEXT NOT NULL DEFAULT 'default' REFERENCES agents(id),
  conversa_id UUID,
  turno_id UUID,
  module_name TEXT NOT NULL,
  module_version TEXT NOT NULL DEFAULT 'v1',
  prompt_version TEXT,
  triggered_by TEXT NOT NULL CHECK (triggered_by IN ('sync_required', 'sync_conditional', 'async_event')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  latency_ms INTEGER,
  model_used TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_estimate NUMERIC(10, 6),
  output_summary_hash TEXT, -- hash por default; bruto em cognitive_debug_payloads
  confidence NUMERIC(4, 3),
  fallback_triggered BOOLEAN NOT NULL DEFAULT false,
  fallback_reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'timeout', 'error', 'skipped')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cognitive_module_log_tenant_agent_idx 
  ON cognitive_module_log(tenant_id, agent_id, created_at DESC);
CREATE INDEX cognitive_module_log_module_idx 
  ON cognitive_module_log(module_name, created_at DESC);
CREATE INDEX cognitive_module_log_conversa_idx 
  ON cognitive_module_log(conversa_id) WHERE conversa_id IS NOT NULL;

COMMIT;
```

- [ ] **Step 2: Adicionar tabela ao Drizzle schema**

Em `src/db/schema.ts`:

```typescript
export const cognitive_module_log = pgTable(
  'cognitive_module_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull().default('default'),
    agent_id: text('agent_id').notNull().default('default'),
    conversa_id: uuid('conversa_id'),
    turno_id: uuid('turno_id'),
    module_name: text('module_name').notNull(),
    module_version: text('module_version').notNull().default('v1'),
    prompt_version: text('prompt_version'),
    triggered_by: text('triggered_by').notNull(),
    started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    ended_at: timestamp('ended_at', { withTimezone: true }),
    latency_ms: integer('latency_ms'),
    model_used: text('model_used'),
    tokens_in: integer('tokens_in'),
    tokens_out: integer('tokens_out'),
    cost_estimate: numeric('cost_estimate', { precision: 10, scale: 6 }),
    output_summary_hash: text('output_summary_hash'),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    fallback_triggered: boolean('fallback_triggered').notNull().default(false),
    fallback_reason: text('fallback_reason'),
    status: text('status').notNull(),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentIdx: index('cognitive_module_log_tenant_agent_idx').on(
      t.tenant_id,
      t.agent_id,
      t.created_at,
    ),
    moduleIdx: index('cognitive_module_log_module_idx').on(t.module_name, t.created_at),
    conversaIdx: index('cognitive_module_log_conversa_idx').on(t.conversa_id),
  }),
);

export type CognitiveModuleLog = typeof cognitive_module_log.$inferSelect;
```

- [ ] **Step 3: Aplicar a migration**

Run: `npm run db:migrate`
Expected: migration 008 aplicada; tabela existe e aceita inserts.

- [ ] **Step 4: Commit**

```bash
git add migrations/008_p0_cognitive_module_log.sql src/db/schema.ts
git commit -m "feat(p0): cognitive_module_log table (ativa pra registrar reflection existente)"
```

---

## Task 5: Repository de `cognitiveModuleLog`, `tenants`, `agents`

**Files:** `src/db/repositories.ts` (modify)

- [ ] **Step 1: Adicionar repos**

Em `src/db/repositories.ts`, perto dos outros repos:

```typescript
import {
  tenants,
  agents,
  cognitive_module_log,
  type Tenant,
  type Agent,
  type CognitiveModuleLog,
} from './schema.js';

export const tenantsRepo = {
  async findById(id: string): Promise<Tenant | null> {
    const rows = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async create(t: { id: string; nome: string; status?: string }): Promise<Tenant> {
    const [created] = await db.insert(tenants).values(t).returning();
    return created;
  },
};

export const agentsRepo = {
  async findById(id: string): Promise<Agent | null> {
    const rows = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ?? null;
  },

  async listByTenant(tenant_id: string): Promise<Agent[]> {
    return db.select().from(agents).where(eq(agents.tenant_id, tenant_id));
  },
};

export const cognitiveModuleLogRepo = {
  async record(entry: Omit<CognitiveModuleLog, 'id' | 'created_at'>): Promise<void> {
    await db.insert(cognitive_module_log).values(entry);
  },

  async recentByModule(module_name: string, limit = 100): Promise<CognitiveModuleLog[]> {
    return db
      .select()
      .from(cognitive_module_log)
      .where(eq(cognitive_module_log.module_name, module_name))
      .orderBy(desc(cognitive_module_log.created_at))
      .limit(limit);
  },
};
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/db/repositories.ts
git commit -m "feat(p0): tenantsRepo, agentsRepo, cognitiveModuleLogRepo"
```

---

## Task 6: Wire `cognitive_module_log` na reflexão existente

**Files:** `src/agent/reflection.ts` (modify)

- [ ] **Step 1: Declarar `startTime` no início do `try` block**

Em `src/agent/reflection.ts`, dentro de `reflectOnCorrection`, adicionar como PRIMEIRA linha dentro do `try`:

```typescript
const startTime = Date.now();
```

Sem isso, `Date.now() - startTime` não compila no Step 2. Verifique que está dentro do escopo do try, antes do `await callLLM(...)`.

- [ ] **Step 2: Adicionar log ao `reflectOnCorrection`**

Em `src/agent/reflection.ts`, dentro do `reflectOnCorrection`, **após** o `await callLLM(...)` e a validação `parsed.success`:

```typescript
import { cognitiveModuleLogRepo } from '@/db/repositories.js';

// ... após o callLLM e parsing:
const latencyMs = Date.now() - startTime;

await cognitiveModuleLogRepo.record({
  tenant_id: 'default',
  agent_id: 'default',
  conversa_id: input.conversa.id,
  turno_id: input.inbound.id,
  module_name: 'reflection.correction',
  module_version: 'v1',
  prompt_version: null,
  triggered_by: 'async_event',
  started_at: new Date(startTime),
  ended_at: new Date(),
  latency_ms: latencyMs,
  model_used: 'claude-haiku-4-5',
  tokens_in: res.usage?.input_tokens ?? null,
  tokens_out: res.usage?.output_tokens ?? null,
  cost_estimate: null,
  output_summary_hash: parsed.success ? hashContent(text) : null,
  confidence: parsed.success && parsed.data.applicable ? 0.5 : 0,
  fallback_triggered: false,
  fallback_reason: null,
  status: parsed.success ? 'success' : 'error',
  metadata: { rule_created: parsed.success && parsed.data.applicable },
});
```

Adicionar helper `hashContent` em `src/lib/utils.ts`:

```typescript
import { createHash } from 'crypto';

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
```

- [ ] **Step 3: Rodar o teste existente de reflection (regression)**

Run: `npx vitest tests/unit/reflection.spec.ts` (se existir; senão pular)
Expected: PASS — reflection ainda funciona idêntico, agora com log.

- [ ] **Step 4: Adicionar teste de smoke do log**

Em `tests/integration/cognitive-module-log.spec.ts` (create):

```typescript
import { describe, it, expect } from 'vitest';
import { db } from '@/db/client.js';
import { cognitive_module_log } from '@/db/schema.js';
import { cognitiveModuleLogRepo } from '@/db/repositories.js';
import { eq } from 'drizzle-orm';

describe('cognitive_module_log smoke', () => {
  it('aceita insert de evento de reflection', async () => {
    await cognitiveModuleLogRepo.record({
      tenant_id: 'default',
      agent_id: 'default',
      conversa_id: null,
      turno_id: null,
      module_name: 'reflection.test',
      module_version: 'v1',
      prompt_version: null,
      triggered_by: 'async_event',
      started_at: new Date(),
      ended_at: new Date(),
      latency_ms: 100,
      model_used: 'claude-haiku-4-5',
      tokens_in: 50,
      tokens_out: 20,
      cost_estimate: null,
      output_summary_hash: 'abc123',
      confidence: '0.500',
      fallback_triggered: false,
      fallback_reason: null,
      status: 'success',
      metadata: { test: true },
    });

    const rows = await db
      .select()
      .from(cognitive_module_log)
      .where(eq(cognitive_module_log.module_name, 'reflection.test'));
    expect(rows.length).toBeGreaterThanOrEqual(1);

    // cleanup
    await db.delete(cognitive_module_log).where(eq(cognitive_module_log.module_name, 'reflection.test'));
  });
});
```

- [ ] **Step 5: Rodar o teste**

Run: `npx vitest tests/integration/cognitive-module-log.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agent/reflection.ts src/lib/utils.ts tests/integration/cognitive-module-log.spec.ts
git commit -m "feat(p0): wire cognitive_module_log no reflection existente"
```

---

## Task 7: Migration — adicionar `tenant_id` e `agent_id` em tabelas relevantes (nullable)

**Files:** `migrations/009_p0_add_tenant_agent_columns.sql` (create), `src/db/schema.ts` (modify)

### Tabelas que ganham `tenant_id` + `agent_id` (checklist canônico)

> **Esta lista é a fonte de verdade pras Tasks 7, 8, 14, 17 Gate 2 e Gate 4.** Sempre consultar daqui.

- [ ] `entidades`
- [ ] `contas_bancarias`
- [ ] `categorias`
- [ ] `transacoes`
- [ ] `transferencias_internas`
- [ ] `recorrencias`
- [ ] `contrapartes`
- [ ] `pessoas`
- [ ] `permission_profiles`
- [ ] `permissoes`
- [ ] `conversas`
- [ ] `mensagens`
- [ ] `agent_facts`
- [ ] `learned_rules`
- [ ] `agent_memories`
- [ ] `self_state`
- [ ] `entity_states`
- [ ] `workflows`
- [ ] `workflow_steps`
- [ ] `pending_questions`
- [ ] `idempotency_keys`
- [ ] `system_health_events`
- [ ] `dead_letter_jobs`
- [ ] `dashboard_sessions`
- [ ] `import_runs`
- [ ] `import_entries`
- [ ] `audit_log`

**Total: 27 tabelas.** Marcar cada uma conforme conclui o Step 3 (Drizzle schema edit).

**Tabelas que NÃO ganham (são tenant-level ou system-wide):** `tenants`, `agents`, `cognitive_module_log` (já tem nativamente).

- [ ] **Step 1: Criar migration SQL**

Em `migrations/009_p0_add_tenant_agent_columns.sql`:

```sql
-- P0: adiciona tenant_id e agent_id (nullable, default 'default') em todas as tabelas relevantes
BEGIN;

-- Helper: lista de tabelas que precisam dos campos
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'entidades', 'contas_bancarias', 'categorias', 'transacoes',
    'transferencias_internas', 'recorrencias', 'contrapartes',
    'pessoas', 'permission_profiles', 'permissoes',
    'conversas', 'mensagens',
    'agent_facts', 'learned_rules', 'agent_memories', 'self_state',
    'entity_states', 'workflows', 'workflow_steps',
    'pending_questions', 'idempotency_keys',
    'system_health_events', 'dead_letter_jobs', 'dashboard_sessions',
    'import_runs', 'import_entries', 'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id TEXT DEFAULT ''default'' REFERENCES tenants(id)',
      t
    );
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS agent_id TEXT DEFAULT ''default'' REFERENCES agents(id)',
      t
    );
  END LOOP;
END $$;

COMMIT;
```

- [ ] **Step 2: Aplicar a migration**

Run: `npm run db:migrate`
Expected: migration 009 aplicada; `SELECT column_name FROM information_schema.columns WHERE table_name='transacoes' AND column_name IN ('tenant_id','agent_id')` retorna 2 rows.

- [ ] **Step 3: Adicionar colunas ao Drizzle schema**

Em `src/db/schema.ts`, **em cada uma das tabelas listadas**, adicionar duas linhas:

```typescript
// Exemplo em entidades:
export const entidades = pgTable('entidades', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant_id: text('tenant_id').notNull().default('default'),  // ← NEW
  agent_id: text('agent_id').notNull().default('default'),    // ← NEW
  nome: text('nome').notNull(),
  // ... resto igual
});
```

Aplicar o mesmo padrão pras 27 tabelas (lista canônica no topo da Task 7).

> **Atenção pro implementador:** evite copiar-colar errado. Use grep `pgTable\('` pra listar todas, e adicione as duas linhas logo após o `id` em cada tabela da lista. NÃO adicionar em `tenants`, `agents`, ou `cognitive_module_log`.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (os tipos `Entidade`, `Transacao`, etc. agora incluem `tenant_id` e `agent_id`).

- [ ] **Step 5: Commit**

```bash
git add migrations/009_p0_add_tenant_agent_columns.sql src/db/schema.ts
git commit -m "feat(p0): tenant_id + agent_id columns em 27 tabelas (nullable, default 'default')"
```

---

## Task 8: Migration — backfill explícito

**Files:** `migrations/010_p0_backfill_tenant_agent.sql` (create)

> **Por que essa migration existe** mesmo com default 'default'? Porque a coluna foi adicionada AS NULL DEFAULT 'default' — Postgres aplica o default apenas em INSERTs novos. Rows existentes ficam NULL. Precisamos UPDATE explícito.

- [ ] **Step 1: Criar migration SQL com UPDATE em batch**

Em `migrations/010_p0_backfill_tenant_agent.sql`:

```sql
-- P0: backfill rows existentes pra tenant_id='default', agent_id='default'
-- Em batches pra não travar a DB; pode rodar várias vezes sem efeito colateral.
BEGIN;

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'entidades', 'contas_bancarias', 'categorias', 'transacoes',
    'transferencias_internas', 'recorrencias', 'contrapartes',
    'pessoas', 'permission_profiles', 'permissoes',
    'conversas', 'mensagens',
    'agent_facts', 'learned_rules', 'agent_memories', 'self_state',
    'entity_states', 'workflows', 'workflow_steps',
    'pending_questions', 'idempotency_keys',
    'system_health_events', 'dead_letter_jobs', 'dashboard_sessions',
    'import_runs', 'import_entries', 'audit_log'
  ];
  rows_updated INTEGER;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'UPDATE %I SET tenant_id = ''default'' WHERE tenant_id IS NULL',
      t
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Backfilled tenant_id em %: % rows', t, rows_updated;

    EXECUTE format(
      'UPDATE %I SET agent_id = ''default'' WHERE agent_id IS NULL',
      t
    );
    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    RAISE NOTICE 'Backfilled agent_id em %: % rows', t, rows_updated;
  END LOOP;
END $$;

-- Validação: nenhuma row deve ter NULL após backfill
DO $$
DECLARE
  t TEXT;
  null_count INTEGER;
  tables TEXT[] := ARRAY[
    'entidades', 'contas_bancarias', 'categorias', 'transacoes',
    'transferencias_internas', 'recorrencias', 'contrapartes',
    'pessoas', 'permission_profiles', 'permissoes',
    'conversas', 'mensagens',
    'agent_facts', 'learned_rules', 'agent_memories', 'self_state',
    'entity_states', 'workflows', 'workflow_steps',
    'pending_questions', 'idempotency_keys',
    'system_health_events', 'dead_letter_jobs', 'dashboard_sessions',
    'import_runs', 'import_entries', 'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE tenant_id IS NULL OR agent_id IS NULL',
      t
    ) INTO null_count;
    IF null_count > 0 THEN
      RAISE EXCEPTION 'Backfill falhou: tabela % ainda tem % rows com NULL', t, null_count;
    END IF;
  END LOOP;
  RAISE NOTICE 'Backfill validado: zero NULLs em todas as tabelas';
END $$;

COMMIT;
```

- [ ] **Step 2: Aplicar a migration**

Run: `npm run db:migrate`
Expected: NOTICE messages pra cada tabela com count de rows backfilled; ao final "Backfill validado: zero NULLs em todas as tabelas".

- [ ] **Step 3: Validar com query ad-hoc**

```bash
psql $DATABASE_URL -c "SELECT count(*) FROM entidades WHERE tenant_id IS NULL OR agent_id IS NULL;"
```
Expected: `0` em todas as tabelas.

- [ ] **Step 4: Commit**

```bash
git add migrations/010_p0_backfill_tenant_agent.sql
git commit -m "feat(p0): backfill tenant_id e agent_id em rows existentes ('default')"
```

---

## Task 9: Migration — índices em (tenant_id, agent_id)

**Files:** `migrations/011_p0_tenant_agent_indexes.sql` (create)

- [ ] **Step 1: Criar migration de índices**

Em `migrations/011_p0_tenant_agent_indexes.sql`:

```sql
-- P0: índices compostos pra queries scoped por tenant/agent
BEGIN;

-- Tabelas de alta cardinalidade (queries críticas): índice composto
CREATE INDEX IF NOT EXISTS transacoes_tenant_agent_idx ON transacoes(tenant_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mensagens_tenant_agent_idx ON mensagens(tenant_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS conversas_tenant_agent_idx ON conversas(tenant_id, agent_id, ultima_atividade_em DESC);
CREATE INDEX IF NOT EXISTS agent_facts_tenant_agent_idx ON agent_facts(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS learned_rules_tenant_agent_idx ON learned_rules(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS agent_memories_tenant_agent_idx ON agent_memories(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS audit_log_tenant_agent_idx ON audit_log(tenant_id, agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workflows_tenant_agent_idx ON workflows(tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS pessoas_tenant_idx ON pessoas(tenant_id);

-- Outras tabelas: índice simples em tenant_id
CREATE INDEX IF NOT EXISTS entidades_tenant_idx ON entidades(tenant_id);
CREATE INDEX IF NOT EXISTS contas_bancarias_tenant_idx ON contas_bancarias(tenant_id);
CREATE INDEX IF NOT EXISTS categorias_tenant_idx ON categorias(tenant_id);
CREATE INDEX IF NOT EXISTS contrapartes_tenant_idx ON contrapartes(tenant_id);
CREATE INDEX IF NOT EXISTS recorrencias_tenant_idx ON recorrencias(tenant_id);
CREATE INDEX IF NOT EXISTS transferencias_internas_tenant_idx ON transferencias_internas(tenant_id);
CREATE INDEX IF NOT EXISTS self_state_tenant_idx ON self_state(tenant_id);
CREATE INDEX IF NOT EXISTS entity_states_tenant_idx ON entity_states(tenant_id);
CREATE INDEX IF NOT EXISTS workflow_steps_tenant_idx ON workflow_steps(tenant_id);
CREATE INDEX IF NOT EXISTS pending_questions_tenant_idx ON pending_questions(tenant_id);

COMMIT;
```

- [ ] **Step 2: Aplicar**

Run: `npm run db:migrate`
Expected: índices criados; `SELECT indexname FROM pg_indexes WHERE tablename='transacoes' AND indexname LIKE '%tenant%'` retorna 1+ row.

- [ ] **Step 3: Commit**

```bash
git add migrations/011_p0_tenant_agent_indexes.sql
git commit -m "feat(p0): índices em (tenant_id, agent_id) nas tabelas de alta cardinalidade"
```

---

## Task 10: Implementar tenant context (AsyncLocalStorage)

**Files:** `src/db/tenant-context.ts` (create), `tests/unit/tenant-context.spec.ts` (create)

> **Por que AsyncLocalStorage:** o middleware `tenant_guard` precisa ler `tenant_id` e `agent_id` do contexto da request atual. AsyncLocalStorage do Node faz isso sem passar parâmetros explícitos por toda a stack de funções.

- [ ] **Step 1: Escrever teste do contexto**

Em `tests/unit/tenant-context.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  runWithTenantContext,
  getCurrentTenant,
  getCurrentAgent,
  MissingTenantContextError,
} from '@/db/tenant-context.js';

describe('tenant-context', () => {
  it('runWithTenantContext propaga tenant_id e agent_id', async () => {
    let captured = { t: '', a: '' };
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
      captured = { t: getCurrentTenant(), a: getCurrentAgent() };
    });
    expect(captured).toEqual({ t: 'acme', a: 'sofia' });
  });

  it('getCurrentTenant fora de contexto lança MissingTenantContextError', () => {
    expect(() => getCurrentTenant()).toThrow(MissingTenantContextError);
  });

  it('contextos aninhados respeitam escopo mais interno', async () => {
    await runWithTenantContext({ tenant_id: 'outer', agent_id: 'a1' }, async () => {
      expect(getCurrentTenant()).toBe('outer');
      await runWithTenantContext({ tenant_id: 'inner', agent_id: 'a2' }, async () => {
        expect(getCurrentTenant()).toBe('inner');
      });
      expect(getCurrentTenant()).toBe('outer');
    });
  });
});
```

- [ ] **Step 2: Rodar o teste — deve falhar**

Run: `npx vitest tests/unit/tenant-context.spec.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar tenant-context**

Em `src/db/tenant-context.ts`:

```typescript
import { AsyncLocalStorage } from 'async_hooks';

export class MissingTenantContextError extends Error {
  constructor() {
    super('Tenant context não está disponível — toda query precisa rodar dentro de runWithTenantContext');
    this.name = 'MissingTenantContextError';
  }
}

type TenantContext = {
  tenant_id: string;
  agent_id: string;
};

const storage = new AsyncLocalStorage<TenantContext>();

export async function runWithTenantContext<T>(
  ctx: TenantContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

export function getCurrentTenant(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingTenantContextError();
  return ctx.tenant_id;
}

export function getCurrentAgent(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingTenantContextError();
  return ctx.agent_id;
}

export function tryGetCurrentContext(): TenantContext | null {
  return storage.getStore() ?? null;
}
```

- [ ] **Step 4: Rodar o teste — deve passar**

Run: `npx vitest tests/unit/tenant-context.spec.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/db/tenant-context.ts tests/unit/tenant-context.spec.ts
git commit -m "feat(p0): tenant-context com AsyncLocalStorage + MissingTenantContextError"
```

---

## Task 11: Implementar `tenant_guard` middleware

**Files:** `src/db/tenant-guard.ts` (create), `tests/unit/tenant-guard.spec.ts` (create)

- [ ] **Step 1: Escrever teste do guard**

Em `tests/unit/tenant-guard.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { applyTenantGuard, MissingTenantContextError } from '@/db/tenant-guard.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

describe('tenant-guard', () => {
  it('sem contexto: throws MissingTenantContextError', () => {
    expect(() => applyTenantGuard({})).toThrow(MissingTenantContextError);
  });

  it('com contexto: injeta tenant_id e agent_id', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
      const guarded = applyTenantGuard({});
      expect(guarded).toEqual({ tenant_id: 'acme', agent_id: 'sofia' });
    });
  });

  it('com tenant_id explícito DIFERENTE do contexto: throws', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
      expect(() => applyTenantGuard({ tenant_id: 'other' })).toThrow(/tenant mismatch/);
    });
  });

  it('com tenant_id explícito IGUAL ao contexto: passa', async () => {
    await runWithTenantContext({ tenant_id: 'acme', agent_id: 'sofia' }, async () => {
      const guarded = applyTenantGuard({ tenant_id: 'acme' });
      expect(guarded).toEqual({ tenant_id: 'acme', agent_id: 'sofia' });
    });
  });
});
```

- [ ] **Step 2: Rodar o teste — deve falhar**

Run: `npx vitest tests/unit/tenant-guard.spec.ts`
Expected: FAIL — módulo não existe.

- [ ] **Step 3: Implementar guard**

Em `src/db/tenant-guard.ts`:

```typescript
import { getCurrentTenant, getCurrentAgent, MissingTenantContextError } from './tenant-context.js';

export { MissingTenantContextError } from './tenant-context.js';

/**
 * applyTenantGuard — injeta tenant_id e agent_id do contexto atual
 * em um objeto de input (insert/update/where clause). Se o input já
 * tem tenant_id explícito e não bate com o contexto, lança erro.
 *
 * Uso típico em repository methods:
 *   create(input) {
 *     const guarded = applyTenantGuard(input);
 *     return db.insert(table).values(guarded).returning();
 *   }
 */
export function applyTenantGuard<T extends { tenant_id?: string; agent_id?: string }>(
  input: T,
): T & { tenant_id: string; agent_id: string } {
  const ctxTenant = getCurrentTenant(); // pode lançar MissingTenantContextError
  const ctxAgent = getCurrentAgent();

  if (input.tenant_id && input.tenant_id !== ctxTenant) {
    throw new Error(
      `tenant mismatch: input ${input.tenant_id} vs context ${ctxTenant}`,
    );
  }
  if (input.agent_id && input.agent_id !== ctxAgent) {
    throw new Error(
      `agent mismatch: input ${input.agent_id} vs context ${ctxAgent}`,
    );
  }

  return {
    ...input,
    tenant_id: ctxTenant,
    agent_id: ctxAgent,
  };
}
```

- [ ] **Step 4: Rodar o teste — deve passar**

Run: `npx vitest tests/unit/tenant-guard.spec.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/db/tenant-guard.ts tests/unit/tenant-guard.spec.ts
git commit -m "feat(p0): tenant_guard middleware + validação de mismatch"
```

---

## Task 12: Wire `tenant_guard` em repos existentes (entry points críticos)

**Files:** `src/db/repositories.ts` (modify), `src/index.ts` ou `src/server.ts` (modify)

> **Estratégia:** não aplicar guard em TODOS os repos numa só PR. Aplicar primeiro nos entry points críticos (mensagens, transacoes, conversas, agent_facts) e expandir depois. Cada repo modificado é um commit separado pra rollback granular.

- [ ] **Step 1: Wire tenant context no entry point canônico do agente**

Em `src/agent/core.ts:128`, função `runAgentForMensagem` (esse é o entry sync único pra todo turno de agente; `handleIncoming` em `src/gateway/baileys.ts` apenas enfileira, o trabalho real começa em `runAgentForMensagem`).

Envolver o **corpo da função** com `runWithTenantContext`:

```typescript
import { runWithTenantContext } from '@/db/tenant-context.js';

export async function runAgentForMensagem(mensagem_id: string): Promise<void> {
  // Por enquanto, 'default' é o único tenant/agent. P6 introduz multi-channel/multi-agent.
  await runWithTenantContext(
    { tenant_id: 'default', agent_id: 'default' },
    async () => {
      // resto do corpo existente (movido pra dentro)
    },
  );
}
```

Verificar com `npm test` que comportamento atual continua intacto — todas as queries dentro do agent loop agora rodam com contexto.

- [ ] **Step 2: Wire em worker handlers (BullMQ)**

Cada worker que faz queries (`reflection-batch`, `conversation-summarizer`, etc.) deve abrir tenant context. Por enquanto: lê `tenant_id` e `agent_id` do job payload (ou usa 'default' se vier sem).

Padrão em workers:

```typescript
worker.process(async (job) => {
  // P0: fallback pra 'default' permite jobs existentes (sem tenant_id no payload) continuarem.
  // P6 OBRIGA tenant_id explícito no payload — fallback é removido nessa fase, e jobs antigos
  // são drenados antes do flip.
  const tenant_id = job.data.tenant_id ?? 'default';
  const agent_id = job.data.agent_id ?? 'default';
  await runWithTenantContext({ tenant_id, agent_id }, async () => {
    // lógica do worker
  });
});
```

> **Implementador:** identifique os workers em `src/workers/` e aplique o padrão. Use grep `worker.process` ou `new Worker(`.

- [ ] **Step 3: Aplicar guard no `transacoes` repo (write path crítico)**

Em `src/db/repositories.ts`, no `transacoesRepo.create`:

```typescript
import { applyTenantGuard } from './tenant-guard.js';

// ANTES:
async create(input) {
  return db.insert(transacoes).values(input).returning();
}

// DEPOIS:
async create(input) {
  const guarded = applyTenantGuard(input);
  return db.insert(transacoes).values(guarded).returning();
}
```

Repetir o padrão em métodos `create`/`update` dos repos críticos:
- `transacoesRepo`
- `mensagensRepo`
- `conversasRepo`
- `agentFactsRepo`
- `learnedRulesRepo`
- `auditLogRepo`

Em `findByX`/`listByX`, adicionar filtro automático:

```typescript
// ANTES:
async listRecent() {
  return db.select().from(transacoes).orderBy(desc(transacoes.created_at)).limit(50);
}

// DEPOIS:
async listRecent() {
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  return db
    .select()
    .from(transacoes)
    .where(and(eq(transacoes.tenant_id, tenant_id), eq(transacoes.agent_id, agent_id)))
    .orderBy(desc(transacoes.created_at))
    .limit(50);
}
```

- [ ] **Step 4: Rodar suite completa**

Run: `npm test`
Expected: PASS — comportamento atual preservado (porque tenant_id e agent_id são 'default' em todas as rows; queries filtram pra 'default' e encontram tudo).

- [ ] **Step 5: Commit (granular por arquivo)**

Stagear apenas arquivos que você modificou de fato. NÃO usar `git add src/workers/` em bloco — pode incluir arquivos não relacionados.

```bash
# Exemplo — substitua pelos workers/repos que você efetivamente modificou:
git add src/agent/core.ts
git add src/workers/reflection-batch.ts
git add src/workers/conversation-summarizer.ts
# ... outros workers especificamente tocados
git add src/db/repositories.ts
git commit -m "feat(p0): wire tenant_guard em entry points + workers (default fallback)"
```

Considere commit per-repo se a mudança em `repositories.ts` for grande (rollback granular):
```bash
git add src/db/repositories.ts
git commit -m "feat(p0): tenant_guard em transacoesRepo + mensagensRepo + conversasRepo"
```

---

## Task 13: Teste de integração — isolamento entre tenants

**Files:** `tests/integration/tenant-isolation.spec.ts` (create)

- [ ] **Step 1: Escrever teste de isolamento**

Em `tests/integration/tenant-isolation.spec.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db/client.js';
import {
  tenants,
  agents,
  transacoes,
  entidades,
  contas_bancarias,
} from '@/db/schema.js';
import { tenantsRepo, agentsRepo, transacoesRepo } from '@/db/repositories.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { eq, like } from 'drizzle-orm';

describe('Tenant isolation (P0)', () => {
  beforeAll(async () => {
    // Cria 2 tenants + 1 agente cada
    await tenantsRepo.create({ id: 't-a', nome: 'Tenant A' });
    await tenantsRepo.create({ id: 't-b', nome: 'Tenant B' });
    await db.insert(agents).values([
      { id: 'agent-a', tenant_id: 't-a', nome: 'Agent A' },
      { id: 'agent-b', tenant_id: 't-b', nome: 'Agent B' },
    ]);
  });

  afterAll(async () => {
    // Cleanup em ordem reversa de FK (transacoes → contas → entidades)
    await db.delete(transacoes).where(eq(transacoes.tenant_id, 't-a'));
    await db.delete(transacoes).where(eq(transacoes.tenant_id, 't-b'));
    // Helper-created rows ficam em tenant 'default' (raw insert bypassa context).
    // Limpar por descritor pra não vazar entre runs:
    await db.delete(contas_bancarias).where(like(contas_bancarias.apelido, 'Conta-test-%'));
    await db.delete(entidades).where(like(entidades.nome, 'TestEnt-%'));
    await db.delete(agents).where(eq(agents.tenant_id, 't-a'));
    await db.delete(agents).where(eq(agents.tenant_id, 't-b'));
    await db.delete(tenants).where(eq(tenants.id, 't-a'));
    await db.delete(tenants).where(eq(tenants.id, 't-b'));
  });

  // Helper pra criar transacao válida (todos os NOT NULL preenchidos).
  // Cria entidade/conta com nomes únicos prefixados pra limpeza confiável.
  let fixtureCounter = 0;
  async function makeTxFixture(descricao: string) {
    fixtureCounter++;
    const [ent] = await db
      .insert(entidades)
      .values({ nome: `TestEnt-${fixtureCounter}`, tipo: 'pj' })
      .returning();
    const [conta] = await db
      .insert(contas_bancarias)
      .values({
        entidade_id: ent.id,
        banco: 'X',
        apelido: `Conta-test-${fixtureCounter}`,
        tipo: 'corrente',
      })
      .returning();
    return {
      entidade_id: ent.id,
      conta_id: conta.id,
      natureza: 'saida' as const,
      valor: '100.00',
      data_competencia: '2026-05-11',
      status: 'confirmada',
      descricao,
      origem: 'manual' as const,
    };
  }

  it('insert no tenant A não aparece em queries do tenant B', async () => {
    await runWithTenantContext({ tenant_id: 't-a', agent_id: 'agent-a' }, async () => {
      const fixture = await makeTxFixture('TESTE A');
      await transacoesRepo.create(fixture);
    });

    const visibleToB = await runWithTenantContext(
      { tenant_id: 't-b', agent_id: 'agent-b' },
      () => transacoesRepo.listRecent(),
    );

    expect(visibleToB.find((t) => t.descricao === 'TESTE A')).toBeUndefined();
  });

  it('tentativa de injetar tenant_id no input lança erro', async () => {
    await runWithTenantContext({ tenant_id: 't-a', agent_id: 'agent-a' }, async () => {
      const fixture = await makeTxFixture('INJECTION');
      await expect(
        transacoesRepo.create({ ...fixture, tenant_id: 't-b' } as any),
      ).rejects.toThrow(/tenant mismatch/);
    });
  });

  it('query fora de tenant context lança MissingTenantContextError', async () => {
    await expect(transacoesRepo.listRecent()).rejects.toThrow(/Tenant context/);
  });
});
```

- [ ] **Step 2: Rodar o teste**

Run: `npx vitest tests/integration/tenant-isolation.spec.ts`
Expected: PASS (3/3).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/tenant-isolation.spec.ts
git commit -m "test(p0): integration test prova isolamento entre tenants"
```

---

## Task 14: Migration — flip NOT NULL constraint

**Files:** `migrations/012_p0_force_not_null.sql` (create), `src/db/schema.ts` (verify)

> **Atenção:** essa migration é o **fail-closed final do P0**. Depois dela, qualquer INSERT sem tenant_id explícito (via SQL direto) falha. O middleware `tenant_guard` previne isso em código, mas a constraint é a defesa em profundidade.

- [ ] **Step 1: Criar migration NOT NULL**

Em `migrations/012_p0_force_not_null.sql`:

```sql
-- P0: força NOT NULL em tenant_id e agent_id em todas as tabelas relevantes
-- Backfill DEVE ter rodado antes (migration 007); se houver NULL, ALTER falha
BEGIN;

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'entidades', 'contas_bancarias', 'categorias', 'transacoes',
    'transferencias_internas', 'recorrencias', 'contrapartes',
    'pessoas', 'permission_profiles', 'permissoes',
    'conversas', 'mensagens',
    'agent_facts', 'learned_rules', 'agent_memories', 'self_state',
    'entity_states', 'workflows', 'workflow_steps',
    'pending_questions', 'idempotency_keys',
    'system_health_events', 'dead_letter_jobs', 'dashboard_sessions',
    'import_runs', 'import_entries', 'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL',
      t
    );
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN agent_id SET NOT NULL',
      t
    );
  END LOOP;
END $$;

COMMIT;
```

- [ ] **Step 2: Aplicar a migration**

Run: `npm run db:migrate`
Expected: aplicada sem erro. Se algum NULL ainda existe, ALTER falha — voltar pra Task 8 e fazer backfill.

- [ ] **Step 3: Validar constraint (smoke test simples)**

Tente um INSERT que IGNORA `tenant_id` numa tabela pequena. Use `idempotency_keys` (poucos NOT NULL, fácil de limpar):

```bash
psql $DATABASE_URL -c "INSERT INTO idempotency_keys (key, scope) VALUES ('test_p0_constraint', 'test');"
```
Expected: ERRO — `null value in column "tenant_id" violates not-null constraint`. (Default 'default' não aplica em INSERTs onde a coluna é explicitamente omitida pós-NOT-NULL? Sim aplica — então a constraint passa, mas o teste de fail-closed real é via tenant_guard middleware em código, não DB.)

**Alternativa robusta** — temporariamente drop default e testar:
```bash
psql $DATABASE_URL <<EOF
BEGIN;
ALTER TABLE idempotency_keys ALTER COLUMN tenant_id DROP DEFAULT;
INSERT INTO idempotency_keys (key, scope) VALUES ('test_p0_constraint', 'test');
-- expect: ERROR null value in column "tenant_id"
ROLLBACK;
EOF
```
Expected: ERRO + ROLLBACK limpa tudo.

- [ ] **Step 4: Garantir schema TS reflete NOT NULL**

Verificar que em `src/db/schema.ts`, todas as 27 tabelas tenham `text('tenant_id').notNull().default('default')` (Drizzle já gera isso quando aplicamos `notNull()`).

- [ ] **Step 5: Rodar suite completa de teste**

Run: `npm test`
Expected: PASS — comportamento intacto. Tenant context wrapping garante que toda query/insert tem os campos.

- [ ] **Step 6: Commit**

```bash
git add migrations/012_p0_force_not_null.sql src/db/schema.ts
git commit -m "feat(p0): flip NOT NULL em tenant_id + agent_id (fail-closed final do P0)"
```

---

## Task 15: Teste de rollback da migration NOT NULL

**Files:** `tests/integration/p0-rollback.spec.ts` (create)

- [ ] **Step 1: Escrever teste que valida rollback**

Em `tests/integration/p0-rollback.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';

describe('P0 rollback NOT NULL', () => {
  it('reverter NOT NULL volta pra nullable sem perda de dados', async () => {
    // Snapshot count antes
    const beforeCount = await db.execute(sql`SELECT count(*) FROM transacoes`);

    // Rollback (em test-db apenas)
    await db.execute(sql`ALTER TABLE transacoes ALTER COLUMN tenant_id DROP NOT NULL`);

    // Verifica que coluna agora aceita NULL
    const result = await db.execute<{ is_nullable: string }>(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'transacoes' AND column_name = 'tenant_id'
    `);
    expect(result.rows[0]?.is_nullable).toBe('YES');

    // Dados preservados
    const afterCount = await db.execute(sql`SELECT count(*) FROM transacoes`);
    expect(afterCount.rows[0]).toEqual(beforeCount.rows[0]);

    // Reapply constraint (cleanup pra outros testes)
    await db.execute(sql`ALTER TABLE transacoes ALTER COLUMN tenant_id SET NOT NULL`);
  });
});
```

- [ ] **Step 2: Rodar o teste**

Run: `npx vitest tests/integration/p0-rollback.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/p0-rollback.spec.ts
git commit -m "test(p0): rollback de NOT NULL preserva dados (defensa em profundidade)"
```

---

## Task 16: Runbook operacional

**Files:** `docs/runbooks/p0-multi-tenant.md` (create)

- [ ] **Step 1: Escrever runbook**

Em `docs/runbooks/p0-multi-tenant.md`:

```markdown
# Runbook — P0 Multi-Tenant Foundation

> Como operar e debugar a fundação multi-tenant da Maia v2.

## Quando usar este runbook

- Erro `MissingTenantContextError` em runtime
- Erro `tenant mismatch` em insert/update
- Performance ruim em queries grandes (talvez índice faltando)
- Necessidade de criar novo tenant ou agente
- Rollback de emergência da P0

## Criar tenant novo

```sql
INSERT INTO tenants (id, nome) VALUES ('cliente-x', 'Cliente X Ltda');
INSERT INTO agents (id, tenant_id, nome) VALUES ('cliente-x-maia', 'cliente-x', 'Maia Cliente X');
```

## Debugar MissingTenantContextError

Significa que uma query foi feita fora de `runWithTenantContext`. Localizar:

```bash
# Grep pelo stack trace; geralmente é um worker ou cron novo
grep -rn "db.select\|db.insert\|db.update" src/ | grep -v "runWithTenantContext"
```

Solução: envolver a operação em `runWithTenantContext({ tenant_id, agent_id }, async () => { ... })`.

## Debugar tenant mismatch

Significa que código passou `tenant_id` explícito diferente do contexto atual. Geralmente é bug. Stack trace mostra a origem.

## Rollback de emergência da P0

> Use apenas em produção quebrada. Voltar P0 perde fail-closed em isolamento.

```sql
BEGIN;

-- Drop NOT NULL (mas mantém colunas e dados)
DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'entidades', 'contas_bancarias', 'categorias', 'transacoes',
    'transferencias_internas', 'recorrencias', 'contrapartes',
    'pessoas', 'permission_profiles', 'permissoes',
    'conversas', 'mensagens',
    'agent_facts', 'learned_rules', 'agent_memories', 'self_state',
    'entity_states', 'workflows', 'workflow_steps',
    'pending_questions', 'idempotency_keys',
    'system_health_events', 'dead_letter_jobs', 'dashboard_sessions',
    'import_runs', 'import_entries', 'audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id DROP NOT NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN agent_id DROP NOT NULL', t);
  END LOOP;
END $$;

COMMIT;
```

Depois desligar `FEATURE_P0_TENANT_GUARD_ENFORCED` via env var ou dashboard.

## Métricas a observar pós-P0

- Latência p95 de queries em `transacoes`, `mensagens`, `conversas` (não deve subir significativamente — índices novos compensam o filtro extra)
- Counts em `cognitive_module_log` (deve haver atividade do reflection)
- Logs de `MissingTenantContextError` (deve ser zero em produção depois de P0 completo)
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/p0-multi-tenant.md
git commit -m "docs(p0): runbook multi-tenant — criar tenant, debugar guard, rollback"
```

---

## Task 17: Acceptance gates do P0 — bateria final

**Files:** Nenhum novo; valida tudo o que já foi feito.

> Roda a lista de gates do §9 do spec. Se algum falhar, voltar pras tasks que cobrem o gate.

- [ ] **Gate 1:** Toda query sem `tenant_id` explícito **falha em runtime**

```bash
# Simular: temporariamente remover wrapping no worker, rodar e ver MissingTenantContextError
# (Não fazer isso em código; apenas verificar que tests/unit/tenant-context.spec.ts passa)
npx vitest tests/unit/tenant-context.spec.ts
```

- [ ] **Gate 2:** `tenant_id` e `agent_id` são **NOT NULL** em todas as tabelas relevantes

```bash
psql $DATABASE_URL -c "
SELECT table_name, column_name, is_nullable 
FROM information_schema.columns 
WHERE column_name IN ('tenant_id', 'agent_id') 
  AND table_schema = 'public'
ORDER BY table_name, column_name;
"
```
Expected: todas as 27 tabelas listadas com `is_nullable=NO` em ambas as colunas.

- [ ] **Gate 3:** Teste de integração prova isolamento

```bash
npx vitest tests/integration/tenant-isolation.spec.ts
```
Expected: PASS.

- [ ] **Gate 4:** Backfill cobre 100%

```bash
psql $DATABASE_URL -c "
DO \$\$
DECLARE
  null_count INTEGER;
  tables TEXT[] := ARRAY[
    'entidades', 'contas_bancarias', 'categorias', 'transacoes',
    'transferencias_internas', 'recorrencias', 'contrapartes',
    'pessoas', 'permission_profiles', 'permissoes',
    'conversas', 'mensagens',
    'agent_facts', 'learned_rules', 'agent_memories', 'self_state',
    'entity_states', 'workflows', 'workflow_steps',
    'pending_questions', 'idempotency_keys',
    'system_health_events', 'dead_letter_jobs', 'dashboard_sessions',
    'import_runs', 'import_entries', 'audit_log'
  ];
  t TEXT;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id IS NULL OR agent_id IS NULL', t)
    INTO null_count;
    IF null_count > 0 THEN
      RAISE EXCEPTION 'Found NULL in %', t;
    END IF;
  END LOOP;
END \$\$;
"
```
Expected: sem exceptions.

- [ ] **Gate 5:** Rollback testado

```bash
npx vitest tests/integration/p0-rollback.spec.ts
```
Expected: PASS.

- [ ] **Gate 6:** `cognitive_module_log` ativa e aceita inserts

```bash
npx vitest tests/integration/cognitive-module-log.spec.ts
```
Expected: PASS — o smoke test da Task 6 prova que o schema existe e o repo funciona.

Adicional opcional (se há tráfego em staging): `psql $DATABASE_URL -c "SELECT count(*) FROM cognitive_module_log WHERE module_name LIKE 'reflection%';"` — count > 0 confirma que reflection real foi instrumentado. Mas o gate primário é o smoke test, que NÃO requer dispatch manual de reflection.

- [ ] **Gate 7:** Enums base existem

```bash
grep -E "TenantStatus|AgentStatus|CognitiveEventType|FeatureFlagName" src/types/enums.ts
```
Expected: 4 enums declarados.

- [ ] **Gate 8:** Feature flag framework funcional

```bash
npx vitest tests/unit/feature-flags.spec.ts
```
Expected: PASS (4/4).

- [ ] **Gate 9: Production build limpo**

```bash
npm run build
```
Expected: clean. Detecta regressões só visíveis no build (não só `tsc --noEmit`).

- [ ] **Final commit + tag**

```bash
git tag p0-foundation-done
git push origin p0-foundation-done
```

---

## P0 Acceptance: o que está provado ao final

1. ✅ Multi-tenancy operacional com 'default' como migração-bridge
2. ✅ `tenant_guard` middleware obriga contexto em todas as queries
3. ✅ Constraint NOT NULL em DB garante fail-closed defensivo
4. ✅ Teste de integração prova isolamento (tenant A não vê dados de B)
5. ✅ Rollback testado, volta pra nullable sem perda
6. ✅ `cognitive_module_log` ativa, registrando reflection existente
7. ✅ Enums base + feature flag framework prontos pra P1 consumir
8. ✅ Runbook operacional documenta criação de tenant, debug, rollback

## O que P0 NÃO entrega (vem em fases seguintes)

- ❌ Schemas dormentes de P2-P6 (vêm no início da fase proprietária — §10.8)
- ❌ Reflexão expandida pra além de correção (P1)
- ❌ Memory scoping com 6 controles (P2)
- ❌ Procedures executáveis (P3a/b/c)
- ❌ Identidade operacional versionada (P4)
- ❌ Capability acquisition (P5)
- ❌ Multi-channel/Role/Policy (P6)
- ❌ Grafo cognitivo formal (P7)

Cada fase seguinte tem seu próprio plano de implementação (a escrever após P0 estabilizar).
