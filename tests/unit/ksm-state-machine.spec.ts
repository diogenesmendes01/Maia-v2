/**
 * P10a — KnowledgeStateMachine.propose / transition / revoke
 * (master §11.1.1).
 *
 * Uses in-memory mocks for knowledgeRepos so we can assert on the
 * append-only lifecycle_transitions array shape and reasons without
 * touching the database. cognitive_module_log writes are best-effort
 * (runCognitiveModule swallows failures); the audit_missing_tenant_context
 * warn is expected in this stand-alone context.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  KnowledgeKind,
  KnowledgeLifecycleStatus,
  KnowledgeRow,
  KnowledgeTransitionRecord,
} from '@/control-plane/knowledge-state-machine/types.js';

// In-memory store keyed by kind+id; populated by mocked create() and
// read/written by find/update.
const storeByKind = new Map<KnowledgeKind, Map<string, KnowledgeRow>>();

function seedStore(kind: KnowledgeKind, row: KnowledgeRow): void {
  if (!storeByKind.has(kind)) storeByKind.set(kind, new Map());
  storeByKind.get(kind)!.set(row.id, row);
}

// KnowledgeConflictError needs the SAME constructor identity that
// state-machine.ts imports via `./repos.js`. We define it INSIDE the
// factory because vi.mock is hoisted above any top-level declaration —
// referencing an outer class would race the hoist and ReferenceError.
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
    async create(input: {
      kind: KnowledgeKind;
      lifecycle_status: KnowledgeLifecycleStatus;
      lifecycle_transitions: KnowledgeTransitionRecord[];
      evidence_count: number;
      tenant_id: string;
      agent_id: string;
    }): Promise<string> {
      const id = `mock-id-${Math.random().toString(36).slice(2, 10)}`;
      seedStore(input.kind, {
        id,
        tenant_id: input.tenant_id,
        agent_id: input.agent_id,
        lifecycle_status: input.lifecycle_status,
        lifecycle_transitions: input.lifecycle_transitions,
        evidence_count: input.evidence_count,
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
      // Optimistic concurrency: simulate the conditional UPDATE so the
      // state-machine's KnowledgeConflictError path is exercised.
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

// Bypass the cognitive_module_log DB write — tenant context missing is
// expected in unit tests, the runner still returns the inner function's
// result via the audit-failed catch path.
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

import {
  KnowledgeStateMachine,
  IllegalTransitionError,
} from '@/control-plane/knowledge-state-machine/state-machine.js';

const baseInput = {
  trace_id: 't-1',
  tenant_id: 'tenant-a',
  agent_id: 'agent-a',
  scope: 'agent' as const,
  key: 'test_key',
  content: { foo: 'bar' },
  content_text: 'this is a test fact',
  source: 'unit-test',
};

beforeEach(() => {
  storeByKind.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('P10a KnowledgeStateMachine.propose — kind=rule always pending_review', () => {
  it('routes rule with low risk + high conf to pending_review (invariant)', async () => {
    const result = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'rule',
      confidence: 0.99,
      origin: 'llm_inference',
    });
    expect(result.initial_status).toBe('pending_review');
    expect(result.visible_to_llm).toBe(false);
    expect(result.proposal_id).toMatch(/mock-id-/);
  });

  it('routes rule with user_explicit origin (low risk) still to pending_review', async () => {
    const result = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'rule',
      confidence: 0.8,
      origin: 'user_explicit',
    });
    expect(result.initial_status).toBe('pending_review');
    expect(result.visible_to_llm).toBe(false);
  });
});

describe('P10a KnowledgeStateMachine.propose — non-rule + risk=low + conf>=0.6 → ephemeral', () => {
  it('routes fact with conf=0.7 + llm_inference to ephemeral', async () => {
    const result = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.7,
      origin: 'llm_inference',
    });
    expect(result.initial_status).toBe('ephemeral');
    expect(result.visible_to_llm).toBe(true);
  });

  it('routes memory with conf=0.6 (boundary) to ephemeral', async () => {
    const result = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'memory',
      confidence: 0.6,
      origin: 'llm_inference',
    });
    expect(result.initial_status).toBe('ephemeral');
    expect(result.visible_to_llm).toBe(true);
  });

  it('persists evidence_count=1 for user_explicit origin', async () => {
    const result = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.9,
      origin: 'user_explicit',
    });
    const row = storeByKind.get('fact')!.get(result.proposal_id)!;
    expect(row.evidence_count).toBe(1);
  });

  it('persists evidence_count=0 for llm_inference origin', async () => {
    const result = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.9,
      origin: 'llm_inference',
    });
    const row = storeByKind.get('fact')!.get(result.proposal_id)!;
    expect(row.evidence_count).toBe(0);
  });
});

describe('P10a KnowledgeStateMachine.propose — non-rule + low conf → pending_review', () => {
  it('routes fact with conf=0.5 to pending_review (conservative default)', async () => {
    const result = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.5,
      origin: 'llm_inference',
    });
    expect(result.initial_status).toBe('pending_review');
    expect(result.visible_to_llm).toBe(false);
  });
});

describe('P10a KnowledgeStateMachine.propose — appends initial transition with risk_score', () => {
  it('lifecycle_transitions[0] records risk_score, decided_by, reason', async () => {
    const result = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.7,
      origin: 'llm_inference',
    });
    const row = storeByKind.get('fact')!.get(result.proposal_id)!;
    expect(row.lifecycle_transitions).toHaveLength(1);
    const first = row.lifecycle_transitions[0]!;
    expect(first.from).toBe('proposed');
    expect(first.to).toBe('ephemeral');
    expect(first.decided_by).toBe('state_machine_propose');
    expect(first.risk_score).toBeDefined();
    expect(first.risk_score?.level).toBe('low');
    expect(first.risk_score?.source).toBe('stub:p10a');
    expect(first.reason).toContain('risk=low');
    expect(first.reason).toContain('kind=fact');
  });
});

describe('P10a KnowledgeStateMachine.transition — valid transitions', () => {
  it('appends transition without dropping previous ones', async () => {
    const created = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.7,
      origin: 'llm_inference',
    });
    const t = await KnowledgeStateMachine.transition({
      kind: 'fact',
      proposal_id: created.proposal_id,
      to: 'observed',
      reason: 'evidence_count>=1',
      decided_by: 'auto_promoter:evidence_threshold',
      evidence_id: 'evi-1',
    });
    expect(t.from).toBe('ephemeral');
    expect(t.to).toBe('observed');
    expect(t.evidence_id).toBe('evi-1');

    const row = storeByKind.get('fact')!.get(created.proposal_id)!;
    expect(row.lifecycle_status).toBe('observed');
    expect(row.lifecycle_transitions).toHaveLength(2);
    expect(row.lifecycle_transitions[1]!.from).toBe('ephemeral');
    expect(row.lifecycle_transitions[1]!.to).toBe('observed');
  });

  it('throws knowledge_not_found on missing proposal', async () => {
    await expect(
      KnowledgeStateMachine.transition({
        kind: 'fact',
        proposal_id: 'does-not-exist',
        to: 'observed',
        reason: 'no row',
        decided_by: 'auto_promoter:evidence_threshold',
      }),
    ).rejects.toThrow(/knowledge_not_found/);
  });
});

describe('P10a KnowledgeStateMachine.transition — invalid transitions throw', () => {
  it('ephemeral → verified throws IllegalTransitionError', async () => {
    const created = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.7,
      origin: 'llm_inference',
    });
    await expect(
      KnowledgeStateMachine.transition({
        kind: 'fact',
        proposal_id: created.proposal_id,
        to: 'verified',
        reason: 'illegal jump',
        decided_by: 'auto_promoter:evidence_threshold',
      }),
    ).rejects.toThrow(IllegalTransitionError);
  });

  it('no-downgrade: verified → reinforced throws', async () => {
    // Manually seed a verified row (skipping the normal propose path).
    seedStore('fact', {
      id: 'verified-1',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      lifecycle_status: 'verified',
      lifecycle_transitions: [],
      evidence_count: 10,
      updated_at: new Date(),
    });
    await expect(
      KnowledgeStateMachine.transition({
        kind: 'fact',
        proposal_id: 'verified-1',
        to: 'reinforced',
        reason: 'should fail',
        decided_by: 'auto_promoter:evidence_threshold',
      }),
    ).rejects.toThrow(IllegalTransitionError);
  });
});

describe('P10a KnowledgeStateMachine.revoke', () => {
  it('revokes ephemeral row, appends terminal transition', async () => {
    const created = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.7,
      origin: 'llm_inference',
    });
    const r = await KnowledgeStateMachine.revoke({
      kind: 'fact',
      proposal_id: created.proposal_id,
      reason: 'incident_response',
      decided_by: 'incident_response',
    });
    expect(r.from).toBe('ephemeral');
    expect(r.to).toBe('revoked');

    const row = storeByKind.get('fact')!.get(created.proposal_id)!;
    expect(row.lifecycle_status).toBe('revoked');
    expect(row.lifecycle_transitions.at(-1)!.to).toBe('revoked');
  });

  it('revoke is idempotent on already-revoked row', async () => {
    seedStore('fact', {
      id: 'revoked-1',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      lifecycle_status: 'revoked',
      lifecycle_transitions: [],
      evidence_count: 0,
      updated_at: new Date('2026-01-01'),
    });
    const r = await KnowledgeStateMachine.revoke({
      kind: 'fact',
      proposal_id: 'revoked-1',
      reason: 'second time',
      decided_by: 'incident_response',
    });
    expect(r.from).toBe('revoked');
    expect(r.to).toBe('revoked');
    expect(r.reason).toBe('already_revoked');
    expect(r.decided_by).toBe('idempotent');

    // No new transition appended — the row's transitions array stays empty.
    const row = storeByKind.get('fact')!.get('revoked-1')!;
    expect(row.lifecycle_transitions).toHaveLength(0);
  });

  it('revoke throws knowledge_not_found on missing row', async () => {
    await expect(
      KnowledgeStateMachine.revoke({
        kind: 'fact',
        proposal_id: 'nope',
        reason: 'x',
        decided_by: 'incident_response',
      }),
    ).rejects.toThrow(/knowledge_not_found/);
  });

  it('revokes from any non-terminal state (active → revoked)', async () => {
    seedStore('rule', {
      id: 'active-1',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      lifecycle_status: 'active',
      lifecycle_transitions: [],
      evidence_count: 10,
      updated_at: new Date(),
    });
    const r = await KnowledgeStateMachine.revoke({
      kind: 'rule',
      proposal_id: 'active-1',
      reason: 'contraevidence found',
      decided_by: 'contraevidence',
    });
    expect(r.from).toBe('active');
    expect(r.to).toBe('revoked');
  });
});

describe('P10a KnowledgeStateMachine — risk scorer integration', () => {
  it('low-conf llm_inference for non-rule routes to pending_review (medium risk)', async () => {
    const result = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'memory',
      confidence: 0.4,
      origin: 'llm_inference',
    });
    expect(result.initial_status).toBe('pending_review');
    expect(result.visible_to_llm).toBe(false);
  });

  it('human_approved origin routes to ephemeral even at low confidence', async () => {
    // human_approved gets low risk; conf 0.4 + low risk → not ephemeral
    // because the rule requires conf>=0.6. So this still routes to
    // pending_review (the conservative default).
    const result = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.4,
      origin: 'human_approved',
    });
    expect(result.initial_status).toBe('pending_review');
  });

  it('human_approved + high conf routes to ephemeral', async () => {
    const result = await KnowledgeStateMachine.propose({
      ...baseInput,
      kind: 'fact',
      confidence: 0.9,
      origin: 'human_approved',
    });
    expect(result.initial_status).toBe('ephemeral');
    expect(result.visible_to_llm).toBe(true);
  });
});
