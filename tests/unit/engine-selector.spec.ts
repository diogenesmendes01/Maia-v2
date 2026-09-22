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
    expect(resolveEngineForNewTurn({ policy: null, kill_switch: false, canary_allows_hermes: true })).toBe('maia_react');
  });

  it('linha hermes liga hermes; linha maia_react fica em maia_react', () => {
    expect(resolveEngineForNewTurn({ policy: { engine: 'hermes' }, kill_switch: false, canary_allows_hermes: true })).toBe(
      'hermes',
    );
    expect(resolveEngineForNewTurn({ policy: { engine: 'maia_react' }, kill_switch: false, canary_allows_hermes: true })).toBe(
      'maia_react',
    );
  });

  it('kill switch vence a linha hermes', () => {
    expect(resolveEngineForNewTurn({ policy: { engine: 'hermes' }, kill_switch: true, canary_allows_hermes: true })).toBe(
      'maia_react',
    );
    expect(resolveEngineForNewTurn({ policy: null, kill_switch: true, canary_allows_hermes: true })).toBe('maia_react');
  });
});

describe('lookupEngineForNewTurn (K-15)', () => {
  const scope = { tenant_id: 't-a', agent_id: 'a-1', channel_id: 'c-1' };
  /** Degrau que já permite Hermes — os casos K-15 falam da LINHA, não da escada. */
  const liberado = async (): Promise<boolean> => true;

  it('lê a política do escopo pedido e usa a linha', async () => {
    const readPolicy = vi.fn(async () => ({ engine: 'hermes' as const }));
    expect(await lookupEngineForNewTurn({ scope, kill_switch: false, readPolicy, canaryAllowsHermes: liberado })).toEqual({
      kind: 'ok',
      engine: 'hermes',
      source: 'policy',
    });
    expect(readPolicy).toHaveBeenCalledWith(scope);
  });

  it('sem linha: maia_react, com a origem dita', async () => {
    expect(
      await lookupEngineForNewTurn({ scope, kill_switch: false, readPolicy: async () => null, canaryAllowsHermes: liberado }),
    ).toEqual({ kind: 'ok', engine: 'maia_react', source: 'no_policy' });
  });

  it('kill switch: maia_react sem ler a tabela', async () => {
    const readPolicy = vi.fn(async () => ({ engine: 'hermes' as const }));
    expect(await lookupEngineForNewTurn({ scope, kill_switch: true, readPolicy, canaryAllowsHermes: liberado })).toEqual({
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
    expect(await lookupEngineForNewTurn({ scope, kill_switch: false, readPolicy, canaryAllowsHermes: liberado })).toEqual({
      kind: 'refused',
      reason: 'policy_lookup_failed',
    });
  });
});

/**
 * P12 (§10.1) — a ESCADA no ponto onde o Hermes é ligado.
 *
 * Antes destes casos, `agent_engine_policies` sozinha bastava: uma linha de
 * tabela ligava o motor remoto sem coorte cadastrada e sem evidência de
 * aceite. A escada existia como dado (147) e como regra (`canary-policy.ts`) e
 * não era consultada por ninguém.
 *
 * As duas condições são conjuntas. A linha diz "queremos Hermes neste canal";
 * o degrau diz "este agente já pode". Faltando qualquer uma, `maia_react` —
 * nunca recusa, porque agente fora do canário não fica sem atendimento.
 */
describe('lookupEngineForNewTurn — a escada do canário (P12)', () => {
  const scope = { tenant_id: 't-a', agent_id: 'a-1', channel_id: 'c-1' };
  const querHermes = async (): Promise<{ engine: 'hermes' }> => ({ engine: 'hermes' });

  it('linha hermes + degrau abaixo de live: fica no motor incumbente', async () => {
    const r = await lookupEngineForNewTurn({
      scope,
      kill_switch: false,
      readPolicy: querHermes,
      canaryAllowsHermes: async () => false,
    });
    expect(r).toEqual({ kind: 'ok', engine: 'maia_react', source: 'canary_hold' });
  });

  it('`canary_hold` tem nome próprio — não é a linha dizendo maia_react', async () => {
    // Colapsar em `source: 'policy'` faria o log dizer que a política escolheu
    // o incumbente, quando ela escolheu Hermes e foi o degrau que não deixou.
    // "Suba o degrau" e "mude a linha" são remediações opostas.
    const r = await lookupEngineForNewTurn({
      scope,
      kill_switch: false,
      readPolicy: querHermes,
      canaryAllowsHermes: async () => false,
    });
    expect(r.kind === 'ok' && r.source).toBe('canary_hold');

    const semLinha = await lookupEngineForNewTurn({
      scope,
      kill_switch: false,
      readPolicy: async () => null,
      canaryAllowsHermes: async () => false,
    });
    expect(semLinha.kind === 'ok' && semLinha.source).toBe('no_policy');
  });

  it('linha hermes + degrau liberado: Hermes, como a linha pediu', async () => {
    // A contra-prova. Sem ela, um gate que negasse SEMPRE passaria nos casos
    // acima e o canário nunca sairia do lugar.
    const r = await lookupEngineForNewTurn({
      scope,
      kill_switch: false,
      readPolicy: querHermes,
      canaryAllowsHermes: async () => true,
    });
    expect(r).toEqual({ kind: 'ok', engine: 'hermes', source: 'policy' });
  });

  it('linha maia_react NÃO consulta a escada — pergunta sem consequência', async () => {
    // Uma consulta por turno para confirmar o que não muda é custo sem
    // pergunta por trás.
    const canaryAllowsHermes = vi.fn(async () => true);
    const r = await lookupEngineForNewTurn({
      scope,
      kill_switch: false,
      readPolicy: async () => ({ engine: 'maia_react' as const }),
      canaryAllowsHermes,
    });
    expect(r).toEqual({ kind: 'ok', engine: 'maia_react', source: 'policy' });
    expect(canaryAllowsHermes).not.toHaveBeenCalled();
  });

  it('kill switch não chega a consultar linha NEM escada', async () => {
    const readPolicy = vi.fn(querHermes);
    const canaryAllowsHermes = vi.fn(async () => true);
    const r = await lookupEngineForNewTurn({
      scope,
      kill_switch: true,
      readPolicy,
      canaryAllowsHermes,
    });
    expect(r).toEqual({ kind: 'ok', engine: 'maia_react', source: 'kill_switch' });
    expect(readPolicy).not.toHaveBeenCalled();
    expect(canaryAllowsHermes).not.toHaveBeenCalled();
  });

  it('o degrau vence a linha TAMBÉM no resolvedor puro', async () => {
    // Os dois caminhos precisam concordar: quem chamar a decisão pura sem
    // passar pela porta de leitura não pode obter uma resposta mais permissiva.
    expect(
      resolveEngineForNewTurn({
        policy: { engine: 'hermes' },
        kill_switch: false,
        canary_allows_hermes: false,
      }),
    ).toBe('maia_react');
  });
});
