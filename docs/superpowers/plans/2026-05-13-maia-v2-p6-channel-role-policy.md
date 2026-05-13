# Maia v2 — P6 Channel / Role / Policy + Role Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Refactor estrutural do gateway pra separar 4 conceitos ortogonais — **Tenant → Agent → Channel → Channel Policy → Role**. O Role Engine **aplica** policies; LLM apenas **sugere** role (`suggested_by`), Policy sempre **decide** (`decided_by`). Toda decisão (mesmo "manter atual") vira row em `role_selector_decisions`. `by_context` tem travas anti-oscilação (cap 3 trocas/conversa por default). Maia atual migra pra `(1 agent / 1 channel / 1 role / policy=free_with_trigger)` **sem mudança visível**.

**Frase-chave inviolável (spec §4.5):**
> *"A Maia deve ser uma identidade única com papéis operacionais configuráveis, e cada canal define se esses papéis serão dinâmicos, fixos ou híbridos."*

**Architecture:** 4 tabelas novas — `channels` (instâncias de entrada de mensagem, linked a agents), `roles` (modos operacionais por agent), `channel_policies` (governa como roles operam no canal — `locked` | `prefer_handoff` | `free_with_trigger` | `by_context`), `role_selector_decisions` (audit append-only). Role Selector é módulo cognitivo que: (1) LLM **sugere** role para o turno (Haiku, fast), (2) Policy **decide** se aplica/mantém/escala (deterministic engine, sem LLM). Travas anti-oscilação: `min_confidence_to_switch`, `cooldown_turns`, `required_strength_delta`, `max_switches_per_conversation`. Gateway baileys ganha **resolver**: dado `from` da mensagem inbound, identifica `channel → agent → tenant`. Tudo coexiste com legacy `default/default` via feature flag `FEATURE_MULTI_CHANNEL`.

**Tech Stack:** TypeScript, Drizzle, PostgreSQL, vitest, Anthropic SDK (Haiku para role sugestão), BullMQ/node-cron. Builds on P0 (tenant_guard) + P1 (cognitive_module_log + runner) + P2 (memory scope_type=`role`/`channel`) + P3 (procedures) + P4 (operational profile pode ter role-aware section) + P5 (gaps escopados a channel/role agora possíveis).

**Reference:** Spec §4.5 (4 conceitos), §6.1 P6 (4 tabelas), §9 P6 (linhas 609-614 done criteria), §10.6 (`role_selector_decisions` segue padrão), §10.7 (precedence channel_policy > procedure ativa), §10.9 (`FEATURE_MULTI_CHANNEL` flag default off).

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `migrations/031_p6_channels.sql` + down | Create | Instâncias de entrada (1+ por agent) |
| `migrations/032_p6_roles.sql` + down | Create | Modos operacionais por agent (default = `default`) |
| `migrations/033_p6_channel_policies.sql` + down | Create | Governa como roles operam no channel + travas anti-osc |
| `migrations/034_p6_role_selector_decisions.sql` + down | Create | Audit append-only de TODA decisão do role selector |
| `migrations/035_p6_seed_default_channel_role_policy.sql` + down | Create | Seed Maia atual → `default channel / default role / policy=free_with_trigger` |
| `src/db/schema.ts` | Modify | 4 tabelas + types |
| `src/db/repositories.ts` | Modify | 4 repos novos |
| `src/types/enums.ts` | Modify | `SwitchBehavior` (4), `SuggestedBy` (3), `DecidedBy` (4), `AnnounceMode` (3), `RoleSelectorStrength` (3), `FeatureFlagName.MULTI_CHANNEL` |
| `src/config/env.ts` | Modify | Schema env: `FEATURE_MULTI_CHANNEL` |
| `src/config/feature-flags.ts` | Modify | Registrar `MULTI_CHANNEL` no singleton |
| `src/gateway/channel-resolver.ts` | Create | Resolver determinístico: `from`/`number` → channel → agent → tenant |
| `src/gateway/baileys.ts` | Modify | Usar resolver quando flag ON; fallback `default/default` quando OFF |
| `src/cognition/role-selector/types.ts` | Create | `RoleCandidate`, `RoleSelectorInput`, `RoleSelectorDecision`, etc |
| `src/cognition/role-selector/llm-suggester.ts` | Create | Haiku — devolve candidato com `suggested_by='llm_classifier'` + confidence + strength |
| `src/cognition/role-selector/deterministic-classifier.ts` | Create | Regex/keyword — devolve candidato com `suggested_by='deterministic_classifier'` |
| `src/cognition/role-selector/policy-decider.ts` | Create | **Determinístico, sem LLM:** aplica policy + travas e decide. `decided_by` ∈ {policy_default, policy_rule, owner_override, fallback_rule} |
| `src/cognition/role-selector/engine.ts` | Create | Orquestra: sugester(es) → policy-decider → audit row → result |
| `src/cognition/role-selector/oscillation-tracker.ts` | Create | Conta switches por conversa; aplica `max_switches_per_conversation` |
| `src/agent/core.ts` | Modify | Quando flag ON, chama role selector pré-turn; injeta role no prompt context |
| `src/agent/prompt-builder.ts` | Modify | Lê role atual + role description, adiciona seção "Modo operacional" |
| `tests/unit/channel-resolver.spec.ts` | Create | Testes resolver |
| `tests/unit/role-selector-llm-suggester.spec.ts` | Create | Mocked Haiku |
| `tests/unit/role-selector-deterministic.spec.ts` | Create | Regex/keyword |
| `tests/unit/role-selector-policy-decider.spec.ts` | Create | 4 switch_behaviors × cenários |
| `tests/unit/role-selector-oscillation-tracker.spec.ts` | Create | Cap 3 switches default |
| `tests/unit/role-selector-engine.spec.ts` | Create | Orquestração end-to-end |
| `tests/unit/role-audit-always-recorded.spec.ts` | Create | Decisão "manter atual" ALSO registrada |
| `tests/unit/channels-repo.spec.ts` | Create | CRUD |
| `tests/unit/roles-repo.spec.ts` | Create | CRUD |
| `tests/unit/channel-policies-repo.spec.ts` | Create | CRUD |
| `tests/unit/role-selector-decisions-repo.spec.ts` | Create | append + listByConversation |
| `tests/unit/prompt-builder-role-section.spec.ts` | Create | Flag-gated injection |
| `tests/integration/p6-channel-role-policy.spec.ts` | Create | E2E: 7 cenários mocked (incl. todas as 4 policies + anti-osc) |
| `scripts/p6-acceptance-gates.sh` | Create | Bateria de gates |
| `docs/runbooks/p6-channel-role-policy.md` | Create | Runbook |

---

## Task 1: Enums (`SwitchBehavior`, `SuggestedBy`, `DecidedBy`, `AnnounceMode`, `RoleSelectorStrength`) + flag `MULTI_CHANNEL`

**Files:**
- Modify: `src/types/enums.ts`
- Modify: `src/config/env.ts`
- Modify: `src/config/feature-flags.ts`
- Test: `tests/unit/enums-p6.spec.ts` (NEW)

**Scene:** §10.1 lista esses enums. Valores snake_case (§10.10). Espelha pattern dos enums P4/P5.

### Enums

```typescript
export const SwitchBehavior = {
  LOCKED: 'locked',                       // role fixo; selector retorna current sempre
  PREFER_HANDOFF: 'prefer_handoff',       // se sugester achar role diferente, sinaliza handoff
  FREE_WITH_TRIGGER: 'free_with_trigger', // troca livre se trigger explícito (ex: cliente chama by name)
  BY_CONTEXT: 'by_context',               // LLM sugere, policy decide com travas
} as const;
export type SwitchBehavior = typeof SwitchBehavior[keyof typeof SwitchBehavior];

export const SuggestedBy = {
  LLM_CLASSIFIER: 'llm_classifier',
  DETERMINISTIC_CLASSIFIER: 'deterministic_classifier',
  NONE: 'none',
} as const;
export type SuggestedBy = typeof SuggestedBy[keyof typeof SuggestedBy];

export const DecidedBy = {
  POLICY_DEFAULT: 'policy_default',
  POLICY_RULE: 'policy_rule',
  OWNER_OVERRIDE: 'owner_override',
  FALLBACK_RULE: 'fallback_rule',
} as const;
export type DecidedBy = typeof DecidedBy[keyof typeof DecidedBy];

export const AnnounceMode = {
  ALWAYS: 'always',
  NEVER: 'never',
  AFFECTS_USER: 'affects_user',
} as const;
export type AnnounceMode = typeof AnnounceMode[keyof typeof AnnounceMode];

export const RoleSelectorStrength = {
  WEAK: 'weak',     // confidence < 0.5
  MEDIUM: 'medium', // 0.5..0.8
  STRONG: 'strong', // >= 0.8
} as const;
export type RoleSelectorStrength = typeof RoleSelectorStrength[keyof typeof RoleSelectorStrength];

export const RoleDecisionAction = {
  KEEP_CURRENT: 'keep_current',
  SWITCH: 'switch',
  HANDOFF: 'handoff',
  FALLBACK: 'fallback',
} as const;
export type RoleDecisionAction = typeof RoleDecisionAction[keyof typeof RoleDecisionAction];
```

Adicionar a `FeatureFlagName`:
```typescript
MULTI_CHANNEL: 'MULTI_CHANNEL',
```

### Env (em `src/config/env.ts`)

```typescript
FEATURE_MULTI_CHANNEL: z
  .string()
  .default('false')
  .transform((s) => s === 'true' || s === '1'),
```

### Feature-flags singleton

```typescript
export const featureFlags = new FeatureFlags({
  [FeatureFlagName.P0_TENANT_GUARD_ENFORCED]: config.FEATURE_P0_TENANT_GUARD_ENFORCED,
  [FeatureFlagName.OPERATIONAL_PROFILE_V2]: config.FEATURE_OPERATIONAL_PROFILE_V2,
  [FeatureFlagName.DIALOGICAL_ACQUISITION]: config.FEATURE_DIALOGICAL_ACQUISITION,
  [FeatureFlagName.MULTI_CHANNEL]: config.FEATURE_MULTI_CHANNEL,  // NEW
});
```

### TDD test `tests/unit/enums-p6.spec.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  SwitchBehavior, SuggestedBy, DecidedBy, AnnounceMode,
  RoleSelectorStrength, RoleDecisionAction, FeatureFlagName,
} from '@/types/enums.js';
import { featureFlags } from '@/config/feature-flags.js';

describe('P6 enums', () => {
  it('SwitchBehavior has 4 values', () => {
    expect(Object.values(SwitchBehavior).sort()).toEqual(['by_context', 'free_with_trigger', 'locked', 'prefer_handoff']);
  });
  it('SuggestedBy has 3 values', () => {
    expect(Object.values(SuggestedBy)).toHaveLength(3);
  });
  it('DecidedBy has 4 values (excludes llm_classifier)', () => {
    expect(Object.values(DecidedBy).sort()).toEqual(['fallback_rule', 'owner_override', 'policy_default', 'policy_rule']);
    expect(Object.values(DecidedBy)).not.toContain('llm_classifier');
  });
  it('AnnounceMode has 3 values', () => {
    expect(Object.values(AnnounceMode).sort()).toEqual(['affects_user', 'always', 'never']);
  });
  it('RoleSelectorStrength has 3 values', () => {
    expect(Object.values(RoleSelectorStrength)).toHaveLength(3);
  });
  it('RoleDecisionAction has 4 values', () => {
    expect(Object.values(RoleDecisionAction)).toHaveLength(4);
  });
  it('FeatureFlagName.MULTI_CHANNEL defined', () => {
    expect(FeatureFlagName.MULTI_CHANNEL).toBe('MULTI_CHANNEL');
  });
  it('featureFlags singleton respects FEATURE_MULTI_CHANNEL default off', () => {
    expect(featureFlags.isEnabled(FeatureFlagName.MULTI_CHANNEL)).toBe(false);
  });
});
```

### Steps

- [ ] **Step 1:** Write failing test → run → FAIL.
- [ ] **Step 2:** Add enums to `src/types/enums.ts`.
- [ ] **Step 3:** Add env entry to `src/config/env.ts`.
- [ ] **Step 4:** Register flag in `src/config/feature-flags.ts`.
- [ ] **Step 5:** Run → PASS.
- [ ] **Step 6:** Typecheck clean.
- [ ] **Step 7:** Commit:

```bash
git add src/types/enums.ts src/config/env.ts src/config/feature-flags.ts tests/unit/enums-p6.spec.ts
git commit -m "feat(p6): enums SwitchBehavior/SuggestedBy/DecidedBy/AnnounceMode/RoleSelectorStrength + flag MULTI_CHANNEL registrada"
```

---

## Task 2: Migrations 031-034 (4 tables) — em 4 commits sequenciais

Para manter commits revisáveis, cada tabela vira commit separado. Vou listar todas em uma task ("Task 2") com 4 sub-passos (cada com TDD), mas o engineer pode optar por trabalhar como 4 sub-tasks contíguas.

**Build invariant:** Após cada migration commit, `npx tsc --noEmit` e o test schema P6 (cumulativo) precisam passar.

### Task 2a: Migration `channels`

**Files:**
- Create: `migrations/031_p6_channels.sql` + down
- Modify: `src/db/schema.ts`
- Test: `tests/unit/db-schema-p6.spec.ts` (NEW)

#### SQL UP

```sql
-- P6: channels — instâncias de entrada de mensagem (1+ por agent)
-- Cada channel pode ter sua own policy linkada (channel_policies.channel_id)
-- NOTE: no BEGIN/COMMIT — migrate.ts wraps in transaction.

CREATE TABLE channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  external_id TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('whatsapp', 'telegram', 'email', 'sms', 'web', 'api', 'other')),
  display_name TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel_type, external_id)
);

CREATE INDEX channels_tenant_agent_idx ON channels(tenant_id, agent_id);
CREATE INDEX channels_external_idx ON channels(channel_type, external_id);
```

#### SQL DOWN

```sql
DROP INDEX IF EXISTS channels_external_idx;
DROP INDEX IF EXISTS channels_tenant_agent_idx;
DROP TABLE IF EXISTS channels;
```

#### Drizzle

```typescript
export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    external_id: text('external_id').notNull(),
    channel_type: text('channel_type').notNull(),
    display_name: text('display_name'),
    active: boolean('active').notNull().default(true),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentIdx: index('channels_tenant_agent_idx').on(t.tenant_id, t.agent_id),
    externalIdx: index('channels_external_idx').on(t.channel_type, t.external_id),
    externalUq: uniqueIndex('channels_tenant_type_external_uq').on(t.tenant_id, t.channel_type, t.external_id),
  }),
);

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
```

#### TDD test (initial)

```typescript
import { describe, it, expect } from 'vitest';
import * as schema from '@/db/schema.js';

describe('P6 schema', () => {
  it('exports channels table', () => expect(schema.channels).toBeDefined());
  it('channels has channel_type + external_id + active', () => {
    const cols = Object.keys(schema.channels);
    expect(cols).toContain('channel_type');
    expect(cols).toContain('external_id');
    expect(cols).toContain('active');
  });
});
```

#### Steps

```bash
git add migrations/031_p6_channels.sql migrations/031_p6_channels_down.sql src/db/schema.ts tests/unit/db-schema-p6.spec.ts
git commit -m "feat(p6): channels table (instâncias de entrada por agent, UNIQUE tenant+type+external)"
```

### Task 2b: Migration `roles`

#### SQL UP

```sql
-- P6: roles — modos operacionais por agent (comercial, suporte, default, etc)
-- 1 row 'default' por agent é seedada via migration 035

CREATE TABLE roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  role_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  prompt_addendum TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_id, role_key)
);

CREATE UNIQUE INDEX roles_unique_default_per_agent_idx
  ON roles(tenant_id, agent_id)
  WHERE is_default = true;

CREATE INDEX roles_tenant_agent_active_idx ON roles(tenant_id, agent_id, active);
```

#### SQL DOWN

```sql
DROP INDEX IF EXISTS roles_tenant_agent_active_idx;
DROP INDEX IF EXISTS roles_unique_default_per_agent_idx;
DROP TABLE IF EXISTS roles;
```

#### Drizzle

```typescript
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    role_key: text('role_key').notNull(),
    display_name: text('display_name').notNull(),
    description: text('description'),
    prompt_addendum: text('prompt_addendum'),
    active: boolean('active').notNull().default(true),
    is_default: boolean('is_default').notNull().default(false),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentActiveIdx: index('roles_tenant_agent_active_idx').on(t.tenant_id, t.agent_id, t.active),
    keyUq: uniqueIndex('roles_tenant_agent_key_uq').on(t.tenant_id, t.agent_id, t.role_key),
  }),
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
```

(Partial unique `WHERE is_default=true` enforced via SQL — Drizzle's `index()` doesn't express WHERE clauses.)

#### Commit

```bash
git add migrations/032_p6_roles.sql migrations/032_p6_roles_down.sql src/db/schema.ts tests/unit/db-schema-p6.spec.ts
git commit -m "feat(p6): roles table (modos operacionais por agent, 1 default por (tenant,agent))"
```

### Task 2c: Migration `channel_policies`

#### SQL UP

```sql
-- P6: channel_policies — governa como roles operam no channel + travas anti-oscilação
-- 1 policy por channel (UNIQUE channel_id). Travas em JSONB pra extensibilidade.

CREATE TABLE channel_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  default_role_id UUID NOT NULL REFERENCES roles(id),
  switch_behavior TEXT NOT NULL CHECK (
    switch_behavior IN ('locked', 'prefer_handoff', 'free_with_trigger', 'by_context')
  ),
  announce_mode TEXT NOT NULL DEFAULT 'affects_user' CHECK (
    announce_mode IN ('always', 'never', 'affects_user')
  ),
  by_context_guards JSONB NOT NULL DEFAULT '{
    "min_confidence_to_switch": 0.7,
    "cooldown_turns": 3,
    "required_strength_delta": 0.2,
    "max_switches_per_conversation": 3
  }'::jsonb,
  allowed_role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id)
);

CREATE INDEX channel_policies_tenant_agent_idx ON channel_policies(tenant_id, agent_id);
```

#### SQL DOWN

```sql
DROP INDEX IF EXISTS channel_policies_tenant_agent_idx;
DROP TABLE IF EXISTS channel_policies;
```

#### Drizzle

```typescript
export const channel_policies = pgTable(
  'channel_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    channel_id: uuid('channel_id').notNull(),
    default_role_id: uuid('default_role_id').notNull(),
    switch_behavior: text('switch_behavior').notNull(),
    announce_mode: text('announce_mode').notNull().default('affects_user'),
    by_context_guards: jsonb('by_context_guards').notNull().default(sql`'{"min_confidence_to_switch":0.7,"cooldown_turns":3,"required_strength_delta":0.2,"max_switches_per_conversation":3}'::jsonb`),
    allowed_role_ids: jsonb('allowed_role_ids').notNull().default(sql`'[]'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tenantAgentIdx: index('channel_policies_tenant_agent_idx').on(t.tenant_id, t.agent_id),
    channelUq: uniqueIndex('channel_policies_channel_uq').on(t.channel_id),
  }),
);

export type ChannelPolicy = typeof channel_policies.$inferSelect;
export type NewChannelPolicy = typeof channel_policies.$inferInsert;
```

#### Commit

```bash
git add migrations/033_p6_channel_policies.sql migrations/033_p6_channel_policies_down.sql src/db/schema.ts tests/unit/db-schema-p6.spec.ts
git commit -m "feat(p6): channel_policies table (default role + switch_behavior + travas anti-osc)"
```

### Task 2d: Migration `role_selector_decisions`

**Spec §10.6 detail (linha 720-725):** estrutura `candidates / conflicts / decision / decided_by / suggested_by`. Audit append-only — TODA decisão registrada (mesmo "manter atual"). **`decided_by` jamais é `llm_classifier`** (CHECK constraint).

#### SQL UP

```sql
-- P6: role_selector_decisions — log append-only de TODA decisão do role selector
-- (mesmo "manter atual"). suggested_by pode ser llm_classifier;
-- decided_by NUNCA pode ser llm_classifier (CHECK constraint).

CREATE TABLE role_selector_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  conversa_id UUID,
  turno_id UUID,
  channel_id UUID REFERENCES channels(id),
  policy_id UUID REFERENCES channel_policies(id),
  current_role_id UUID REFERENCES roles(id),
  suggested_role_id UUID REFERENCES roles(id),
  decided_role_id UUID NOT NULL REFERENCES roles(id),
  action TEXT NOT NULL CHECK (action IN ('keep_current', 'switch', 'handoff', 'fallback')),
  candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggested_by TEXT NOT NULL CHECK (suggested_by IN ('llm_classifier', 'deterministic_classifier', 'none')),
  decided_by TEXT NOT NULL CHECK (decided_by IN ('policy_default', 'policy_rule', 'owner_override', 'fallback_rule')),
  suggested_strength TEXT CHECK (suggested_strength IS NULL OR suggested_strength IN ('weak', 'medium', 'strong')),
  suggested_confidence NUMERIC(4, 3),
  reason TEXT,
  switch_count_in_conversation INTEGER NOT NULL DEFAULT 0,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX role_selector_conversa_idx
  ON role_selector_decisions(conversa_id, decided_at DESC);
CREATE INDEX role_selector_tenant_agent_idx
  ON role_selector_decisions(tenant_id, agent_id, decided_at DESC);
```

#### SQL DOWN

```sql
DROP INDEX IF EXISTS role_selector_tenant_agent_idx;
DROP INDEX IF EXISTS role_selector_conversa_idx;
DROP TABLE IF EXISTS role_selector_decisions;
```

#### Drizzle

```typescript
export const role_selector_decisions = pgTable(
  'role_selector_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenant_id: text('tenant_id').notNull(),
    agent_id: text('agent_id').notNull(),
    conversa_id: uuid('conversa_id'),
    turno_id: uuid('turno_id'),
    channel_id: uuid('channel_id'),
    policy_id: uuid('policy_id'),
    current_role_id: uuid('current_role_id'),
    suggested_role_id: uuid('suggested_role_id'),
    decided_role_id: uuid('decided_role_id').notNull(),
    action: text('action').notNull(),
    candidates: jsonb('candidates').notNull().default(sql`'[]'::jsonb`),
    conflicts: jsonb('conflicts').notNull().default(sql`'[]'::jsonb`),
    suggested_by: text('suggested_by').notNull(),
    decided_by: text('decided_by').notNull(),
    suggested_strength: text('suggested_strength'),
    suggested_confidence: numeric('suggested_confidence', { precision: 4, scale: 3 }),
    reason: text('reason'),
    switch_count_in_conversation: integer('switch_count_in_conversation').notNull().default(0),
    decided_at: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    conversaIdx: index('role_selector_conversa_idx').on(t.conversa_id, t.decided_at),
    tenantAgentIdx: index('role_selector_tenant_agent_idx').on(t.tenant_id, t.agent_id, t.decided_at),
  }),
);

export type RoleSelectorDecisionRow = typeof role_selector_decisions.$inferSelect;
export type NewRoleSelectorDecisionRow = typeof role_selector_decisions.$inferInsert;
```

#### Commit

```bash
git add migrations/034_p6_role_selector_decisions.sql migrations/034_p6_role_selector_decisions_down.sql src/db/schema.ts tests/unit/db-schema-p6.spec.ts
git commit -m "feat(p6): role_selector_decisions table (audit append-only; decided_by NUNCA llm_classifier)"
```

---

## Task 3: Migration 035 — Seed Maia atual como `(default channel / default role / policy=free_with_trigger)`

**Files:**
- Create: `migrations/035_p6_seed_default_channel_role_policy.sql` + down

**Scene:** Spec §9 P6 done criterion #5: "Maia atual migra pra (1 agent / 1 channel / 1 role / policy=free_with_trigger) **sem mudança visível**". Migration cria 3 rows tied ao `(tenant_id='default', agent_id='default')` que já existem (P0 criou).

### SQL UP

```sql
-- P6: seed para preservar comportamento da Maia atual no schema multi-channel
-- Cria: default channel, default role (is_default=true), default policy (free_with_trigger).
-- Idempotente via ON CONFLICT DO NOTHING.

DO $$
DECLARE
  default_role_uuid UUID;
  default_channel_uuid UUID;
BEGIN
  -- Default role
  INSERT INTO roles (tenant_id, agent_id, role_key, display_name, description, is_default, active)
  VALUES ('default', 'default', 'default', 'Default', 'Modo operacional padrão (compatibilidade legacy)', true, true)
  ON CONFLICT (tenant_id, agent_id, role_key) DO NOTHING
  RETURNING id INTO default_role_uuid;

  IF default_role_uuid IS NULL THEN
    SELECT id INTO default_role_uuid FROM roles WHERE tenant_id='default' AND agent_id='default' AND role_key='default';
  END IF;

  -- Default channel
  INSERT INTO channels (tenant_id, agent_id, external_id, channel_type, display_name, active)
  VALUES ('default', 'default', 'default-channel', 'whatsapp', 'Default WhatsApp Channel', true)
  ON CONFLICT (tenant_id, channel_type, external_id) DO NOTHING
  RETURNING id INTO default_channel_uuid;

  IF default_channel_uuid IS NULL THEN
    SELECT id INTO default_channel_uuid FROM channels
    WHERE tenant_id='default' AND channel_type='whatsapp' AND external_id='default-channel';
  END IF;

  -- Default channel policy (free_with_trigger preserves legacy "no role switching")
  INSERT INTO channel_policies (
    tenant_id, agent_id, channel_id, default_role_id,
    switch_behavior, announce_mode
  )
  VALUES (
    'default', 'default', default_channel_uuid, default_role_uuid,
    'free_with_trigger', 'affects_user'
  )
  ON CONFLICT (channel_id) DO NOTHING;
END $$;
```

### SQL DOWN

```sql
DELETE FROM channel_policies WHERE tenant_id='default' AND agent_id='default';
DELETE FROM channels WHERE tenant_id='default' AND agent_id='default' AND external_id='default-channel';
DELETE FROM roles WHERE tenant_id='default' AND agent_id='default' AND role_key='default';
```

### Steps

- [ ] **Step 1:** Create files (UP + DOWN).
- [ ] **Step 2:** Validate SQL syntax mentally — `DO $$ ... END $$` is Postgres anonymous block; works within `migrate.ts` transaction wrapping.
- [ ] **Step 3:** Commit:

```bash
git add migrations/035_p6_seed_default_channel_role_policy.sql migrations/035_p6_seed_default_channel_role_policy_down.sql
git commit -m "feat(p6): seed default tenant -> 1 channel / 1 default role / policy=free_with_trigger (legacy compat)"
```

---

## Task 4: Repos (`channelsRepo`, `rolesRepo`, `channelPoliciesRepo`, `roleSelectorDecisionsRepo`)

**Files:**
- Modify: `src/db/repositories.ts`
- Test: `tests/unit/channels-repo.spec.ts`, `tests/unit/roles-repo.spec.ts`, `tests/unit/channel-policies-repo.spec.ts`, `tests/unit/role-selector-decisions-repo.spec.ts`

### Signatures

```typescript
export const channelsRepo = {
  async create(input: { external_id: string; channel_type: 'whatsapp' | 'telegram' | 'email' | 'sms' | 'web' | 'api' | 'other'; display_name?: string; metadata?: unknown }): Promise<Channel>,
  async getById(id: string): Promise<Channel | null>,
  async findByExternal(channel_type: string, external_id: string): Promise<Channel | null>,
  async listActive(): Promise<Channel[]>,
  async deactivate(id: string): Promise<void>,
};

export const rolesRepo = {
  async create(input: { role_key: string; display_name: string; description?: string; prompt_addendum?: string; is_default?: boolean }): Promise<Role>,
  async getById(id: string): Promise<Role | null>,
  async getByKey(role_key: string): Promise<Role | null>,
  async getDefault(): Promise<Role | null>,
  async listActive(): Promise<Role[]>,
  async deactivate(id: string): Promise<void>,
};

export const channelPoliciesRepo = {
  async create(input: { channel_id: string; default_role_id: string; switch_behavior: SwitchBehavior; announce_mode?: AnnounceMode; by_context_guards?: unknown; allowed_role_ids?: string[] }): Promise<ChannelPolicy>,
  async getByChannelId(channel_id: string): Promise<ChannelPolicy | null>,
  async update(id: string, patch: Partial<NewChannelPolicy>): Promise<ChannelPolicy>,
};

export const roleSelectorDecisionsRepo = {
  async record(input: {
    conversa_id?: string;
    turno_id?: string;
    channel_id?: string;
    policy_id?: string;
    current_role_id?: string;
    suggested_role_id?: string;
    decided_role_id: string;
    action: RoleDecisionAction;
    candidates: unknown[];
    conflicts: unknown[];
    suggested_by: SuggestedBy;
    decided_by: DecidedBy;
    suggested_strength?: RoleSelectorStrength;
    suggested_confidence?: number;
    reason?: string;
    switch_count_in_conversation?: number;
  }): Promise<RoleSelectorDecisionRow>,
  async listByConversation(conversa_id: string): Promise<RoleSelectorDecisionRow[]>,
  async countSwitchesInConversation(conversa_id: string): Promise<number>,
};
```

### Critical guard

`roleSelectorDecisionsRepo.record` deve **validar em runtime** que `input.decided_by !== 'llm_classifier'` antes de inserir, mesmo que o DB tenha CHECK constraint. Falha hard (`throw new Error('decided_by_cannot_be_llm_classifier')`) — defense in depth.

### TDD scenarios

**channels-repo.spec.ts** (~5 tests):
- create + findByExternal pair
- listActive filters inactive
- UNIQUE(tenant, type, external) — segunda create com mesmos valores falha

**roles-repo.spec.ts** (~5 tests):
- create returning row
- getByKey
- getDefault returns the row with is_default=true (apenas 1 por agent)
- listActive

**channel-policies-repo.spec.ts** (~5 tests):
- create with all defaults (by_context_guards from JSON default)
- getByChannelId
- update patches selected fields
- UNIQUE(channel_id) — segundo create no mesmo channel falha

**role-selector-decisions-repo.spec.ts** (~6 tests):
- record with action='keep_current' (mesmo manter é registrado)
- record with action='switch' atualizando switch_count
- listByConversation ordered by decided_at DESC
- countSwitchesInConversation = count(action='switch') in conversation
- record com `decided_by='llm_classifier'` lança erro (defense)

### Steps

```bash
git add src/db/repositories.ts tests/unit/channels-repo.spec.ts tests/unit/roles-repo.spec.ts tests/unit/channel-policies-repo.spec.ts tests/unit/role-selector-decisions-repo.spec.ts
git commit -m "feat(p6): 4 repos (channels + roles + channel_policies + role_selector_decisions) com guard anti-llm-decisor"
```

---

## Task 5: Channel resolver (gateway lookup)

**Files:**
- Create: `src/gateway/channel-resolver.ts`
- Test: `tests/unit/channel-resolver.spec.ts`

**Scene:** Dado uma mensagem inbound (de Baileys ou outro gateway), devolve `{ tenant_id, agent_id, channel_id }`. Determinístico. Quando flag OFF → sempre `{default, default, null}`. Quando flag ON → lookup em `channels` by `(channel_type, external_id)`.

### Signature

```typescript
import { featureFlags } from '@/config/feature-flags.js';
import { FeatureFlagName } from '@/types/enums.js';
import { channelsRepo } from '@/db/repositories.js';

export type ChannelResolution = {
  tenant_id: string;
  agent_id: string;
  channel_id: string | null;  // null em legacy mode
};

export async function resolveChannel(args: {
  channel_type: 'whatsapp' | 'telegram' | 'email' | 'sms' | 'web' | 'api' | 'other';
  external_id: string;
}): Promise<ChannelResolution> {
  if (!featureFlags.isEnabled(FeatureFlagName.MULTI_CHANNEL)) {
    return { tenant_id: 'default', agent_id: 'default', channel_id: null };
  }

  // Need cross-tenant lookup — channels lookup is NOT tenant-scoped (we're routing TO a tenant).
  // Use a dedicated repo method or raw query that bypasses applyTenantGuard.
  // (channelsRepo.findByExternal can be tenant-scoped; we need an unscoped version here.)
  const channel = await channelsRepo.findByExternalCrossTenant({
    channel_type: args.channel_type,
    external_id: args.external_id,
  });

  if (!channel || !channel.active) {
    // Unknown/inactive channel → fall back to default. Explicit warning so prod can detect
    // misrouting (e.g., new Baileys number not yet registered as channel row).
    logger.warn(
      { channel_type: args.channel_type, external_id: args.external_id, found: !!channel, active: channel?.active ?? false },
      'channel_resolver.unknown_or_inactive_channel_fallback',
    );
    return { tenant_id: 'default', agent_id: 'default', channel_id: null };
  }

  return { tenant_id: channel.tenant_id, agent_id: channel.agent_id, channel_id: channel.id };
}
```

**Repo addition** to `channelsRepo`:

```typescript
async findByExternalCrossTenant(args: { channel_type: string; external_id: string }): Promise<Channel | null> {
  // Explicitly bypasses tenant guard — needed for routing.
  const rows = await db
    .select()
    .from(schema.channels)
    .where(and(
      eq(schema.channels.channel_type, args.channel_type),
      eq(schema.channels.external_id, args.external_id),
    ))
    .limit(1);
  return rows[0] ?? null;
},
```

### TDD scenarios

1. Flag OFF → always returns `default/default/null`, no DB call.
2. Flag ON + active channel exists → returns its (tenant, agent, id).
3. Flag ON + channel inactive → fallback to `default/default/null` + warning logged.
4. Flag ON + channel not found → fallback to `default/default/null` + warning logged.

### Steps

```bash
git add src/gateway/channel-resolver.ts src/db/repositories.ts tests/unit/channel-resolver.spec.ts
git commit -m "feat(p6): channel resolver (flag-gated; fallback default/default em legacy ou unknown)"
```

---

## Task 6: Role Selector — Suggesters (LLM + Determinístico)

**Files:**
- Create: `src/cognition/role-selector/types.ts`
- Create: `src/cognition/role-selector/llm-suggester.ts`
- Create: `src/cognition/role-selector/deterministic-classifier.ts`
- Test: `tests/unit/role-selector-llm-suggester.spec.ts`
- Test: `tests/unit/role-selector-deterministic.spec.ts`

### `types.ts`

```typescript
import type { Role, ChannelPolicy } from '@/db/schema.js';
import type { SuggestedBy, RoleSelectorStrength } from '@/types/enums.js';

export type RoleSelectorInput = {
  inbound_text: string;
  current_role: Role;
  available_roles: Role[];
  policy: ChannelPolicy;
  conversa_id?: string;
  channel_id?: string;   // propagado para audit (role_selector_decisions.channel_id)
  turno_id?: string;     // opcional, propagado para audit
};

export type RoleCandidate = {
  role_id: string;
  role_key: string;
  confidence: number;
  strength: RoleSelectorStrength;
  suggested_by: SuggestedBy;
  reason: string;
};

export interface RoleSuggester {
  suggest(input: RoleSelectorInput): Promise<RoleCandidate | null>;
}
```

### `llm-suggester.ts` (Haiku)

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { runCognitiveModule } from '@/cognition/runner.js';
import { SuggestedBy, RoleSelectorStrength } from '@/types/enums.js';
import type { RoleSuggester, RoleCandidate, RoleSelectorInput } from './types.js';

function strengthFromConfidence(c: number): RoleSelectorStrength {
  if (c >= 0.8) return RoleSelectorStrength.STRONG;
  if (c >= 0.5) return RoleSelectorStrength.MEDIUM;
  return RoleSelectorStrength.WEAK;
}

export const llmSuggester: RoleSuggester = {
  async suggest(input: RoleSelectorInput): Promise<RoleCandidate | null> {
    const result = await runCognitiveModule<RoleCandidate | null>(
      { name: 'role_selector_llm', timeoutMs: 3000, triggered_by: 'sync_conditional', fallback: null },
      async () => {
        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
        const rolesBlock = input.available_roles.map((r) => `- ${r.role_key}: ${r.display_name}${r.description ? ' (' + r.description + ')' : ''}`).join('\n');
        const system = [
          'Você é um classificador de papel operacional. Dado o role atual e a mensagem do usuário,',
          'sugira qual papel é mais apropriado entre os disponíveis. Devolva JSON {role_key, confidence (0-1), reason}.',
        ].join('\n');
        const user = [
          `ROLE ATUAL: ${input.current_role.role_key} (${input.current_role.display_name})`,
          `ROLES DISPONÍVEIS:\n${rolesBlock}`,
          `MENSAGEM:\n${input.inbound_text}`,
          'Devolva JSON estrito.',
        ].join('\n\n');
        const completion = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          system,
          messages: [{ role: 'user', content: user }],
        });
        const text = completion.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text).join('');
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return null;
        let parsed: { role_key?: string; confidence?: number; reason?: string };
        try {
          parsed = JSON.parse(match[0]) as { role_key?: string; confidence?: number; reason?: string };
        } catch {
          // malformed JSON → clean null (not error log spam)
          return null;
        }
        const role = input.available_roles.find((r) => r.role_key === parsed.role_key);
        if (!role || typeof parsed.confidence !== 'number') return null;
        return {
          role_id: role.id,
          role_key: role.role_key,
          confidence: Math.max(0, Math.min(1, parsed.confidence)),
          strength: strengthFromConfidence(parsed.confidence),
          suggested_by: SuggestedBy.LLM_CLASSIFIER,
          reason: parsed.reason ?? '',
        };
      },
    );
    return result.output;
  },
};
```

### `deterministic-classifier.ts`

Pattern-based rapid detection (regex/keyword). Examples:
- "suporte", "problema", "não funciona" → role `suporte` (if exists)
- "quero comprar", "preço", "vender" → role `comercial` (if exists)
- Default: returns null (no suggestion)

```typescript
import { SuggestedBy, RoleSelectorStrength } from '@/types/enums.js';
import type { RoleSuggester, RoleCandidate, RoleSelectorInput } from './types.js';

const PATTERNS: Array<{ role_key: string; regex: RegExp; strength: RoleSelectorStrength; confidence: number }> = [
  { role_key: 'suporte', regex: /\b(suporte|problema|n[ãa]o funciona|erro|ajuda|bug|reclama)\b/i, strength: RoleSelectorStrength.MEDIUM, confidence: 0.7 },
  { role_key: 'comercial', regex: /\b(comprar|pre[çc]o|vender|valor|or[çc]amento|cota[çc][ãa]o|venda)\b/i, strength: RoleSelectorStrength.MEDIUM, confidence: 0.7 },
  { role_key: 'financeiro', regex: /\b(boleto|pagamento|fatura|pix|cobran[çc]a|d[íi]vida)\b/i, strength: RoleSelectorStrength.STRONG, confidence: 0.85 },
];

export const deterministicSuggester: RoleSuggester = {
  async suggest(input: RoleSelectorInput): Promise<RoleCandidate | null> {
    for (const p of PATTERNS) {
      if (p.regex.test(input.inbound_text)) {
        const role = input.available_roles.find((r) => r.role_key === p.role_key);
        if (!role) continue;
        return {
          role_id: role.id,
          role_key: role.role_key,
          confidence: p.confidence,
          strength: p.strength,
          suggested_by: SuggestedBy.DETERMINISTIC_CLASSIFIER,
          reason: `regex match: ${p.regex.source}`,
        };
      }
    }
    return null;
  },
};
```

### TDD scenarios

**llm-suggester** (4 tests, mocked Haiku):
- Returns valid candidate from Haiku JSON
- Returns null when Haiku unparseable
- Returns null when role_key not in available_roles
- Returns null on timeout/error (via runCognitiveModule fallback)

**deterministic** (5 tests):
- Suporte pattern detected
- Comercial pattern detected
- Financeiro detected (strength=STRONG)
- No match → null
- Match but role not in available_roles → null

### Steps

```bash
git add src/cognition/role-selector/types.ts src/cognition/role-selector/llm-suggester.ts src/cognition/role-selector/deterministic-classifier.ts tests/unit/role-selector-llm-suggester.spec.ts tests/unit/role-selector-deterministic.spec.ts
git commit -m "feat(p6): role suggesters (Haiku LLM + deterministic regex; ambos com suggested_by tipado)"
```

---

## Task 7: Role Selector — Policy Decider (determinístico) + Oscillation Tracker

**Files:**
- Create: `src/cognition/role-selector/policy-decider.ts`
- Create: `src/cognition/role-selector/oscillation-tracker.ts`
- Test: `tests/unit/role-selector-policy-decider.spec.ts`
- Test: `tests/unit/role-selector-oscillation-tracker.spec.ts`

**Scene:** Núcleo da governança P6 — **determinístico**. Recebe candidates dos suggesters + policy + current role, decide ação tipada (`keep_current | switch | handoff | fallback`). **`decided_by` jamais é `llm_classifier`** (CHECK constraint + runtime guard).

### `oscillation-tracker.ts`

```typescript
import { roleSelectorDecisionsRepo } from '@/db/repositories.js';

export async function shouldBlockSwitchByOscillation(args: {
  conversa_id: string;
  max_switches: number;
}): Promise<{ blocked: boolean; current_switches: number }> {
  if (!args.conversa_id) return { blocked: false, current_switches: 0 };
  const count = await roleSelectorDecisionsRepo.countSwitchesInConversation(args.conversa_id);
  return { blocked: count >= args.max_switches, current_switches: count };
}
```

### `policy-decider.ts`

```typescript
import { DecidedBy, RoleDecisionAction, SwitchBehavior } from '@/types/enums.js';
import { shouldBlockSwitchByOscillation } from './oscillation-tracker.js';
import type { RoleSelectorInput, RoleCandidate } from './types.js';
import type { Role } from '@/db/schema.js';

export type PolicyDecisionResult = {
  decided_role: Role;
  action: RoleDecisionAction;
  decided_by: DecidedBy;
  reason: string;
};

export async function decidePolicy(args: {
  input: RoleSelectorInput;
  candidate: RoleCandidate | null;
}): Promise<PolicyDecisionResult> {
  const { input, candidate } = args;
  const policy = input.policy;
  const switch_behavior = policy.switch_behavior as SwitchBehavior;

  // 1. LOCKED — always keep current
  if (switch_behavior === SwitchBehavior.LOCKED) {
    return {
      decided_role: input.current_role,
      action: RoleDecisionAction.KEEP_CURRENT,
      decided_by: DecidedBy.POLICY_RULE,
      reason: 'policy locked',
    };
  }

  // No candidate → keep current
  if (!candidate || candidate.role_id === input.current_role.id) {
    return {
      decided_role: input.current_role,
      action: RoleDecisionAction.KEEP_CURRENT,
      decided_by: DecidedBy.POLICY_DEFAULT,
      reason: candidate ? 'candidate equals current' : 'no candidate',
    };
  }

  // 2. PREFER_HANDOFF — sinaliza handoff em vez de switch
  if (switch_behavior === SwitchBehavior.PREFER_HANDOFF) {
    return {
      decided_role: input.current_role,
      action: RoleDecisionAction.HANDOFF,
      decided_by: DecidedBy.POLICY_RULE,
      reason: `prefer_handoff to ${candidate.role_key}`,
    };
  }

  // 3. FREE_WITH_TRIGGER — only switch on strong/explicit signal (strength >= MEDIUM)
  if (switch_behavior === SwitchBehavior.FREE_WITH_TRIGGER) {
    if (candidate.strength === 'strong' || candidate.strength === 'medium') {
      return {
        decided_role: findRoleById(input.available_roles, candidate.role_id) ?? input.current_role,
        action: RoleDecisionAction.SWITCH,
        decided_by: DecidedBy.POLICY_RULE,
        reason: `free_with_trigger fired (strength=${candidate.strength})`,
      };
    }
    return {
      decided_role: input.current_role,
      action: RoleDecisionAction.KEEP_CURRENT,
      decided_by: DecidedBy.POLICY_DEFAULT,
      reason: `weak signal, no trigger`,
    };
  }

  // 4. BY_CONTEXT — apply guards
  if (switch_behavior === SwitchBehavior.BY_CONTEXT) {
    const guards = policy.by_context_guards as {
      min_confidence_to_switch?: number;
      cooldown_turns?: number;
      required_strength_delta?: number;
      max_switches_per_conversation?: number;
    };
    const minConf = guards.min_confidence_to_switch ?? 0.7;
    const maxSwitches = guards.max_switches_per_conversation ?? 3;

    if (candidate.confidence < minConf) {
      return {
        decided_role: input.current_role,
        action: RoleDecisionAction.KEEP_CURRENT,
        decided_by: DecidedBy.POLICY_RULE,
        reason: `confidence ${candidate.confidence.toFixed(2)} < min ${minConf}`,
      };
    }

    // Oscillation guard
    if (input.conversa_id) {
      const osc = await shouldBlockSwitchByOscillation({
        conversa_id: input.conversa_id,
        max_switches: maxSwitches,
      });
      if (osc.blocked) {
        return {
          decided_role: input.current_role,
          action: RoleDecisionAction.FALLBACK,
          decided_by: DecidedBy.FALLBACK_RULE,
          reason: `max_switches_per_conversation reached (${osc.current_switches}/${maxSwitches})`,
        };
      }
    }

    return {
      decided_role: findRoleById(input.available_roles, candidate.role_id) ?? input.current_role,
      action: findRoleById(input.available_roles, candidate.role_id) ? RoleDecisionAction.SWITCH : RoleDecisionAction.FALLBACK,
      decided_by: DecidedBy.POLICY_RULE,
      reason: `by_context approved (conf=${candidate.confidence.toFixed(2)} >= ${minConf})`,
    };
  }

  // unknown switch_behavior — defensive fallback
  return {
    decided_role: input.current_role,
    action: RoleDecisionAction.FALLBACK,
    decided_by: DecidedBy.FALLBACK_RULE,
    reason: `unknown switch_behavior: ${switch_behavior}`,
  };
}

function findRoleById(roles: Role[], id: string): Role | null {
  return roles.find((r) => r.id === id) ?? null;
}
```

**Invariant:** No `Anthropic`/`anthropic` import. `decided_by` never `'llm_classifier'`. Acceptance gate #4 enforces this via grep.

### TDD scenarios

**policy-decider.spec.ts** (12+):
- LOCKED → always keep_current (com candidate strong)
- PREFER_HANDOFF + candidate diferente → handoff
- FREE_WITH_TRIGGER + strength=weak → keep_current
- FREE_WITH_TRIGGER + strength=medium → switch
- FREE_WITH_TRIGGER + strength=strong → switch
- BY_CONTEXT + confidence < min → keep_current
- BY_CONTEXT + confidence >= min + osc count < max → switch
- BY_CONTEXT + confidence >= min + osc count >= max → fallback (anti-osc)
- No candidate → keep_current
- Candidate equals current → keep_current
- Custom guards (min_confidence=0.9; candidate at 0.85) → keep_current
- Unknown switch_behavior → fallback

**oscillation-tracker.spec.ts** (4):
- No conversa_id → not blocked
- count < max → not blocked
- count = max → blocked
- count > max → blocked

### Steps

```bash
git add src/cognition/role-selector/policy-decider.ts src/cognition/role-selector/oscillation-tracker.ts tests/unit/role-selector-policy-decider.spec.ts tests/unit/role-selector-oscillation-tracker.spec.ts
git commit -m "feat(p6): policy decider (determinístico; 4 switch_behaviors + travas anti-osc) + oscillation tracker"
```

---

## Task 8: Role Selector — Engine + Audit (sempre registra)

**Files:**
- Create: `src/cognition/role-selector/engine.ts`
- Test: `tests/unit/role-selector-engine.spec.ts`
- Test: `tests/unit/role-audit-always-recorded.spec.ts`

**Scene:** Orquestra: suggesters → policy-decider → audit (sempre). Mesmo decisão `keep_current` gera 1 row em `role_selector_decisions` (spec §9 P6 done #3).

### `engine.ts`

```typescript
import { roleSelectorDecisionsRepo } from '@/db/repositories.js';
import { llmSuggester } from './llm-suggester.js';
import { deterministicSuggester } from './deterministic-classifier.js';
import { decidePolicy } from './policy-decider.js';
import { SuggestedBy } from '@/types/enums.js';
import type { RoleSelectorInput, RoleCandidate } from './types.js';
import type { Role } from '@/db/schema.js';

export type RoleSelectorResult = {
  decided_role: Role;
  action: 'keep_current' | 'switch' | 'handoff' | 'fallback';
  decision_id: string;
};

export async function selectRole(input: RoleSelectorInput): Promise<RoleSelectorResult> {
  // Run both suggesters in parallel; deterministic wins if both match (cheaper, more predictable)
  const [detResult, llmResult] = await Promise.all([
    deterministicSuggester.suggest(input),
    llmSuggester.suggest(input),
  ]);

  const candidates: RoleCandidate[] = [detResult, llmResult].filter((c): c is RoleCandidate => c !== null);
  const conflicts: Array<{ a: string; b: string; reason: string }> = [];

  // Prefer deterministic if both present
  let chosenCandidate: RoleCandidate | null = null;
  if (detResult && llmResult) {
    if (detResult.role_id === llmResult.role_id) {
      chosenCandidate = detResult; // both agree
    } else {
      conflicts.push({ a: detResult.role_key, b: llmResult.role_key, reason: 'suggesters_disagree' });
      chosenCandidate = detResult; // deterministic wins
    }
  } else {
    chosenCandidate = detResult ?? llmResult;
  }

  const decision = await decidePolicy({ input, candidate: chosenCandidate });

  // Compute switch count
  const baseCount = await roleSelectorDecisionsRepo.countSwitchesInConversation(input.conversa_id ?? '');
  const newSwitchCount = decision.action === 'switch' ? baseCount + 1 : baseCount;

  // ALWAYS record — even for keep_current (spec §9 P6 done criterion #3)
  const recorded = await roleSelectorDecisionsRepo.record({
    conversa_id: input.conversa_id,
    channel_id: input.channel_id,
    turno_id: input.turno_id,
    policy_id: input.policy.id,
    current_role_id: input.current_role.id,
    suggested_role_id: chosenCandidate?.role_id,
    decided_role_id: decision.decided_role.id,
    action: decision.action,
    candidates: candidates.map((c) => ({ role_key: c.role_key, confidence: c.confidence, strength: c.strength, suggested_by: c.suggested_by, reason: c.reason })),
    conflicts,
    suggested_by: chosenCandidate?.suggested_by ?? SuggestedBy.NONE,
    decided_by: decision.decided_by,
    suggested_strength: chosenCandidate?.strength,
    suggested_confidence: chosenCandidate?.confidence,
    reason: decision.reason,
    switch_count_in_conversation: newSwitchCount,
  });

  return {
    decided_role: decision.decided_role,
    action: decision.action,
    decision_id: recorded.id,
  };
}
```

### TDD scenarios

**role-selector-engine.spec.ts** (~6):
- Both suggesters agree → 1 candidate, no conflict, switch decision
- Suggesters disagree → conflict logged, deterministic wins
- Only LLM suggests → llm_classifier as suggested_by
- Only deterministic suggests → deterministic_classifier as suggested_by
- Neither suggests → action=keep_current, audit row still created
- Switch triggers → switch_count_in_conversation incremented

**role-audit-always-recorded.spec.ts** (3):
- `keep_current` decision → audit row created
- `switch` decision → audit row created
- `handoff` decision → audit row created
(prove invariant: every call to selectRole creates 1 row)

### Steps

```bash
git add src/cognition/role-selector/engine.ts tests/unit/role-selector-engine.spec.ts tests/unit/role-audit-always-recorded.spec.ts
git commit -m "feat(p6): role selector engine (suggesters paralelos -> policy decider -> audit sempre)"
```

---

## Task 9: Agent core + Prompt-builder integration

**Files:**
- Modify: `src/agent/core.ts`
- Modify: `src/agent/prompt-builder.ts`
- Test: `tests/unit/prompt-builder-role-section.spec.ts`

**Scene:** Quando flag ON, `runAgentForMensagem`:
1. Resolve channel via `resolveChannel` (Task 5) — extrai `(tenant_id, agent_id, channel_id)` da mensagem.
2. Roda `runWithTenantContext({ tenant_id, agent_id }, async () => {...})`.
3. Dentro do context: chama `selectRole({inbound_text, current_role, available_roles, policy, conversa_id})` pré-turn.
4. Anexa `decided_role` ao context. Prompt-builder injeta `role.prompt_addendum` como seção "Modo operacional".

Flag OFF → comportamento atual preservado (default/default, sem role injection).

### `agent/core.ts` modification

Replace the existing comment + hardcoded `default/default`:

```typescript
// BEFORE (existing P0 code):
// P0: 'default' is the only tenant/agent — single-tenant deployment.
// P6 introduces multi-channel/multi-agent and will route via channel→tenant
// resolution before this function is invoked.
await runWithTenantContext(
  { tenant_id: 'default', agent_id: 'default' },
  () => runAgentForMensagemInner(mensagem_id),
);

// AFTER:
const channelType = inferChannelTypeFromMensagem(mensagem_id);
const externalId = inferExternalIdFromMensagem(mensagem_id);
const resolution = await resolveChannel({ channel_type: channelType, external_id: externalId });
await runWithTenantContext(
  { tenant_id: resolution.tenant_id, agent_id: resolution.agent_id },
  () => runAgentForMensagemInner(mensagem_id, { channel_id: resolution.channel_id }),
);
```

(Note: `inferChannelTypeFromMensagem` and `inferExternalIdFromMensagem` are helpers that read the mensagem before tenant context exists — pure DB lookup without tenant guard. Need an unscoped fetch method. Alternatively, the gateway baileys layer can supply these at insert time so `mensagensRepo.findByIdCrossTenant` exists; document approach.)

Inside `runAgentForMensagemInner`, before the existing prompt build:

```typescript
if (featureFlags.isEnabled(FeatureFlagName.MULTI_CHANNEL) && opts?.channel_id) {
  const policy = await channelPoliciesRepo.getByChannelId(opts.channel_id);
  if (policy) {
    const availableRoles = await rolesRepo.listActive();
    const currentRole = await rolesRepo.getById(policy.default_role_id);
    if (currentRole && availableRoles.length > 0) {
      const result = await selectRole({
        inbound_text: inbound.conteudo ?? '',
        current_role: currentRole,
        available_roles: availableRoles,
        policy,
        conversa_id: inbound.conversa_id ?? undefined,
      });
      // Attach to context for prompt-builder
      attachedRole = result.decided_role;
    }
  }
}
```

### `prompt-builder.ts` modification

Add a helper:

```typescript
async function buildRoleSection(role: Role | null): Promise<string | null> {
  if (!role || !featureFlags.isEnabled(FeatureFlagName.MULTI_CHANNEL)) return null;
  if (!role.prompt_addendum && !role.description) return null;
  const parts: string[] = ['## Modo operacional'];
  parts.push(`Você está operando como **${role.display_name}**.`);
  if (role.description) parts.push(role.description);
  if (role.prompt_addendum) parts.push(role.prompt_addendum);
  return parts.join('\n\n');
}
```

**Insertion order — IMPORTANT (spec §10.7 precedence: CHANNEL POLICY > PROCEDURE ATIVA > LEARNED_RULES > MEMORY > BEHAVIORAL HINT):**

The role section represents CHANNEL POLICY context and must appear **BEFORE** `procedureSection` in the final system block assembly. The current code in `src/agent/prompt-builder.ts` concatenates approximately `... + selfAwarenessSection + procedureSection + gapMentionSection`. The new assembly should be:

```
... + selfAwarenessSection + roleSection + procedureSection + gapMentionSection + ...
```

Inserting role section AFTER procedureSection would put procedure ahead of policy in precedence — violates §10.7. The gap mention section stays at the end (lowest precedence among hint-like sections).

### TDD scenarios

**prompt-builder-role-section.spec.ts** (5):
1. Flag OFF → no role section.
2. Flag ON + role=null → no role section.
3. Flag ON + role with prompt_addendum → section present.
4. Flag ON + role only with description, no addendum → section with description.
5. Flag ON + role with neither description nor addendum → no section.

### Steps

```bash
git add src/agent/core.ts src/agent/prompt-builder.ts tests/unit/prompt-builder-role-section.spec.ts
git commit -m "feat(p6): agent/core resolve channel + prompt-builder inject role section (flag-gated)"
```

---

## Task 10: Integration test end-to-end P6

**Files:**
- Create: `tests/integration/p6-channel-role-policy.spec.ts`

**Scene:** Cenário completo, mocked end-to-end. **7 cenários** (todas as 4 policies + anti-osc + audit always + flag OFF):

1. **Flag OFF: legacy preserved** — `resolveChannel` retorna default; agent core não chama selector; comportamento idêntico ao P5 (cenário "no role section in prompt").
2. **Policy=LOCKED** — qualquer mensagem mantém current_role; audit row criado com action=keep_current, decided_by=policy_rule.
3. **Policy=PREFER_HANDOFF + candidate diferente** — action=handoff, decided_role=current (não muda); audit row mostra suggested != decided.
4. **Policy=FREE_WITH_TRIGGER + trigger strong** — switch; switch_count=1; audit row action=switch.
5. **Policy=BY_CONTEXT + travas honradas** — 1ª mensagem com conf=0.85 → switch (count=1); 2ª com conf=0.85 → switch (count=2); 3ª com conf=0.85 → switch (count=3); 4ª com conf=0.85 → **action=fallback** (anti-osc disparado), decided_by=fallback_rule.
6. **decided_by NUNCA é llm_classifier** — qualquer cenário acima, verificar que `decided_by` está em `{policy_default, policy_rule, owner_override, fallback_rule}`. Negative test: tentar `roleSelectorDecisionsRepo.record({decided_by: 'llm_classifier', ...})` lança erro hard.
7. **Maia atual sem mudança visível** — flag OFF + mensagem normal → prompt gerado sem seção "Modo operacional"; comportamento idêntico ao baseline.

### Steps

1. Inspect `tests/integration/p5-dialogical-acquisition.spec.ts` for mock pattern.
2. Write 7 cenários with `vi.hoisted` + `vi.mock` for repos + suggesters.
3. Iterate até all pass. Don't modify production code; report DONE_WITH_CONCERNS if bug surfaces.
4. Typecheck clean.
5. Commit:

```bash
git add tests/integration/p6-channel-role-policy.spec.ts
git commit -m "test(p6): integration test channel/role/policy (7 cenários mocked, incl. anti-osc + audit always)"
```

---

## Task 11: Acceptance gates + runbook

**Files:**
- Create: `scripts/p6-acceptance-gates.sh`
- Create: `docs/runbooks/p6-channel-role-policy.md`

### Gates script (espelha P5 style)

**8 gates** (1 a mais que P5 dada a complexidade):

1. **Migrations 031-035 exist (UP+DOWN)** + grep CREATE TABLE channels/roles/channel_policies/role_selector_decisions + grep seed DO $$ block in 035.
2. **Vitest:** all P6 specs:
   ```
   npx vitest run \
     tests/unit/enums-p6.spec.ts \
     tests/unit/db-schema-p6.spec.ts \
     tests/unit/channels-repo.spec.ts \
     tests/unit/roles-repo.spec.ts \
     tests/unit/channel-policies-repo.spec.ts \
     tests/unit/role-selector-decisions-repo.spec.ts \
     tests/unit/channel-resolver.spec.ts \
     tests/unit/role-selector-llm-suggester.spec.ts \
     tests/unit/role-selector-deterministic.spec.ts \
     tests/unit/role-selector-policy-decider.spec.ts \
     tests/unit/role-selector-oscillation-tracker.spec.ts \
     tests/unit/role-selector-engine.spec.ts \
     tests/unit/role-audit-always-recorded.spec.ts \
     tests/unit/prompt-builder-role-section.spec.ts \
     tests/integration/p6-channel-role-policy.spec.ts
   ```
3. **Typecheck:** `npx tsc --noEmit`.
4. **`policy-decider.ts` é determinístico:** `grep -E "anthropic|Anthropic|openai|OpenAI" src/cognition/role-selector/policy-decider.ts` retorna 0 matches.
5. **Worker / module registrations:** flag `MULTI_CHANNEL` no singleton (`grep "MULTI_CHANNEL" src/config/feature-flags.ts`).
6. **`decided_by` CHECK constraint não inclui `llm_classifier`:** `grep "decided_by IN" migrations/034_p6_role_selector_decisions.sql` deve retornar a linha sem `'llm_classifier'`. Critical for spec criterion #2.
7. **Seed migration preserva Maia atual:** `grep "free_with_trigger" migrations/035_p6_seed_default_channel_role_policy.sql` matches (proves default policy = free_with_trigger as spec criterion #5 mandates).
8. **Audit always check:** `grep "ALWAYS record" src/cognition/role-selector/engine.ts` ou similar — proves comment/invariant em código (também coberto por test, mas grep dá rastreabilidade).

### Runbook

Sections (mirror P5):
- Overview P6 + escopo (4 tabelas, role engine, gateway refactor) + dependências
- Feature flag `FEATURE_MULTI_CHANNEL` (default off) + killSwitch
- Como rodar a migração: 031-035 em ordem
- Como criar novo channel manualmente: SQL INSERT + INSERT em channel_policies
- Como criar novo role: SQL INSERT em roles
- Como customizar policy de um channel: UPDATE channel_policies SET ...
- Switch behaviors explicados: locked / prefer_handoff / free_with_trigger / by_context (com exemplos)
- Travas by_context (4 parâmetros) + defaults
- Como inspecionar decisões: SQL SELECT em role_selector_decisions
- Como auditar conformidade spec §9 P6 done criterion #2: `SELECT DISTINCT decided_by FROM role_selector_decisions` — nenhum row pode ter `llm_classifier`
- Rollback <1min via killSwitch
- Rollback persistente: env + restart
- Rollback migrations: 035 → 034 → 033 → 032 → 031 (ordem reversa de FKs)
- Troubleshooting:
  - "Role não muda mesmo com candidate strong" → checar `switch_behavior` (provavelmente `locked` ou `prefer_handoff`)
  - "Switches em loop" → conferir `max_switches_per_conversation` em `by_context_guards`
  - "Channel resolver retorna default sempre" → flag off ou channel não cadastrado
  - "Prompt sem 'Modo operacional'" → flag off ou role sem `prompt_addendum`/`description`
- Próxima fase: **P7** (Grafo cognitivo formal)

### Steps

```bash
git add scripts/p6-acceptance-gates.sh docs/runbooks/p6-channel-role-policy.md
git commit -m "docs(p6): acceptance gates script + runbook channel/role/policy"
```

---

## Acceptance Criteria (P6 done — spec §9 linhas 609-614)

1. **LLM apenas sugere role (`suggested_by=llm_classifier` em todas as decisões)** — Task 6 enforces this; suggester returns `suggested_by: SuggestedBy.LLM_CLASSIFIER`. Integration cenário 4/5/6.

2. **Policy decide role (`decided_by` jamais é `llm_classifier`)** — Multiple defenses:
   - Enum `DecidedBy` doesn't include `llm_classifier` (Task 1).
   - DB CHECK constraint on `role_selector_decisions.decided_by` (Task 2d).
   - Runtime guard in `roleSelectorDecisionsRepo.record` (Task 4).
   - Acceptance gate #6 verifies via grep.

3. **Toda troca de role registrada em `role_selector_decisions` (mesmo "manter atual")** — Task 8 engine ALWAYS records. Test `role-audit-always-recorded.spec.ts` proves invariant.

4. **`by_context` com travas anti-oscilação previne mais de 3 trocas por conversa (default)** — Task 7 `policy-decider` checks `oscillation-tracker`. Default `max_switches_per_conversation=3`. Integration cenário 5 exercises 4 attempts, 4th blocked.

5. **Maia atual migra pra (1 agent / 1 channel / 1 role / policy=free_with_trigger) sem mudança visível** — Task 3 seed creates exactly this config. Integration cenário 7 verifies legacy preserved with flag off.

---

## Riscos & Mitigations

| Risco | Mitigação |
|---|---|
| Gateway refactor quebra produção | Flag default OFF; resolver retorna `default/default` em legacy. Integration cenário 1 valida. |
| Role selector vira gargalo (sync Haiku call por turn) | Wrapped em `runCognitiveModule` com timeout 3s + fallback null. Determinístico roda em paralelo (gratuito). |
| Switches em loop infinito | Oscillation tracker + `max_switches_per_conversation=3` default. Integration cenário 5 valida. |
| `decided_by=llm_classifier` escapa para audit | 3 camadas: enum não inclui, DB CHECK, runtime guard. Acceptance gate #6. |
| Seed migration falha em ambiente sem `default` tenant | ON CONFLICT DO NOTHING + DO $$ block; idempotente. |
| Conflitos de role suggesters confundem audit | Deterministic wins; conflicts logados em `conflicts` JSONB para análise post-hoc. |
| Channel resolver cross-tenant lookup viola tenant isolation | Resolver é ENTRY POINT — antes do tenant context. Explicitamente documentado em `findByExternalCrossTenant`. Após resolver, tudo entra em runWithTenantContext do tenant resolvido. |

---

## Notas finais

- **Migrations 031-035** entram em ordem (FK channel_policies → channels + roles; role_selector_decisions → channels + policies + roles).
- **NÃO MERGEAR P6** sem P5 (#87) merged. Migrations dependem do schema atual.
- **Quando rodar gates:** após DB up + 031-035 aplicadas + seed inicial executado.
- **`FEATURE_MULTI_CHANNEL` deve ficar OFF em produção** até validação completa em staging — esta é a fase de maior risco do roadmap.
- **Próxima fase candidata:** **P7 (Grafo cognitivo formal)** — orquestração via grafo declarativo; última fase do roadmap.
