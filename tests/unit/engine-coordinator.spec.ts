/**
 * P02 (spec §5.2, §5.9.2) — `MaiaOutputCoordinator`.
 *
 * ─── A regra que este arquivo prende ────────────────────────────────────────
 *
 * 1. [P2] O hook `onDelivered` é fire-and-forget, NUNCA bloqueia a entrega
 *    (§5.9.2.9). Throws síncronos e rejeições assíncronas precisam ser capturados
 *    sem que a função lance — o caller já tem o veredito de entrega e não pode
 *    perdê-lo por falha auxiliar.
 *
 * 2. [P2] Divergência com efeito cometido é um bloqueio de reconciliação, não um
 *    turno vazio. O motivo 'claim_divergence_blocked' propaga até decideTurnAction,
 *    que o reconhece como dead_letter/unsafe_to_retry quando sideEffectsCommitted=true.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  coordinateOutput,
  type OutputCoordinatorDepsV1,
  type OutputHostContextV1,
} from '@/runtime/engines/coordinator.js';
import { assembleTurnResult, type EngineToolReceiptV1 } from '@/runtime/engines/assembler.js';
import type { EngineStopV1 } from '@/runtime/engines/contracts.js';
import type { Conversa, Mensagem, Pessoa } from '@/db/schema.js';

const PESSOA: Pessoa = {
  id: '11111111-1111-4111-8111-111111111111',
  tenant_id: '00000000-0000-4000-8000-000000000000',
  telefone: '5511999999999',
  nome: 'Test User',
  apelido: null,
  gender: null,
  birthdate: null,
  email: null,
  cpf: null,
  external_id: null,
  status: 'active',
  created_at: new Date(),
  updated_at: new Date(),
};

const CONVERSA: Conversa = {
  id: '22222222-2222-4222-8222-222222222222',
  agent_id: '33333333-3333-4333-8333-333333333333',
  tenant_id: '00000000-0000-4000-8000-000000000000',
  pessoa_id: PESSOA.id,
  channel: 'whatsapp',
  channel_metadata: {},
  status: 'active',
  created_at: new Date(),
  updated_at: new Date(),
};

const INBOUND: Mensagem = {
  id: '44444444-4444-4444-8444-444444444444',
  conversa_id: CONVERSA.id,
  agent_id: CONVERSA.agent_id,
  tenant_id: CONVERSA.tenant_id,
  channel: 'whatsapp',
  jid_from: '5511999999999@s.whatsapp.net',
  jid_thread: null,
  direction: 'inbound',
  status: 'received',
  text: 'Qual é meu saldo?',
  media_type: null,
  media_url: null,
  ferramentas_chamadas: null,
  metadata: {},
  created_at: new Date(),
  read_at: null,
};

const HOST: OutputHostContextV1 = {
  pessoa: PESSOA,
  conversa: CONVERSA,
  inbound: INBOUND,
  jid: INBOUND.jid_from,
};

function receipt(
  over: Partial<EngineToolReceiptV1> & { call_id: string; ordinal: number },
): EngineToolReceiptV1 {
  return {
    tool_name: 'consultar_saldo',
    result: { ok: true },
    status: 'success',
    side_effect: 'read',
    sensitive: false,
    summary: {
      tool_call_id: over.call_id,
      tool_name: over.tool_name ?? 'consultar_saldo',
      status: 'success',
      side_effect: over.side_effect ?? 'read',
      result_summary: 'ok',
      occurred_at: new Date().toISOString(),
    },
    pending: null,
    report_pdf: null,
    ...over,
  };
}

describe('MaiaOutputCoordinator', () => {
  describe('[P2] onDelivered hook é fire-and-forget', () => {
    it('recupera de throw síncrono e retorna dispatched=true', async () => {
      const onDeliveredHook = vi.fn(() => {
        throw new Error('hook failed');
      });

      const assembled = assembleTurnResult({
        proposal: {
          version: 1,
          run_id: '11111111-1111-4111-8111-111111111111',
          request_key: '22222222-2222-4222-8222-222222222222',
          stop: { kind: 'reply', raw_text: 'Seu saldo é R$ 10,00.' } as EngineStopV1,
          iterations: 1,
          observed_tool_call_ids: [],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cost_microusd: '1500',
            source: 'provider_accounted' as const,
          },
        },
        receipts: [],
        outboundPrefix: null,
      });

      const deps: OutputCoordinatorDepsV1 = {
        dispatch: vi.fn(async () => ({ status: 'delivered' })),
        flushUnconfirmedToolSummaries: vi.fn(async () => {}),
        onDelivered: onDeliveredHook,
      };

      const result = await coordinateOutput(HOST, assembled, deps);

      expect(result.delivery.dispatched).toBe(true);
      expect(result.delivery.exitReason).toBe('empty_final_text');
      expect(onDeliveredHook).toHaveBeenCalled();
    });

    it('recupera de rejeição assíncronas e retorna dispatched=true', async () => {
      const onDeliveredHook = vi.fn(async () => {
        throw new Error('async hook failed');
      });

      const assembled = assembleTurnResult({
        proposal: {
          version: 1,
          run_id: '11111111-1111-4111-8111-111111111111',
          request_key: '22222222-2222-4222-8222-222222222222',
          stop: { kind: 'reply', raw_text: 'Seu saldo é R$ 10,00.' } as EngineStopV1,
          iterations: 1,
          observed_tool_call_ids: [],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cost_microusd: '1500',
            source: 'provider_accounted' as const,
          },
        },
        receipts: [],
        outboundPrefix: null,
      });

      const deps: OutputCoordinatorDepsV1 = {
        dispatch: vi.fn(async () => ({ status: 'delivered' })),
        flushUnconfirmedToolSummaries: vi.fn(async () => {}),
        onDelivered: onDeliveredHook,
      };

      const result = await coordinateOutput(HOST, assembled, deps);

      expect(result.delivery.dispatched).toBe(true);
      expect(result.delivery.exitReason).toBe('empty_final_text');
      expect(onDeliveredHook).toHaveBeenCalled();
    });
  });

  describe('[P2] Divergência com efeito é bloqueio de reconciliação', () => {
    it('retorna claim_divergence_blocked com sideEffectsCommitted=true', async () => {
      const assembled = assembleTurnResult({
        proposal: {
          version: 1,
          run_id: '11111111-1111-4111-8111-111111111111',
          request_key: '22222222-2222-4222-8222-222222222222',
          stop: { kind: 'reply', raw_text: 'Seu saldo é R$ 10,00.' } as EngineStopV1,
          iterations: 2,
          // Motor afirma ter chamado uma ferramenta
          observed_tool_call_ids: ['c1', 'fantasma'],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cost_microusd: '1500',
            source: 'provider_accounted' as const,
          },
        },
        // Mas só uma tem receipt (a outra é divergência)
        receipts: [receipt({ call_id: 'c1', ordinal: 0, side_effect: 'write' })],
        outboundPrefix: null,
      });

      const deps: OutputCoordinatorDepsV1 = {
        dispatch: vi.fn(),
        flushUnconfirmedToolSummaries: vi.fn(async () => {}),
      };

      const result = await coordinateOutput(HOST, assembled, deps);

      expect(result.delivery.dispatched).toBe(false);
      expect(result.delivery.exitReason).toBe('claim_divergence_blocked');
      expect(result.delivery.sideEffectsCommitted).toBe(true);
      // dispatch() nunca foi chamado porque divergência bloqueia antes
      expect(deps.dispatch).not.toHaveBeenCalled();
    });
  });
});
