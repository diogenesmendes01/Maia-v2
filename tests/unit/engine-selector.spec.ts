/**
 * P07 (K-10) — o seletor cumpre o pin de `engine_turn_bindings` e nunca troca
 * de motor para cobrir indisponibilidade (§5.8.2).
 */
import { describe, expect, it } from 'vitest';
import type { AgentEnginePortV1, EngineKind } from '@/runtime/engines/contracts.js';
import { selectEngine } from '@/runtime/engines/selector.js';

function engine(kind: EngineKind, rev = 'r1', digest = 'd1'): AgentEnginePortV1 {
  return {
    pin: { engine: kind, adapter_revision: rev, configuration_digest: digest, protocol_version: 1 },
    start: async () => ({ kind: 'unknown', code: 'x' }),
    observe: async () => ({ kind: 'not_found', proof: 'inconclusive' }),
    cancel: async () => ({ kind: 'unknown' }),
  };
}

const maia = engine('maia_react');
const hermes = engine('hermes');
const pin = (e: string, rev = 'r1', digest = 'd1') => ({
  engine: e,
  adapter_revision: rev,
  configuration_digest: digest,
});

describe('selectEngine', () => {
  it('turno sem pin usa o motor local', () => {
    expect(selectEngine({ pin: null, engines: { maia_react: maia, hermes } })).toEqual({
      kind: 'ok',
      engine: maia,
    });
  });

  it('pin cumprido: cada motor atende o próprio pin', () => {
    expect(selectEngine({ pin: pin('hermes'), engines: { maia_react: maia, hermes } })).toEqual({
      kind: 'ok',
      engine: hermes,
    });
    expect(selectEngine({ pin: pin('maia_react'), engines: { maia_react: maia, hermes } })).toEqual({
      kind: 'ok',
      engine: maia,
    });
  });

  it('Hermes pinado e indisponível: recusa, NUNCA cai no local', () => {
    expect(
      selectEngine({ pin: pin('hermes'), engines: { maia_react: maia, hermes: null } }),
    ).toEqual({ kind: 'refused', reason: 'engine_unavailable' });
  });

  it('revisão ou configuração diferente do pin: recusa', () => {
    const engines = { maia_react: maia, hermes };
    expect(selectEngine({ pin: pin('hermes', 'r2'), engines })).toEqual({
      kind: 'refused',
      reason: 'pin_mismatch',
    });
    expect(selectEngine({ pin: pin('hermes', 'r1', 'd2'), engines })).toEqual({
      kind: 'refused',
      reason: 'pin_mismatch',
    });
  });

  it('motor desconhecido no pin: recusa', () => {
    expect(selectEngine({ pin: pin('gpt'), engines: { maia_react: maia, hermes } })).toEqual({
      kind: 'refused',
      reason: 'engine_unknown',
    });
  });
});
