/**
 * Issue #256 — KSM.revoke() bounded retry loop under optimistic-conflict.
 *
 * Context (revalidation of PR #243):
 *   The original single-shot retry on optimistic-conflict broke the
 *   idempotency contract under 3+ concurrent actors. Scenario from the
 *   issue:
 *     A revokes → B transitions back → C revokes (initial), conflicts,
 *     re-reads `active`, C retries → A re-revokes before C's retry
 *     lands → C's retry sees `revoked`, throws KnowledgeConflictError
 *     to the caller despite the row being in the desired terminal state.
 *
 * Fix (this PR): bounded retry loop with MAX_REVOKE_RETRIES=3 and a
 * small exponential backoff (10ms, 30ms). On every conflict we re-read
 * the row, short-circuit if it's already `revoked` (idempotency), and
 * otherwise re-attempt against the freshly observed status. If
 * MAX_REVOKE_RETRIES is exhausted, the last KnowledgeConflictError is
 * thrown so the caller is aware the row is under pathological
 * contention.
 *
 * Strategy:
 *   Mock `knowledgeRepos.update` and `findById` with scripted sequences
 *   that return `KnowledgeConflictError` for a controlled number of
 *   attempts. The state-machine code is exercised end-to-end against
 *   the mocked repo — no DB, no SQL.
 *
 * IMPORTANT — pattern copied from tests/unit/ksm-state-machine.spec.ts:
 *   The `KnowledgeConflictError` class must be defined INSIDE the
 *   vi.mock factory so the constructor identity matches what the
 *   state-machine imports via `./repos.js`. vi.mock hoists above any
 *   top-level declaration, so referencing an outer class would
 *   ReferenceError.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KnowledgeKind,
  KnowledgeLifecycleStatus,
  KnowledgeRow,
  KnowledgeTransitionRecord,
} from '@/control-plane/knowledge-state-machine/types.js';

// ---------------------------------------------------------------------------
// In-memory store + scripted-conflict mock for knowledgeRepos.
// ---------------------------------------------------------------------------
const storeByKind = new Map<KnowledgeKind, Map<string, KnowledgeRow>>();

/**
 * Per-id script of conflict outcomes the next N calls to `update` should
 * emit. Each entry is either:
 *   - 'success' — the update applies (with optional concurrent mutation
 *     of lifecycle_status _before_ the update lands, simulating that
 *     another writer transitioned the row in between)
 *   - { conflict: true, postReadStatus?: KnowledgeLifecycleStatus } —
 *     the update throws KnowledgeConflictError. If postReadStatus is
 *     provided, the next `findById` returns the row with that status
 *     (simulating that a concurrent mutation happened between the
 *     conflict and the subsequent re-read).
 *
 * Once the script is exhausted the mock defaults to 'success' for the
 * remaining calls (which the scenarios below don't reach).
 */
type ConflictScript = Array<
  | 'success'
  | {
      conflict: true;
      postReadStatus?: KnowledgeLifecycleStatus;
    }
>;
const conflictScriptByKindId = new Map<string, ConflictScript>();
const updateCallCountByKindId = new Map<string, number>();

function seedStore(kind: KnowledgeKind, row: KnowledgeRow): void {
  if (!storeByKind.has(kind)) storeByKind.set(kind, new Map());
  storeByKind.get(kind)!.set(row.id, row);
}

function scriptKey(kind: KnowledgeKind, id: string): string {
  return `${kind}:${id}`;
}

function scriptConflicts(
  kind: KnowledgeKind,
  id: string,
  script: ConflictScript,
): void {
  conflictScriptByKindId.set(scriptKey(kind, id), script);
  updateCallCountByKindId.set(scriptKey(kind, id), 0);
}

vi.mock('@/control-plane/knowledge-state-machine/repos.js', () => {
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
        const key = scriptKey(kind, id);
        const script = conflictScriptByKindId.get(key) ?? [];
        const callIdx = updateCallCountByKindId.get(key) ?? 0;
        updateCallCountByKindId.set(key, callIdx + 1);

        const step = script[callIdx];
        const row = storeByKind.get(kind)?.get(id);

        if (
          step &&
          typeof step === 'object' &&
          'conflict' in step &&
          step.conflict
        ) {
          // Simulate the conflict (production raises this when the
          // conditional UPDATE affects 0 rows). If the script asked us
          // to mutate the row's status before the next re-read, do so —
          // mirrors a concurrent writer landing between our update and
          // our next findById.
          if (row && step.postReadStatus) {
            row.lifecycle_status = step.postReadStatus;
            row.updated_at = new Date();
          }
          throw new KnowledgeConflictError(
            kind,
            id,
            updates.expected_previous_status ?? 'pending_review',
          );
        }

        // Default: apply the update (success path).
        if (!row) return;
        if (
          updates.expected_previous_status !== undefined &&
          row.lifecycle_status !== updates.expected_previous_status
        ) {
          // No script step, but the state has drifted out from under us.
          // Production would raise KnowledgeConflictError here too.
          throw new KnowledgeConflictError(
            kind,
            id,
            updates.expected_previous_status,
          );
        }
        if (updates.lifecycle_status !== undefined) {
          row.lifecycle_status = updates.lifecycle_status;
        }
        if (updates.lifecycle_transitions !== undefined) {
          row.lifecycle_transitions = updates.lifecycle_transitions;
        }
        if (updates.evidence_count !== undefined) {
          row.evidence_count = updates.evidence_count;
        }
        row.updated_at = new Date();
      },
    },
  };
});

// Bypass the cognitive_module_log DB write — tenant context is missing
// in these unit tests and the runner swallows the audit failure.
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

// Silence the audit_missing_tenant_context warn — expected outside of
// runWithTenantContext.
vi.mock('@/lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { KnowledgeStateMachine } from '@/control-plane/knowledge-state-machine/state-machine.js';
import { KnowledgeConflictError } from '@/control-plane/knowledge-state-machine/repos.js';

const TENANT = 'tenant-a';
const AGENT = 'agent-a';

function seedRule(id: string, status: KnowledgeLifecycleStatus): void {
  seedStore('rule', {
    id,
    tenant_id: TENANT,
    agent_id: AGENT,
    lifecycle_status: status,
    lifecycle_transitions: [],
    evidence_count: 0,
    updated_at: new Date('2026-01-01'),
  });
}

beforeEach(() => {
  storeByKind.clear();
  conflictScriptByKindId.clear();
  updateCallCountByKindId.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Issue #256 — KSM.revoke() bounded retry under optimistic-conflict', () => {
  it('Scenario 1: race resolved in 2 tries — 1 concurrent mutation between initial update and retry, revoke returns without error', async () => {
    // Initial state: pending_review.
    // Attempt 0: conflict (simulate parallel writer flipping pending_review
    //            → active between our findById and our update). The mock
    //            also flips the row's status to 'active' so the
    //            subsequent re-read in production sees the new status.
    // Attempt 1: success.
    seedRule('rule-race-2', 'pending_review');
    scriptConflicts('rule', 'rule-race-2', [
      { conflict: true, postReadStatus: 'active' },
      'success',
    ]);

    const result = await KnowledgeStateMachine.revoke({
      kind: 'rule',
      proposal_id: 'rule-race-2',
      reason: 'concurrency_test',
      decided_by: 'incident_response',
    });

    expect(result.to).toBe('revoked');
    // Attempt 1 sees `active` (postReadStatus), so the `from` recorded
    // on the transition is `active`.
    expect(result.from).toBe('active');
    expect(result.reason).toBe('concurrency_test');
    expect(result.decided_by).toBe('incident_response');

    const row = storeByKind.get('rule')!.get('rule-race-2')!;
    expect(row.lifecycle_status).toBe('revoked');

    // Exactly 2 update calls (attempt 0 conflict + attempt 1 success).
    expect(updateCallCountByKindId.get('rule:rule-race-2')).toBe(2);
  });

  it('Scenario 2: race resolved in 3 tries — 2 concurrent mutations, revoke succeeds on attempt 3', async () => {
    // Attempt 0: conflict; row flips to active.
    // Attempt 1: conflict; row flips to deprecated.
    // Attempt 2: success.
    seedRule('rule-race-3', 'pending_review');
    scriptConflicts('rule', 'rule-race-3', [
      { conflict: true, postReadStatus: 'active' },
      { conflict: true, postReadStatus: 'deprecated' },
      'success',
    ]);

    const result = await KnowledgeStateMachine.revoke({
      kind: 'rule',
      proposal_id: 'rule-race-3',
      reason: 'concurrency_test',
      decided_by: 'incident_response',
    });

    expect(result.to).toBe('revoked');
    // Attempt 2 sees `deprecated` (postReadStatus from attempt-1's
    // conflict), so the `from` is `deprecated`.
    expect(result.from).toBe('deprecated');

    const row = storeByKind.get('rule')!.get('rule-race-3')!;
    expect(row.lifecycle_status).toBe('revoked');

    // Exactly 3 update calls.
    expect(updateCallCountByKindId.get('rule:rule-race-3')).toBe(3);
  });

  it('Scenario 3: max retries exhausted — continuous concurrent mutations beyond MAX_REVOKE_RETRIES, KnowledgeConflictError surfaces after backoff', async () => {
    // 3+ continuous conflicts → revoke throws KnowledgeConflictError.
    seedRule('rule-exhausted', 'pending_review');
    scriptConflicts('rule', 'rule-exhausted', [
      { conflict: true, postReadStatus: 'active' },
      { conflict: true, postReadStatus: 'deprecated' },
      { conflict: true, postReadStatus: 'active' },
      { conflict: true, postReadStatus: 'deprecated' }, // never reached
    ]);

    await expect(
      KnowledgeStateMachine.revoke({
        kind: 'rule',
        proposal_id: 'rule-exhausted',
        reason: 'concurrency_test',
        decided_by: 'incident_response',
      }),
    ).rejects.toBeInstanceOf(KnowledgeConflictError);

    // Row is NOT revoked — all three update attempts were rejected.
    const row = storeByKind.get('rule')!.get('rule-exhausted')!;
    expect(row.lifecycle_status).not.toBe('revoked');
    // The last conflict's postReadStatus is what the row ended up as.
    expect(row.lifecycle_status).toBe('active');

    // Exactly MAX_REVOKE_RETRIES (3) update calls were made.
    expect(updateCallCountByKindId.get('rule:rule-exhausted')).toBe(3);
  });

  it('Scenario 4: early-exit when already revoked — fresh.lifecycle_status === revoked on re-read returns idempotent (no throw)', async () => {
    // Attempt 0: initial update conflicts. The mock simulates that a
    // concurrent revoke landed in between by flipping the row to
    // 'revoked'. Production's re-read sees `revoked` and returns the
    // idempotent synthetic record without throwing or retrying.
    seedRule('rule-already-revoked', 'pending_review');
    scriptConflicts('rule', 'rule-already-revoked', [
      { conflict: true, postReadStatus: 'revoked' },
      'success', // should NOT be reached
    ]);

    const result = await KnowledgeStateMachine.revoke({
      kind: 'rule',
      proposal_id: 'rule-already-revoked',
      reason: 'concurrency_test',
      decided_by: 'incident_response',
    });

    expect(result.from).toBe('revoked');
    expect(result.to).toBe('revoked');
    expect(result.reason).toBe('already_revoked_concurrent');
    expect(result.decided_by).toBe('idempotent');

    // Only the first attempt's update was called — the early-exit
    // skipped the second `success` script entry.
    expect(updateCallCountByKindId.get('rule:rule-already-revoked')).toBe(1);

    const row = storeByKind.get('rule')!.get('rule-already-revoked')!;
    expect(row.lifecycle_status).toBe('revoked');
  });

  it('Scenario 5: no race — normal path with attempt 0 succeeds, no re-read needed', async () => {
    // Empty script → first update succeeds immediately.
    seedRule('rule-no-race', 'active');

    const result = await KnowledgeStateMachine.revoke({
      kind: 'rule',
      proposal_id: 'rule-no-race',
      reason: 'no_concurrency_test',
      decided_by: 'contraevidence',
    });

    expect(result.from).toBe('active');
    expect(result.to).toBe('revoked');
    expect(result.reason).toBe('no_concurrency_test');
    expect(result.decided_by).toBe('contraevidence');

    const row = storeByKind.get('rule')!.get('rule-no-race')!;
    expect(row.lifecycle_status).toBe('revoked');

    // Exactly 1 update call (the only attempt needed).
    expect(updateCallCountByKindId.get('rule:rule-no-race')).toBe(1);

    // The transition record was appended.
    expect(row.lifecycle_transitions).toHaveLength(1);
    expect(row.lifecycle_transitions[0]!.to).toBe('revoked');
    expect(row.lifecycle_transitions[0]!.from).toBe('active');
  });

  it('preserves existing idempotency on pre-revoked row — initial findById sees revoked, returns synthetic without any update attempt', async () => {
    // Defense-in-depth: ensure the fast-path (initial read already shows
    // revoked) is preserved by the refactor — must NOT call update.
    seedRule('rule-pre-revoked', 'revoked');

    const result = await KnowledgeStateMachine.revoke({
      kind: 'rule',
      proposal_id: 'rule-pre-revoked',
      reason: 'second-time',
      decided_by: 'incident_response',
    });

    expect(result.from).toBe('revoked');
    expect(result.to).toBe('revoked');
    expect(result.reason).toBe('already_revoked');
    expect(result.decided_by).toBe('idempotent');

    // No update calls.
    expect(updateCallCountByKindId.get('rule:rule-pre-revoked') ?? 0).toBe(0);
  });

  it('non-conflict errors are not retried — generic Error propagates immediately', async () => {
    // Inject a non-conflict error via the mock by seeding a row whose
    // expected_previous_status mismatches. Wait — actually we need to
    // simulate a generic throw. Easier: temporarily wrap the mock's
    // update to throw a plain Error on first call.
    seedRule('rule-generic-err', 'pending_review');

    const { knowledgeRepos } = await import(
      '@/control-plane/knowledge-state-machine/repos.js'
    );
    const updateSpy = vi.spyOn(knowledgeRepos, 'update');
    updateSpy.mockRejectedValueOnce(new Error('db_unreachable'));

    await expect(
      KnowledgeStateMachine.revoke({
        kind: 'rule',
        proposal_id: 'rule-generic-err',
        reason: 'generic_error_test',
        decided_by: 'incident_response',
      }),
    ).rejects.toThrow(/db_unreachable/);

    // Exactly 1 update call (no retry on generic error).
    expect(updateSpy).toHaveBeenCalledTimes(1);

    updateSpy.mockRestore();
  });
});
