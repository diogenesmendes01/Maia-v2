/**
 * Issue #504 — contrato PURO de claim/lease/jobId (src/runtime/turns/claim.ts).
 *
 * Tudo aqui roda sem Postgres, sem Redis e sem env: é exatamente por isso que o
 * contrato foi mantido puro. As propriedades provadas aqui são as que a suíte
 * de integração NÃO consegue provar barato — determinismo do `jobId`,
 * fail-closed do parser e a relação de segurança TTL × heartbeat.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  AGENT_TURN_JOB_VERSION,
  CLAIM_ELIGIBLE_STATUSES,
  CLAIM_TAKEOVER_STATUSES,
  LEASE_HEARTBEAT_MAX_RATIO,
  LEASE_TTL_MIN_MS,
  RETRY_JITTER_RATIO,
  TURN_JOB_ID_PREFIX,
  agentJobIdentity,
  assertLeaseConfig,
  checkLeaseConfig,
  jitteredDelayMs,
  parseAgentJob,
  turnJobId,
  TurnFenceRejectedError,
  TurnLeaseLostError,
} from '@/runtime/turns/claim.js';

const TURN = '6f1a2c34-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const MSG = '11112222-3333-4444-5555-666677778888';

describe('#504 — jobId determinístico', () => {
  it('é ESTÁVEL: o mesmo turn_id produz sempre o mesmo id', () => {
    expect(turnJobId(TURN)).toBe(turnJobId(TURN));
    // Estabilidade entre execuções é o que faz o rearmamento ser idempotente;
    // fixar o valor aqui transforma uma mudança acidental de algoritmo (trocar
    // o hash, mudar o corte) em falha de CI em vez de duplicação em produção.
    expect(turnJobId(TURN)).toBe('turn-b42250b73828f8b41a9f293364f2e8b3df0b80b2');
  });

  it('separa turnos distintos', () => {
    expect(turnJobId(TURN)).not.toBe(turnJobId(MSG));
  });

  it('nunca contém ":" — o separador que o BullMQ reserva em custom ids', () => {
    for (let i = 0; i < 50; i++) {
      const id = turnJobId(randomUUID());
      expect(id.includes(':')).toBe(false);
      expect(id.startsWith(TURN_JOB_ID_PREFIX)).toBe(true);
      expect(id).toHaveLength(TURN_JOB_ID_PREFIX.length + 40);
    }
  });
});

describe('#504 — leitura DUAL do payload', () => {
  it('lê o payload V2', () => {
    const parsed = parseAgentJob({ version: 2, turn_id: TURN });
    expect(parsed).toEqual({ version: 2, turn_id: TURN, legacy: false });
    expect(agentJobIdentity(parsed!)).toBe(TURN);
  });

  it('lê o payload LEGADO durante a janela de rollout', () => {
    const parsed = parseAgentJob({ mensagem_id: MSG, received_at_ms: 1 });
    expect(parsed).toEqual({ version: 1, mensagem_id: MSG, legacy: true });
    expect(agentJobIdentity(parsed!)).toBe(MSG);
  });

  it('V2 vence quando o payload carrega as duas formas (rollout misto)', () => {
    const parsed = parseAgentJob({ version: 2, turn_id: TURN, mensagem_id: MSG });
    expect(parsed?.version).toBe(2);
  });

  it('FAIL-CLOSED: payload desconhecido não vira execução', () => {
    expect(parseAgentJob({})).toBeNull();
    expect(parseAgentJob(null)).toBeNull();
    expect(parseAgentJob({ version: 2 })).toBeNull();
    expect(parseAgentJob({ version: 2, turn_id: 'não-é-uuid' })).toBeNull();
    expect(parseAgentJob({ mensagem_id: 'não-é-uuid' })).toBeNull();
    // Versão FUTURA (V3) não é lida como V1 por acidente: um consumidor antigo
    // que "quase entende" um payload novo é pior que um que o recusa.
    expect(parseAgentJob({ version: 3, turn_id: TURN })).toBeNull();
  });

  it('a versão corrente é 2', () => {
    expect(AGENT_TURN_JOB_VERSION).toBe(2);
  });
});

describe('#504 — elegibilidade do claim', () => {
  it('inclui as origens novas e EXCLUI outbound_pending e terminais', () => {
    expect([...CLAIM_ELIGIBLE_STATUSES].sort()).toEqual(
      ['claimed', 'queued', 'received', 'retryable', 'running'].sort(),
    );
    for (const forbidden of ['outbound_pending', 'completed', 'ignored', 'superseded', 'dead_letter']) {
      expect(CLAIM_ELIGIBLE_STATUSES).not.toContain(forbidden);
    }
  });

  it('takeover só a partir de claimed/running', () => {
    expect([...CLAIM_TAKEOVER_STATUSES].sort()).toEqual(['claimed', 'running']);
    for (const s of CLAIM_TAKEOVER_STATUSES) expect(CLAIM_ELIGIBLE_STATUSES).toContain(s);
  });
});

describe('#504 — configuração de lease', () => {
  it('aceita a relação segura (heartbeat <= TTL/3)', () => {
    expect(checkLeaseConfig({ ttl_ms: 60_000, heartbeat_ms: 20_000 })).toEqual({ ok: true });
    expect(checkLeaseConfig({ ttl_ms: 60_000, heartbeat_ms: 15_000 })).toEqual({ ok: true });
  });

  it('RECUSA heartbeat acima de um terço do TTL', () => {
    const check = checkLeaseConfig({ ttl_ms: 60_000, heartbeat_ms: 30_000 });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe('heartbeat_too_slow');
    // Exatamente no limite ainda passa; um milissegundo acima, não.
    expect(checkLeaseConfig({ ttl_ms: 30_000, heartbeat_ms: 10_000 }).ok).toBe(true);
    expect(checkLeaseConfig({ ttl_ms: 30_000, heartbeat_ms: 10_001 }).ok).toBe(false);
  });

  it('RECUSA TTL abaixo do piso e heartbeat não-positivo', () => {
    const ttl = checkLeaseConfig({ ttl_ms: LEASE_TTL_MIN_MS - 1, heartbeat_ms: 100 });
    expect(ttl.ok === false && ttl.reason).toBe('ttl_too_small');
    const hb = checkLeaseConfig({ ttl_ms: 60_000, heartbeat_ms: 0 });
    expect(hb.ok === false && hb.reason).toBe('heartbeat_not_positive');
  });

  it('a variante fail-loud lança em configuração insegura', () => {
    expect(() => assertLeaseConfig({ ttl_ms: 60_000, heartbeat_ms: 15_000 })).not.toThrow();
    expect(() => assertLeaseConfig({ ttl_ms: 60_000, heartbeat_ms: 59_000 })).toThrow(
      /lease insegura/,
    );
  });

  it('a razão máxima é um terço', () => {
    expect(LEASE_HEARTBEAT_MAX_RATIO).toBeCloseTo(1 / 3, 10);
  });
});

describe('#504 — backoff com jitter limitado', () => {
  it('mantém o atraso dentro de ±20% do base', () => {
    const base = 30_000;
    for (let i = 0; i <= 100; i++) {
      const value = jitteredDelayMs(base, () => i / 100);
      expect(value).toBeGreaterThanOrEqual(base * (1 - RETRY_JITTER_RATIO));
      expect(value).toBeLessThanOrEqual(base * (1 + RETRY_JITTER_RATIO));
    }
  });

  it('nunca devolve atraso negativo', () => {
    expect(jitteredDelayMs(10, () => 0)).toBeGreaterThanOrEqual(0);
  });

  it('espalha: dois sorteios distintos produzem atrasos distintos', () => {
    expect(jitteredDelayMs(30_000, () => 0)).not.toBe(jitteredDelayMs(30_000, () => 0.99));
  });
});

describe('#504 — erros tipados', () => {
  it('TurnFenceRejectedError carrega turno e operação', () => {
    const err = new TurnFenceRejectedError({
      turn_id: TURN,
      operation: 'conclude',
      claim_token: 'tok',
    });
    expect(err.code).toBe('TURN_FENCE_REJECTED');
    expect(err.turn_id).toBe(TURN);
    expect(err.operation).toBe('conclude');
    expect(err).toBeInstanceOf(Error);
  });

  it('TurnLeaseLostError carrega o motivo', () => {
    const err = new TurnLeaseLostError({ turn_id: TURN, reason: 'taken_over' });
    expect(err.code).toBe('TURN_LEASE_LOST');
    expect(err.reason).toBe('taken_over');
  });
});
