/**
 * P02.1 (spec §5.2, §5.3.1, §5.4.2) — `MaiaEngine`: o motor LOCAL atrás da porta.
 *
 * ─── Por que o motor local também passa pela porta ──────────────────────────
 *
 * Porque a porta não existe para o Hermes: existe para que "quem decide o
 * desfecho do turno" deixe de ser "o que a função retornou". O motor local é o
 * primeiro cliente dela e o que prova que ela não foi desenhada em volta de um
 * motor remoto — se `AgentEnginePortV1` só servisse ao Hermes, a extração teria
 * trocado um acoplamento por outro.
 *
 * ─── As quatro regras que este arquivo prende ───────────────────────────────
 *
 * 1. **O motor propõe, não entrega.** `start` devolve aceite; a proposta
 *    terminal traz `stop`, iterações, ids observados e uso — e NADA sobre
 *    despacho, efeito comitado ou outbound (§5.3.3). Quem decide isso é o
 *    coordenador de saída da Maia, com o journal na mão.
 * 2. **O adapter local não finge memória que não tem.** Depois de reiniciar o
 *    processo, `observe` de um run desconhecido é `not_found/inconclusive` —
 *    NUNCA `definitely_not_accepted` (§5.3.1). Prova de não-aceite exige
 *    garantia; ausência de registro não é prova.
 * 3. **Cancelar é pedir, não desfazer.** `cancel` devolve `requested`; um run já
 *    terminal devolve `already_terminal`; e nenhum dos dois afirma ausência de
 *    efeito (§5.3.1, INV-06).
 * 4. **Perda de posse precede tudo.** Ela não vira um `stop` — propaga, e a
 *    tentativa velha não conclui nem agenda retry (§5.4.2 item 1).
 */
import { describe, it, expect, vi } from 'vitest';
import { createMaiaEngine } from '@/runtime/engines/maia-engine.js';
import {
  engineTerminalProposalV1Schema,
  engineStartResultV1Schema,
  engineObservationV1Schema,
} from '@/runtime/engines/schemas.js';
import type {
  EngineRequestV1,
  EngineIOV1,
  EngineRunLocatorV1,
  EngineToolCallV1,
} from '@/runtime/engines/contracts.js';
import { TurnOwnershipLostError } from '@/runtime/turns/execution-context.js';

const RUN = '3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70';
const KEY = '8a1e2c3d-4b5a-4c7d-8e9f-0a1b2c3d4e5f';

function mkRequest(over: Partial<EngineRequestV1> = {}): EngineRequestV1 {
  return {
    version: 1,
    run_id: RUN,
    request_key: KEY,
    task: 'reasoner',
    isolation: 'one_run_no_shared_memory',
    context: {
      system: 'instruções aprovadas',
      messages: [{ role: 'user', content: '<user_message>oi</user_message>' }],
      tools: [],
    },
    limits: {
      max_iterations: 5,
      max_output_tokens_per_call: 1024,
      max_tool_calls: 4,
      deadline_at: '2026-09-15T23:00:00.000Z',
      max_cost_microusd: '250000',
    },
    ...over,
  };
}

function mkIo(over: Partial<EngineIOV1> = {}): EngineIOV1 {
  return {
    signal: new AbortController().signal,
    invokeTool: vi.fn(async (call: EngineToolCallV1) => ({
      kind: 'result' as const,
      call_id: call.call_id,
      result: { ok: true },
      is_error: false,
    })),
    ...over,
  };
}

function locatorOf(run_id = RUN, remote_run_id: string | null = null): EngineRunLocatorV1 {
  return { run_id, request_key: KEY, remote_instance_id: 'local', remote_run_id };
}

/** Raciocínio de mentira: devolve o desfecho que o caso quer, sem LLM. */
function reasoningQueDevolve(
  resultado: Parameters<Parameters<typeof createMaiaEngine>[0]['runReasoning']>[0] extends never
    ? never
    : Awaited<ReturnType<Parameters<typeof createMaiaEngine>[0]['runReasoning']>>,
): Parameters<typeof createMaiaEngine>[0]['runReasoning'] {
  return vi.fn(async () => resultado);
}

const TERMINAL_SIMPLES = {
  stop: { kind: 'reply' as const, raw_text: 'resposta candidata' },
  iterations: 1,
  observed_tool_call_ids: [] as string[],
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cost_microusd: null,
    source: 'engine_reported' as const,
  },
};

describe('MaiaEngine — identidade da porta', () => {
  it('o pin declara o motor canônico, não um rótulo de UI', () => {
    const engine = createMaiaEngine({
      runReasoning: reasoningQueDevolve(TERMINAL_SIMPLES),
      adapterRevision: 'maia-engine-0.1.0',
      configurationDigest: 'c'.repeat(64),
    });
    expect(engine.pin).toEqual({
      engine: 'maia_react',
      adapter_revision: 'maia-engine-0.1.0',
      configuration_digest: 'c'.repeat(64),
      protocol_version: 1,
    });
  });
});

describe('MaiaEngine — start e proposta terminal', () => {
  it('aceita o trabalho e devolve um handle local válido pelo schema', async () => {
    const engine = createMaiaEngine({ runReasoning: reasoningQueDevolve(TERMINAL_SIMPLES) });

    const r = await engine.start(mkRequest(), mkIo());

    expect(engineStartResultV1Schema.safeParse(r).success).toBe(true);
    expect(r.kind).toBe('accepted');
  });

  it('a proposta observada valida no schema e NÃO fala de entrega nem de efeito', async () => {
    const engine = createMaiaEngine({ runReasoning: reasoningQueDevolve(TERMINAL_SIMPLES) });
    const start = await engine.start(mkRequest(), mkIo());
    const remote = start.kind === 'accepted' ? start.remote_run_id : '';

    const obs = await engine.observe(locatorOf(RUN, remote), new AbortController().signal);

    expect(engineObservationV1Schema.safeParse(obs).success).toBe(true);
    expect(obs.kind).toBe('terminal');
    if (obs.kind !== 'terminal') return;
    expect(engineTerminalProposalV1Schema.safeParse(obs.proposal).success).toBe(true);
    expect(obs.proposal.run_id).toBe(RUN);
    expect(obs.proposal.request_key).toBe(KEY);
    expect(obs.proposal.stop).toEqual({ kind: 'reply', raw_text: 'resposta candidata' });
    // As chaves são EXATAMENTE as do contrato: nada de `dispatched`,
    // `sideEffectsCommitted`, `delivery` ou lista de efeitos.
    expect(Object.keys(obs.proposal).sort()).toEqual([
      'iterations',
      'observed_tool_call_ids',
      'request_key',
      'run_id',
      'stop',
      'usage',
      'version',
    ]);
  });

  it('repetir o start com a MESMA request_key devolve o mesmo handle, sem raciocinar de novo', async () => {
    // §5.6.1: `request_key` é a identidade do start. Reenviar não cria segunda
    // deliberação — é isso que impede um ACK perdido virar dois turnos pagos.
    const runReasoning = reasoningQueDevolve(TERMINAL_SIMPLES);
    const engine = createMaiaEngine({ runReasoning });

    const a = await engine.start(mkRequest(), mkIo());
    const b = await engine.start(mkRequest(), mkIo());

    expect(a).toEqual(b);
    expect(runReasoning).toHaveBeenCalledTimes(1);
  });

  it('mesma request_key com pedido DIFERENTE é conflito, não segunda execução', async () => {
    const runReasoning = reasoningQueDevolve(TERMINAL_SIMPLES);
    const engine = createMaiaEngine({ runReasoning });
    await engine.start(mkRequest(), mkIo());

    const conflito = await engine.start(
      mkRequest({ context: { system: 'OUTRO', messages: [{ role: 'user', content: 'x' }], tools: [] } }),
      mkIo(),
    );

    expect(conflito.kind).toBe('rejected');
    if (conflito.kind !== 'rejected') return;
    expect(conflito.definitely_not_accepted).toBe(true);
    expect(conflito.code).toBe('request_key_payload_conflict');
    expect(runReasoning).toHaveBeenCalledTimes(1);
  });

  it('as ferramentas passam pelo io.invokeTool com call_id derivado e ordinal a partir de zero', async () => {
    // §4.1: `call_seq` começa em zero, `call_id = run_id:call_seq`, e o motor
    // não escolhe nenhum dos dois.
    const io = mkIo();
    const engine = createMaiaEngine({
      runReasoning: vi.fn(async (_req, ioLocal) => {
        await ioLocal.invokeTool({
          version: 1,
          run_id: RUN,
          call_id: `${RUN}:0`,
          ordinal: 0,
          iteration: null,
          name: 'fixture_echo',
          args: { texto: 'oi' },
        });
        return { ...TERMINAL_SIMPLES, observed_tool_call_ids: [`${RUN}:0`] };
      }),
    });

    await engine.start(mkRequest(), io);

    const chamada = (io.invokeTool as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as EngineToolCallV1;
    expect(chamada.call_id).toBe(`${RUN}:0`);
    expect(chamada.ordinal).toBe(0);
    expect(chamada.iteration).toBeNull();
  });
});

describe('MaiaEngine — observe não inventa memória', () => {
  it('run desconhecido é not_found/INCONCLUSIVE, nunca prova de não-aceite', async () => {
    // §5.3.1: "após reinício não pode fingir reencontrar uma Promise:
    // `inconclusive`". Um `definitely_not_accepted` aqui autorizaria o
    // supervisor a recomeçar um turno que pode ter rodado.
    const engine = createMaiaEngine({ runReasoning: reasoningQueDevolve(TERMINAL_SIMPLES) });

    const obs = await engine.observe(
      locatorOf('11111111-2222-4333-8444-555555555555'),
      new AbortController().signal,
    );

    expect(obs).toEqual({ kind: 'not_found', proof: 'inconclusive' });
  });

  it('um motor novo (processo reiniciado) não reencontra o run do motor anterior', async () => {
    const primeiro = createMaiaEngine({ runReasoning: reasoningQueDevolve(TERMINAL_SIMPLES) });
    const start = await primeiro.start(mkRequest(), mkIo());
    const remote = start.kind === 'accepted' ? start.remote_run_id : '';

    const segundo = createMaiaEngine({ runReasoning: reasoningQueDevolve(TERMINAL_SIMPLES) });
    const obs = await segundo.observe(locatorOf(RUN, remote), new AbortController().signal);

    expect(obs).toEqual({ kind: 'not_found', proof: 'inconclusive' });
  });
});

describe('MaiaEngine — desfechos e falhas', () => {
  it.each([
    ['no_reply/empty_final_text', { kind: 'no_reply', reason: 'empty_final_text' }],
    ['no_reply/iteration_cap', { kind: 'no_reply', reason: 'iteration_cap' }],
    ['failed/reasoner_failed', { kind: 'failed', code: 'reasoner_failed' }],
  ])('%s vira proposta terminal válida', async (_nome, stop) => {
    const engine = createMaiaEngine({
      runReasoning: reasoningQueDevolve({
        ...TERMINAL_SIMPLES,
        stop: stop as never,
      }),
    });
    const start = await engine.start(mkRequest(), mkIo());
    const remote = start.kind === 'accepted' ? start.remote_run_id : '';

    const obs = await engine.observe(locatorOf(RUN, remote), new AbortController().signal);

    expect(obs.kind).toBe('terminal');
    if (obs.kind !== 'terminal') return;
    expect(engineTerminalProposalV1Schema.safeParse(obs.proposal).success).toBe(true);
    expect(obs.proposal.stop).toEqual(stop);
  });

  it('perda de posse PROPAGA — não vira `stop` nem proposta', async () => {
    // §5.4.2 item 1: a perda de posse precede tudo. Transformá-la num desfecho
    // faria a tentativa velha "concluir" um turno que não é mais dela.
    const engine = createMaiaEngine({
      runReasoning: vi.fn(async () => {
        throw new TurnOwnershipLostError('react_iteration', 'turn-1');
      }),
    });

    await expect(engine.start(mkRequest(), mkIo())).rejects.toBeInstanceOf(TurnOwnershipLostError);

    const obs = await engine.observe(locatorOf(), new AbortController().signal);
    expect(obs).toEqual({ kind: 'not_found', proof: 'inconclusive' });
  });

  it('erro inesperado do raciocínio vira `failed/reasoner_failed` observável, sem derrubar o supervisor', async () => {
    const engine = createMaiaEngine({
      runReasoning: vi.fn(async () => {
        throw new Error('provider fora do ar');
      }),
    });

    const start = await engine.start(mkRequest(), mkIo());
    expect(start.kind).toBe('accepted');
    const remote = start.kind === 'accepted' ? start.remote_run_id : '';

    const obs = await engine.observe(locatorOf(RUN, remote), new AbortController().signal);
    expect(obs.kind).toBe('terminal');
    if (obs.kind !== 'terminal') return;
    expect(obs.proposal.stop).toEqual({ kind: 'failed', code: 'reasoner_failed' });
    // Sem uso conhecido: `null`, nunca zero fabricado (§5.3.4).
    expect(obs.proposal.usage).toEqual({
      input_tokens: null,
      output_tokens: null,
      cost_microusd: null,
      source: 'unavailable',
    });
  });
});

describe('MaiaEngine — cancelamento pede, não desfaz', () => {
  it('run em voo: cancel devolve `requested` e aborta o sinal entregue ao raciocínio', async () => {
    let sinalDoRaciocinio: AbortSignal | undefined;
    let liberar: (() => void) | undefined;
    const engine = createMaiaEngine({
      runReasoning: vi.fn(async (_req, io) => {
        sinalDoRaciocinio = io.signal;
        await new Promise<void>((resolve) => {
          liberar = resolve;
        });
        return { ...TERMINAL_SIMPLES, stop: { kind: 'cancelled', reason: 'operator' } as never };
      }),
    });

    const emVoo = engine.start(mkRequest(), mkIo());
    await Promise.resolve();

    const c = await engine.cancel(locatorOf(), new AbortController().signal);
    expect(c).toEqual({ kind: 'requested' });
    expect(sinalDoRaciocinio?.aborted).toBe(true);

    liberar?.();
    await emVoo;
  });

  it('run já terminal devolve `already_terminal`, e run desconhecido devolve `unknown`', async () => {
    const engine = createMaiaEngine({ runReasoning: reasoningQueDevolve(TERMINAL_SIMPLES) });
    await engine.start(mkRequest(), mkIo());

    await expect(engine.cancel(locatorOf(), new AbortController().signal)).resolves.toEqual({
      kind: 'already_terminal',
    });
    await expect(
      engine.cancel(
        locatorOf('11111111-2222-4333-8444-555555555555'),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ kind: 'unknown' });
  });
});
