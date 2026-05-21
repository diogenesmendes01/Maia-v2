import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CognitiveEventType } from '@/types/enums.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

// Mock callLLM — controls what Reflector and Classifier "return" per scenario.
vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(),
}));

// Mock repos that Persister calls — verify routing without touching DB
vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    factsRepo: { ...actual.factsRepo, upsert: vi.fn(async () => ({ id: 'fact-id' } as any)) },
    rulesRepo: { ...actual.rulesRepo, create: vi.fn(async () => ({ id: 'rule-id' } as any)) },
    cognitiveCandidatesRepo: {
      create: vi.fn(async () => ({ id: 'cand-id' } as any)),
      listPending: vi.fn(async () => []),
      markConsumed: vi.fn(async () => {}),
    },
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

import { callLLM } from '@/lib/claude.js';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';

describe('P1 reflection expansion — 4 triggers integration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('SUCCESS_EXPLICIT → fato → factsRepo.upsert', async () => {
    (callLLM as any)
      .mockResolvedValueOnce({ content: 'cliente prefere comunicação direta' }) // reflector
      .mockResolvedValueOnce({ content: JSON.stringify({ type: 'fato', content: 'X', scope: 'agent' }) }); // classifier

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const event = {
        type: CognitiveEventType.SUCCESS_EXPLICIT,
        conversa_id: '00000000-0000-0000-0000-000000000001',
        inbound_mensagem_id: '00000000-0000-0000-0000-000000000002',
        signal: 'perfeito!',
        context_summary: '',
      } as const;
      const reflected = await reflect(event);
      expect(reflected).not.toBeNull();
      const classified = await classify(reflected!.insight);
      expect(classified?.type).toBe('fato');
      const result = await persistCandidate(classified!, event);
      // P2: persister classifies + writes to memory_entry alongside agent_facts.
      // Accept either return value depending on whether classifier produced an
      // entry (the legacy 'agent_facts' path stays valid for classifier no-ops).
      expect(['agent_facts', 'agent_facts+memory_entry']).toContain(result.persisted_to);
    });
  });

  it('CONVERSATION_CLOSED → procedimento → cognitive_candidates queue', async () => {
    (callLLM as any)
      .mockResolvedValueOnce({ content: 'procedure que emerge da conversa' })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          type: 'procedimento',
          nome: 'fechar conta',
          intencao: 'guiar cliente',
          passos_draft: ['confirmar identidade', 'pedir motivo'],
        }),
      });

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const event = {
        type: CognitiveEventType.CONVERSATION_CLOSED,
        conversa_id: '00000000-0000-0000-0000-000000000003',
        transcript: 'oi\nbom dia',
        summary: 'cliente fechou conta',
        duration_minutes: 15,
      } as const;
      const reflected = await reflect(event);
      const classified = await classify(reflected!.insight);
      expect(classified?.type).toBe('procedimento');
      const result = await persistCandidate(classified!, event);
      expect(result.persisted_to).toBe('cognitive_candidates');
    });
  });

  it('PATTERN_DETECTED → lacuna → cognitive_candidates queue', async () => {
    (callLLM as any)
      .mockResolvedValueOnce({ content: 'falta tool de consulta' })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          type: 'lacuna',
          capability_description: 'consultar X',
          tipo: 'tool',
          contexto: 'múltiplos clientes pediram',
        }),
      });

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const event = {
        type: CognitiveEventType.PATTERN_DETECTED,
        pattern_descriptor: 'consulta_externa|cliente perguntou',
        evidence_count: 5,
        evidence_ids: ['e1', 'e2'],
      } as const;
      const reflected = await reflect(event);
      const classified = await classify(reflected!.insight);
      expect(classified?.type).toBe('lacuna');
      const result = await persistCandidate(classified!, event);
      expect(result.persisted_to).toBe('cognitive_candidates');
    });
  });

  it('INTERNAL_GAP → tool_request → cognitive_candidates queue', async () => {
    (callLLM as any)
      .mockResolvedValueOnce({ content: 'precisaria tool nova' })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          type: 'tool_request',
          tool_name_sketch: 'consultar_estoque',
          description: 'verifica estoque por produto',
          inputs_sketch: 'produto_id',
          outputs_sketch: 'quantity',
        }),
      });

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const event = {
        type: CognitiveEventType.INTERNAL_GAP,
        conversa_id: '00000000-0000-0000-0000-000000000005',
        inbound_mensagem_id: '00000000-0000-0000-0000-000000000006',
        gap_description: 'não tenho como consultar',
        attempted_response: 'não tenho como consultar estoque agora',
      } as const;
      const reflected = await reflect(event);
      const classified = await classify(reflected!.insight);
      expect(classified?.type).toBe('tool_request');
      const result = await persistCandidate(classified!, event);
      expect(result.persisted_to).toBe('cognitive_candidates');
    });
  });

  it('DESCARTE → log only, sem persist', async () => {
    (callLLM as any)
      .mockResolvedValueOnce({ content: 'nada relevante' })
      .mockResolvedValueOnce({ content: JSON.stringify({ type: 'descarte', reason: 'noise' }) });

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const event = {
        type: CognitiveEventType.USER_CORRECTION,
        conversa_id: '00000000-0000-0000-0000-000000000007',
        inbound_mensagem_id: '00000000-0000-0000-0000-000000000008',
        previous_assistant_mensagem_id: '00000000-0000-0000-0000-000000000009',
        correction_text: 'ok',
        previous_response_text: '...',
      } as const;
      const reflected = await reflect(event);
      const classified = await classify(reflected!.insight);
      expect(classified?.type).toBe('descarte');
      const result = await persistCandidate(classified!, event);
      expect(result.persisted_to).toBe('log_only');
    });
  });
});
