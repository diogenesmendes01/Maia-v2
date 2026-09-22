/**
 * PR #775 finding 1 — indexação VINCULADA para itens novos.
 *
 * `persistCandidate`'s legacy 'fato' branch (origin 'user'/'admin') creates
 * the canonical `memory_entry` row via `memoryEntryRepo.create` and, since
 * this fix, immediately vectorizes it via `writeMemory({ memory_entry_id })`
 * — the ONE call site in `src/` where the canonical item is already known at
 * indexing time (see `src/cognition/persister.ts`, right after
 * `memoryEntryId = memEntry.id`).
 *
 * Without `memory_entry_id` on the INSERT, `recallAuthorized`'s JOIN fence
 * (src/memory/recall-authorized.ts) makes the vector permanently ineligible
 * — this spec pins that the id flows from `memoryEntryRepo.create`'s
 * `.returning()` straight into `writeMemory`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeMemoryMock = vi.fn().mockResolvedValue({ id: 'vec-1' });
vi.mock('@/memory/vector.js', () => ({
  writeMemory: writeMemoryMock,
}));

const memoryEntryCreate = vi.fn().mockResolvedValue({ id: 'mem-entry-1' });
const factsUpsert = vi.fn().mockResolvedValue({ id: 'legacy-fact-id' });
vi.mock('@/db/repositories.js', async () => {
  const actual =
    await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    factsRepo: { upsert: factsUpsert },
    rulesRepo: { create: vi.fn() },
    cognitiveCandidatesRepo: { create: vi.fn() },
    memoryEntryRepo: { create: memoryEntryCreate },
    behavioralHintRepo: { create: vi.fn() },
    capabilityGapsRepo: { upsert: vi.fn() },
  };
});

vi.mock('@/cognition/memory-classifier.js', () => ({
  classifyMemory: vi.fn().mockResolvedValue({
    memory_type: 'operational',
    scope_type: 'agent',
    sensitivity: 'low',
    proactive_use: true,
    mention_allowed: true,
    ttl_days: null,
  }),
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
  writeMemoryMock.mockClear();
  memoryEntryCreate.mockClear();
  factsUpsert.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('persistCandidate — fato legacy branch links the vector to the memory_entry it just created', () => {
  it('writeMemory is called with memory_entry_id === the id returned by memoryEntryRepo.create', async () => {
    const { persistCandidate } = await import('@/cognition/persister.js');
    const { CandidateType, CognitiveEventType } = await import('@/types/enums.js');

    const result = await persistCandidate(
      {
        type: CandidateType.FATO,
        content: 'usuário prefere respostas curtas',
        scope: 'agent',
        subject_id: 'ent-1',
      },
      {
        type: CognitiveEventType.USER_CORRECTION,
        conversa_id: 'conv-1',
        inbound_mensagem_id: 'msg-1',
        previous_assistant_mensagem_id: 'msg-0',
        correction_text: 'prefiro direto',
        previous_response_text: 'foo',
      },
      'admin',
    );

    expect(result.persisted_to).toBe('agent_facts+memory_entry');
    expect(memoryEntryCreate).toHaveBeenCalledTimes(1);
    expect(writeMemoryMock).toHaveBeenCalledTimes(1);
    const call = writeMemoryMock.mock.calls[0]![0] as { memory_entry_id?: string; conteudo: string };
    expect(call.memory_entry_id).toBe('mem-entry-1');
    expect(call.conteudo).toBe('usuário prefere respostas curtas');
  });

  it('a writeMemory failure does not roll back or fail the already-created memory_entry', async () => {
    writeMemoryMock.mockRejectedValueOnce(new Error('embedding_generation_failed'));
    const { persistCandidate } = await import('@/cognition/persister.js');
    const { CandidateType, CognitiveEventType } = await import('@/types/enums.js');

    const result = await persistCandidate(
      {
        type: CandidateType.FATO,
        content: 'outro fato',
        scope: 'agent',
      },
      {
        type: CognitiveEventType.USER_CORRECTION,
        conversa_id: 'conv-1',
        inbound_mensagem_id: 'msg-1',
        previous_assistant_mensagem_id: 'msg-0',
        correction_text: 'não',
        previous_response_text: 'foo',
      },
      'admin',
    );

    // memory_entry was created before the (failing) vector write, and the
    // failure is caught locally — the caller still sees the successful path.
    expect(result.persisted_to).toBe('agent_facts+memory_entry');
  });
});
