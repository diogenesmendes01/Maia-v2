/**
 * P07 (K-10) — o seletor cumpre o pin de `engine_turn_bindings` e nunca troca
 * de motor para cobrir indisponibilidade (§5.8.2).
 *
 * K-15 — turno novo: linha de `agent_engine_policies` por escopo, linha ausente
 * = `maia_react`, kill switch vence a linha, falha de lookup recusa.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentEnginePortV1, EngineKind } from '@/runtime/engines/contracts.js';
import {
  lookupEngineForNewTurn,
  resolveEngineForNewTurn,
  selectEngine,
} from '@/runtime/engines/selector.js';

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
    expect(selectEngine({ pin: pin('maia_react'), engines: { maia_react: maia, hermes } })).toEqual(
      {
        kind: 'ok',
        engine: maia,
      },
    );
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

describe('resolveEngineForNewTurn (K-15)', () => {
  it('linha ausente cai em maia_react', () => {
    expect(resolveEngineForNewTurn({ policy: null, kill_switch: false })).toBe('maia_react');
  });

  it('linha hermes liga hermes; linha maia_react fica em maia_react', () => {
    expect(resolveEngineForNewTurn({ policy: { engine: 'hermes' }, kill_switch: false })).toBe(
      'hermes',
    );
    expect(resolveEngineForNewTurn({ policy: { engine: 'maia_react' }, kill_switch: false })).toBe(
      'maia_react',
    );
  });

  it('kill switch vence a linha hermes', () => {
    expect(resolveEngineForNewTurn({ policy: { engine: 'hermes' }, kill_switch: true })).toBe(
      'maia_react',
    );
    expect(resolveEngineForNewTurn({ policy: null, kill_switch: true })).toBe('maia_react');
  });
});

describe('lookupEngineForNewTurn (K-15)', () => {
  const scope = { tenant_id: 't-a', agent_id: 'a-1', channel_id: 'c-1' };

  it('lê a política do escopo pedido e usa a linha', async () => {
    const readPolicy = vi.fn(async () => ({ engine: 'hermes' as const }));
    expect(await lookupEngineForNewTurn({ scope, kill_switch: false, readPolicy })).toEqual({
      kind: 'ok',
      engine: 'hermes',
      source: 'policy',
    });
    expect(readPolicy).toHaveBeenCalledWith(scope);
  });

  it('sem linha: maia_react, com a origem dita', async () => {
    expect(
      await lookupEngineForNewTurn({ scope, kill_switch: false, readPolicy: async () => null }),
    ).toEqual({ kind: 'ok', engine: 'maia_react', source: 'no_policy' });
  });

  it('kill switch: maia_react sem ler a tabela', async () => {
    const readPolicy = vi.fn(async () => ({ engine: 'hermes' as const }));
    expect(await lookupEngineForNewTurn({ scope, kill_switch: true, readPolicy })).toEqual({
      kind: 'ok',
      engine: 'maia_react',
      source: 'kill_switch',
    });
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it('falha de lookup recusa; não vira maia_react nem hermes', async () => {
    const readPolicy = async (): Promise<null> => {
      throw new Error('conexão caiu');
    };
    expect(await lookupEngineForNewTurn({ scope, kill_switch: false, readPolicy })).toEqual({
      kind: 'refused',
      reason: 'policy_lookup_failed',
    });
  });
});
