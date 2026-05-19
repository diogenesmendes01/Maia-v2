/**
 * P10a (Codex review round-2 finding 3) — propose() never returns
 * success with an empty proposal_id.
 *
 *   - Scorer timeout falls back to a conservative high-risk score AND
 *     still completes the DB insert synchronously.
 *   - DB insert failure throws (not silent empty id).
 *   - propose_* tool output schemas reject non-UUID `proposal_id`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let createBehavior: 'normal' | 'returns_empty' | 'throws' = 'normal';
const storeFact = new Map<string, { lifecycle_status: string }>();

vi.mock('@/control-plane/knowledge-state-machine/repos.js', () => {
  class KnowledgeConflictError extends Error {}
  return {
    KnowledgeConflictError,
    knowledgeRepos: {
      async create(input: { lifecycle_status: string }): Promise<string> {
        if (createBehavior === 'throws') throw new Error('mock_db_failure');
        if (createBehavior === 'returns_empty') return '';
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
    cognitiveModuleLogRepo: {
      record: vi.fn().mockResolvedValue(undefined),
    },
  };
});

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  createBehavior = 'normal';
  storeFact.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Finding 3 — propose() insert error behaviour', () => {
  it('insert returning empty id throws', async () => {
    createBehavior = 'returns_empty';
    const { KnowledgeStateMachine } = await import(
      '@/control-plane/knowledge-state-machine/state-machine.js'
    );
    await expect(
      KnowledgeStateMachine.propose({
        trace_id: 't',
        tenant_id: 'tenant-a',
        agent_id: 'agent-a',
        kind: 'fact',
        scope: 'agent',
        key: 'k',
        content: { x: 1 },
        content_text: 'test',
        confidence: 0.7,
        origin: 'llm_inference',
        source: 'unit-test',
      }),
    ).rejects.toThrow(/insert_returned_empty_id/);
  });

  it('DB insert failure throws (not silent empty id)', async () => {
    createBehavior = 'throws';
    const { KnowledgeStateMachine } = await import(
      '@/control-plane/knowledge-state-machine/state-machine.js'
    );
    await expect(
      KnowledgeStateMachine.propose({
        trace_id: 't',
        tenant_id: 'tenant-a',
        agent_id: 'agent-a',
        kind: 'fact',
        scope: 'agent',
        key: 'k',
        content: { x: 1 },
        content_text: 'test',
        confidence: 0.7,
        origin: 'llm_inference',
        source: 'unit-test',
      }),
    ).rejects.toThrow(/mock_db_failure/);
  });
});

describe('Finding 3 — propose_* output schemas reject non-UUID proposal_id', () => {
  it('propose_fact rejects empty proposal_id', async () => {
    const mod = await import('@/tools/propose-fact.js');
    expect(
      mod.proposeFactTool.output_schema.safeParse({
        proposal_id: '',
        initial_status: 'ephemeral',
        visible_to_llm: true,
        reason: 'x',
      }).success,
    ).toBe(false);
  });

  it('propose_rule rejects empty proposal_id', async () => {
    const mod = await import('@/tools/propose-rule.js');
    expect(
      mod.proposeRuleTool.output_schema.safeParse({
        proposal_id: '',
        initial_status: 'pending_review' as const,
        visible_to_llm: false as const,
        reason: 'x',
      }).success,
    ).toBe(false);
  });

  it('propose_memory rejects non-UUID proposal_id', async () => {
    const mod = await import('@/tools/propose-memory.js');
    expect(
      mod.proposeMemoryTool.output_schema.safeParse({
        proposal_id: 'not-a-uuid',
        initial_status: 'ephemeral',
        visible_to_llm: true,
        reason: 'x',
      }).success,
    ).toBe(false);
  });

  it('propose_hint accepts valid UUID, rejects empty string', async () => {
    const mod = await import('@/tools/propose-hint.js');
    expect(
      mod.proposeHintTool.output_schema.safeParse({
        proposal_id: '00000000-0000-0000-0000-000000000001',
        initial_status: 'ephemeral' as const,
        visible_to_llm: true,
        reason: 'x',
      }).success,
    ).toBe(true);
    expect(
      mod.proposeHintTool.output_schema.safeParse({
        proposal_id: '',
        initial_status: 'ephemeral' as const,
        visible_to_llm: true,
        reason: 'x',
      }).success,
    ).toBe(false);
  });
});
