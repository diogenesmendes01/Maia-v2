/**
 * P10a (Codex review round-2 finding 1) — `persistCandidate` MUST
 * route LLM/worker-origin fact/rule writes through the Knowledge
 * State Machine when the KSM feature flag is enabled.
 *
 * Before this fix, every reflection path (agent/core, react-loop,
 * reflection.ts, worker/conversation-summarizer, worker/pattern-detector,
 * cognitive-graph/postturn-graph) called `factsRepo.upsert` and
 * `rulesRepo.create` directly. With migration 036 those tables added
 * `lifecycle_status DEFAULT 'active'`, so LLM-derived rows were born
 * active and surfaced to the prompt without any risk-score review.
 *
 * This file pins the fixed behaviour: for origin 'llm' or 'worker', the
 * persister routes fact/rule writes through KnowledgeStateMachine.propose()
 * — never through factsRepo.upsert with the default-active lifecycle.
 * (KSM is always-on; the former feature-flag gate was removed.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Captured = { lifecycle_status: string };
const ksmStore = new Map<string, Captured>();

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
        ksmStore.set(id, { lifecycle_status: input.lifecycle_status });
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

vi.mock('@/db/tenant-context.js', () => ({
  getCurrentTenant: () => 'tenant-a',
  getCurrentAgent: () => 'agent-a',
  tryGetCurrentContext: () => ({
    tenant_id: 'tenant-a',
    agent_id: 'agent-a',
  }),
  runWithTenantContext: <T,>(_ctx: unknown, fn: () => Promise<T>) => fn(),
  MissingTenantContextError: class extends Error {},
}));

// Legacy repos stubbed so the non-KSM candidate branches return cleanly.
// The fact/rule tests assert that we DIDN'T touch factsRepo.upsert at all.
const factsUpsert = vi.fn().mockResolvedValue({ id: 'legacy-fact-id' });
const rulesCreate = vi.fn().mockResolvedValue({ id: 'legacy-rule-id' });
vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    factsRepo: { upsert: factsUpsert },
    rulesRepo: { create: rulesCreate },
    cognitiveCandidatesRepo: {
      create: vi.fn().mockResolvedValue({ id: 'cand-1' }),
    },
    memoryEntryRepo: { create: vi.fn().mockResolvedValue(null) },
    behavioralHintRepo: { create: vi.fn() },
    capabilityGapsRepo: { upsert: vi.fn() },
    cognitiveModuleLogRepo: { record: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock('@/cognition/memory-classifier.js', () => ({
  classifyMemory: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/cognition/behavioral-hint-deriver.js', () => ({
  deriveBehavioralHint: vi.fn(),
}));
vi.mock('@/workers/behavioral-hint-validator.js', () => ({
  validateBehavioralHint: vi.fn(),
}));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  ksmStore.clear();
  factsUpsert.mockClear();
  rulesCreate.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Finding 1 — persistCandidate routes LLM/worker through KSM when flag is on', () => {
  it('LLM-origin "fato" routes through KSM (never lifecycle_status="active")', async () => {
    const { persistCandidate } = await import('@/cognition/persister.js');
    const { CandidateType, CognitiveEventType } = await import(
      '@/types/enums.js'
    );

    const result = await persistCandidate(
      {
        type: CandidateType.FATO,
        content: 'usuário prefere tom direto',
        scope: 'agent',
        subject_id: 'ent-1',
      },
      {
        type: CognitiveEventType.USER_CORRECTION,
        conversa_id: 'conv-1',
        inbound_mensagem_id: 'msg-1',
        previous_assistant_mensagem_id: 'msg-0',
        correction_text: 'não',
        previous_response_text: 'foo',
      },
      'llm',
    );

    expect(result.persisted_to).toMatch(/^ksm:/);
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const row = ksmStore.get(result.id!)!;
    expect(row.lifecycle_status).not.toBe('active');
    expect(['ephemeral', 'pending_review']).toContain(row.lifecycle_status);

    // The legacy upsert must NOT have been called when the KSM path
    // is active — that's the whole point of finding 1.
    expect(factsUpsert).not.toHaveBeenCalled();
  });

  it('LLM-origin "regra" always lands in pending_review through KSM', async () => {
    const { persistCandidate } = await import('@/cognition/persister.js');
    const { CandidateType, CognitiveEventType } = await import(
      '@/types/enums.js'
    );

    const result = await persistCandidate(
      {
        type: CandidateType.REGRA,
        tipo: 'classificacao',
        contexto: 'transação acima de R$5000',
        acao: 'pedir aprovação',
      },
      {
        type: CognitiveEventType.USER_CORRECTION,
        conversa_id: 'conv-1',
        inbound_mensagem_id: 'msg-1',
        previous_assistant_mensagem_id: 'msg-0',
        correction_text: 'não',
        previous_response_text: 'foo',
      },
      'llm',
    );

    expect(result.persisted_to).toBe('ksm:pending_review');
    const row = ksmStore.get(result.id!)!;
    expect(row.lifecycle_status).toBe('pending_review');
    expect(rulesCreate).not.toHaveBeenCalled();
  });

  it('worker-origin candidate also routes through KSM', async () => {
    const { persistCandidate } = await import('@/cognition/persister.js');
    const { CandidateType, CognitiveEventType } = await import(
      '@/types/enums.js'
    );

    const result = await persistCandidate(
      {
        type: CandidateType.FATO,
        content: 'pattern detected fact',
        scope: 'agent',
      },
      {
        type: CognitiveEventType.PATTERN_DETECTED,
        pattern_descriptor: 'recurrent',
        evidence_count: 3,
        evidence_ids: ['e1', 'e2', 'e3'],
      },
      'worker',
    );

    expect(result.persisted_to).toMatch(/^ksm:/);
    const row = ksmStore.get(result.id!)!;
    expect(row.lifecycle_status).not.toBe('active');
    expect(factsUpsert).not.toHaveBeenCalled();
  });
});
