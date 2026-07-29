/**
 * Issue #518 — vocabulário de estado de linha da tela de canais.
 *
 * São funções puras, mas carregam decisões de SEGURANÇA operacional:
 *   - uma linha ATIVA nunca oferece "parear" direto — re-parear passa pelo
 *     fluxo que encerra a posse de forma auditada;
 *   - uma linha `logged_out` não oferece "parear" tampouco: a posse acabou e
 *     o auth state precisa ser destruído antes;
 *   - todo estado do modelo tem apresentação (um estado novo sem tradução
 *     apareceria como "desconhecido" para o operador).
 */
import { describe, it, expect } from 'vitest';
import {
  presentState,
  presentReason,
  primaryAction,
  countdown,
  type LineState,
} from '@/admin-ui/app/setup/channels/_components/line-state.js';

const ALL_STATES: LineState[] = [
  'declared',
  'pairing',
  'aborting',
  'verified_offline',
  'connected',
  'recovering',
  'logged_out',
  'failed',
  'disabled',
];

describe('presentState', () => {
  it('cobre TODOS os estados do modelo — nenhum cai em "desconhecido"', () => {
    for (const s of ALL_STATES) {
      expect(presentState(s).label).not.toBe('desconhecido');
      expect(presentState(s).help.length).toBeGreaterThan(10);
    }
  });

  it('um estado desconhecido degrada de forma honesta, sem quebrar a tela', () => {
    expect(presentState('teleported').label).toBe('desconhecido');
  });

  it('conectada é sucesso; deslogada e falha são perigo', () => {
    expect(presentState('connected').tone).toBe('success');
    expect(presentState('logged_out').tone).toBe('danger');
    expect(presentState('failed').tone).toBe('danger');
  });
});

describe('primaryAction — a CTA não pode contradizer a posse', () => {
  it('linha ativa oferece RE-parear, nunca "parear"', () => {
    expect(primaryAction({ state: 'connected', active: true })).toBe('repair');
    expect(primaryAction({ state: 'verified_offline', active: true })).toBe('repair');
  });

  it('linha deslogada oferece re-parear (a posse acabou; o auth precisa ir embora)', () => {
    expect(primaryAction({ state: 'logged_out', active: false })).toBe('repair');
  });

  it('linha declarada, falhada ou desabilitada oferece parear', () => {
    expect(primaryAction({ state: 'declared', active: false })).toBe('pair');
    expect(primaryAction({ state: 'failed', active: false })).toBe('pair');
    expect(primaryAction({ state: 'disabled', active: false })).toBe('pair');
  });

  it('durante o pareamento não há CTA primária — só acompanhar/cancelar', () => {
    expect(primaryAction({ state: 'pairing', active: false })).toBeNull();
  });

  it('durante o CANCELAMENTO também não há CTA: o backend rejeitaria o start', () => {
    // Um botão "Parear" em `aborting` só devolveria CONFLICT — a sessão antiga
    // ainda pode estar viva. A UI espera a confirmação junto com o backend.
    expect(primaryAction({ state: 'aborting', active: false })).toBeNull();
  });
});

describe('presentReason', () => {
  it('traduz os códigos conhecidos', () => {
    expect(presentReason('line_mismatch')).toMatch(/não é o número declarado/);
    expect(presentReason('interrupted_retryable')).toMatch(/reiniciou/);
  });

  it('null continua null (sem "undefined" na tela)', () => {
    expect(presentReason(null)).toBeNull();
  });

  it('código desconhecido é exibido como veio (o vocabulário é fechado e sanitizado)', () => {
    expect(presentReason('algo_novo')).toBe('algo_novo');
  });
});

describe('countdown', () => {
  const NOW = new Date('2026-07-28T12:00:00Z').getTime();

  it('formata mm:ss', () => {
    expect(countdown(new Date(NOW + 90_000), NOW)).toBe('01:30');
    expect(countdown(new Date(NOW + 5_000), NOW)).toBe('00:05');
  });

  it('aceita ISO string (a resposta tRPC pode chegar serializada)', () => {
    expect(countdown('2026-07-28T12:01:00.000Z', NOW)).toBe('01:00');
  });

  it('nunca vai negativo — expirado é 00:00', () => {
    expect(countdown(new Date(NOW - 60_000), NOW)).toBe('00:00');
  });

  it('null e data inválida devolvem null', () => {
    expect(countdown(null, NOW)).toBeNull();
    expect(countdown('não é data', NOW)).toBeNull();
  });
});
