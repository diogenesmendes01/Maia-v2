/**
 * P05 (spec §5.2, §6.9.1) — `EngineToolGateway`.
 *
 * A regra que estes casos prendem: **o handler só roda depois da releitura do
 * banco**. O `admit` do broker é estático e diz apenas que nenhuma regra de
 * catálogo barra; tudo que muda com o tempo — lease, ordem, idempotência,
 * efeito — é relido aqui. Um caminho que chegue ao `dispatch` sem passar por
 * essa releitura é a falha que o módulo inteiro existe para impedir.
 *
 * O segundo grupo cobre os desfechos em que o efeito é INCERTO. Eles importam
 * mais que os de sucesso: é neles que um `failed` no lugar de `effect_unknown`
 * autoriza um retry que duplica um boleto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEngineToolGateway } from '@/integrations/hermes/tool-gateway.js';
import type { ToolGatewayDepsV1 } from '@/integrations/hermes/tool-gateway.js';
import type { EngineToolCallV1 } from '@/runtime/engines/contracts.js';
import type { ToolClassification } from '@/db/repositories/engine-repos.js';

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const IDENT = {
  run_id: 'run-1',
  turn_id: 'turn-1',
  origin_claim_token: 'tok-1',
  request_id: 'req-1',
};

const CHAMADA: EngineToolCallV1 = {
  version: 1,
  run_id: 'run-1',
  call_id: 'c1',
  ordinal: 0,
  iteration: 1,
  name: 'consultar_saldo',
  args: { conta: 'x' },
};

const CLASSIFICACAO: ToolClassification = {
  side_effect: 'read',
  effect_class: 'read_only',
  sensitive: false,
  legacy_irreversible_invoked: false,
};

const TOOL = { name: 'consultar_saldo', input_schema: {}, result_limit_chars: 1000 };

function deps(over: Partial<ToolGatewayDepsV1> = {}): ToolGatewayDepsV1 {
  return {
    decide: vi.fn(() => ({ kind: 'admit' as const, tool: TOOL as never })),
    admit: vi.fn(async () => ({
      ok: true as const,
      kind: 'admitted' as const,
      call_id: 'c1',
      ordinal: 0,
    })),
    markDispatching: vi.fn(async () => ({
      ok: true as const,
      dispatch_token: 'dt-1',
      row_version: 1,
    })),
    freezeToolIdentity: vi.fn(async () => ({
      ok: true as const,
      frozen: true,
    })),
    markToolHandlerStarted: vi.fn(async () => ({
      ok: true as const,
      effect_evidence: 'none' as const,
      row_version: 2,
    })),
    settle: vi.fn(async () => ({ ok: true as const })),
    dispatch: vi.fn(async () => ({ saldo: 10 })),
    buildToolContext: vi.fn(async () => ({}) as never),
    classify: vi.fn(() => CLASSIFICACAO),
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('EngineToolGateway — compatibilidade de contrato', () => {
  it('sonda: settle deve aceitar ToolSettlement com os desfechos corretos', async () => {
    // Falha o build se os deps divergirem do repositório real.
    // Esta sonda força o compilador a provar o alinhamento.
    const d = deps();
    const settle = d.settle;

    // Chamadas que precisam compilar corretamente:
    await settle({
      run_id: 'r1',
      turn_id: 't1',
      origin_claim_token: 'tok',
      call_id: 'c1',
      expected_row_version: 2,
      dispatch_token: 'dt',
      outcome: { kind: 'completed', result: { ok: true }, receipt: null },
    });

    await settle({
      run_id: 'r1',
      turn_id: 't1',
      origin_claim_token: 'tok',
      call_id: 'c1',
      expected_row_version: 2,
      dispatch_token: 'dt',
      outcome: { kind: 'denied', result: { error: 'test' } },
    });

    await settle({
      run_id: 'r1',
      turn_id: 't1',
      origin_claim_token: 'tok',
      call_id: 'c1',
      expected_row_version: 2,
      dispatch_token: 'dt',
      outcome: { kind: 'effect_unknown', result: null },
    });

    expect(settle).toHaveBeenCalled();
  });
});

describe('EngineToolGateway — o handler só roda depois da releitura', () => {
  it('caminho feliz: decide, admite, congela, congela identidade, marca handler, despacha e liquida', async () => {
    const d = deps();
    const invoke = createEngineToolGateway(IDENT, d);
    const r = await invoke(CHAMADA);

    expect(r).toEqual({ kind: 'result', call_id: 'c1', result: { saldo: 10 }, is_error: false });

    // Verifica a sequência correta de chamadas
    expect(d.markDispatching).toHaveBeenCalledBefore(d.freezeToolIdentity as never);
    expect(d.freezeToolIdentity).toHaveBeenCalledBefore(d.markToolHandlerStarted as never);
    expect(d.markToolHandlerStarted).toHaveBeenCalledBefore(d.dispatch as never);
    expect(d.dispatch).toHaveBeenCalledBefore(d.settle as never);

    // Verifica que settle foi chamado com row_version do markToolHandlerStarted
    expect(d.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatch_token: 'dt-1',
        expected_row_version: 2,
        outcome: expect.objectContaining({ kind: 'completed', receipt: null }),
      }),
    );
  });

  it('recusa estática do broker não toca o banco nem o handler', async () => {
    const d = deps({
      decide: vi.fn(() => ({
        kind: 'refuse' as const,
        reason: 'binding_mismatch' as never,
        wire: 'run_not_authorized' as const,
        detail: '',
      })),
    });
    const r = await createEngineToolGateway(IDENT, d)(CHAMADA);
    expect(r).toEqual({ kind: 'refused', call_id: 'c1', code: 'run_not_authorized' });
    expect(d.admit).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('redelivery com vencedor em voo NÃO reexecuta o handler', async () => {
    const d = deps({
      admit: vi.fn(async () => ({
        ok: true as const,
        kind: 'in_progress' as const,
        call_id: 'c1',
      })),
    });
    const r = await createEngineToolGateway(IDENT, d)(CHAMADA);
    expect(r.kind).toBe('in_progress');
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('chamada já conciliada devolve o resultado PERSISTIDO, sem reexecutar', async () => {
    const d = deps({
      admit: vi.fn(async () => ({
        ok: true as const,
        kind: 'receipt' as const,
        call_id: 'c1',
        state: 'completed' as const,
        result: { saldo: 99 },
      })),
    });
    const r = await createEngineToolGateway(IDENT, d)(CHAMADA);
    expect(r).toEqual({ kind: 'result', call_id: 'c1', result: { saldo: 99 }, is_error: false });
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('conflito de payload vira `payload_conflict`; os outros viram `run_not_authorized`', async () => {
    const conflito = deps({
      admit: vi.fn(async () => ({
        ok: false as const,
        reason: 'payload_conflict' as const,
        current_args_hash: 'h',
      })),
    });
    expect((await createEngineToolGateway(IDENT, conflito)(CHAMADA)).kind).toBe('refused');
    expect(await createEngineToolGateway(IDENT, conflito)(CHAMADA)).toMatchObject({
      code: 'payload_conflict',
    });

    const fora = deps({
      admit: vi.fn(async () => ({
        ok: false as const,
        reason: 'ordinal_out_of_order' as const,
        expected_ordinal: 3,
      })),
    });
    expect(await createEngineToolGateway(IDENT, fora)(CHAMADA)).toMatchObject({
      code: 'run_not_authorized',
    });
  });

  it('tool sem classificação de efeito NÃO chega ao handler', async () => {
    // `effect_class: null` nunca autoriza handler (§4.1): efeito que ninguém
    // sabe descrever é efeito desconhecido.
    const d = deps({ classify: vi.fn(() => null) });
    const r = await createEngineToolGateway(IDENT, d)(CHAMADA);
    expect(r).toMatchObject({ code: 'tool_not_allowed' });
    expect(d.dispatch).not.toHaveBeenCalled();
  });
});

describe('EngineToolGateway — efeito incerto nunca vira retry seguro', () => {
  it('handler que LANÇA liquida como effect_unknown, não como denied', async () => {
    const d = deps({
      dispatch: vi.fn(async () => {
        throw new Error('timeout no banco externo');
      }),
    });
    const r = await createEngineToolGateway(IDENT, d)(CHAMADA);

    expect(r).toMatchObject({ code: 'effect_unknown' });
    expect(d.settle).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: 'effect_unknown', result: null } }),
    );
  });

  it('liquidação que falha DEPOIS do efeito devolve effect_unknown', async () => {
    // O handler rodou, o efeito existe no mundo e o journal não registrou.
    // Devolver o resultado faria o motor seguir em cima de algo que a Maia não
    // consegue provar depois de um crash.
    const d = deps({
      settle: vi.fn(async () => ({ ok: false as const, reason: 'version_conflict' })),
    });
    const r = await createEngineToolGateway(IDENT, d)(CHAMADA);
    expect(r).toMatchObject({ code: 'effect_unknown' });
  });

  it('erro do handler (sem exceção) é resultado com is_error, não incerteza', async () => {
    const d = deps({ dispatch: vi.fn(async () => ({ error: 'conta inexistente' })) });
    const r = await createEngineToolGateway(IDENT, d)(CHAMADA);
    expect(r).toMatchObject({ kind: 'result', is_error: true });
    expect(d.settle).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ kind: 'denied' }) }),
    );
  });

  it('defer vira in_progress: o wire não sabe dizer "esperando aprovação"', async () => {
    const d = deps({
      decide: vi.fn(() => ({
        kind: 'defer' as const,
        reason: 'approval_required' as const,
        tool: TOOL as never,
      })),
    });
    const r = await createEngineToolGateway(IDENT, d)(CHAMADA);
    expect(r).toMatchObject({ kind: 'in_progress' });
    expect(d.admit).not.toHaveBeenCalled();
  });

  it('falha ao congelar identidade recusa a chamada', async () => {
    const d = deps({
      freezeToolIdentity: vi.fn(async () => ({
        ok: false as const,
        reason: 'state_conflict' as const,
        current_state: 'completed',
      })),
    });
    const r = await createEngineToolGateway(IDENT, d)(CHAMADA);
    expect(r).toMatchObject({ kind: 'refused', code: 'run_not_authorized' });
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it('falha ao marcar handler recusa a chamada', async () => {
    const d = deps({
      markToolHandlerStarted: vi.fn(async () => ({
        ok: false as const,
        reason: 'capabilities_revoked' as const,
      })),
    });
    const r = await createEngineToolGateway(IDENT, d)(CHAMADA);
    expect(r).toMatchObject({ kind: 'refused', code: 'run_not_authorized' });
    expect(d.dispatch).not.toHaveBeenCalled();
  });
});
