/**
 * Issue #503 — fachada de ciclo de vida do turno (src/runtime/turns/lifecycle.ts).
 *
 * Cobre o que NÃO depende de Postgres:
 *  - kill switch: com a flag OFF tudo é no-op (nenhuma escrita, nenhum audit);
 *  - o caller declara o OUTCOME e a fachada deriva o ESTADO terminal;
 *  - `failTurnRetryable` vira dead letter ao esgotar as tentativas;
 *  - backoff exponencial com teto;
 *  - fail-soft: erro do repositório NÃO escapa para o hot path;
 *  - auditoria obrigatória (descarte por política, dead letter, conclusão sem
 *    resposta) e ausência de auditoria no caminho feliz.
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
  countLegacyProjectionMismatch: vi.fn(),
};
const auditSpy = vi.fn();
// `config` é substituído por inteiro, então precisa carregar também o que o
// logger lê no import (LOG_LEVEL/NODE_ENV) — do contrário o pino falha ao subir.
const flags = {
  FEATURE_TURN_STATE_MACHINE: true,
  FEATURE_TURN_STATE_AUTHORITATIVE: false,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
};

vi.mock('@/db/repositories/turn-repos.js', () => ({ agentTurnsRepo: repo }));
vi.mock('@/governance/audit.js', () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));
vi.mock('@/config/env.js', () => ({ config: flags }));

const {
  concludeTurn,
  failTurnRetryable,
  beginTurnExecution,
  ensureTurnHandle,
  reportLegacyProjectionDivergence,
  retryDelayMs,
  MAX_TURN_ATTEMPTS,
  TurnStateWriteError,
  turnStateMachineEnabled,
  turnStateAuthoritative,
} = await import('@/runtime/turns/lifecycle.js');

type Handle = {
  turn_id: string;
  status: 'received' | 'queued' | 'claimed' | 'running' | 'retryable';
  state_version: number;
  attempt_count: number;
  conversa_id: string | null;
};

function handle(overrides: Partial<Handle> = {}): Handle {
  return {
    turn_id: 'turn-1',
    status: 'running',
    state_version: 3,
    attempt_count: 1,
    conversa_id: 'conv-1',
    ...overrides,
  };
}

/** Resposta de sucesso do repo, com a row já no estado alvo. */
function ok(status: string, outcome: string | null = null) {
  return {
    ok: true,
    to: status,
    turn: {
      id: 'turn-1',
      status,
      outcome,
      state_version: 4,
      attempt_count: 1,
      conversa_id: 'conv-1',
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.FEATURE_TURN_STATE_MACHINE = true;
  flags.FEATURE_TURN_STATE_AUTHORITATIVE = false;
});

describe('turn lifecycle — kill switch', () => {
  it('flag OFF: nenhuma escrita e nenhum audit', async () => {
    flags.FEATURE_TURN_STATE_MACHINE = false;
    expect(turnStateMachineEnabled()).toBe(false);
    await concludeTurn(handle(), 'reply_delivered');
    await failTurnRetryable(handle(), { code: 'reasoner_failed' });
    await beginTurnExecution(handle({ status: 'queued' }));
    expect(repo.completeTurnTx).not.toHaveBeenCalled();
    expect(repo.markRetryable).not.toHaveBeenCalled();
    expect(repo.markClaimed).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('leitura autoritativa exige as DUAS flags', async () => {
    flags.FEATURE_TURN_STATE_MACHINE = true;
    flags.FEATURE_TURN_STATE_AUTHORITATIVE = false;
    expect(turnStateAuthoritative()).toBe(false);
    flags.FEATURE_TURN_STATE_AUTHORITATIVE = true;
    expect(turnStateAuthoritative()).toBe(true);
    flags.FEATURE_TURN_STATE_MACHINE = false;
    expect(turnStateAuthoritative()).toBe(false);
  });

  it('handle null (turno inexistente) é no-op seguro', async () => {
    await concludeTurn(null, 'reply_delivered');
    await failTurnRetryable(null, { code: 'x' });
    expect(repo.completeTurnTx).not.toHaveBeenCalled();
    expect(repo.markRetryable).not.toHaveBeenCalled();
  });
});

describe('turn lifecycle — o outcome determina o estado terminal', () => {
  it('outcomes de descarte por política vão para `ignored` e são AUDITADOS', async () => {
    repo.markIgnored.mockResolvedValue(ok('ignored', 'identity_unknown'));
    await concludeTurn(handle(), 'identity_unknown', { mensagem_id: 'm-1' });
    expect(repo.markIgnored).toHaveBeenCalledWith(
      expect.objectContaining({ turn_id: 'turn-1', outcome: 'identity_unknown' }),
    );
    expect(repo.completeTurnTx).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'turn_ignored_by_policy' }),
    );
  });

  it('`merged_into_turn` vai para `superseded`', async () => {
    repo.markSuperseded.mockResolvedValue(ok('superseded', 'merged_into_turn'));
    await concludeTurn(handle(), 'merged_into_turn');
    expect(repo.markSuperseded).toHaveBeenCalled();
    expect(repo.markIgnored).not.toHaveBeenCalled();
  });

  it('resposta entregue vai para `completed` e NÃO gera audit', async () => {
    repo.completeTurnTx.mockResolvedValue(ok('completed', 'reply_delivered'));
    await concludeTurn(handle(), 'reply_delivered');
    expect(repo.completeTurnTx).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'reply_delivered' }),
    );
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('conclusão SEM resposta é auditada', async () => {
    repo.completeTurnTx.mockResolvedValue(ok('completed', 'no_reply_produced'));
    await concludeTurn(handle(), 'no_reply_produced');
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'turn_completed_without_reply' }),
    );
  });

  it('conflito de CAS não gera audit (nada mudou de estado)', async () => {
    repo.completeTurnTx.mockResolvedValue({
      ok: false,
      conflict: 'state_mismatch',
      to: 'completed',
      current_status: 'outbound_pending',
      current_state_version: 9,
    });
    await concludeTurn(handle(), 'no_reply_produced');
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('o CAS usa a state_version do handle e avança o handle no sucesso', async () => {
    const h = handle({ state_version: 3 });
    repo.completeTurnTx.mockResolvedValue(ok('completed', 'reply_delivered'));
    await concludeTurn(h, 'reply_delivered');
    expect(repo.completeTurnTx).toHaveBeenCalledWith(
      expect.objectContaining({ expected_version: 3 }),
    );
    expect(h.state_version).toBe(4);
    expect(h.status).toBe('completed');
  });
});

describe('turn lifecycle — retry e dead letter', () => {
  it('agenda retry com next_attempt_at futuro e erro sanitizado', async () => {
    repo.markRetryable.mockResolvedValue(ok('retryable'));
    const before = Date.now();
    await failTurnRetryable(handle({ attempt_count: 1 }), {
      code: 'REASONER_FAILED',
      error: new Error('timeout falando com +55 11 98888-7777'),
    });
    const args = repo.markRetryable.mock.calls[0]![0];
    expect(args.error_code).toBe('reasoner_failed');
    expect(args.error_summary).not.toMatch(/98888/);
    expect(args.next_attempt_at.getTime()).toBeGreaterThan(before);
    expect(repo.markDeadLetter).not.toHaveBeenCalled();
  });

  it('esgotou tentativas: vira dead letter AUDITADO em vez de novo retry', async () => {
    repo.markDeadLetter.mockResolvedValue(ok('dead_letter', 'retry_exhausted'));
    await failTurnRetryable(handle({ attempt_count: MAX_TURN_ATTEMPTS }), {
      code: 'outbound_failure',
    });
    expect(repo.markRetryable).not.toHaveBeenCalled();
    expect(repo.markDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'retry_exhausted', error_code: 'outbound_failure' }),
    );
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ acao: 'turn_dead_lettered' }));
  });

  it('backoff é exponencial e limitado a 15min', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(50)).toBe(15 * 60_000);
    expect(retryDelayMs(0)).toBe(30_000);
  });
});

describe('turn lifecycle — SHADOW: fail-soft não derruba o hot path', () => {
  it('erro do repositório é engolido, logado e contabilizado', async () => {
    repo.completeTurnTx.mockRejectedValue(new Error('DB down'));
    await expect(concludeTurn(handle(), 'reply_delivered')).resolves.toBeUndefined();
  });

  it('erro no begin não impede o turno de seguir', async () => {
    repo.markClaimed.mockRejectedValue(new Error('DB down'));
    await expect(beginTurnExecution(handle({ status: 'queued' }))).resolves.toBeUndefined();
  });
});

// Achado P1 rodada 1: em modo autoritativo o fail-soft CONTRADIZ "PostgreSQL é
// a fonte de verdade" — a persistência falharia e o caller seguiria gravando
// `processada_em`, deixando o turno `running` sem lease e fora do recovery.
describe('turn lifecycle — AUTORITATIVO: falha de transição é BLOQUEANTE', () => {
  beforeEach(() => {
    flags.FEATURE_TURN_STATE_AUTHORITATIVE = true;
  });

  const boom = (): Error => new Error('DB down');

  it.each([
    ['reply_delivered (completed)', 'completeTurnTx' as const],
    ['identity_unknown (ignored)', 'markIgnored' as const],
    ['merged_into_turn (superseded)', 'markSuperseded' as const],
  ])('conclusão terminal %s propaga TurnStateWriteError', async (_label, method) => {
    repo[method].mockRejectedValue(boom());
    const outcome =
      method === 'completeTurnTx'
        ? 'reply_delivered'
        : method === 'markIgnored'
          ? 'identity_unknown'
          : 'merged_into_turn';
    await expect(concludeTurn(handle(), outcome as never)).rejects.toThrow(TurnStateWriteError);
  });

  it('retry propaga', async () => {
    repo.markRetryable.mockRejectedValue(boom());
    await expect(
      failTurnRetryable(handle({ attempt_count: 1 }), { code: 'reasoner_failed' }),
    ).rejects.toThrow(TurnStateWriteError);
  });

  it('dead letter propaga', async () => {
    repo.markDeadLetter.mockRejectedValue(boom());
    await expect(
      failTurnRetryable(handle({ attempt_count: MAX_TURN_ATTEMPTS }), { code: 'x' }),
    ).rejects.toThrow(TurnStateWriteError);
  });

  it('begin e ensure propagam', async () => {
    repo.markClaimed.mockRejectedValue(boom());
    await expect(beginTurnExecution(handle({ status: 'queued' }))).rejects.toThrow(
      TurnStateWriteError,
    );
    repo.findTurnByMessage.mockRejectedValue(boom());
    await expect(
      ensureTurnHandle({
        id: 'm-1',
        tenant_id: 't',
        agent_id: 'a',
        conversa_id: null,
        channel_id: null,
      }),
    ).rejects.toThrow(TurnStateWriteError);
  });

  it('o erro carrega op e error_code sanitizados (sem PII)', async () => {
    repo.completeTurnTx.mockRejectedValue(
      Object.assign(new Error('conn to +55 11 98888-7777 lost'), { code: 'ECONNREFUSED' }),
    );
    await expect(concludeTurn(handle(), 'reply_delivered')).rejects.toMatchObject({
      code: 'TURN_STATE_WRITE_FAILED',
      op: 'conclude',
      error_code: 'econnrefused',
    });
  });

  it('NÃO propaga um CONFLITO de CAS — conflito é resultado, não falha', async () => {
    repo.completeTurnTx.mockResolvedValue({
      ok: false,
      conflict: 'state_mismatch',
      to: 'completed',
      current_status: 'outbound_pending',
      current_state_version: 9,
    });
    await expect(concludeTurn(handle(), 'reply_delivered')).resolves.toBeUndefined();
  });

  it('o probe de divergência continua NÃO-bloqueante mesmo autoritativo', async () => {
    repo.countLegacyProjectionMismatch.mockRejectedValue(boom());
    await expect(reportLegacyProjectionDivergence()).resolves.toBeNull();
  });
});

describe('turn lifecycle — begin execution', () => {
  it('received -> claimed -> running em uma passada', async () => {
    repo.markClaimed.mockResolvedValue({
      ok: true,
      to: 'claimed',
      turn: {
        id: 'turn-1',
        status: 'claimed',
        state_version: 2,
        attempt_count: 0,
        conversa_id: null,
      },
    });
    repo.markRunning.mockResolvedValue({
      ok: true,
      to: 'running',
      turn: {
        id: 'turn-1',
        status: 'running',
        state_version: 3,
        attempt_count: 1,
        conversa_id: 'conv-9',
      },
    });
    const h = handle({ status: 'received', state_version: 1, attempt_count: 0 });
    await beginTurnExecution(h, { conversa_id: 'conv-9' });
    expect(repo.markClaimed).toHaveBeenCalledWith(
      expect.objectContaining({ expected_version: 1 }),
    );
    expect(repo.markRunning).toHaveBeenCalledWith(
      expect.objectContaining({ expected_version: 2, conversa_id: 'conv-9' }),
    );
    expect(h.status).toBe('running');
    expect(h.attempt_count).toBe(1);
  });

  it('turno já em running não retransiciona', async () => {
    await beginTurnExecution(handle({ status: 'running' }));
    expect(repo.markClaimed).not.toHaveBeenCalled();
    expect(repo.markRunning).not.toHaveBeenCalled();
  });

  it('conflito no claim NÃO aborta o turno (exclusão mútua é #504)', async () => {
    repo.markClaimed.mockResolvedValue({
      ok: false,
      conflict: 'state_mismatch',
      to: 'claimed',
      current_status: 'running',
      current_state_version: 7,
    });
    const h = handle({ status: 'queued', state_version: 1 });
    await expect(beginTurnExecution(h)).resolves.toBeUndefined();
    expect(repo.markRunning).not.toHaveBeenCalled();
    expect(h.status).toBe('queued');
  });
});
