/**
 * Issue #309 follow-up (PR #324 B1) — message-recovery sweep fail-closed
 * behaviour when `enqueueAgent` cannot reach Redis.
 *
 * Contract proven here:
 *   The recovery sweep re-enqueues stranded inbound work. It NEVER marks a row
 *   processed (it has no such capability — only `enqueueAgent` is called), so a
 *   failed enqueue always leaves the work pending for the next sweep. On a
 *   Redis OOM the sweep stops early (`break`) instead of hammering a
 *   memory-capped Redis; on a non-OOM error it logs per item and continues with
 *   the rest of the batch.
 *
 * ─── POR QUE ESTE ARQUIVO É PARAMETRIZADO POR REGIME (#504) ────────────────
 *
 * `runMessageRecovery` tem DOIS inners e escolhe entre eles por
 * `turnStateAuthoritative()`:
 *
 *   · `runTurnRecoveryInner`  — elege por `agent_turns.status`. É o caminho
 *     PADRÃO desde que as flags de turno passaram a vir ON por default.
 *   · `runMessageRecoveryInner` — elege por `processada_em IS NULL`. É o
 *     caminho de ROLLBACK EMERGENCIAL, e continua coberto porque um rollback
 *     que ninguém testa não é rollback.
 *
 * Antes deste arquivo declarar o regime, ele herdava o default do contrato e
 * provava o fail-closed em UM inner só — e ninguém sabia em qual. A abortagem
 * por OOM do inner autoritativo nunca tinha sido exercitada. Agora os dois
 * regimes rodam a mesma matriz, e o regime é escolha EXPLÍCITA do teste.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  enqueueAgentMock,
  listUnprocessedMock,
  listPairsMock,
  findRecoverableMock,
  listTurnPairsMock,
  noteTurnQueuedMock,
  logWarn,
  logInfo,
  flags,
} = vi.hoisted(() => ({
  enqueueAgentMock: vi.fn(async () => undefined),
  listUnprocessedMock: vi.fn(),
  // Issue #345 (Phase 4): the worker is a DISPATCHER — it first enumerates the
  // (tenant_id, agent_id) tuples with stuck work, then runs the inner once per
  // tuple. `runWithTenantContext` is mocked pass-through below, so these
  // OOM/error tests (which exercise the INNER sweep) just need the enumeration
  // to yield exactly one real tuple.
  listPairsMock: vi.fn(async () => [{ tenant_id: 'tenant-A', agent_id: 'agent-A' }]),
  findRecoverableMock: vi.fn(),
  listTurnPairsMock: vi.fn(async () => [{ tenant_id: 'tenant-A', agent_id: 'agent-A' }]),
  noteTurnQueuedMock: vi.fn(async () => undefined),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  flags: { authoritative: true },
}));

// Re-use the real typed error so `instanceof` in the worker matches.
class QueueRedisUnavailableError extends Error {
  readonly code = 'QUEUE_REDIS_UNAVAILABLE';
  readonly oom: boolean;
  constructor(opts?: { oom?: boolean }) {
    super('test queue unavailable');
    this.name = 'QueueRedisUnavailableError';
    this.oom = opts?.oom ?? false;
  }
}

vi.mock('@/gateway/queue.js', () => ({
  enqueueAgent: enqueueAgentMock,
  QueueRedisUnavailableError,
}));
vi.mock('@/db/repositories.js', () => ({
  mensagensRepo: {
    listUnprocessedOlderThan: listUnprocessedMock,
    listTenantAgentPairsWithUnprocessedOlderThan: listPairsMock,
  },
  agentTurnsRepo: {
    findRecoverableTurns: findRecoverableMock,
    listTenantAgentPairsWithRecoverableTurns: listTurnPairsMock,
  },
}));
vi.mock('@/lib/logger.js', () => ({
  logger: { warn: logWarn, info: logInfo, error: vi.fn(), debug: vi.fn() },
}));
// runWithTenantContext just needs to invoke the inner fn.
vi.mock('@/db/tenant-context.js', () => ({
  runWithTenantContext: <T>(_ctx: unknown, fn: () => Promise<T>) => fn(),
}));
// O REGIME é escolha explícita do teste — nunca herdado do default do contrato.
vi.mock('@/runtime/turns/index.js', () => ({
  turnStateAuthoritative: () => flags.authoritative,
  turnStateMachineEnabled: () => true,
  noteTurnQueued: noteTurnQueuedMock,
  reportLegacyProjectionDivergence: vi.fn(async () => null),
}));

const { runMessageRecovery } = await import('@/workers/message-recovery.js');

/** Linhas do inner LEGADO (`mensagens`). */
const legacyRows = (...ids: string[]) => ids.map((id) => ({ id }));

/** Candidatos do inner AUTORITATIVO (`agent_turns`), já no formato do repo. */
const turnRows = (...ids: string[]) =>
  ids.map((id) => ({
    turn: {
      id: `turn-${id}`,
      representative_message_id: id,
      status: 'received',
      state_version: 1,
      attempt_count: 0,
      conversa_id: null,
    },
    reason: 'received_stale',
  }));

beforeEach(() => {
  vi.clearAllMocks();
  enqueueAgentMock.mockResolvedValue(undefined);
  listPairsMock.mockResolvedValue([{ tenant_id: 'tenant-A', agent_id: 'agent-A' }]);
  listTurnPairsMock.mockResolvedValue([{ tenant_id: 'tenant-A', agent_id: 'agent-A' }]);
  noteTurnQueuedMock.mockResolvedValue(undefined);
});

/**
 * Cada regime tem seu inner, seu mock de leitura e seus rótulos de log. O
 * CONTRATO afirmado é o mesmo nos dois — é isso que este arquivo prova.
 */
const REGIMES = [
  {
    label: 'AUTORITATIVO (padrão: elege por agent_turns.status)',
    authoritative: true,
    seed: (...ids: string[]) => findRecoverableMock.mockResolvedValue(turnRows(...ids)),
    seedEmpty: () => findRecoverableMock.mockResolvedValue([]),
    abortedLog: 'turn_recovery.aborted_redis_unavailable',
    failedLog: 'turn_recovery.enqueue_failed',
    doneLog: 'turn_recovery.done',
    firstEnqueue: { mensagem_id: 'm1', turn_id: 'turn-m1' },
  },
  {
    label: 'LEGADO (rollback: elege por processada_em IS NULL)',
    authoritative: false,
    seed: (...ids: string[]) => listUnprocessedMock.mockResolvedValue(legacyRows(...ids)),
    seedEmpty: () => listUnprocessedMock.mockResolvedValue([]),
    abortedLog: 'message_recovery.aborted_redis_unavailable',
    failedLog: 'message_recovery.enqueue_failed',
    doneLog: 'message_recovery.done',
    firstEnqueue: { mensagem_id: 'm1', received_at_ms: undefined },
  },
] as const;

for (const regime of REGIMES) {
  describe(`message recovery — fail-closed enqueue (#309 / PR #324 B1) — ${regime.label}`, () => {
    beforeEach(() => {
      flags.authoritative = regime.authoritative;
    });

    it('aborts the sweep on the FIRST OOM (does not enqueue the rest of the batch)', async () => {
      regime.seed('m1', 'm2', 'm3');
      // First row OOMs; remaining rows must NOT be attempted.
      enqueueAgentMock.mockImplementationOnce(async () => {
        throw new QueueRedisUnavailableError({ oom: true });
      });

      await runMessageRecovery();

      expect(enqueueAgentMock).toHaveBeenCalledTimes(1);
      expect(enqueueAgentMock).toHaveBeenCalledWith(regime.firstEnqueue);
      // breadcrumb log identifies the abort
      const aborted = logWarn.mock.calls.find((c) => c[1] === regime.abortedLog);
      expect(aborted).toBeTruthy();
      expect(aborted![0]).toMatchObject({ oom: true, requeued: 0, scanned: 3 });
    });

    it('continues past a NON-OOM error and processes the rest of the batch', async () => {
      regime.seed('m1', 'm2', 'm3');
      const boom = Object.assign(new Error('WRONGTYPE'), { name: 'ReplyError' });
      enqueueAgentMock.mockImplementationOnce(async () => {
        throw boom; // m1 fails (non-OOM)
      });
      // m2, m3 succeed.

      await runMessageRecovery();

      expect(enqueueAgentMock).toHaveBeenCalledTimes(3);
      const failed = logWarn.mock.calls.find((c) => c[1] === regime.failedLog);
      expect(failed).toBeTruthy();
      // 2 of 3 re-queued — the poison row did not stall the others.
      const done = logInfo.mock.calls.find((c) => c[1] === regime.doneLog);
      expect(done![0]).toMatchObject({ requeued: 2, scanned: 3 });
    });

    it('happy path re-enqueues every stuck item', async () => {
      regime.seed('m1', 'm2');
      await runMessageRecovery();
      expect(enqueueAgentMock).toHaveBeenCalledTimes(2);
      const done = logInfo.mock.calls.find((c) => c[1] === regime.doneLog);
      expect(done![0]).toMatchObject({ requeued: 2, scanned: 2 });
    });

    it('no rows → no enqueue attempts', async () => {
      regime.seedEmpty();
      await runMessageRecovery();
      expect(enqueueAgentMock).not.toHaveBeenCalled();
    });
  });
}

/**
 * Diferença MATERIAL entre os dois inners, e a razão de o autoritativo ser o
 * padrão: só ele devolve o turno ao estado `queued` ao rearmar. O inner legado
 * não tem estado para atualizar — e é por isso que, sob ele, um turno
 * `retryable` fica invisível para o recovery.
 */
describe('message recovery — o inner autoritativo devolve o turno a `queued`', () => {
  it('chama noteTurnQueued para cada turno rearmado', async () => {
    flags.authoritative = true;
    findRecoverableMock.mockResolvedValue(turnRows('m1', 'm2'));

    await runMessageRecovery();

    expect(noteTurnQueuedMock).toHaveBeenCalledTimes(2);
    expect(noteTurnQueuedMock).toHaveBeenCalledWith(
      expect.objectContaining({ turn_id: 'turn-m1', status: 'received' }),
    );
  });

  it('o inner legado não conhece estado nenhum', async () => {
    flags.authoritative = false;
    listUnprocessedMock.mockResolvedValue(legacyRows('m1'));

    await runMessageRecovery();

    expect(noteTurnQueuedMock).not.toHaveBeenCalled();
  });
});
