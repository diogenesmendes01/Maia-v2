/**
 * Issue #504 — FENCING na fachada de ciclo de vida.
 *
 * A propriedade central: uma tentativa que perdeu a posse NÃO consegue gravar,
 * e a recusa é RUIDOSA (métrica + auditoria + exceção). O caminho oposto também
 * é testado — sem claim ativo, nada muda em relação a #503, que é o que torna a
 * flag um rollback de verdade.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const repo = {
  markQueued: vi.fn(),
  markClaimed: vi.fn(),
  markRunning: vi.fn(),
  markIgnored: vi.fn(),
  markSuperseded: vi.fn(),
  completeTurnTx: vi.fn(),
  markRetryable: vi.fn(),
  markDeadLetter: vi.fn(),
  findTurnByMessage: vi.fn(),
  ensureTurnForMessage: vi.fn(),
  attachInputTx: vi.fn(),
  findById: vi.fn(),
  replayDeadLetterTx: vi.fn(),
  countLegacyProjectionMismatchByPair: vi.fn(),
};
const auditSpy = vi.fn().mockResolvedValue(undefined);
const flags = {
  FEATURE_TURN_STATE_MACHINE: true,
  FEATURE_TURN_STATE_AUTHORITATIVE: true,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
};

vi.mock('@/db/repositories/turn-repos.js', () => ({ agentTurnsRepo: repo }));
vi.mock('@/governance/audit.js', () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));
vi.mock('@/config/env.js', () => ({ config: flags }));

const { concludeTurn, failTurnRetryable, beginTurnExecution } = await import(
  '@/runtime/turns/lifecycle.js'
);
const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');
const { TurnFenceRejectedError } = await import('@/runtime/turns/claim.js');

const TURN = '6f1a2c34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

function handle(status = 'running') {
  return { turn_id: TURN, status, state_version: 3, attempt_count: 2, conversa_id: null } as never;
}

function ctx(turn_id = TURN, claim_token = 'token-1') {
  return {
    tenant_id: 't1',
    agent_id: 'a1',
    turn_id,
    attempt: 2,
    claim_token,
    worker_id: 'host:1',
    lease_expires_at: new Date(Date.now() + 60_000),
    deadline: null,
    signal: new AbortController().signal,
  };
}

const staleResult = {
  ok: false,
  conflict: 'stale_claim',
  to: 'completed',
  current_status: 'running',
  current_claim_token: 'token-2',
  current_claimed_by: 'host:2',
};

beforeEach(() => {
  vi.clearAllMocks();
  flags.FEATURE_TURN_STATE_MACHINE = true;
});

describe('#504 — a tentativa dona grava com o fence', () => {
  it('propaga o claim_token para a conclusão', async () => {
    repo.completeTurnTx.mockResolvedValue({
      ok: true,
      turn: { status: 'completed', state_version: 4, attempt_count: 2, conversa_id: null },
      from: 'running',
      to: 'completed',
    });
    await runWithTurnExecution(ctx(), () => concludeTurn(handle(), 'reply_delivered'));
    expect(repo.completeTurnTx).toHaveBeenCalledWith(
      expect.objectContaining({ turn_id: TURN, expected_claim_token: 'token-1' }),
    );
  });

  it('não bumpa a tentativa de novo — o claim já a incrementou', async () => {
    repo.markRunning.mockResolvedValue({
      ok: true,
      turn: { status: 'running', state_version: 5, attempt_count: 2, conversa_id: null },
      from: 'claimed',
      to: 'running',
    });
    await runWithTurnExecution(ctx(), () => beginTurnExecution(handle('claimed')));
    expect(repo.markRunning).toHaveBeenCalledWith(
      expect.objectContaining({ bump_attempt: false, expected_claim_token: 'token-1' }),
    );
    // Com claim ativo, `claimed` já é o estado: nenhuma perna extra roda.
    expect(repo.markClaimed).not.toHaveBeenCalled();
    expect(repo.markQueued).not.toHaveBeenCalled();
  });
});

describe('#504 — a tentativa ZUMBI é recusada', () => {
  it('conclusão com token velho LANÇA e audita turn_fence_rejected', async () => {
    repo.completeTurnTx.mockResolvedValue(staleResult);
    await expect(
      runWithTurnExecution(ctx(), () => concludeTurn(handle(), 'reply_delivered')),
    ).rejects.toBeInstanceOf(TurnFenceRejectedError);
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'turn_fence_rejected',
        alvo_id: TURN,
        metadata: expect.objectContaining({ operation: 'conclude', current_claimed_by: 'host:2' }),
      }),
    );
  });

  it('o retry também é recusado — o zumbi não reagenda o turno do sucessor', async () => {
    repo.markRetryable.mockResolvedValue({ ...staleResult, to: 'retryable' });
    await expect(
      runWithTurnExecution(ctx(), () => failTurnRetryable(handle(), { code: 'boom' })),
    ).rejects.toBeInstanceOf(TurnFenceRejectedError);
  });

  it('o fencing atravessa a política de MODO — nem em shadow vira fail-soft', async () => {
    // Em shadow (`AUTHORITATIVE=false`) `guarded` engoliria a falha; se
    // engolisse esta, a tentativa seguiria acreditando ter concluído o turno.
    flags.FEATURE_TURN_STATE_AUTHORITATIVE = false;
    repo.completeTurnTx.mockResolvedValue(staleResult);
    await expect(
      runWithTurnExecution(ctx(), () => concludeTurn(handle(), 'reply_delivered')),
    ).rejects.toBeInstanceOf(TurnFenceRejectedError);
    flags.FEATURE_TURN_STATE_AUTHORITATIVE = true;
  });
});

describe('#504 — sem claim ativo o comportamento de #503 é preservado', () => {
  it('não envia expected_claim_token quando não há contexto', async () => {
    repo.completeTurnTx.mockResolvedValue({
      ok: true,
      turn: { status: 'completed', state_version: 4, attempt_count: 2, conversa_id: null },
      from: 'running',
      to: 'completed',
    });
    await concludeTurn(handle(), 'reply_delivered');
    const arg = repo.completeTurnTx.mock.calls[0]![0] as Record<string, unknown>;
    expect('expected_claim_token' in arg).toBe(false);
  });

  it('o fence de OUTRO turno nunca vaza para este', async () => {
    repo.completeTurnTx.mockResolvedValue({
      ok: true,
      turn: { status: 'completed', state_version: 4, attempt_count: 2, conversa_id: null },
      from: 'running',
      to: 'completed',
    });
    // Contexto do turno B, escrita sobre o turno A: fence de outro turno não é
    // fence, é dano.
    await runWithTurnExecution(ctx('99999999-8888-4777-8666-555544443333'), () =>
      concludeTurn(handle(), 'reply_delivered'),
    );
    const arg = repo.completeTurnTx.mock.calls[0]![0] as Record<string, unknown>;
    expect('expected_claim_token' in arg).toBe(false);
  });

  it('sem claim, `beginTurnExecution` mantém a cadeia retryable -> queued -> claimed -> running', async () => {
    repo.markQueued.mockResolvedValue({
      ok: true,
      turn: { status: 'queued', state_version: 4, attempt_count: 2, conversa_id: null },
      from: 'retryable',
      to: 'queued',
    });
    repo.markClaimed.mockResolvedValue({
      ok: true,
      turn: { status: 'claimed', state_version: 5, attempt_count: 2, conversa_id: null },
      from: 'queued',
      to: 'claimed',
    });
    repo.markRunning.mockResolvedValue({
      ok: true,
      turn: { status: 'running', state_version: 6, attempt_count: 3, conversa_id: null },
      from: 'claimed',
      to: 'running',
    });
    await beginTurnExecution(handle('retryable'));
    expect(repo.markQueued).toHaveBeenCalled();
    expect(repo.markClaimed).toHaveBeenCalled();
    const arg = repo.markRunning.mock.calls[0]![0] as Record<string, unknown>;
    expect('bump_attempt' in arg).toBe(false); // default true — #503 conta aqui
  });
});
