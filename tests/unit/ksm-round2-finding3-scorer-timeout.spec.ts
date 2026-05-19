/**
 * P10a (Codex review round-2 finding 3) — when the risk scorer
 * exceeds the 300ms budget, the state machine MUST still complete
 * the DB insert synchronously and return a non-empty proposal_id
 * with the conservative pending_review status.
 *
 * Previously the timeout wrapper covered the entire propose function
 * (scorer + insert) and the fallback returned `proposal_id: ''` as
 * a "successful" result. That let callers cache/audit a nonexistent
 * row id.
 */

import { describe, expect, it, vi } from 'vitest';

const storeFact = new Map<string, { lifecycle_status: string }>();

// Slow risk scorer: resolves AFTER the state-machine's 300ms timeout.
vi.mock('@/control-plane/knowledge-state-machine/risk-scorer.js', () => ({
  KnowledgeRiskScorer: {
    score: () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              level: 'low' as const,
              sensitivity: 'low' as const,
              reasons: ['late'],
              source: 'stub:p10a' as const,
            }),
          500,
        ),
      ),
  },
}));

vi.mock('@/control-plane/knowledge-state-machine/repos.js', () => {
  class KnowledgeConflictError extends Error {}
  return {
    KnowledgeConflictError,
    knowledgeRepos: {
      async create(input: { lifecycle_status: string }): Promise<string> {
        const id = `00000000-0000-0000-0000-${Math.floor(
          Math.random() * 1e12,
        )
          .toString(16)
          .padStart(12, '0')}`;
        storeFact.set(id, { lifecycle_status: input.lifecycle_status });
        return id;
      },
      async findById() {
        return null;
      },
      async update() {
        /* no-op */
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Finding 3 — slow scorer still completes the insert synchronously', () => {
  it('returns UUID proposal_id + pending_review on scorer timeout', async () => {
    const { KnowledgeStateMachine } = await import(
      '@/control-plane/knowledge-state-machine/state-machine.js'
    );

    const result = await KnowledgeStateMachine.propose({
      trace_id: 't',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      kind: 'fact',
      scope: 'agent',
      key: 'slow',
      content: { x: 1 },
      content_text: 'slow scorer',
      confidence: 0.7,
      origin: 'llm_inference',
      source: 'unit-test',
    });

    expect(result.proposal_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.initial_status).toBe('pending_review');
    expect(result.visible_to_llm).toBe(false);
    expect(result.reason).toMatch(/fallback:scorer_/);
    expect(storeFact.size).toBe(1);
    expect([...storeFact.values()][0]!.lifecycle_status).toBe('pending_review');
  });
});
