/**
 * Issue #504 — o DETENTOR da lease (src/runtime/turns/lease.ts).
 *
 * Cobre o que não depende de Postgres: a política em memória de quem segura a
 * posse. O statement atômico em si é provado em
 * `tests/integration/turn-claim-real-db.spec.ts` — concorrência real entre
 * réplicas não é verificável com mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const repo = {
  tryClaimTurn: vi.fn(),
  renewTurnLease: vi.fn(),
  releaseTurnLease: vi.fn(),
};
const auditSpy = vi.fn().mockResolvedValue(undefined);
const flags = {
  FEATURE_TURN_CLAIM: true,
  FEATURE_TURN_STATE_MACHINE: true,
  TURN_LEASE_TTL_MS: 60_000,
  TURN_LEASE_HEARTBEAT_MS: 15_000,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
};
let accepting = true;

vi.mock('@/db/repositories/turn-repos.js', () => ({ agentTurnsRepo: repo }));
vi.mock('@/governance/audit.js', () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));
vi.mock('@/config/env.js', () => ({ config: flags }));
vi.mock('@/runtime/lifecycle/controller.js', () => ({
  lifecycle: { isAcceptingWork: () => accepting },
}));

const {
  acquireTurnLease,
  activeTurnLeaseCount,
  drainTurnLeases,
  turnClaimEnabled,
  turnWorkerId,
  __resetTurnLeaseStateForTests,
} = await import('@/runtime/turns/lease.js');

const TURN = '6f1a2c34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';

function claimOk(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    claim: {
      turn: {
        id: TURN,
        status: 'claimed',
        state_version: 4,
        conversa_id: null,
        deadline_at: null,
        ...((overrides.turn as Record<string, unknown>) ?? {}),
      },
      turn_id: TURN,
      tenant_id: 't1',
      agent_id: 'a1',
      claim_token: 'token-1',
      claimed_by: 'host:1',
      lease_expires_at: new Date(Date.now() + 60_000),
      attempt: 2,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  accepting = true;
  flags.FEATURE_TURN_CLAIM = true;
  flags.TURN_LEASE_TTL_MS = 60_000;
  flags.TURN_LEASE_HEARTBEAT_MS = 15_000;
  __resetTurnLeaseStateForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('#504 — aquisição', () => {
  it('devolve o contexto de fencing quando vence o claim', async () => {
    repo.tryClaimTurn.mockResolvedValue(claimOk());
    const lease = await acquireTurnLease({ turn_id: TURN });
    expect(lease).not.toBeNull();
    expect(lease!.ctx.claim_token).toBe('token-1');
    expect(lease!.ctx.attempt).toBe(2);
    expect(lease!.ctx.tenant_id).toBe('t1');
    expect(lease!.ctx.agent_id).toBe('a1');
    expect(lease!.claimed_state_version).toBe(4);
    expect(lease!.isValid()).toBe(true);
    expect(activeTurnLeaseCount()).toBe(1);
    await lease!.finish();
  });

  it('AUDITA a aquisição — é a primeira pergunta de um incidente de execução dupla', async () => {
    repo.tryClaimTurn.mockResolvedValue(claimOk());
    const lease = await acquireTurnLease({ turn_id: TURN });
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'turn_claimed', alvo_id: TURN }),
    );
    await lease!.finish();
  });

  it('devolve null (SEM erro) quando outro worker é o dono', async () => {
    repo.tryClaimTurn.mockResolvedValue({ ok: false, reason: 'lease_active', current_status: 'running' });
    await expect(acquireTurnLease({ turn_id: TURN })).resolves.toBeNull();
    expect(activeTurnLeaseCount()).toBe(0);
  });

  it('RECUSA reivindicar quando o processo está drenando', async () => {
    accepting = false;
    await expect(acquireTurnLease({ turn_id: TURN })).resolves.toBeNull();
    // Sem sequer tocar no banco: um processo em drain não gasta tentativa
    // canônica de um turno que ele mesmo abortaria segundos depois.
    expect(repo.tryClaimTurn).not.toHaveBeenCalled();
  });

  it('FAIL-LOUD: configuração de lease insegura impede a aquisição', async () => {
    flags.TURN_LEASE_HEARTBEAT_MS = 59_000; // > TTL/3
    repo.tryClaimTurn.mockResolvedValue(claimOk());
    await expect(acquireTurnLease({ turn_id: TURN })).rejects.toThrow(/lease insegura/);
    expect(repo.tryClaimTurn).not.toHaveBeenCalled();
  });
});

describe('#504 — heartbeat e perda', () => {
  it('renova a lease na cadência configurada, com o token vigente', async () => {
    vi.useFakeTimers();
    repo.tryClaimTurn.mockResolvedValue(claimOk());
    repo.renewTurnLease.mockResolvedValue({ ok: true, lease_expires_at: new Date() });
    const lease = await acquireTurnLease({ turn_id: TURN });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(repo.renewTurnLease).toHaveBeenCalledWith(
      expect.objectContaining({ turn_id: TURN, claim_token: 'token-1', lease_ms: 60_000 }),
    );
    expect(lease!.isValid()).toBe(true);
    await lease!.finish();
  });

  it('renovação RECUSADA pelo banco cancela a tentativa imediatamente', async () => {
    vi.useFakeTimers();
    repo.tryClaimTurn.mockResolvedValue(claimOk());
    repo.renewTurnLease.mockResolvedValue({ ok: false, reason: 'lost' });
    const lease = await acquireTurnLease({ turn_id: TURN });

    await vi.advanceTimersByTimeAsync(15_000);
    // Uma única recusa basta: não há retentativa possível, retomar posse
    // implicitamente é o que a issue proíbe.
    expect(lease!.isValid()).toBe(false);
    expect(lease!.ctx.signal.aborted).toBe(true);
    expect(() => lease!.assertValid()).toThrow(/lease do turno perdida/);
    await lease!.finish();
  });

  it('tolera UMA falha de infraestrutura e aborta na segunda', async () => {
    vi.useFakeTimers();
    repo.tryClaimTurn.mockResolvedValue(claimOk());
    repo.renewTurnLease.mockRejectedValue(new Error('connection reset'));
    const lease = await acquireTurnLease({ turn_id: TURN });

    await vi.advanceTimersByTimeAsync(15_000);
    // Ainda dono: uma falha do banco não prova perda de posse.
    expect(lease!.isValid()).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    // Duas falhas consumiram 2/3 do TTL — desistir AGORA é desistir enquanto
    // ainda somos donos, em vez de descobrir a perda depois do takeover.
    expect(lease!.isValid()).toBe(false);
    await lease!.finish();
  });

  it('para o timer ao encerrar — nenhum heartbeat depois do finish', async () => {
    vi.useFakeTimers();
    repo.tryClaimTurn.mockResolvedValue(claimOk());
    repo.renewTurnLease.mockResolvedValue({ ok: true, lease_expires_at: new Date() });
    const lease = await acquireTurnLease({ turn_id: TURN });
    await lease!.finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(repo.renewTurnLease).not.toHaveBeenCalled();
    expect(activeTurnLeaseCount()).toBe(0);
  });

  it('finish é idempotente', async () => {
    repo.tryClaimTurn.mockResolvedValue(claimOk());
    repo.releaseTurnLease.mockResolvedValue({ released: true });
    const lease = await acquireTurnLease({ turn_id: TURN });
    await lease!.finish({ release: true });
    await lease!.finish({ release: true });
    expect(repo.releaseTurnLease).toHaveBeenCalledTimes(1);
  });
});

describe('#504 — drain do shutdown ordenado', () => {
  it('devolve a posse das leases ainda vivas e esvazia o registro', async () => {
    repo.tryClaimTurn.mockResolvedValue(claimOk());
    repo.releaseTurnLease.mockResolvedValue({ released: true });
    await acquireTurnLease({ turn_id: TURN });
    expect(activeTurnLeaseCount()).toBe(1);

    const { released } = await drainTurnLeases();
    expect(released).toBe(1);
    expect(activeTurnLeaseCount()).toBe(0);
    expect(repo.releaseTurnLease).toHaveBeenCalledWith({
      turn_id: TURN,
      claim_token: 'token-1',
    });
  });

  it('não derruba o shutdown quando a devolução falha', async () => {
    repo.tryClaimTurn.mockResolvedValue(claimOk());
    repo.releaseTurnLease.mockRejectedValue(new Error('db down'));
    await acquireTurnLease({ turn_id: TURN });
    // Best-effort: a lease expira sozinha e o recovery reencontra o turno.
    await expect(drainTurnLeases()).resolves.toEqual({ released: 1 });
  });

  it('é no-op quando nada está em voo — o caminho normal do deploy', async () => {
    await expect(drainTurnLeases()).resolves.toEqual({ released: 0 });
  });
});

describe('#504 — flags e identidade', () => {
  it('o claim exige a máquina de estados ligada', () => {
    expect(turnClaimEnabled()).toBe(true);
    flags.FEATURE_TURN_STATE_MACHINE = false;
    expect(turnClaimEnabled()).toBe(false);
    flags.FEATURE_TURN_STATE_MACHINE = true;
  });

  it('a identidade do dono diz QUAL container segura o turno', () => {
    expect(turnWorkerId()).toMatch(/^.+:\d+$/);
  });
});
