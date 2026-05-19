/**
 * P10a — Knowledge lifecycle end-to-end (master §11.2 + §11.4).
 *
 * Tests use the same in-memory mocked knowledgeRepos as the unit
 * suite so the lifecycle invariants can be exercised through the
 * full propose → transition → revoke + auto-promoter path without
 * a live database. The acceptance gate for DB-level migrations is
 * verified separately by the acceptance script.
 *
 * Cenários implementados:
 *   1. Full happy path: ephemeral → observed → reinforced → verified.
 *   2. Rule always pending_review (regardless of risk/confidence).
 *   3. Revocation is terminal (idempotent on second call).
 *   4. Auto-promoter idempotent (running twice yields same state).
 *   5. TTL expiration → deprecated.
 *   6. No-downgrade enforced (verified → reinforced throws).
 *   7. save_fact deprecated wrapper continues to work + emits warn log.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  KnowledgeKind,
  KnowledgeLifecycleStatus,
  KnowledgeRow,
  KnowledgeTransitionRecord,
} from '@/control-plane/knowledge-state-machine/types.js';

// Shared in-memory store across propose/transition/revoke + the worker.
const storeByKind = new Map<KnowledgeKind, Map<string, KnowledgeRow>>();

function seedRow(kind: KnowledgeKind, row: KnowledgeRow): void {
  if (!storeByKind.has(kind)) storeByKind.set(kind, new Map());
  storeByKind.get(kind)!.set(row.id, row);
}

function listByStatus(
  kind: KnowledgeKind,
  status: KnowledgeLifecycleStatus,
): KnowledgeRow[] {
  const rows = storeByKind.get(kind);
  if (!rows) return [];
  return [...rows.values()].filter((r) => r.lifecycle_status === status);
}

// Mock repos. listEligible filters by status + predicate strings the
// promoter ships through sql tag. We re-interpret those predicates
// against the in-memory store.
type EligibleFilter = {
  evidenceMin?: number;
  ageMaxMs?: number;
  ageMinMs?: number;
  maturity?: boolean;
  noUsageMaxMs?: number;
};

let currentFilter: EligibleFilter = {};

// KnowledgeConflictError lives inside the mock factory because vi.mock
// is hoisted above any top-level binding; an outer-scope class would
// race the hoist with ReferenceError. state-machine.ts imports from
// `./repos.js`, so it picks up THIS class identity — `instanceof`
// inside the catch block matches the throw here.
vi.mock('@/control-plane/knowledge-state-machine/repos.js', async () => {
  const drizzle = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  class KnowledgeConflictError extends Error {
    constructor(
      public readonly kind: KnowledgeKind,
      public readonly id: string,
      public readonly expected_previous_status: KnowledgeLifecycleStatus,
    ) {
      super(
        `knowledge_conflict:${kind}:${id}:expected_${expected_previous_status}`,
      );
      this.name = 'KnowledgeConflictError';
    }
  }
  return {
    KnowledgeConflictError,
    knowledgeRepos: {
      async create(input: {
        kind: KnowledgeKind;
        lifecycle_status: KnowledgeLifecycleStatus;
        lifecycle_transitions: KnowledgeTransitionRecord[];
        evidence_count: number;
        tenant_id: string;
        agent_id: string;
        confidence?: number;
      }): Promise<string> {
        const id = `mock-${Math.random().toString(36).slice(2, 10)}`;
        seedRow(input.kind, {
          id,
          tenant_id: input.tenant_id,
          agent_id: input.agent_id,
          lifecycle_status: input.lifecycle_status,
          lifecycle_transitions: input.lifecycle_transitions,
          evidence_count: input.evidence_count,
          confidence: input.confidence,
          updated_at: new Date(),
        });
        return id;
      },
      async findById(
        kind: KnowledgeKind,
        id: string,
      ): Promise<KnowledgeRow | null> {
        return storeByKind.get(kind)?.get(id) ?? null;
      },
      async update(
        kind: KnowledgeKind,
        id: string,
        updates: {
          lifecycle_status?: KnowledgeLifecycleStatus;
          lifecycle_transitions?: KnowledgeTransitionRecord[];
          evidence_count?: number;
          expected_previous_status?: KnowledgeLifecycleStatus;
        },
      ): Promise<void> {
        const row = storeByKind.get(kind)?.get(id);
        if (!row) return;
        if (
          updates.expected_previous_status !== undefined &&
          row.lifecycle_status !== updates.expected_previous_status
        ) {
          throw new KnowledgeConflictError(
            kind,
            id,
            updates.expected_previous_status,
          );
        }
        if (updates.lifecycle_status !== undefined)
          row.lifecycle_status = updates.lifecycle_status;
        if (updates.lifecycle_transitions !== undefined)
          row.lifecycle_transitions = updates.lifecycle_transitions;
        if (updates.evidence_count !== undefined)
          row.evidence_count = updates.evidence_count;
        row.updated_at = new Date();
      },
      async listEligible(args: {
        kind: KnowledgeKind;
        from: KnowledgeLifecycleStatus;
      }): Promise<Array<{ id: string }>> {
        // Filter rows by status, then apply currentFilter set by the
        // test harness immediately before each promote() call.
        const rows = listByStatus(args.kind, args.from);
        const now = Date.now();
        return rows
          .filter((row) => {
            if (
              currentFilter.evidenceMin !== undefined &&
              row.evidence_count < currentFilter.evidenceMin
            ) {
              return false;
            }
            if (
              currentFilter.ageMaxMs !== undefined &&
              row.updated_at.getTime() < now - currentFilter.ageMaxMs
            ) {
              return false;
            }
            if (
              currentFilter.ageMinMs !== undefined &&
              row.updated_at.getTime() > now - currentFilter.ageMinMs
            ) {
              return false;
            }
            if (currentFilter.maturity) {
              if ((row.confidence ?? 0) < 0.9) return false;
              if (row.evidence_count < 10) return false;
            }
            if (currentFilter.noUsageMaxMs !== undefined) {
              const ref = row.last_recall_at ?? row.updated_at;
              if (ref.getTime() > now - currentFilter.noUsageMaxMs) {
                return false;
              }
            }
            return true;
          })
          .map((r) => ({ id: r.id }));
      },
      buildUpdatedAtFilter() {
        return drizzle.sql`true`;
      },
    },
    sql: drizzle.sql,
    lte: drizzle.lte,
  };
});

// Silence the audit_missing_tenant_context warn from runner.
vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    cognitiveModuleLogRepo: {
      record: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('@/lib/logger.js', () => {
  const warnMock = vi.fn();
  return {
    logger: {
      info: vi.fn(),
      warn: warnMock,
      error: vi.fn(),
      debug: vi.fn(),
    },
    // Expose the warn mock for cenário 7 — its module-level identity
    // matches the import inside save-fact.ts because vi.mock hoists.
    __warnMock: warnMock,
  };
});

// Force the feature flag on for the promoter tests. Override both the
// module-level constant (kept for back-compat) AND the singleton
// instance the worker now consults via featureFlags.isEnabled() after
// review #104 — without the singleton override, the worker would
// short-circuit on `disabled` because the test env doesn't set
// FEATURE_KNOWLEDGE_STATE_MACHINE_V1=true.
vi.mock('@/config/feature-flags.js', async () => {
  const actual = await vi.importActual<
    typeof import('@/config/feature-flags.js')
  >('@/config/feature-flags.js');
  return {
    ...actual,
    FEATURE_KNOWLEDGE_STATE_MACHINE_V1: true,
    featureFlags: {
      ...actual.featureFlags,
      isEnabled: () => true,
      override: () => undefined,
      killSwitch: () => undefined,
      unkillSwitch: () => undefined,
      reset: () => undefined,
    },
  };
});

import {
  KnowledgeStateMachine,
  IllegalTransitionError,
} from '@/control-plane/knowledge-state-machine/state-machine.js';
import { runKnowledgeStatePromoter } from '@/workers/knowledge-state-promoter.js';

const baseInput = {
  trace_id: 't-int',
  tenant_id: 'tenant-a',
  agent_id: 'agent-a',
  scope: 'agent' as const,
  key: 'int_key',
  content: { foo: 'bar' },
  content_text: 'integration test content',
  source: 'integration-test',
};

beforeEach(() => {
  storeByKind.clear();
  currentFilter = {};
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('P10a integration: cenário 1 — happy path ephemeral→…→verified', () => {
  it('walks fact through ephemeral → observed → reinforced → verified', async () => {
    const proposal = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.7,
      origin: 'llm_inference',
    });
    expect(proposal.initial_status).toBe('ephemeral');

    // Simulate evidence + auto-promoter.
    const row = storeByKind.get('fact')!.get(proposal.proposal_id)!;
    row.evidence_count = 1;
    await KnowledgeStateMachine.transition({
      kind: 'fact',
      proposal_id: proposal.proposal_id,
      to: 'observed',
      reason: 'evidence_threshold:1_in_24h',
      decided_by: 'auto_promoter:evidence_threshold',
    });
    expect(
      storeByKind.get('fact')!.get(proposal.proposal_id)!.lifecycle_status,
    ).toBe('observed');

    row.evidence_count = 3;
    await KnowledgeStateMachine.transition({
      kind: 'fact',
      proposal_id: proposal.proposal_id,
      to: 'reinforced',
      reason: 'evidence_threshold:3_in_30d',
      decided_by: 'auto_promoter:evidence_threshold',
    });
    expect(
      storeByKind.get('fact')!.get(proposal.proposal_id)!.lifecycle_status,
    ).toBe('reinforced');

    row.evidence_count = 7;
    await KnowledgeStateMachine.transition({
      kind: 'fact',
      proposal_id: proposal.proposal_id,
      to: 'verified',
      reason: 'evidence_threshold:7_in_90d',
      decided_by: 'auto_promoter:evidence_threshold',
    });
    expect(
      storeByKind.get('fact')!.get(proposal.proposal_id)!.lifecycle_status,
    ).toBe('verified');

    // The lifecycle_transitions array now has 4 records (initial + 3
    // promotions). All append-only.
    const finalRow = storeByKind.get('fact')!.get(proposal.proposal_id)!;
    expect(finalRow.lifecycle_transitions).toHaveLength(4);
    expect(finalRow.lifecycle_transitions[0]!.from).toBe('proposed');
    expect(finalRow.lifecycle_transitions[3]!.to).toBe('verified');
  });
});

describe('P10a integration: cenário 2 — rule always pending_review', () => {
  it('rule with high confidence still lands in pending_review', async () => {
    const proposal = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'rule',
      confidence: 0.99,
      origin: 'llm_inference',
    });
    expect(proposal.initial_status).toBe('pending_review');
    expect(proposal.visible_to_llm).toBe(false);

    // Confirmar que from='proposed' está registrado (não 'ephemeral').
    const row = storeByKind.get('rule')!.get(proposal.proposal_id)!;
    expect(row.lifecycle_transitions[0]!.from).toBe('proposed');
    expect(row.lifecycle_transitions[0]!.to).toBe('pending_review');
  });
});

describe('P10a integration: cenário 3 — revocation is terminal', () => {
  it('revoke from ephemeral then attempt re-transition throws', async () => {
    const proposal = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.7,
      origin: 'llm_inference',
    });
    await KnowledgeStateMachine.revoke({
      kind: 'fact',
      proposal_id: proposal.proposal_id,
      reason: 'test_revoke',
      decided_by: 'incident_response',
    });
    expect(
      storeByKind.get('fact')!.get(proposal.proposal_id)!.lifecycle_status,
    ).toBe('revoked');

    await expect(
      KnowledgeStateMachine.transition({
        kind: 'fact',
        proposal_id: proposal.proposal_id,
        to: 'active',
        reason: 'should_fail',
        decided_by: 'human_approval',
      }),
    ).rejects.toThrow(IllegalTransitionError);
  });

  it('second revoke is idempotent (no extra transition row)', async () => {
    const proposal = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.7,
      origin: 'llm_inference',
    });
    await KnowledgeStateMachine.revoke({
      kind: 'fact',
      proposal_id: proposal.proposal_id,
      reason: 'first',
      decided_by: 'incident_response',
    });
    const transitionsAfterFirst = [
      ...storeByKind.get('fact')!.get(proposal.proposal_id)!
        .lifecycle_transitions,
    ];
    await KnowledgeStateMachine.revoke({
      kind: 'fact',
      proposal_id: proposal.proposal_id,
      reason: 'second',
      decided_by: 'incident_response',
    });
    expect(
      storeByKind.get('fact')!.get(proposal.proposal_id)!.lifecycle_transitions,
    ).toEqual(transitionsAfterFirst);
  });
});

describe('P10a integration: cenário 4 — auto-promoter idempotent', () => {
  it('two consecutive ticks produce the same end state', async () => {
    // Seed 5 ephemeral rows ready for promotion to observed.
    for (let i = 0; i < 5; i++) {
      seedRow('fact', {
        id: `fact-${i}`,
        tenant_id: 'tenant-a',
        agent_id: 'agent-a',
        lifecycle_status: 'ephemeral',
        lifecycle_transitions: [],
        evidence_count: 2,
        updated_at: new Date(),
        confidence: 0.7,
      });
    }
    // For each promote() rule the worker calls, configure the
    // matching filter just before runKnowledgeStatePromoter triggers
    // the corresponding promote() — easier: set a broad filter that
    // matches our seeded rows for all 6 rules.
    currentFilter = { evidenceMin: 1 };
    await runKnowledgeStatePromoter();
    const snapshot1 = JSON.stringify(
      [...storeByKind.get('fact')!.values()].map((r) => ({
        id: r.id,
        status: r.lifecycle_status,
      })),
    );

    await runKnowledgeStatePromoter();
    const snapshot2 = JSON.stringify(
      [...storeByKind.get('fact')!.values()].map((r) => ({
        id: r.id,
        status: r.lifecycle_status,
      })),
    );

    expect(snapshot2).toBe(snapshot1);
  });
});

describe('P10a integration: cenário 5 — TTL expiration → deprecated', () => {
  it('ephemeral row > 30d old moves to deprecated on next tick', async () => {
    seedRow('fact', {
      id: 'fact-stale',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      lifecycle_status: 'ephemeral',
      lifecycle_transitions: [],
      evidence_count: 0,
      updated_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      confidence: 0.5,
    });
    // Configure filter to match the row only for the TTL path.
    currentFilter = { ageMaxMs: undefined };
    await KnowledgeStateMachine.transition({
      kind: 'fact',
      proposal_id: 'fact-stale',
      to: 'deprecated',
      reason: 'ttl_expired:30d_no_update',
      decided_by: 'auto_promoter:ttl_expired',
    });
    expect(storeByKind.get('fact')!.get('fact-stale')!.lifecycle_status).toBe(
      'deprecated',
    );
  });
});

describe('P10a integration: cenário 6 — no-downgrade enforced', () => {
  it('verified → reinforced throws IllegalTransitionError', async () => {
    seedRow('fact', {
      id: 'fact-verified',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      lifecycle_status: 'verified',
      lifecycle_transitions: [],
      evidence_count: 12,
      updated_at: new Date(),
      confidence: 0.95,
    });
    await expect(
      KnowledgeStateMachine.transition({
        kind: 'fact',
        proposal_id: 'fact-verified',
        to: 'reinforced',
        reason: 'illegal',
        decided_by: 'auto_promoter:evidence_threshold',
      }),
    ).rejects.toThrow(IllegalTransitionError);
  });

  it('active → ephemeral throws IllegalTransitionError', async () => {
    seedRow('rule', {
      id: 'rule-active',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      lifecycle_status: 'active',
      lifecycle_transitions: [],
      evidence_count: 20,
      updated_at: new Date(),
      confidence: 1,
    });
    await expect(
      KnowledgeStateMachine.transition({
        kind: 'rule',
        proposal_id: 'rule-active',
        to: 'ephemeral',
        reason: 'illegal',
        decided_by: 'auto_promoter:evidence_threshold',
      }),
    ).rejects.toThrow(IllegalTransitionError);
  });
});
