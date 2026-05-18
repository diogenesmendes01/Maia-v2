/**
 * P10a (Codex review #104 critical #2) — atomic transitions via
 * optimistic concurrency.
 *
 * Before this fix, `KnowledgeStateMachine.transition()` did a
 * read-validate-write sequence with no row-level guard. Two concurrent
 * writers (e.g. auto-promoter + human revoke) could each read the same
 * old status, validate independently, and the last write would win
 * blindly — silently resurrecting a revoked row or losing a revoke.
 *
 * After the fix, `update()` uses
 * `WHERE id = ? AND lifecycle_status = <expected>` so a stale write
 * gets 0 affected rows and we throw KnowledgeConflictError, which the
 * state-machine translates into an IllegalTransitionError carrying the
 * now-observed status. The auto-promoter already treats
 * IllegalTransitionError as a benign skip; human paths surface the
 * error to the operator.
 *
 * This suite simulates the race by manipulating the mocked store's
 * status BETWEEN findById() and update() — the same race window a
 * concurrent worker would exploit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KnowledgeKind,
  KnowledgeLifecycleStatus,
  KnowledgeRow,
  KnowledgeTransitionRecord,
} from '@/control-plane/knowledge-state-machine/types.js';

const storeByKind = new Map<KnowledgeKind, Map<string, KnowledgeRow>>();

function seedStore(kind: KnowledgeKind, row: KnowledgeRow): void {
  if (!storeByKind.has(kind)) storeByKind.set(kind, new Map());
  storeByKind.get(kind)!.set(row.id, row);
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
      async create(): Promise<string> {
        throw new Error('create_not_used_in_this_suite');
      },
      async findById(
        kind: KnowledgeKind,
        id: string,
      ): Promise<KnowledgeRow | null> {
        const row = storeByKind.get(kind)?.get(id);
        if (!row) return null;
        // Return a shallow copy so the caller can't mutate the store.
        return { ...row, lifecycle_transitions: [...row.lifecycle_transitions] };
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
    },
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

import {
  KnowledgeStateMachine,
  IllegalTransitionError,
} from '@/control-plane/knowledge-state-machine/state-machine.js';

beforeEach(() => {
  storeByKind.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('P10a optimistic concurrency — lost-revoke prevention', () => {
  it('promoter transition that races with revoke throws IllegalTransitionError', async () => {
    // Seed an ephemeral row.
    seedStore('fact', {
      id: 'race-1',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      lifecycle_status: 'ephemeral',
      lifecycle_transitions: [],
      evidence_count: 1,
      updated_at: new Date(),
    });

    // The state-machine reads the row first (returns ephemeral), then
    // tries to write observed. We simulate the race by mutating the
    // row's status between the read and the write — done by
    // wrapping the mocked repo to revoke the row mid-flight.
    //
    // Easiest: call revoke() first to flip the persisted state to
    // revoked, then attempt the stale promotion. Since the state-machine
    // re-reads inside its own call, we need to simulate a stale read.
    // We can do this by patching findById to return ephemeral while the
    // store already holds revoked.
    const reposModule = await import(
      '@/control-plane/knowledge-state-machine/repos.js'
    );
    const originalFindById = reposModule.knowledgeRepos.findById;
    let firstCall = true;
    (reposModule.knowledgeRepos.findById as unknown) = async (
      kind: KnowledgeKind,
      id: string,
    ) => {
      if (firstCall) {
        firstCall = false;
        // Return the stale ephemeral snapshot. Meanwhile, mutate the
        // store to simulate a concurrent revoke.
        const row = storeByKind.get(kind)!.get(id)!;
        row.lifecycle_status = 'revoked';
        return {
          id: row.id,
          tenant_id: row.tenant_id,
          agent_id: row.agent_id,
          lifecycle_status: 'ephemeral',
          lifecycle_transitions: [],
          evidence_count: row.evidence_count,
          updated_at: row.updated_at,
        };
      }
      return originalFindById(kind, id);
    };

    try {
      await expect(
        KnowledgeStateMachine.transition({
          kind: 'fact',
          proposal_id: 'race-1',
          to: 'observed',
          reason: 'race_test',
          decided_by: 'auto_promoter:evidence_threshold',
        }),
      ).rejects.toThrow(IllegalTransitionError);

      // The store-level state remains revoked — the revoke was preserved.
      expect(storeByKind.get('fact')!.get('race-1')!.lifecycle_status).toBe(
        'revoked',
      );
    } finally {
      (reposModule.knowledgeRepos.findById as unknown) = originalFindById;
    }
  });

  it('revoke wins over concurrent revoke (idempotent no-op)', async () => {
    seedStore('fact', {
      id: 'race-2',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      lifecycle_status: 'ephemeral',
      lifecycle_transitions: [],
      evidence_count: 1,
      updated_at: new Date(),
    });

    const reposModule = await import(
      '@/control-plane/knowledge-state-machine/repos.js'
    );
    const originalFindById = reposModule.knowledgeRepos.findById;
    let firstCall = true;
    (reposModule.knowledgeRepos.findById as unknown) = async (
      kind: KnowledgeKind,
      id: string,
    ) => {
      if (firstCall) {
        firstCall = false;
        // Stale ephemeral snapshot; meanwhile another writer already
        // revoked the row.
        const row = storeByKind.get(kind)!.get(id)!;
        row.lifecycle_status = 'revoked';
        return {
          id: row.id,
          tenant_id: row.tenant_id,
          agent_id: row.agent_id,
          lifecycle_status: 'ephemeral',
          lifecycle_transitions: [],
          evidence_count: row.evidence_count,
          updated_at: row.updated_at,
        };
      }
      return originalFindById(kind, id);
    };

    try {
      const result = await KnowledgeStateMachine.revoke({
        kind: 'fact',
        proposal_id: 'race-2',
        reason: 'second_revoke',
        decided_by: 'incident_response',
      });
      // Concurrent revoke should idempotently return revoked → revoked
      // with reason 'already_revoked_concurrent'.
      expect(result.from).toBe('revoked');
      expect(result.to).toBe('revoked');
      expect(result.decided_by).toBe('idempotent');
    } finally {
      (reposModule.knowledgeRepos.findById as unknown) = originalFindById;
    }
  });

  it('revoke retries when row moved to a non-terminal state between read and write', async () => {
    seedStore('fact', {
      id: 'race-3',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      lifecycle_status: 'ephemeral',
      lifecycle_transitions: [],
      evidence_count: 1,
      updated_at: new Date(),
    });

    const reposModule = await import(
      '@/control-plane/knowledge-state-machine/repos.js'
    );
    const originalFindById = reposModule.knowledgeRepos.findById;
    let call = 0;
    (reposModule.knowledgeRepos.findById as unknown) = async (
      kind: KnowledgeKind,
      id: string,
    ) => {
      call++;
      if (call === 1) {
        // First read: ephemeral. Meanwhile, promote to observed.
        const row = storeByKind.get(kind)!.get(id)!;
        row.lifecycle_status = 'observed';
        return {
          id: row.id,
          tenant_id: row.tenant_id,
          agent_id: row.agent_id,
          lifecycle_status: 'ephemeral',
          lifecycle_transitions: [],
          evidence_count: row.evidence_count,
          updated_at: row.updated_at,
        };
      }
      // Subsequent reads: real value (observed).
      return originalFindById(kind, id);
    };

    try {
      const result = await KnowledgeStateMachine.revoke({
        kind: 'fact',
        proposal_id: 'race-3',
        reason: 'human_initiated',
        decided_by: 'incident_response',
      });
      // After conflict + retry, the row ends up revoked from observed.
      expect(result.from).toBe('observed');
      expect(result.to).toBe('revoked');
      expect(storeByKind.get('fact')!.get('race-3')!.lifecycle_status).toBe(
        'revoked',
      );
    } finally {
      (reposModule.knowledgeRepos.findById as unknown) = originalFindById;
    }
  });
});
