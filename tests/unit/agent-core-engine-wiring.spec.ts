/**
 * P02 · K-15 — o `core.ts` × o seam de motor, pelo caminho de verdade.
 *
 * `engine-route-existing-run.spec.ts` já prova a FUNÇÃO pura, e
 * `turn-engine-integration.spec.ts` prova a DECISÃO de motor. O que nenhuma das
 * duas prova é que o `core.ts` as consulta: enquanto o seam existia sem ninguém
 * alimentá-lo, as duas podiam estar perfeitas e o turno seguir reexecutando o
 * pipeline em cima de um run em voo.
 *
 * Esta spec fecha isso pelo único lugar onde a pergunta é observável: chamando
 * `runAgentForMensagem` e olhando QUAL desfecho o turno recebeu.
 *
 * O inbound de fixture não tem `conversa_id` nem `metadata.telefone`, então o
 * pipeline — quando ele roda — para no primeiro degrau, em
 * `concludeTurn(..., 'identity_unknown')`. É por isso que `concludeTurn` serve
 * aqui como o sinal "o pipeline RODOU", e a ausência dele como "não rodou".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';
import type { TurnEngineState } from '@/db/repositories/engine-repos.js';

const { estado } = vi.hoisted(() => ({
  estado: { atual: { kind: 'no_binding' } as TurnEngineState },
}));

const findTurnEngineState = vi.fn(async () => estado.atual);
const findMensagem = vi.fn();
const markProcessed = vi.fn();
const concludeTurn = vi.fn();
const failTurnRetryable = vi.fn();
const deadLetterTurn = vi.fn();

vi.mock('../../src/db/repositories/engine-repos.js', () => ({
  engineRunsRepo: { findTurnEngineState },
}));

vi.mock('../../src/db/repositories.js', () => ({
  agentTurnsRepo: {},
  mensagensRepo: {
    findById: findMensagem,
    markProcessed,
    create: vi.fn(),
    createInbound: vi.fn(),
    setConversaId: vi.fn(),
    recentInConversation: vi.fn(async () => []),
  },
  conversasRepo: {
    byIdWithPessoa: vi.fn(async () => null),
    touch: vi.fn(),
    mergeMetadata: vi.fn(),
  },
  procedureExecutionsRepo: { findActiveForConversa: vi.fn(async () => null) },
  procedureDefinitionsRepo: { findById: vi.fn(async () => null) },
  procedureSelectorDecisionsRepo: { record: vi.fn() },
  channelPoliciesRepo: { getByChannelId: vi.fn(async () => null) },
  rolesRepo: { listActive: vi.fn(async () => []), getById: vi.fn(async () => null) },
  agentAudienceProfilesRepo: { findByPessoa: vi.fn(async () => null) },
}));

// O probe de canal lê `mensagens.metadata` por aqui. Zero linhas = "sem
// telefone", que é o caminho que mantém o escopo `primary/primary` sem chamar
// o resolver — o que esta spec quer, porque o canal do turno vem do inbound.
vi.mock('../../src/db/client.js', () => {
  const q = {
    from: () => q,
    where: () => q,
    limit: () => Promise.resolve([] as unknown[]),
  };
  return { db: { select: () => q }, withTx: vi.fn(async (fn: (tx: unknown) => unknown) => fn({})) };
});
vi.mock('../../src/db/schema.js', () => ({ mensagens: { metadata: {}, id: {} } }));
vi.mock('drizzle-orm', () => ({ eq: () => ({}) }));
vi.mock('../../src/gateway/channel-resolver.js', () => ({ resolveChannel: vi.fn() }));
vi.mock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/runtime/turns/index.js', async () => {
  class TurnOwnershipLostError extends Error {
    readonly boundary: string;
    constructor(boundary = 'test') {
      super('ownership lost');
      this.boundary = boundary;
    }
  }
  return {
    ensureTurnHandle: vi.fn(async () => ({
      turn_id: 't1',
      status: 'claimed',
      state_version: 1,
      attempt_count: 1,
      conversa_id: null,
      lease: null,
    })),
    beginTurnExecution: vi.fn(async () => ({ started: true })),
    absorbDebounceInputs: vi.fn(async () => []),
    concludeTurn,
    failTurnRetryable,
    deadLetterTurn,
    isTerminalTurnStatus: () => false,
    turnStateAuthoritative: () => true,
    runWithTurnExecution: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
    turnOwnershipLost: () => false,
    getTurnExecutionContext: () => null,
    assertTurnOwnership: vi.fn(),
    reportBlockedEffect: vi.fn(),
    transactionalDebounceEnabled: () => false,
    TurnOwnershipLostError,
  };
});
vi.mock('../../src/runtime/outbound/turn-scope.js', () => ({
  runWithOutboundTurnScope: vi.fn(async (_turn: unknown, fn: () => Promise<unknown>) => fn()),
}));

// Módulos pesados do grafo de `core.ts` que esta spec nunca alcança. Ficam
// dublados para que o custo do arquivo seja o do seam, não o do WhatsApp.
vi.mock('../../src/gateway/baileys.js', () => ({
  sendOutboundText: vi.fn(),
  sendOutboundDocument: vi.fn(),
  sendOutboundVoice: vi.fn(),
  isBaileysConnected: () => true,
  MEDIA_ROOT: '/tmp/maia-test-media',
}));
vi.mock('../../src/lib/claude.js', () => ({ callLLM: vi.fn() }));
vi.mock('../../src/agent/prompt-builder.js', () => ({
  buildPrompt: vi.fn(async () => ({ system: 's', messages: [] })),
  PROMPT_TOKEN_BUDGET_INPUT: 11000,
  PROMPT_TOKEN_BUDGET_OUTPUT: 1024,
}));
vi.mock('../../src/identity/resolver.js', () => ({ resolveIdentity: vi.fn() }));
// Os dois donos do cliente Redis no grafo de `core.ts`. Sem eles a spec tenta
// conectar em 6379 e gasta o timeout do ioredis num caminho que ela nem usa.
vi.mock('../../src/gateway/debouncer.js', () => ({ clearDebounceState: vi.fn() }));
vi.mock('../../src/gateway/rate-limit.js', () => ({
  checkRateLimit: vi.fn(async () => ({ kind: 'allow' })),
  formatPoliteReply: vi.fn(),
}));

const INBOUND = {
  id: 'in1',
  conversa_id: null,
  channel_id: 'ch-1',
  metadata: {},
  processada_em: null,
} as const;

/** Um run aberto, na fase pedida. */
function comRunAberto(phase: 'running' | 'blocked'): TurnEngineState {
  return {
    kind: 'open_run',
    pin: { engine: 'hermes', adapter_revision: 'r1', configuration_digest: 'd1' },
    run: {
      id: 'run-1',
      phase,
      generation_no: 1,
      row_version: 1,
      submit_count: 1,
      remote_run_id: null,
      request_key: 'rk-1',
    },
  };
}

// #545 — o grafo de produção de `core.ts` custa ~3s para carregar. Fora do
// orçamento do caso, ele mede o caso; dentro, mede o import.
const core = moduloDeProducao(() => import('../../src/agent/core.js'));
const wiring = moduloDeProducao(() => import('@/runtime/engines/integration.js'));

async function rodarTurno(): Promise<void> {
  await core().runAgentForMensagem('in1');
}

beforeEach(() => {
  vi.clearAllMocks();
  estado.atual = { kind: 'no_binding' };
  findMensagem.mockResolvedValue({ ...INBOUND });
});

afterEach(() => {
  wiring()._resetTurnEnginePorts();
});

describe('seam de rota — run em voo não reexecuta o pipeline', () => {
  it('run `running` leva o turno a RETRY, e o pipeline nunca roda', async () => {
    estado.atual = comRunAberto('running');
    await rodarTurno();

    expect(failTurnRetryable).toHaveBeenCalledWith(
      expect.objectContaining({ turn_id: 't1' }),
      expect.objectContaining({ code: 'engine_run_in_flight' }),
    );
    // A prova de que a rota foi alcançada de verdade: o pipeline pararia em
    // `identity_unknown`, e ele não chegou nem lá.
    expect(concludeTurn).not.toHaveBeenCalled();
  });

  it('CONTRAPROVA — sem binding, o pipeline roda e o turno recebe desfecho dele', async () => {
    estado.atual = { kind: 'no_binding' };
    await rodarTurno();

    expect(failTurnRetryable).not.toHaveBeenCalled();
    expect(concludeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turn_id: 't1' }),
      'identity_unknown',
      expect.anything(),
    );
  });

  it('run `blocked` vai para dead letter — tempo não resolve decisão humana', async () => {
    estado.atual = comRunAberto('blocked');
    await rodarTurno();

    expect(deadLetterTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turn_id: 't1' }),
      expect.objectContaining({ code: 'engine_run_blocked', outcome: 'unsafe_to_retry' }),
    );
    expect(concludeTurn).not.toHaveBeenCalled();
  });

  it('binding sem run aberto libera o pipeline: não há run para duplicar', async () => {
    estado.atual = {
      kind: 'binding_without_open_run',
      pin: { engine: 'maia_react', adapter_revision: 'r1', configuration_digest: 'd1' },
    };
    await rodarTurno();

    // O pin não casa com a porta local deste build, então o turno RECUSA em vez
    // de ser atendido por um motor diferente do pinado. O que importa neste
    // caso é que a rota liberou o pipeline — quem parou foi a escolha de motor.
    expect(deadLetterTurn).not.toHaveBeenCalled();
    expect(failTurnRetryable).toHaveBeenCalledWith(
      expect.objectContaining({ turn_id: 't1' }),
      expect.objectContaining({ code: 'engine_pinned_engine_mismatch' }),
    );
  });
});

describe('a escolha de motor é CONSUMIDA pelo core, não só registrada', () => {
  it('motor remoto escolhido e sem run preparável: o turno para, não é atendido localmente', async () => {
    wiring()._overrideTurnEnginePorts({
      killSwitch: () => false,
      readPolicy: async () => ({ engine: 'hermes' as const }),
      canaryAllowsHermes: async () => true,
      hermesEngine: () => ({
        pin: {
          engine: 'hermes',
          adapter_revision: 'r',
          configuration_digest: 'd',
          protocol_version: 1,
        },
        start: vi.fn(),
        observe: vi.fn(),
        cancel: vi.fn(),
      }),
    });

    await rodarTurno();

    expect(failTurnRetryable).toHaveBeenCalledWith(
      expect.objectContaining({ turn_id: 't1' }),
      expect.objectContaining({ code: 'engine_remote_turn_not_wired' }),
    );
    expect(concludeTurn).not.toHaveBeenCalled();
  });

  it('CONTRAPROVA — a MESMA linha e o MESMO degrau, sem instância, atendem localmente', async () => {
    wiring()._overrideTurnEnginePorts({
      killSwitch: () => false,
      readPolicy: async () => ({ engine: 'hermes' as const }),
      canaryAllowsHermes: async () => true,
      hermesEngine: () => null,
    });

    await rodarTurno();

    expect(failTurnRetryable).not.toHaveBeenCalled();
    expect(concludeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ turn_id: 't1' }),
      'identity_unknown',
      expect.anything(),
    );
  });
});
