/**
 * P10a — property tests for the Knowledge State Machine.
 *
 * These are pure invariant checks over ALLOWED_TRANSITIONS and the
 * promoter idempotency contract. They run without a database and use
 * the same in-memory store mock as the unit/integration suites so they
 * exercise the full state-machine + worker call graph.
 *
 * Per Codex review #104:
 *   (1) BFS reachability — no path exists from `revoked` → any visible
 *       state (or any non-terminal state). The transition table is the
 *       contract; this test is the property fence.
 *   (2) Auto-promoter idempotency — running the worker 100 times in a
 *       row on the same dataset produces the same final lifecycle
 *       snapshot. No row should advance past its evidence-supported
 *       state, and no row should regress.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KnowledgeKind,
  KnowledgeLifecycleStatus,
  KnowledgeRow,
  KnowledgeTransitionRecord,
} from '@/control-plane/knowledge-state-machine/types.js';

// ---------------------------------------------------------------------
// Shared in-memory store + mocks (same shape as the integration suite)
// ---------------------------------------------------------------------
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

type EligibleFilter = {
  evidenceMin?: number;
  maturity?: boolean;
  ageMaxMs?: number;
  noUsageMaxMs?: number;
};

let currentFilter: EligibleFilter = {};

vi.mock('@/control-plane/knowledge-state-machine/repos.js', async () => {
  const drizzle = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
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
      }): Promise<Array<{ id: string; tenant_id: string; agent_id: string }>> {
        // Issue #234: include tenant_id/agent_id so the worker's
        // runWithTenantContext wrapper has real values to set on ALS.
        const rows = listByStatus(args.kind, args.from);
        return rows
          .filter((row) => {
            if (
              currentFilter.evidenceMin !== undefined &&
              row.evidence_count < currentFilter.evidenceMin
            ) {
              return false;
            }
            if (currentFilter.maturity) {
              if ((row.confidence ?? 0) < 0.9) return false;
              if (row.evidence_count < 10) return false;
            }
            if (currentFilter.ageMaxMs !== undefined) {
              const cutoff = Date.now() - currentFilter.ageMaxMs;
              if (row.updated_at.getTime() >= cutoff) return false;
            }
            return true;
          })
          .map((r) => ({
            id: r.id,
            tenant_id: r.tenant_id,
            agent_id: r.agent_id,
          }));
      },
      buildUpdatedAtFilter() {
        return drizzle.sql`true`;
      },
    },
    sql: drizzle.sql,
    lte: drizzle.lte,
  };
});

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    cognitiveModuleLogRepo: { record: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Worker now uses featureFlags.isEnabled(); override the singleton so
// the property test isn't dependent on the test-runner env.
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
  ALLOWED_TRANSITIONS,
  assertAllowedTransition,
  IllegalTransitionError,
} from '@/control-plane/knowledge-state-machine/transitions.js';
import { runKnowledgeStatePromoter } from '@/workers/knowledge-state-promoter.js';

// ---------------------------------------------------------------------
// Property 1 — BFS reachability: revoked → active is impossible.
// ---------------------------------------------------------------------
describe('P10a property: ALLOWED_TRANSITIONS graph invariants', () => {
  function bfsReachable(
    start: KnowledgeLifecycleStatus,
  ): Set<KnowledgeLifecycleStatus> {
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

  it('no path exists from revoked to active (BFS exhaustive)', () => {
    const reachable = bfsReachable('revoked');
    expect(reachable.has('active')).toBe(false);
    // also assert it's truly terminal
    expect(reachable.size).toBe(1);
    expect(reachable.has('revoked')).toBe(true);
  });

  it('no path exists from deprecated to active', () => {
    const reachable = bfsReachable('deprecated');
    expect(reachable.has('active')).toBe(false);
    // deprecated can only reach revoked
    expect([...reachable].sort()).toEqual(['deprecated', 'revoked']);
  });

  it('no path from revoked to ANY non-revoked state', () => {
    const reachable = bfsReachable('revoked');
    const nonRevoked: KnowledgeLifecycleStatus[] = [
      'proposed',
      'pending_review',
      'ephemeral',
      'observed',
      'reinforced',
      'verified',
      'active',
      'deprecated',
    ];
    for (const state of nonRevoked) {
      expect(reachable.has(state)).toBe(false);
    }
  });

  it('runtime assertion mirrors BFS — every edge in BFS path passes assertAllowedTransition', () => {
    // Iterate every node × every outbound edge declared in the table;
    // the assertion must never throw for those, and must throw for every
    // edge NOT in the table.
    const allStates: KnowledgeLifecycleStatus[] = [
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
    for (const from of allStates) {
      const allowed = new Set(ALLOWED_TRANSITIONS[from]);
      for (const to of allStates) {
        if (allowed.has(to)) {
          expect(() => assertAllowedTransition(from, to)).not.toThrow();
        } else if (from !== to) {
          expect(() => assertAllowedTransition(from, to)).toThrow(
            IllegalTransitionError,
          );
        }
      }
    }
  });
});

// ---------------------------------------------------------------------
// Property 2 — Auto-promoter idempotency over 100 iterations.
// ---------------------------------------------------------------------
describe('P10a property: auto-promoter idempotency (100 iterations)', () => {
  beforeEach(() => {
    storeByKind.clear();
    currentFilter = {};
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('100 sequential ticks produce the same final snapshot as 1 tick', async () => {
    // Build a varied dataset across all 4 kinds + 4 lifecycle states.
    // Some rows are eligible for the first promotion; others are stuck
    // (low evidence_count or already at verified) so we cover both paths.
    const kinds: KnowledgeKind[] = ['fact', 'rule', 'memory', 'behavioral_hint'];
    for (const kind of kinds) {
      // Eligible ephemeral rows (evidence_count >= 1)
      for (let i = 0; i < 5; i++) {
        seedRow(kind, {
          id: `${kind}-eph-${i}`,
          tenant_id: 'tenant-a',
          agent_id: 'agent-a',
          lifecycle_status: 'ephemeral',
          lifecycle_transitions: [],
          evidence_count: 2,
          updated_at: new Date(),
          confidence: 0.7,
        });
      }
      // Stuck ephemeral rows (evidence_count = 0 → no promotion under
      // the broad filter, but ALSO no TTL because we keep updated_at
      // recent)
      for (let i = 0; i < 3; i++) {
        seedRow(kind, {
          id: `${kind}-stuck-${i}`,
          tenant_id: 'tenant-a',
          agent_id: 'agent-a',
          lifecycle_status: 'ephemeral',
          lifecycle_transitions: [],
          evidence_count: 0,
          updated_at: new Date(),
          confidence: 0.5,
        });
      }
      // Already-verified rows that lack maturity (conf < 0.9)
      seedRow(kind, {
        id: `${kind}-verif-locked`,
        tenant_id: 'tenant-a',
        agent_id: 'agent-a',
        lifecycle_status: 'verified',
        lifecycle_transitions: [],
        evidence_count: 5,
        updated_at: new Date(),
        confidence: 0.75,
      });
    }

    // Broad filter — the promoter's per-rule filters are mocked away in
    // the listEligible factory; evidenceMin=1 matches the eph/observed
    // promotions.
    currentFilter = { evidenceMin: 1 };

    await runKnowledgeStatePromoter();

    const snapshotOf = () =>
      JSON.stringify(
        kinds.flatMap((k) =>
          [...(storeByKind.get(k)?.values() ?? [])]
            .map((r) => ({ kind: k, id: r.id, status: r.lifecycle_status }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        ),
      );

    const snapshotAfterFirst = snapshotOf();

    for (let i = 0; i < 99; i++) {
      await runKnowledgeStatePromoter();
    }

    const snapshotAfterHundred = snapshotOf();
    expect(snapshotAfterHundred).toBe(snapshotAfterFirst);
  });

  it('idempotency holds even when seeded with revoked rows (must stay revoked)', async () => {
    seedRow('fact', {
      id: 'fact-revoked-1',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      lifecycle_status: 'revoked',
      lifecycle_transitions: [],
      evidence_count: 100,
      updated_at: new Date(),
      confidence: 1.0,
    });
    currentFilter = { evidenceMin: 0 };

    for (let i = 0; i < 100; i++) {
      await runKnowledgeStatePromoter();
    }

    expect(storeByKind.get('fact')!.get('fact-revoked-1')!.lifecycle_status).toBe(
      'revoked',
    );
  });
});
