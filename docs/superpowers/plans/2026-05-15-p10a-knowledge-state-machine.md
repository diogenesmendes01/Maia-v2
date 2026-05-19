# P10a Knowledge State Machine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 9-state Knowledge State Machine with auto-promoter worker + 4 `propose_*` tools + deterministic visibility logic. Every knowledge proposal (fact/rule/memory/behavioral_hint) routes through `KnowledgeStateMachine.propose()` to ephemeral or pending_review (never active by accident). Auto-promoter matures by evidence; Admin UI approves pending_review; all transitions audit via append-only `lifecycle_transitions JSONB`.

**Architecture:** `KnowledgeStateMachine` class (propose/transition/revoke) + `KnowledgeRiskScorer` (P9c input) + deterministic `decideInitialStatus()` rules + 9-state `ALLOWED_TRANSITIONS` table + cron worker (every 1h) + visibility predicate `knowledgeIsVisible()` for ranking.

**Tech Stack:** TypeScript (Node.js 22), Drizzle ORM, PostgreSQL 16, vitest.

**Spec:** [`docs/superpowers/specs/2026-05-15-p10a-knowledge-state-machine-design.md`](../specs/2026-05-15-p10a-knowledge-state-machine-design.md) — §0.1 (Architecture Lock), §2.6 (lifecycle definition), §4–8 (state machine details), §11 (testing).

**Branch alvo:** `claude/p10a-knowledge-state-machine` (new from main)

---

## Preconditions

1. **P8c merged** — `lifecycle_status` column (DEFAULT `'active'`) + `evidence_count`, `confidence`, `lifecycle_transitions JSONB` in 4 tables (memory_entry, agent_facts, learned_rules, behavioral_hint). `isVisibleLifecycle` predicate already filters at DB level.
2. **P9c merged** — `KnowledgeRiskScorer.score()` available with no-downgrade rule enforced.
3. **P8.5 merged** — Admin UI Proposal Inbox (`/inbox`) with endpoints `inbox.listProposals` + `inbox.counters` filtering `Type=knowledge` + `Status=pending_review`.
4. **P1 available** — `runCognitiveModule` wrapper exported and functional.
5. **No tenants in prod with knowledge data yet** — P8c DEFAULT `'active'` preserves legacy backfill; P10a new proposals will route differently.

**Setup worktree:**

```bash
cd "C:/Users/PC Di/Desktop/CODIGO/Maia"
git fetch origin
git worktree add .claude/worktrees/p10a-knowledge-state-machine main
cd .claude/worktrees/p10a-knowledge-state-machine
git checkout -b claude/p10a-knowledge-state-machine
```

**Verify preconditions (fail-fast):**

```bash
set -e
test -f migrations/030_p8c_lifecycle_status.sql || { echo "FAIL: P8c migration missing"; exit 1; }
test -f src/control-plane/knowledge-risk-scorer/index.ts || { echo "FAIL: P9c scorer missing"; exit 1; }
test -f src/admin/proposal-inbox/routes.ts || { echo "FAIL: P8.5 inbox missing"; exit 1; }
test -f src/cognition/runner.ts || { echo "FAIL: runCognitiveModule missing"; exit 1; }
# Check columns in schema
grep -q "lifecycle_status" src/db/schema.ts || { echo "FAIL: lifecycle_status not in schema"; exit 1; }
grep -q "evidence_count" src/db/schema.ts || { echo "FAIL: evidence_count not in schema"; exit 1; }
grep -q "lifecycle_transitions" src/db/schema.ts || { echo "FAIL: lifecycle_transitions not in schema"; exit 1; }
echo "✓ all preconditions OK"
```

---

## File Structure

### Files to create

```
src/control-plane/knowledge-state-machine/
├── index.ts                                  # barrel re-export
├── state-machine.ts                          # NEW — KnowledgeStateMachine class
├── transitions.ts                            # NEW — ALLOWED_TRANSITIONS table + assertAllowedTransition
├── visibility.ts                             # NEW — knowledgeIsVisible(k, ctx)
├── repos.ts                                  # NEW — knowledge repo facade (4 tables)
├── types.ts                                  # NEW — KnowledgeKind, KnowledgeLifecycleStatus, etc.
└── __tests__/
    ├── state-machine.spec.ts
    ├── transitions.spec.ts
    ├── visibility.spec.ts
    └── no-path-revoked-to-active.property.spec.ts

src/workers/
└── knowledge-state-promoter.ts               # NEW — cron worker (every 1h)

src/tools/
├── propose-fact.ts                           # NEW
├── propose-rule.ts                           # NEW
├── propose-memory.ts                         # NEW
├── propose-hint.ts                           # NEW
├── save-fact.ts                              # MODIFIED — wrapper + deprecation log
├── save-rule.ts                              # MODIFIED — wrapper + deprecation log
└── recall-memory.ts                          # MODIFIED — apply visibility filter (if needed)

src/db/migrations/
└── 0XX_p10a_ksm_indexes_and_check.sql        # NEW — pending_review_idx + auto_promoter_eligible_idx + CHECK

src/config/
└── feature-flags.ts                          # MODIFIED — add FEATURE_KNOWLEDGE_STATE_MACHINE_V1

.github/
└── CODEOWNERS                                # MODIFIED — add founder approval for KSM files

tests/integration/
└── p10a-knowledge-lifecycle.spec.ts          # NEW — 7 end-to-end cenários

docs/superpowers/runbooks/
└── p10a-knowledge-state-machine.md           # NEW — operational guide

scripts/acceptance/
└── p10a-knowledge-state-machine.sh           # NEW — 12 gates
```

### Files to modify

| File | Change |
|---|---|
| `src/tools/_registry.ts` | Register 4 new `propose_*` tools; modify `save_fact`/`save_rule` entries |
| `src/workers/index.ts` | Add `knowledge_state_promoter` to `JOBS[]` cron |
| `src/admin/proposal-inbox/routes.ts` | Enrich risk_score from `lifecycle_transitions[0].risk_score` |
| `src/user-layer/internal/visibility.ts` | No change (P8c predicate already filters); P10a extends in KSM code |

---

## Phase 1 — Types + migrations + core state machine (Tasks 1-5)

### Task 1: Worktree + branch + feature flag

**Files:**
- Config: `src/config/feature-flags.ts`

- [ ] **Step 1: Verify branch exists**

```bash
git branch -a | grep -q "claude/p10a-knowledge-state-machine" && echo "OK" || git checkout -b claude/p10a-knowledge-state-machine
```

- [ ] **Step 2: Add feature flag**

Ensure `src/config/feature-flags.ts` exports:

```typescript
export const FEATURE_KNOWLEDGE_STATE_MACHINE_V1 =
  process.env.FEATURE_KNOWLEDGE_STATE_MACHINE_V1 === 'true';
```

If it doesn't exist, create it or add to existing flags file.

- [ ] **Step 3: Verify initial state**

```bash
git status
```

Expected: on `claude/p10a-knowledge-state-machine`, clean tree.

- [ ] **Step 4: Commit**

```bash
git add src/config/feature-flags.ts
git commit -m "feat(p10a): feature flag FEATURE_KNOWLEDGE_STATE_MACHINE_V1"
```

---

### Task 2: Migration — indexes + CHECK constraint

**Files:**
- Create: `src/db/migrations/0XX_p10a_ksm_indexes_and_check.sql` (replace `0XX` with next migration number)

- [ ] **Step 1: Find next migration number**

```bash
ls src/db/migrations/ | grep "^[0-9]" | sort -n | tail -1
```

Assume result is `030` — next is `031`.

- [ ] **Step 2: Write migration file**

Content per spec §2 (Migration SQL). Create `src/db/migrations/031_p10a_ksm_indexes_and_check.sql`:

```sql
-- 031_p10a_ksm_indexes_and_check.sql
-- P10a — Knowledge State Machine indexes + transition CHECK constraint.
-- Pré-requisito: P8c (030_p8c_lifecycle_status.sql) já criou as colunas.

BEGIN;

-- ============================================================
-- Índices: Admin UI Proposal Inbox
-- ============================================================
CREATE INDEX IF NOT EXISTS knowledge_pending_review_idx_memory
  ON memory_entry (tenant_id, created_at DESC)
  WHERE lifecycle_status = 'pending_review';

CREATE INDEX IF NOT EXISTS knowledge_pending_review_idx_facts
  ON agent_facts (tenant_id, created_at DESC)
  WHERE lifecycle_status = 'pending_review';

CREATE INDEX IF NOT EXISTS knowledge_pending_review_idx_rules
  ON learned_rules (tenant_id, created_at DESC)
  WHERE lifecycle_status = 'pending_review';

CREATE INDEX IF NOT EXISTS knowledge_pending_review_idx_hints
  ON behavioral_hint (tenant_id, created_at DESC)
  WHERE lifecycle_status = 'pending_review';

-- ============================================================
-- Índices: auto-promoter eligibility
-- ============================================================
CREATE INDEX IF NOT EXISTS knowledge_auto_promoter_eligible_idx_memory
  ON memory_entry (lifecycle_status, evidence_count, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX IF NOT EXISTS knowledge_auto_promoter_eligible_idx_facts
  ON agent_facts (lifecycle_status, evidence_count, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX IF NOT EXISTS knowledge_auto_promoter_eligible_idx_rules
  ON learned_rules (lifecycle_status, evidence_count, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

CREATE INDEX IF NOT EXISTS knowledge_auto_promoter_eligible_idx_hints
  ON behavioral_hint (lifecycle_status, evidence_count, updated_at)
  WHERE lifecycle_status IN ('ephemeral', 'observed', 'reinforced', 'verified');

-- ============================================================
-- CHECK: lifecycle_transitions JSONB shape
-- ============================================================
ALTER TABLE memory_entry
  ADD CONSTRAINT memory_entry_lifecycle_transitions_shape
  CHECK (jsonb_typeof(lifecycle_transitions) = 'array');

ALTER TABLE agent_facts
  ADD CONSTRAINT agent_facts_lifecycle_transitions_shape
  CHECK (jsonb_typeof(lifecycle_transitions) = 'array');

ALTER TABLE learned_rules
  ADD CONSTRAINT learned_rules_lifecycle_transitions_shape
  CHECK (jsonb_typeof(lifecycle_transitions) = 'array');

ALTER TABLE behavioral_hint
  ADD CONSTRAINT behavioral_hint_lifecycle_transitions_shape
  CHECK (jsonb_typeof(lifecycle_transitions) = 'array');

COMMIT;
```

- [ ] **Step 3: Create down migration** (even though forward-only in practice)

Create `src/db/migrations/031_p10a_ksm_indexes_and_check_down.sql`:

```sql
-- Down migration for 031
BEGIN;

DROP CONSTRAINT IF EXISTS behavioral_hint_lifecycle_transitions_shape;
DROP CONSTRAINT IF EXISTS learned_rules_lifecycle_transitions_shape;
DROP CONSTRAINT IF EXISTS agent_facts_lifecycle_transitions_shape;
DROP CONSTRAINT IF EXISTS memory_entry_lifecycle_transitions_shape;

DROP INDEX IF EXISTS knowledge_auto_promoter_eligible_idx_hints;
DROP INDEX IF EXISTS knowledge_auto_promoter_eligible_idx_rules;
DROP INDEX IF EXISTS knowledge_auto_promoter_eligible_idx_facts;
DROP INDEX IF EXISTS knowledge_auto_promoter_eligible_idx_memory;

DROP INDEX IF EXISTS knowledge_pending_review_idx_hints;
DROP INDEX IF EXISTS knowledge_pending_review_idx_rules;
DROP INDEX IF EXISTS knowledge_pending_review_idx_facts;
DROP INDEX IF EXISTS knowledge_pending_review_idx_memory;

COMMIT;
```

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/031_p10a_ksm_indexes_and_check.sql src/db/migrations/031_p10a_ksm_indexes_and_check_down.sql
git commit -m "migration(p10a): add KSM indexes + lifecycle_transitions CHECK"
```

---

### Task 3: Types — `KnowledgeKind`, `KnowledgeLifecycleStatus`, interfaces

**Files:**
- Create: `src/control-plane/knowledge-state-machine/types.ts`

- [ ] **Step 1: Write types file**

```typescript
// src/control-plane/knowledge-state-machine/types.ts

export type KnowledgeKind = 'fact' | 'rule' | 'memory' | 'behavioral_hint' | 'procedure_hint';
export type KnowledgeScope = 'turn' | 'session' | 'user' | 'agent' | 'tenant' | 'global';
export type KnowledgeLifecycleStatus =
  | 'proposed'
  | 'pending_review'
  | 'ephemeral'
  | 'observed'
  | 'reinforced'
  | 'verified'
  | 'active'
  | 'deprecated'
  | 'revoked';

export interface KnowledgeProposalInput {
  trace_id: string;
  tenant_id: string;
  agent_id: string;
  kind: KnowledgeKind;
  scope: KnowledgeScope;
  scope_value?: string;
  key: string;
  content: unknown;
  content_text: string;
  confidence: number; // 0–1
  origin: 'llm_inference' | 'user_explicit' | 'tool_callback' | 'human_approved';
  source: string;
  sensitivity_hint?: 'low' | 'medium' | 'high';
  ttl_days?: number;
}

export interface KnowledgeProposeResult {
  proposal_id: string;
  initial_status: KnowledgeLifecycleStatus;
  visible_to_llm: boolean;
  reason: string;
}

export interface KnowledgeTransitionInput {
  kind: KnowledgeKind;
  proposal_id: string;
  to: KnowledgeLifecycleStatus;
  reason: string;
  decided_by:
    | 'state_machine_propose'
    | 'auto_promoter:evidence_threshold'
    | 'auto_promoter:ttl_expired'
    | 'auto_promoter:no_usage_90d'
    | 'human_approval'
    | 'human_rejection'
    | 'incident_response'
    | 'drift_decision';
  evidence_id?: string;
}

export interface KnowledgeTransitionResult {
  from: KnowledgeLifecycleStatus;
  to: KnowledgeLifecycleStatus;
  at: string;
  reason: string;
  decided_by?: string;
  evidence_id?: string;
}

export interface KnowledgeRevokeInput {
  kind: KnowledgeKind;
  proposal_id: string;
  reason: string;
  decided_by: 'human_rejection' | 'incident_response' | 'drift_decision' | 'contraevidence';
}

export type KnowledgeRevokeResult = KnowledgeTransitionResult;

export interface KnowledgeRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  kind: KnowledgeKind;
  key: string;
  scope: KnowledgeScope;
  scope_value?: string;
  content: unknown;
  confidence: number;
  lifecycle_status: KnowledgeLifecycleStatus;
  lifecycle_transitions: Array<{
    from: KnowledgeLifecycleStatus;
    to: KnowledgeLifecycleStatus;
    at: string;
    reason: string;
    decided_by: string;
    risk_score?: { level: string; sensitivity?: string; reasons?: string[]; source?: string };
    evidence_id?: string;
  }>;
  evidence_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface KnowledgeVisibilityContext {
  context_mode?: 'normal' | 'strict' | 'debug';
}

export interface KnowledgeVisibilityResult {
  visible: boolean;
  weight: number;
  label: string | null;
}
```

- [ ] **Step 2: Test types compile**

```bash
npm run typecheck
```

Expected: no errors in newly created file.

- [ ] **Step 3: Commit**

```bash
git add src/control-plane/knowledge-state-machine/types.ts
git commit -m "feat(p10a): add KnowledgeStateMachine types"
```

---

### Task 4: Transitions table + assertion

**Files:**
- Create: `src/control-plane/knowledge-state-machine/transitions.ts`
- Create: `src/control-plane/knowledge-state-machine/__tests__/transitions.spec.ts`

- [ ] **Step 1: Write transitions.ts**

```typescript
// src/control-plane/knowledge-state-machine/transitions.ts

import type { KnowledgeLifecycleStatus } from './types.js';

/**
 * Tabela canônica de transições válidas. Mudança aqui = Architecture Lock.
 * Exige aprovação do founder.
 */
export const ALLOWED_TRANSITIONS: Record<
  KnowledgeLifecycleStatus,
  KnowledgeLifecycleStatus[]
> = {
  proposed: ['pending_review', 'ephemeral'],
  pending_review: ['active', 'verified', 'revoked'],
  ephemeral: ['observed', 'deprecated', 'revoked'],
  observed: ['reinforced', 'deprecated', 'revoked'],
  reinforced: ['verified', 'deprecated', 'revoked'],
  verified: ['active', 'deprecated', 'revoked'],
  active: ['deprecated', 'revoked'],
  deprecated: ['revoked'],
  revoked: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: KnowledgeLifecycleStatus,
    public readonly to: KnowledgeLifecycleStatus,
  ) {
    super(`Illegal knowledge lifecycle transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertAllowedTransition(
  from: KnowledgeLifecycleStatus,
  to: KnowledgeLifecycleStatus,
): void {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) throw new IllegalTransitionError(from, to);
}
```

- [ ] **Step 2: Write transitions.spec.ts**

```typescript
// src/control-plane/knowledge-state-machine/__tests__/transitions.spec.ts

import { describe, it, expect } from 'vitest';
import { ALLOWED_TRANSITIONS, assertAllowedTransition, IllegalTransitionError } from '../transitions.js';
import type { KnowledgeLifecycleStatus } from '../types.js';

describe('ALLOWED_TRANSITIONS table', () => {
  it('has all 9 states as keys', () => {
    const states: KnowledgeLifecycleStatus[] = [
      'proposed',
      'pending_review',
      'ephemeral',
      'observed',
      'reinforced',
      'verified',
      'active',
      'deprecated',
      'revoked',
    ];
    for (const state of states) {
      expect(state in ALLOWED_TRANSITIONS).toBe(true);
    }
  });

  it('proposed only transitions to pending_review or ephemeral', () => {
    expect(ALLOWED_TRANSITIONS.proposed).toEqual(['pending_review', 'ephemeral']);
  });

  it('revoked is terminal (empty transitions)', () => {
    expect(ALLOWED_TRANSITIONS.revoked).toEqual([]);
  });

  it('pending_review can go to active/verified/revoked', () => {
    expect(ALLOWED_TRANSITIONS.pending_review).toEqual(['active', 'verified', 'revoked']);
  });

  it('ephemeral can go to observed/deprecated/revoked', () => {
    expect(ALLOWED_TRANSITIONS.ephemeral).toEqual(['observed', 'deprecated', 'revoked']);
  });

  it('verified cannot go to lower states (no-downgrade)', () => {
    expect(ALLOWED_TRANSITIONS.verified).not.toContain('reinforced');
    expect(ALLOWED_TRANSITIONS.verified).not.toContain('observed');
    expect(ALLOWED_TRANSITIONS.verified).not.toContain('ephemeral');
  });

  it('active cannot go to lower states (no-downgrade)', () => {
    expect(ALLOWED_TRANSITIONS.active).not.toContain('verified');
    expect(ALLOWED_TRANSITIONS.active).not.toContain('reinforced');
    expect(ALLOWED_TRANSITIONS.active).not.toContain('observed');
    expect(ALLOWED_TRANSITIONS.active).not.toContain('ephemeral');
  });
});

describe('assertAllowedTransition', () => {
  it('accepts valid transitions', () => {
    expect(() => assertAllowedTransition('ephemeral', 'observed')).not.toThrow();
    expect(() => assertAllowedTransition('verified', 'active')).not.toThrow();
    expect(() => assertAllowedTransition('deprecated', 'revoked')).not.toThrow();
  });

  it('rejects invalid transitions', () => {
    expect(() => assertAllowedTransition('ephemeral', 'verified')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('verified', 'reinforced')).toThrow(
      IllegalTransitionError,
    );
    expect(() => assertAllowedTransition('revoked', 'active')).toThrow(IllegalTransitionError);
  });

  it('throws IllegalTransitionError with from/to', () => {
    try {
      assertAllowedTransition('proposed', 'active');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      expect((err as IllegalTransitionError).from).toBe('proposed');
      expect((err as IllegalTransitionError).to).toBe('active');
    }
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test src/control-plane/knowledge-state-machine/__tests__/transitions.spec.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/control-plane/knowledge-state-machine/transitions.ts src/control-plane/knowledge-state-machine/__tests__/transitions.spec.ts
git commit -m "feat(p10a): ALLOWED_TRANSITIONS table + assertion"
```

---

### Task 5: `decideInitialStatus()` + integration with `KnowledgeRiskScorer`

**Files:**
- Create: `src/control-plane/knowledge-state-machine/state-machine.ts` (partial — propose method + helper)
- Create: `src/control-plane/knowledge-state-machine/__tests__/state-machine.spec.ts` (partial)

- [ ] **Step 1: Write helper function**

Add to `state-machine.ts`:

```typescript
// src/control-plane/knowledge-state-machine/state-machine.ts (partial)

import type { KnowledgeKind, KnowledgeLifecycleStatus } from './types.js';

/**
 * Master §2.6 — decide initial state when proposal created.
 * Order of evaluation:
 * 1. kind='rule' → always pending_review
 * 2. risk='high' OR 'critical' → pending_review
 * 3. sensitivity='high' → pending_review
 * 4. risk='medium' → pending_review
 * 5. risk='low' AND confidence >= 0.6 AND kind != 'rule' → ephemeral
 * 6. else (default conservador) → pending_review
 */
export function decideInitialStatus(args: {
  kind: KnowledgeKind;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  sensitivity: 'low' | 'medium' | 'high';
  confidence: number;
}): KnowledgeLifecycleStatus {
  if (args.kind === 'rule') return 'pending_review';
  if (args.risk_level === 'high' || args.risk_level === 'critical') return 'pending_review';
  if (args.sensitivity === 'high') return 'pending_review';
  if (args.risk_level === 'medium') return 'pending_review';
  if (args.risk_level === 'low' && args.confidence >= 0.6) return 'ephemeral';
  return 'pending_review'; // default conservador
}
```

- [ ] **Step 2: Write unit tests for decideInitialStatus**

In `__tests__/state-machine.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { decideInitialStatus } from '../state-machine.js';

describe('decideInitialStatus', () => {
  it('always returns pending_review for kind=rule', () => {
    for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
      for (const conf of [0.1, 0.5, 0.9, 0.99]) {
        expect(
          decideInitialStatus({
            kind: 'rule',
            risk_level: risk,
            sensitivity: 'low',
            confidence: conf,
          }),
        ).toBe('pending_review');
      }
    }
  });

  it('returns pending_review for risk=high/critical', () => {
    for (const kind of ['fact', 'memory', 'behavioral_hint'] as const) {
      for (const risk of ['high', 'critical'] as const) {
        expect(
          decideInitialStatus({
            kind,
            risk_level: risk,
            sensitivity: 'low',
            confidence: 1.0,
          }),
        ).toBe('pending_review');
      }
    }
  });

  it('returns pending_review for sensitivity=high', () => {
    expect(
      decideInitialStatus({
        kind: 'fact',
        risk_level: 'low',
        sensitivity: 'high',
        confidence: 0.9,
      }),
    ).toBe('pending_review');
  });

  it('returns pending_review for risk=medium', () => {
    expect(
      decideInitialStatus({
        kind: 'fact',
        risk_level: 'medium',
        sensitivity: 'low',
        confidence: 0.99,
      }),
    ).toBe('pending_review');
  });

  it('returns ephemeral for risk=low AND confidence>=0.6 AND kind!=rule', () => {
    for (const kind of ['fact', 'memory', 'behavioral_hint'] as const) {
      expect(
        decideInitialStatus({
          kind,
          risk_level: 'low',
          sensitivity: 'low',
          confidence: 0.6,
        }),
      ).toBe('ephemeral');
      expect(
        decideInitialStatus({
          kind,
          risk_level: 'low',
          sensitivity: 'low',
          confidence: 0.99,
        }),
      ).toBe('ephemeral');
    }
  });

  it('returns pending_review for default case (low confidence < 0.6)', () => {
    expect(
      decideInitialStatus({
        kind: 'fact',
        risk_level: 'low',
        sensitivity: 'low',
        confidence: 0.5,
      }),
    ).toBe('pending_review');
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test src/control-plane/knowledge-state-machine/__tests__/state-machine.spec.ts
```

Expected: all decideInitialStatus tests pass.

- [ ] **Step 4: Commit (partial)**

```bash
git add src/control-plane/knowledge-state-machine/state-machine.ts src/control-plane/knowledge-state-machine/__tests__/state-machine.spec.ts
git commit -m "feat(p10a): decideInitialStatus rules + unit tests"
```

---

## Phase 2 — Core KSM class + visibility (Tasks 6-7)

### Task 6: `KnowledgeStateMachine` class — `propose / transition / revoke` methods

**Files:**
- Modify: `src/control-plane/knowledge-state-machine/state-machine.ts` (add full class)
- Modify: `src/control-plane/knowledge-state-machine/__tests__/state-machine.spec.ts` (extend with class tests)
- Create: `src/control-plane/knowledge-state-machine/repos.ts` (repo facade)

- [ ] **Step 1: Write repos.ts facade**

```typescript
// src/control-plane/knowledge-state-machine/repos.ts

import { db } from '@/db/connection.js';
import {
  memory_entry,
  agent_facts,
  learned_rules,
  behavioral_hint,
  and,
  eq,
} from '@/db/schema.js';
import type { KnowledgeKind, KnowledgeRow } from './types.js';

function getTableAndSchema(kind: KnowledgeKind) {
  switch (kind) {
    case 'memory':
      return { table: memory_entry, name: 'memory_entry' };
    case 'fact':
      return { table: agent_facts, name: 'agent_facts' };
    case 'rule':
      return { table: learned_rules, name: 'learned_rules' };
    case 'behavioral_hint':
    case 'procedure_hint':
      return { table: behavioral_hint, name: 'behavioral_hint' };
    default:
      throw new Error(`Unknown knowledge kind: ${kind}`);
  }
}

export const knowledgeRepos = {
  async create(args: {
    tenant_id: string;
    agent_id: string;
    kind: KnowledgeKind;
    key: string;
    scope: string;
    scope_value?: string;
    content: unknown;
    content_text: string;
    confidence: number;
    lifecycle_status: string;
    lifecycle_transitions: unknown[];
    evidence_count: number;
  }): Promise<string> {
    const { table } = getTableAndSchema(args.kind);
    const result = await db
      .insert(table)
      .values({
        tenant_id: args.tenant_id,
        agent_id: args.agent_id,
        key: args.key,
        scope: args.scope,
        scope_value: args.scope_value,
        content: args.content,
        confidence: args.confidence,
        lifecycle_status: args.lifecycle_status,
        lifecycle_transitions: args.lifecycle_transitions,
        evidence_count: args.evidence_count,
      } as any)
      .returning({ id: (table as any).id });
    return result[0]?.id ?? '';
  },

  async findById(kind: KnowledgeKind, id: string): Promise<KnowledgeRow | null> {
    const { table } = getTableAndSchema(kind);
    const result = await db
      .select()
      .from(table)
      .where(eq((table as any).id, id))
      .limit(1);
    return (result[0] as KnowledgeRow) ?? null;
  },

  async update(
    kind: KnowledgeKind,
    id: string,
    updates: {
      lifecycle_status?: string;
      lifecycle_transitions?: unknown[];
      evidence_count?: number;
    },
  ): Promise<void> {
    const { table } = getTableAndSchema(kind);
    await db
      .update(table)
      .set({
        ...(updates.lifecycle_status && { lifecycle_status: updates.lifecycle_status }),
        ...(updates.lifecycle_transitions && { lifecycle_transitions: updates.lifecycle_transitions }),
        ...(updates.evidence_count !== undefined && { evidence_count: updates.evidence_count }),
        updated_at: new Date(),
      } as any)
      .where(eq((table as any).id, id));
  },
};
```

- [ ] **Step 2: Extend state-machine.ts with full KnowledgeStateMachine class**

```typescript
// Add to src/control-plane/knowledge-state-machine/state-machine.ts

import { KnowledgeRiskScorer } from './risk-scorer.js';
import { assertAllowedTransition } from './transitions.js';
import { knowledgeRepos } from './repos.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import { logger } from '@/lib/logger.js';
import type {
  KnowledgeProposalInput,
  KnowledgeProposeResult,
  KnowledgeTransitionInput,
  KnowledgeTransitionResult,
  KnowledgeRevokeInput,
  KnowledgeRevokeResult,
  KnowledgeLifecycleStatus,
} from './types.js';

const VISIBLE_STATES: KnowledgeLifecycleStatus[] = [
  'ephemeral',
  'observed',
  'reinforced',
  'verified',
  'active',
];

export class KnowledgeStateMachine {
  static async propose(input: KnowledgeProposalInput): Promise<KnowledgeProposeResult> {
    return runCognitiveModule({
      module: 'knowledge-state-machine',
      submodule: 'propose',
      trace_id: input.trace_id,
      tenant_id: input.tenant_id,
      agent_id: input.agent_id,
      timeout_ms: 300,
      fallback: {
        initial_status: 'pending_review' as const,
        visible_to_llm: false,
        proposal_id: '',
        reason: 'fallback:scorer_timeout',
      },
      run: async () => {
        const risk = await KnowledgeRiskScorer.score({
          trace_id: input.trace_id,
          tenant_id: input.tenant_id,
          agent_id: input.agent_id,
          kind: input.kind,
          scope: input.scope,
          content_text: input.content_text,
          confidence: input.confidence,
          origin: input.origin,
          proposer_sensitivity_hint: input.sensitivity_hint,
        });

        const initial_status = decideInitialStatus({
          kind: input.kind,
          risk_level: risk.level,
          sensitivity: risk.sensitivity ?? 'low',
          confidence: input.confidence,
        });

        const proposal_id = await knowledgeRepos.create({
          tenant_id: input.tenant_id,
          agent_id: input.agent_id,
          kind: input.kind,
          key: input.key,
          scope: input.scope,
          scope_value: input.scope_value,
          content: input.content,
          content_text: input.content_text,
          confidence: input.confidence,
          lifecycle_status: initial_status,
          lifecycle_transitions: [
            {
              from: 'proposed',
              to: initial_status,
              at: new Date().toISOString(),
              reason: `risk=${risk.level};kind=${input.kind};confidence=${input.confidence}`,
              decided_by: 'state_machine_propose',
              risk_score: {
                level: risk.level,
                sensitivity: risk.sensitivity,
                reasons: risk.reasons,
                source: risk.source,
              },
            },
          ],
          evidence_count:
            input.origin === 'user_explicit' || input.origin === 'human_approved' ? 1 : 0,
        });

        return {
          proposal_id,
          initial_status,
          visible_to_llm: VISIBLE_STATES.includes(initial_status),
          reason: `risk=${risk.level} | kind=${input.kind} | conf=${input.confidence}`,
        };
      },
    });
  }

  static async transition(input: KnowledgeTransitionInput): Promise<KnowledgeTransitionResult> {
    const { kind, proposal_id, to, reason, decided_by } = input;
    const current = await knowledgeRepos.findById(kind, proposal_id);
    if (!current) throw new Error(`knowledge_not_found:${kind}:${proposal_id}`);

    assertAllowedTransition(current.lifecycle_status, to);

    const at = new Date().toISOString();
    const transition = {
      from: current.lifecycle_status,
      to,
      at,
      reason,
      decided_by,
      evidence_id: input.evidence_id,
    };

    await knowledgeRepos.update(kind, proposal_id, {
      lifecycle_status: to,
      lifecycle_transitions: [...current.lifecycle_transitions, transition],
    });

    logger.info(
      { proposal_id, kind, from: current.lifecycle_status, to, reason },
      'knowledge_state_machine.transition',
    );

    return transition;
  }

  static async revoke(input: KnowledgeRevokeInput): Promise<KnowledgeRevokeResult> {
    const { kind, proposal_id, reason, decided_by } = input;
    const current = await knowledgeRepos.findById(kind, proposal_id);
    if (!current) throw new Error(`knowledge_not_found:${kind}:${proposal_id}`);
    if (current.lifecycle_status === 'revoked') {
      return {
        from: 'revoked',
        to: 'revoked',
        at: current.updated_at.toISOString(),
        reason: 'already_revoked',
        decided_by: 'idempotent',
      };
    }

    const at = new Date().toISOString();
    const transition = {
      from: current.lifecycle_status,
      to: 'revoked' as const,
      at,
      reason,
      decided_by,
    };

    await knowledgeRepos.update(kind, proposal_id, {
      lifecycle_status: 'revoked',
      lifecycle_transitions: [...current.lifecycle_transitions, transition],
    });

    logger.warn(
      { proposal_id, kind, from: current.lifecycle_status, reason },
      'knowledge_state_machine.revoked',
    );

    return transition;
  }
}
```

- [ ] **Step 3: Extend state-machine.spec.ts with class tests**

```typescript
// Add to __tests__/state-machine.spec.ts

describe('KnowledgeStateMachine.propose', () => {
  it('returns pending_review for rule regardless of risk/conf', async () => {
    // Mock KnowledgeRiskScorer.score to return low risk
    const result = await KnowledgeStateMachine.propose({
      trace_id: 'test-1',
      tenant_id: 'test-tenant',
      agent_id: 'test-agent',
      kind: 'rule',
      scope: 'agent',
      key: 'test_rule',
      content: { some: 'content' },
      content_text: 'test rule',
      confidence: 0.99,
      origin: 'llm_inference',
      source: 'test',
    });
    expect(result.initial_status).toBe('pending_review');
    expect(result.visible_to_llm).toBe(false);
  });

  // Additional tests for propose method...
});

describe('KnowledgeStateMachine.transition', () => {
  it('valid transition succeeds', async () => {
    // Setup: create proposal in ephemeral
    // Transition: ephemeral → observed
    // Assert: succeeds, appends transition record
  });

  it('invalid transition throws IllegalTransitionError', async () => {
    // Setup: create proposal in ephemeral
    // Attempt: ephemeral → verified (invalid)
    // Assert: throws IllegalTransitionError
  });

  it('no-downgrade enforced', async () => {
    // Setup: create proposal in verified
    // Attempt: verified → reinforced
    // Assert: throws IllegalTransitionError
  });
});

describe('KnowledgeStateMachine.revoke', () => {
  it('revokes from any state', async () => {
    // Setup: proposal in ephemeral
    // Revoke: → revoked
    // Assert: succeeds, terminal
  });

  it('revoking already-revoked is idempotent', async () => {
    // Setup: proposal in revoked
    // Revoke again
    // Assert: returns { from: 'revoked', to: 'revoked', reason: 'already_revoked' }
  });
});
```

- [ ] **Step 4: Run all tests**

```bash
npm test src/control-plane/knowledge-state-machine/__tests__/state-machine.spec.ts
```

Expected: all pass (may need mock setup for KnowledgeRiskScorer).

- [ ] **Step 5: Commit**

```bash
git add src/control-plane/knowledge-state-machine/{repos.ts,state-machine.ts} src/control-plane/knowledge-state-machine/__tests__/state-machine.spec.ts
git commit -m "feat(p10a): KnowledgeStateMachine class (propose/transition/revoke) + repos facade"
```

---

### Task 7: Visibility predicate `knowledgeIsVisible()`

**Files:**
- Create: `src/control-plane/knowledge-state-machine/visibility.ts`
- Create: `src/control-plane/knowledge-state-machine/__tests__/visibility.spec.ts`

- [ ] **Step 1: Write visibility.ts**

```typescript
// src/control-plane/knowledge-state-machine/visibility.ts

import type {
  KnowledgeLifecycleStatus,
  KnowledgeVisibilityContext,
  KnowledgeVisibilityResult,
} from './types.js';

const VISIBILITY_TABLE: Record<KnowledgeLifecycleStatus, KnowledgeVisibilityResult> = {
  proposed: { visible: false, weight: 0.0, label: null },
  pending_review: { visible: false, weight: 0.0, label: null },
  ephemeral: { visible: true, weight: 0.3, label: '[novo, baixa confiança]' },
  observed: { visible: true, weight: 0.5, label: '[observado]' },
  reinforced: { visible: true, weight: 0.7, label: '[reforçado]' },
  verified: { visible: true, weight: 0.9, label: '[verificado]' },
  active: { visible: true, weight: 1.0, label: '[ativo]' },
  deprecated: { visible: false, weight: 0.0, label: null },
  revoked: { visible: false, weight: 0.0, label: null },
};

export function knowledgeIsVisible(
  k: { lifecycle_status: KnowledgeLifecycleStatus },
  ctx?: KnowledgeVisibilityContext,
): KnowledgeVisibilityResult {
  const result = VISIBILITY_TABLE[k.lifecycle_status];
  // In strict mode, ephemeral also becomes invisible
  if (ctx?.context_mode === 'strict' && k.lifecycle_status === 'ephemeral') {
    return { visible: false, weight: 0.0, label: null };
  }
  return result;
}

export function getVisibilityTable(): typeof VISIBILITY_TABLE {
  return VISIBILITY_TABLE;
}
```

- [ ] **Step 2: Write visibility.spec.ts**

```typescript
// src/control-plane/knowledge-state-machine/__tests__/visibility.spec.ts

import { describe, it, expect } from 'vitest';
import { knowledgeIsVisible } from '../visibility.js';
import type { KnowledgeLifecycleStatus } from '../types.js';

describe('knowledgeIsVisible', () => {
  const visibleStates: KnowledgeLifecycleStatus[] = [
    'ephemeral',
    'observed',
    'reinforced',
    'verified',
    'active',
  ];
  const invisibleStates: KnowledgeLifecycleStatus[] = [
    'proposed',
    'pending_review',
    'deprecated',
    'revoked',
  ];

  it('returns correct visibility for all states in normal mode', () => {
    for (const state of visibleStates) {
      const result = knowledgeIsVisible({ lifecycle_status: state });
      expect(result.visible).toBe(true, `${state} should be visible`);
      expect(result.weight).toBeGreaterThan(0);
      expect(result.label).not.toBeNull();
    }

    for (const state of invisibleStates) {
      const result = knowledgeIsVisible({ lifecycle_status: state });
      expect(result.visible).toBe(false, `${state} should not be visible`);
      expect(result.weight).toBe(0.0);
      expect(result.label).toBeNull();
    }
  });

  it('returns weights in ascending order: ephemeral < observed < reinforced < verified < active', () => {
    const ephemeral = knowledgeIsVisible({ lifecycle_status: 'ephemeral' });
    const observed = knowledgeIsVisible({ lifecycle_status: 'observed' });
    const reinforced = knowledgeIsVisible({ lifecycle_status: 'reinforced' });
    const verified = knowledgeIsVisible({ lifecycle_status: 'verified' });
    const active = knowledgeIsVisible({ lifecycle_status: 'active' });

    expect(ephemeral.weight).toBeLessThan(observed.weight);
    expect(observed.weight).toBeLessThan(reinforced.weight);
    expect(reinforced.weight).toBeLessThan(verified.weight);
    expect(verified.weight).toBeLessThan(active.weight);
  });

  it('in strict mode, ephemeral becomes invisible', () => {
    const result = knowledgeIsVisible({ lifecycle_status: 'ephemeral' }, { context_mode: 'strict' });
    expect(result.visible).toBe(false);
    expect(result.weight).toBe(0.0);
    expect(result.label).toBeNull();
  });

  it('in strict mode, other visible states remain visible', () => {
    for (const state of ['observed', 'reinforced', 'verified', 'active'] as const) {
      const result = knowledgeIsVisible({ lifecycle_status: state }, { context_mode: 'strict' });
      expect(result.visible).toBe(true, `${state} should remain visible in strict mode`);
    }
  });

  it('pending_review is never visible regardless of context', () => {
    for (const mode of ['normal', 'strict', 'debug', undefined] as const) {
      const result = knowledgeIsVisible(
        { lifecycle_status: 'pending_review' },
        mode ? { context_mode: mode } : undefined,
      );
      expect(result.visible).toBe(false);
    }
  });

  it('proposed is never visible (transit state)', () => {
    expect(knowledgeIsVisible({ lifecycle_status: 'proposed' }).visible).toBe(false);
  });

  it('revoked is never visible', () => {
    expect(knowledgeIsVisible({ lifecycle_status: 'revoked' }).visible).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test src/control-plane/knowledge-state-machine/__tests__/visibility.spec.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/control-plane/knowledge-state-machine/visibility.ts src/control-plane/knowledge-state-machine/__tests__/visibility.spec.ts
git commit -m "feat(p10a): knowledgeIsVisible() predicate + tests"
```

---

## Phase 3 — Auto-promoter + tools (Tasks 8-10)

### Task 8: Auto-promoter worker `knowledge-state-promoter.ts`

**Files:**
- Create: `src/workers/knowledge-state-promoter.ts`
- Modify: `src/workers/index.ts`

- [ ] **Step 1: Write worker file**

Create `src/workers/knowledge-state-promoter.ts` per spec §5 (auto-promoter logic).

- [ ] **Step 2: Register in workers/index.ts**

Add to `JOBS[]`:

```typescript
{ name: 'knowledge_state_promoter', cron: '0 * * * *', fn: runKnowledgeStatePromoter, phase: 2 },
```

- [ ] **Step 3: Write test for worker idempotency**

```typescript
// tests/integration/p10a-knowledge-lifecycle.spec.ts (first test)
it('auto-promoter is idempotent', async () => {
  // Setup: insert rows in ephemeral
  // Tick 1
  await runKnowledgeStatePromoter();
  const after1 = await fetchAllStatuses();
  // Tick 2
  await runKnowledgeStatePromoter();
  const after2 = await fetchAllStatuses();
  // Assert: same
  expect(after1).toEqual(after2);
});
```

- [ ] **Step 4: Commit**

```bash
git add src/workers/knowledge-state-promoter.ts src/workers/index.ts tests/integration/p10a-knowledge-lifecycle.spec.ts
git commit -m "feat(p10a): knowledge-state-promoter worker (every 1h)"
```

---

### Task 9: Four `propose_*` tools + deprecation aliases

**Files:**
- Create: `src/tools/propose-fact.ts`, `propose-rule.ts`, `propose-memory.ts`, `propose-hint.ts`
- Modify: `src/tools/save-fact.ts`, `save-rule.ts` (add deprecation wrapper)
- Modify: `src/tools/_registry.ts`

- [ ] **Step 1: Write propose-fact.ts** (template per spec §6.2)

- [ ] **Step 2: Write propose-rule.ts** (similar, but kind='rule' always pending_review)

- [ ] **Step 3: Write propose-memory.ts** and **propose-hint.ts**

- [ ] **Step 4: Modify save-fact.ts and save-rule.ts to wrap propose_* with deprecation log**

- [ ] **Step 5: Register all 4 tools + modified 2 in _registry.ts**

- [ ] **Step 6: Run typecheck**

```bash
npm run typecheck
```

- [ ] **Step 7: Write smoke test for tools**

```typescript
it('propose_fact can be invoked via agent context', async () => {
  const result = await proposeFactTool.handler(
    {
      escopo: 'global',
      chave: 'test_fact',
      valor: { test: true },
      texto: 'test fact',
      confianca: 0.7,
    },
    mockCtx,
  );
  expect(result.proposal_id).toBeTruthy();
  expect(result.initial_status).toMatch(/ephemeral|pending_review/);
});

it('save_fact (deprecated) logs warning but works', async () => {
  const warnSpy = vi.spyOn(logger, 'warn');
  const result = await saveFactTool.handler(
    {
      escopo: 'global',
      chave: 'legacy_fact',
      valor: { test: true },
      texto: 'legacy fact',
      confianca: 0.7,
    },
    mockCtx,
  );
  expect(warnSpy).toHaveBeenCalledWith(
    expect.objectContaining({ tool: 'save_fact' }),
    expect.stringMatching('deprecation'),
  );
  expect(result.proposal_id).toBeTruthy();
});
```

- [ ] **Step 8: Commit**

```bash
git add src/tools/propose-*.ts src/tools/save-{fact,rule}.ts src/tools/_registry.ts tests/unit/tools-propose.spec.ts
git commit -m "feat(p10a): add propose_* tools + deprecate save_* aliases"
```

---

### Task 10: Property tests — no-downgrade + visibility guarantees

**Files:**
- Create: `src/control-plane/knowledge-state-machine/__tests__/no-path-revoked-to-active.property.spec.ts`
- Modify: `src/control-plane/knowledge-state-machine/__tests__/visibility.spec.ts` (add property tests)

- [ ] **Step 1: Write property test for revoked terminal**

```typescript
// src/control-plane/knowledge-state-machine/__tests__/no-path-revoked-to-active.property.spec.ts

import { describe, it, expect } from 'vitest';
import { ALLOWED_TRANSITIONS } from '../transitions.js';
import type { KnowledgeLifecycleStatus } from '../types.js';

function bfsReachable(start: KnowledgeLifecycleStatus): Set<KnowledgeLifecycleStatus> {
  const reached = new Set<KnowledgeLifecycleStatus>([start]);
  const queue: KnowledgeLifecycleStatus[] = [start];
  while (queue.length) {
    const node = queue.shift()!;
    for (const next of ALLOWED_TRANSITIONS[node]) {
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  return reached;
}

describe('property: graph invariants', () => {
  it('revoked is terminal (BFS from revoked reaches only revoked)', () => {
    const reachable = bfsReachable('revoked');
    expect(reachable).toEqual(new Set(['revoked']));
  });

  it('verified never downgrades to reinforced/observed/ephemeral', () => {
    const reachable = bfsReachable('verified');
    expect(reachable.has('reinforced')).toBe(false);
    expect(reachable.has('observed')).toBe(false);
    expect(reachable.has('ephemeral')).toBe(false);
    // verified can reach active, deprecated, revoked
    expect(reachable.has('active')).toBe(true);
    expect(reachable.has('deprecated')).toBe(true);
    expect(reachable.has('revoked')).toBe(true);
  });

  it('active never downgrades to reinforced/observed/ephemeral', () => {
    const reachable = bfsReachable('active');
    expect(reachable.has('reinforced')).toBe(false);
    expect(reachable.has('observed')).toBe(false);
    expect(reachable.has('ephemeral')).toBe(false);
    // active can reach deprecated, revoked
    expect(reachable.has('deprecated')).toBe(true);
    expect(reachable.has('revoked')).toBe(true);
  });

  it('no state can escape to visible state from revoked', () => {
    const visibleStates: KnowledgeLifecycleStatus[] = [
      'ephemeral',
      'observed',
      'reinforced',
      'verified',
      'active',
    ];
    const revokedReachable = bfsReachable('revoked');
    for (const visible of visibleStates) {
      expect(revokedReachable.has(visible)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Add visibility property tests to visibility.spec.ts**

```typescript
describe('property: pending_review never visible', () => {
  it('pending_review is never visible in any context mode', () => {
    for (const mode of ['normal', 'strict', 'debug', undefined] as const) {
      const result = knowledgeIsVisible(
        { lifecycle_status: 'pending_review' },
        mode ? { context_mode: mode } : undefined,
      );
      expect(result.visible).toBe(false);
      expect(result.label).toBeNull();
    }
  });

  it('proposed never visible (transit state)', () => {
    expect(knowledgeIsVisible({ lifecycle_status: 'proposed' }).visible).toBe(false);
  });

  it('deprecated never visible', () => {
    expect(knowledgeIsVisible({ lifecycle_status: 'deprecated' }).visible).toBe(false);
  });

  it('revoked never visible (anti-memory)', () => {
    expect(knowledgeIsVisible({ lifecycle_status: 'revoked' }).visible).toBe(false);
  });
});
```

- [ ] **Step 3: Run property tests**

```bash
npm test src/control-plane/knowledge-state-machine/__tests__/
```

Expected: all property tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/control-plane/knowledge-state-machine/__tests__/no-path-revoked-to-active.property.spec.ts
git commit -m "feat(p10a): property tests (revoked terminal, no-downgrade, visibility invariants)"
```

---

## Phase 4 — Integration + barrel export + acceptance gates (Tasks 11-12)

### Task 11: Barrel export + CODEOWNERS architecture lock

**Files:**
- Create: `src/control-plane/knowledge-state-machine/index.ts`
- Modify: `.github/CODEOWNERS`

- [ ] **Step 1: Write barrel export**

```typescript
// src/control-plane/knowledge-state-machine/index.ts

export { KnowledgeStateMachine } from './state-machine.js';
export { ALLOWED_TRANSITIONS, assertAllowedTransition, IllegalTransitionError } from './transitions.js';
export { knowledgeIsVisible, getVisibilityTable } from './visibility.js';
export { knowledgeRepos } from './repos.js';
export type {
  KnowledgeKind,
  KnowledgeScope,
  KnowledgeLifecycleStatus,
  KnowledgeProposalInput,
  KnowledgeProposeResult,
  KnowledgeTransitionInput,
  KnowledgeTransitionResult,
  KnowledgeRevokeInput,
  KnowledgeRevokeResult,
  KnowledgeVisibilityContext,
  KnowledgeVisibilityResult,
} from './types.js';
```

- [ ] **Step 2: Add CODEOWNERS entries**

In `.github/CODEOWNERS`, add:

```
src/control-plane/knowledge-state-machine/transitions.ts @founder
src/control-plane/knowledge-state-machine/visibility.ts @founder
src/control-plane/knowledge-state-machine/state-machine.ts @founder
```

(Adjust `@founder` to actual GitHub handle if different.)

- [ ] **Step 3: Commit**

```bash
git add src/control-plane/knowledge-state-machine/index.ts .github/CODEOWNERS
git commit -m "feat(p10a): barrel export + architecture lock CODEOWNERS"
```

---

### Task 12: Integration tests + acceptance gates + final validation

**Files:**
- Create: `tests/integration/p10a-knowledge-lifecycle.spec.ts` (full 7 cenários)
- Create: `scripts/acceptance/p10a-knowledge-state-machine.sh`
- Create: `docs/superpowers/runbooks/p10a-knowledge-state-machine.md`

- [ ] **Step 1: Write integration tests** (7 cenários per spec §11.2)

```typescript
// tests/integration/p10a-knowledge-lifecycle.spec.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeStateMachine } from '@/control-plane/knowledge-state-machine/index.js';
import { knowledgeRepos } from '@/control-plane/knowledge-state-machine/repos.js';
import { db } from '@/db/connection.js';

describe('P10a Knowledge Lifecycle — integration', () => {
  const testContext = {
    trace_id: 'int-test',
    tenant_id: 'test-tenant',
    agent_id: 'test-agent',
  };

  beforeEach(async () => {
    // Cleanup before each test
  });

  afterEach(async () => {
    // Cleanup after each test
  });

  it('cenário 1: full happy path — ephemeral → observed → reinforced → verified', async () => {
    // Propose fact with risk=low, conf=0.7
    const proposal = await KnowledgeStateMachine.propose({
      ...testContext,
      kind: 'fact',
      scope: 'agent',
      key: 'test_fact_1',
      content: { value: 'test' },
      content_text: 'test fact',
      confidence: 0.7,
      origin: 'llm_inference',
      source: 'reflection_batch',
    });
    expect(proposal.initial_status).toBe('ephemeral');
    expect(proposal.visible_to_llm).toBe(true);

    // Simulate evidence, promote to observed
    const row1 = await knowledgeRepos.findById('fact', proposal.proposal_id);
    expect(row1?.lifecycle_status).toBe('ephemeral');

    // Transition: ephemeral → observed
    await KnowledgeStateMachine.transition({
      kind: 'fact',
      proposal_id: proposal.proposal_id,
      to: 'observed',
      reason: 'evidence_count_1',
      decided_by: 'auto_promoter:evidence_threshold',
    });

    const row2 = await knowledgeRepos.findById('fact', proposal.proposal_id);
    expect(row2?.lifecycle_status).toBe('observed');

    // Continue transitions...
    // (abbreviated for space; full version has all transitions)
  });

  it('cenário 2: rule always pending_review', async () => {
    const proposal = await KnowledgeStateMachine.propose({
      ...testContext,
      kind: 'rule',
      scope: 'agent',
      key: 'test_rule_1',
      content: { if: 'condition', then: 'action' },
      content_text: 'test rule',
      confidence: 0.99,
      origin: 'llm_inference',
      source: 'reflection_batch',
    });
    expect(proposal.initial_status).toBe('pending_review');
    expect(proposal.visible_to_llm).toBe(false);
  });

  it('cenário 3: revocation is terminal', async () => {
    const proposal = await KnowledgeStateMachine.propose({
      ...testContext,
      kind: 'fact',
      scope: 'agent',
      key: 'test_fact_revoke',
      content: { value: 'will_revoke' },
      content_text: 'test',
      confidence: 0.7,
      origin: 'llm_inference',
      source: 'test',
    });

    await KnowledgeStateMachine.revoke({
      kind: 'fact',
      proposal_id: proposal.proposal_id,
      reason: 'test_revoke',
      decided_by: 'incident_response',
    });

    const revoked = await knowledgeRepos.findById('fact', proposal.proposal_id);
    expect(revoked?.lifecycle_status).toBe('revoked');

    // Try to transition out of revoked (should fail)
    expect(async () => {
      await KnowledgeStateMachine.transition({
        kind: 'fact',
        proposal_id: proposal.proposal_id,
        to: 'active',
        reason: 'should_fail',
        decided_by: 'human_approval',
      });
    }).rejects.toThrow('Illegal knowledge lifecycle transition');
  });

  it('cenário 4: auto-promoter idempotent', async () => {
    // (abbreviated; full version seeds rows and runs promoter twice)
  });

  it('cenário 5: TTL expiration → deprecated', async () => {
    // (abbreviated)
  });

  it('cenário 6: no-downgrade enforced', async () => {
    // (abbreviated)
  });

  it('cenário 7: save_fact deprecated but functional', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    // Call deprecated save_fact
    // Assert: log warns, but result is same as propose_fact
  });
});
```

- [ ] **Step 2: Write acceptance gates script**

Create `scripts/acceptance/p10a-knowledge-state-machine.sh` per spec §12.

- [ ] **Step 3: Write runbook**

Create `docs/superpowers/runbooks/p10a-knowledge-state-machine.md` documenting:
- 9 states + transitions
- Auto-promoter thresholds (1 in 24h, 3 in 30d, 7 in 90d)
- TTL defaults (30d ephemeral, 90d others)
- Admin UI Proposal Inbox workflow
- Visibility weights + ranking
- Architecture Lock + CODEOWNERS

- [ ] **Step 4: Run all tests**

```bash
npm test src/control-plane/knowledge-state-machine/
npm test tests/integration/p10a-knowledge-lifecycle.spec.ts
```

Expected: 100% pass.

- [ ] **Step 5: Run typecheck**

```bash
npm run typecheck
```

Expected: zero errors.

- [ ] **Step 6: Run lint**

```bash
npm run lint
```

Expected: zero warnings.

- [ ] **Step 7: Run acceptance gates**

```bash
bash scripts/acceptance/p10a-knowledge-state-machine.sh
```

Expected: all 12 gates pass.

- [ ] **Step 8: Commit**

```bash
git add tests/integration/p10a-knowledge-lifecycle.spec.ts scripts/acceptance/p10a-knowledge-state-machine.sh docs/superpowers/runbooks/p10a-knowledge-state-machine.md
git commit -m "feat(p10a): integration tests + acceptance gates + runbook"
```

---

## Done Criteria

When all 12 tasks + sub-steps completed:

- [ ] `src/control-plane/knowledge-state-machine/` namespace complete (state-machine.ts, transitions.ts, visibility.ts, repos.ts, types.ts, index.ts).
- [ ] `KnowledgeStateMachine.propose / transition / revoke` operationalize, wrapped in `runCognitiveModule`.
- [ ] `knowledge-state-promoter` worker registered, cron every 1h (phase 2).
- [ ] 4 tools `propose_fact` / `propose_rule` / `propose_memory` / `propose_hint` registered and functional.
- [ ] 2 tools `save_fact` / `save_rule` redirect to `propose_*` with deprecation log (TTL: until P11).
- [ ] Migration 031 (indexes + CHECK constraints) applied in staging + canary + 100% prod.
- [ ] All property tests pass (§11.3: revoked terminal, no-downgrade, visibility invariants).
- [ ] All 7 integration test cenários pass (§11.2).
- [ ] All 12 acceptance gates pass (§12).
- [ ] CODEOWNERS configured: founder approval for transitions.ts / visibility.ts / decideInitialStatus.
- [ ] Runbook published at `docs/superpowers/runbooks/p10a-knowledge-state-machine.md`.
- [ ] Feature flag `FEATURE_KNOWLEDGE_STATE_MACHINE_V1=true` ready for canary rollout.
- [ ] Cognitive module log emits rows with module='knowledge-state-machine' + p95 latency <300ms propose, <60s auto-promoter.
- [ ] `npm run lint` / `npm run typecheck` / `npm test` all zero errors/warnings.

---

## Risks + Mitigations

| Risk | Mitigation |
|---|---|
| Legacy tenants "lose visibility" while canary | P8c DEFAULT 'active' keeps legacy visible. Canary owner approves new proposals via Admin UI. Document 1st week babysitting. |
| Admin UI Inbox grows (proposals accumulate) | Bulk reject for low-risk proposals. Auto-promoter TTL expires ephemeral after 30d. Alerte >500 pending. |
| KnowledgeRiskScorer timeout in propose hot path | runCognitiveModule.fallback → 'pending_review' (fail-safe). P9c cache reduces repeats. |
| Auto-promoter lock contention with reflection_batch | Worker LIMIT 100/table/tick. Cron 1h apart. Single-row UPDATEs. |
| Property test coverage gap | BFS exhaustive on ALLOWED_TRANSITIONS — any new edge is tested. |
| Founder approval gate friction | CODEOWNERS applies only to decision files (transitions.ts/visibility.ts), not refactoring. |
| `revoked` antimemória grows unbounded | Terminal absolute (auto-promoter does NOT expire). Future: founder-only "unrevoke" via Architecture Lock change. |
| Migration adds index on large tables | Use CONCURRENTLY if >1M rows. Run off-peak. Canary includes EXPLAIN ANALYZE before/after. |

---

## Dependencies

- **P1** — `runCognitiveModule` wrapper (all proposes/promoter wrapped).
- **P4** — Drift detectors alert on `papel_drift`/`procedure_drift` during canary.
- **P8c** — Lifecycle columns, `isVisibleLifecycle` predicate, `last_recall_at` maintained.
- **P8.5** — Admin UI Proposal Inbox + approval/rejection flow.
- **P9c** — `KnowledgeRiskScorer.score()` with no-downgrade rule.

---

**End of plan.**
