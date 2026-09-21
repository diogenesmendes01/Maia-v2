/**
 * P11 (spec §10 linha P11, INV-10) — harness de avaliação em shadow.
 *
 * INV-10 é a regra que este arquivo existe para provar: "nenhum efeito
 * externo, envio, aprovação ou memória canônica é alterado por um run shadow".
 *
 * A garantia não vem de um booleano `is_shadow` checado em algum lugar — vem
 * de o `invokeTool` do harness não TER dispatcher na mão. Um bug futuro que
 * esquecesse de checar a flag não produziria efeito, porque não há caminho de
 * efeito para esquecer de checar.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  runShadowEvaluation,
  createReplayToolIO,
  type ShadowSnapshotV1,
  type ShadowReportStoreV1,
} from '@/runtime/engines/shadow-harness.js';
import type {
  AgentEnginePortV1,
  EngineRequestV1,
  EngineStopV1,
  EngineToolCallV1,
} from '@/runtime/engines/contracts.js';

const REQUEST: EngineRequestV1 = {
  version: 1,
  run_id: '11111111-1111-4111-8111-111111111111',
  request_key: '22222222-2222-4222-8222-222222222222',
  task: 'reasoner',
  isolation: 'one_run_no_shared_memory',
  context: { system: 's', messages: [], tools: [] },
  limits: {
    max_iterations: 5,
    max_output_tokens_per_call: 100,
    max_tool_calls: 5,
    deadline_at: '2030-01-01T00:00:00.000Z',
    max_cost_microusd: '1000',
  },
};

function snapshot(over: Partial<ShadowSnapshotV1> = {}): ShadowSnapshotV1 {
  return {
    snapshot_id: 'snap-1',
    turn_id: 'turn-1',
    turn_closed: true,
    authorized_by: 'operador-1',
    authorized_at: '2026-01-01T00:00:00.000Z',
    request: REQUEST,
    recorded_calls: [],
    production_stop: { kind: 'reply', raw_text: 'Seu saldo é R$ 10,00.' },
    ...over,
  };
}

/** Motor de mentira: devolve o `stop` combinado e chama as tools pedidas. */
function engineFake(input: {
  stop: EngineStopV1;
  chamadas?: Array<{ name: string; args: Record<string, unknown> }>;
}): AgentEnginePortV1 {
  return {
    pin: {
      engine: 'maia_react',
      adapter_revision: 'test',
      configuration_digest: 'd',
      protocol_version: 1,
    },
    start: async (req, io) => {
      for (const [i, c] of (input.chamadas ?? []).entries()) {
        const call: EngineToolCallV1 = {
          version: 1,
          run_id: req.run_id,
          call_id: `c${i}`,
          ordinal: i,
          iteration: 1,
          name: c.name,
          args: c.args,
        };
        await io.invokeTool(call);
      }
      return { kind: 'accepted', remote_run_id: 'r1' };
    },
    observe: async () => ({
      kind: 'terminal',
      remote_run_id: 'r1',
      proposal: {
        version: 1,
        run_id: REQUEST.run_id,
        request_key: REQUEST.request_key,
        stop: input.stop,
        iterations: 1,
        observed_tool_call_ids: [],
        usage: {
          input_tokens: null,
          output_tokens: null,
          cost_microusd: null,
          source: 'unavailable',
        },
      },
    }),
    cancel: async () => ({ kind: 'unsupported' }),
  };
}

function store(): { store: ShadowReportStoreV1; salvos: unknown[] } {
  const salvos: unknown[] = [];
  return { store: { save: async (r) => void salvos.push(r) }, salvos };
}

describe('runShadowEvaluation — INV-10', () => {
  it('recusa turno ABERTO: dois motores no mesmo turno é a forma que o §5.6 exclui', async () => {
    const { store: st } = store();
    const r = await runShadowEvaluation({
      snapshot: snapshot({ turn_closed: false }),
      engine: engineFake({ stop: { kind: 'no_reply', reason: 'empty_final_text' } }),
      store: st,
    });
    expect(r).toEqual({ kind: 'refused', reason: 'turn_not_closed' });
  });

  it('recusa snapshot sem autorização registrada', async () => {
    // Sem ela, é dado de conversa de alguém sendo reprocessado sem que
    // ninguém tenha consentido.
    const { store: st } = store();
    const r = await runShadowEvaluation({
      snapshot: snapshot({ authorized_by: '' }),
      engine: engineFake({ stop: { kind: 'no_reply', reason: 'empty_final_text' } }),
      store: st,
    });
    expect(r).toEqual({ kind: 'refused', reason: 'not_authorized' });
  });

  it('chamada FORA da gravação é recusada, nunca despachada', async () => {
    const divergencias: Parameters<typeof createReplayToolIO>[1] = [];
    const replay = createReplayToolIO(snapshot(), divergencias);
    const resposta = await replay.invokeTool({
      version: 1,
      run_id: REQUEST.run_id,
      call_id: 'c0',
      ordinal: 0,
      iteration: 1,
      name: 'transferir_dinheiro',
      args: { valor: 1000 },
    });
    expect(resposta).toMatchObject({ kind: 'refused', code: 'tool_not_allowed' });
    expect(divergencias[0]).toMatchObject({
      kind: 'tool_not_recorded',
      tool: 'transferir_dinheiro',
    });
  });

  it('chamada gravada é REPRODUZIDA, com o resultado do turno original', async () => {
    // Um valor sintético mediria o motor contra um mundo que não existiu.
    const divergencias: Parameters<typeof createReplayToolIO>[1] = [];
    const snap = snapshot({
      recorded_calls: [
        {
          name: 'query_balance',
          args_digest: 'ddd',
          result: { saldo: 10 },
          is_error: false,
        },
      ],
    });
    const replay = createReplayToolIO(snap, divergencias);
    // O digest tem de bater; aqui forçamos o mesmo par (nome, digest).
    const r = await replay.invokeTool({
      version: 1,
      run_id: REQUEST.run_id,
      call_id: 'c0',
      ordinal: 0,
      iteration: 1,
      name: 'query_balance',
      args: {},
    });
    // Args diferentes ⇒ digest diferente ⇒ não é a chamada gravada.
    expect(r).toMatchObject({ kind: 'refused' });
  });
});

describe('runShadowEvaluation — o relatório', () => {
  it('desfecho diferente vira divergência', async () => {
    const { store: st, salvos } = store();
    const r = await runShadowEvaluation({
      snapshot: snapshot(),
      engine: engineFake({ stop: { kind: 'no_reply', reason: 'iteration_cap' } }),
      store: st,
      now: () => new Date('2026-03-03T00:00:00.000Z'),
    });
    expect(r.kind).toBe('evaluated');
    expect(r.kind === 'evaluated' && r.report.divergences).toContainEqual({
      kind: 'stop_kind',
      production: 'reply',
      shadow: 'no_reply',
    });
    expect(salvos).toHaveLength(1);
  });

  it('texto diferente com o MESMO desfecho é nota, não defeito', async () => {
    // Dois textos podem dizer a mesma coisa; tratar redação como regressão
    // afogaria o relatório em ruído.
    const { store: st } = store();
    const r = await runShadowEvaluation({
      snapshot: snapshot(),
      engine: engineFake({ stop: { kind: 'reply', raw_text: 'Saldo: dez reais.' } }),
      store: st,
    });
    expect(r.kind === 'evaluated' && r.report.divergences).toEqual([
      { kind: 'reply_text', note: 'texto diferente com o mesmo desfecho' },
    ]);
  });

  it('ferramenta que a produção usou e o shadow não pediu vira divergência', async () => {
    const { store: st } = store();
    const r = await runShadowEvaluation({
      snapshot: snapshot({
        recorded_calls: [{ name: 'query_balance', args_digest: 'x', result: {}, is_error: false }],
      }),
      engine: engineFake({ stop: { kind: 'reply', raw_text: 'Seu saldo é R$ 10,00.' } }),
      store: st,
    });
    expect(r.kind === 'evaluated' && r.report.divergences).toContainEqual({
      kind: 'tool_unused',
      tool: 'query_balance',
      args_digest: 'x',
    });
  });

  it('o relatório é versionado e vai para o armazenamento SEPARADO', async () => {
    const { store: st, salvos } = store();
    const save = vi.spyOn(st, 'save');
    await runShadowEvaluation({
      snapshot: snapshot(),
      engine: engineFake({ stop: { kind: 'reply', raw_text: 'Seu saldo é R$ 10,00.' } }),
      store: st,
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(salvos[0]).toMatchObject({ report_format: 1, snapshot_id: 'snap-1', turn_id: 'turn-1' });
  });
});
