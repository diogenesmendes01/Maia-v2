/**
 * Issue #504 §"Retry, recovery e DLQ" — "backoff deve ser persistido como
 * `next_attempt_at` e ter JITTER LIMITADO".
 *
 * ─── O que esta suíte prova, e por que em duas camadas ──────────────────────
 *
 * A propriedade não é "existe uma função que sorteia". É "o valor GRAVADO em
 * `agent_turns.next_attempt_at` se espalha". Por isso há dois blocos:
 *
 *   1. a função `retryDelayMs` (`src/runtime/turns/lifecycle.ts`), onde a
 *      janela e o teto são assertáveis diretamente;
 *   2. `failTurnRetryable` — o CALL SITE DE PRODUÇÃO —, provando que o número
 *      que chega ao repositório é o número com jitter. Sem esse segundo bloco,
 *      alguém poderia adicionar jitter à função e o caminho real continuar
 *      chamando outra coisa, com a suíte verde.
 *
 * O sorteio é fixado por `vi.spyOn(Math, 'random')` NO PONTO DE PRODUÇÃO —
 * `retryDelayMs` lê `Math.random` diretamente, sem parâmetro injetável, porque
 * um parâmetro `rand` faria todo teste de jitter medir a função que o próprio
 * teste passou.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const repo = {
  markQueued: vi.fn(),
  markClaimed: vi.fn(),
  markRunning: vi.fn(),
  markIgnored: vi.fn(),
  markSupersededSelf: vi.fn(),
  markSupersededByAbsorber: vi.fn(),
  completeTurnTx: vi.fn(),
  markRetryable: vi.fn(),
  markDeadLetter: vi.fn(),
  findTurnByMessage: vi.fn(),
  ensureTurnForMessage: vi.fn(),
  findById: vi.fn(),
  replayDeadLetterTx: vi.fn(),
  countLegacyProjectionMismatchByPair: vi.fn(),
};
const flags = {
  FEATURE_TURN_STATE_MACHINE: true,
  FEATURE_TURN_STATE_AUTHORITATIVE: false,
  FEATURE_TURN_CLAIM: false,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
};

vi.mock('@/db/repositories/turn-repos.js', () => ({ agentTurnsRepo: repo }));
vi.mock('@/governance/audit.js', () => ({ audit: vi.fn() }));
vi.mock('@/config/env.js', () => ({ config: flags }));

const { retryDelayMs, failTurnRetryable, RETRY_JITTER_RATIO, RETRY_BACKOFF_CEILING_MS } =
  await import('@/runtime/turns/lifecycle.js');

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

/** O atraso BASE (sem jitter) que a issue documenta para cada tentativa. */
function baseFor(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_CEILING_MS);
}

describe('#504 — jitter limitado no backoff de retry', () => {
  it('espalha o atraso: 400 sorteios reais produzem MUITOS valores distintos', () => {
    // Sem jitter, `retryDelayMs(2)` é a constante 60000 e este Set tem tamanho
    // 1. É o assert que morre no instante em que o termo de jitter sai da
    // produção — a razão de existir do teste.
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) seen.add(retryDelayMs(2));
    expect(seen.size).toBeGreaterThan(50);
  });

  it('o espalhamento fica DENTRO da janela ±20% — é jitter limitado, não aleatório', () => {
    for (const attempt of [1, 2, 3, 4]) {
      const base = baseFor(attempt);
      const lo = base * (1 - RETRY_JITTER_RATIO);
      const hi = base * (1 + RETRY_JITTER_RATIO);
      for (let i = 0; i < 200; i++) {
        const d = retryDelayMs(attempt);
        expect(d).toBeGreaterThanOrEqual(Math.floor(lo));
        expect(d).toBeLessThanOrEqual(Math.ceil(hi));
      }
    }
  });

  it('o teto continua sendo um TETO: nenhum sorteio passa de 15min', () => {
    for (let i = 0; i < 500; i++) {
      expect(retryDelayMs(50)).toBeLessThanOrEqual(RETRY_BACKOFF_CEILING_MS);
    }
  });

  it('os extremos do sorteio batem exatamente com a janela declarada', () => {
    const rand = vi.spyOn(Math, 'random');
    rand.mockReturnValue(0); // -100% da amplitude => base * 0.8
    expect(retryDelayMs(2)).toBe(48_000);
    rand.mockReturnValue(1); // +100% da amplitude => base * 1.2
    expect(retryDelayMs(2)).toBe(72_000);
    rand.mockReturnValue(0.5); // jitter neutro
    expect(retryDelayMs(2)).toBe(60_000);
  });
});

describe('#504 — o jitter chega ao `next_attempt_at` PERSISTIDO', () => {
  it('dois turnos que falham na MESMA tentativa recebem next_attempt_at DIFERENTES', async () => {
    repo.markRetryable.mockResolvedValue({
      ok: true,
      to: 'retryable',
      turn: {
        id: 't',
        status: 'retryable',
        state_version: 2,
        attempt_count: 1,
        conversa_id: null,
      },
    });
    const handle = () => ({
      turn_id: '11111111-1111-4111-8111-111111111111',
      status: 'running' as const,
      state_version: 1,
      attempt_count: 1,
      conversa_id: null,
    });

    const rand = vi.spyOn(Math, 'random');
    // Dois sorteios opostos: o mesmo `attempt_count` (1 -> próximo é 2, base
    // 60s) tem de produzir 48s e 72s. É este delta que prova que o valor
    // gravado no banco carrega o jitter, e não só o valor de retorno de uma
    // função pura que ninguém usa.
    rand.mockReturnValue(0);
    const t0 = Date.now();
    await failTurnRetryable(handle(), { code: 'reasoner_failed' });
    rand.mockReturnValue(1);
    const t1 = Date.now();
    await failTurnRetryable(handle(), { code: 'reasoner_failed' });

    const first = repo.markRetryable.mock.calls[0]![0].next_attempt_at as Date;
    const second = repo.markRetryable.mock.calls[1]![0].next_attempt_at as Date;
    expect(first.getTime() - t0).toBeGreaterThanOrEqual(48_000 - 50);
    expect(first.getTime() - t0).toBeLessThanOrEqual(48_000 + 50);
    expect(second.getTime() - t1).toBeGreaterThanOrEqual(72_000 - 50);
    expect(second.getTime() - t1).toBeLessThanOrEqual(72_000 + 50);
    expect(second.getTime() - first.getTime()).toBeGreaterThan(20_000);
  });
});
