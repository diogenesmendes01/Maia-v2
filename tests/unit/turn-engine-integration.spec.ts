/**
 * K-15 · P12 · §5.7.1 — `decideTurnEngine`, o invólucro de produção da escolha
 * de motor.
 *
 * Cada caso aqui tem CONTRAPROVA: um par que falharia se a implementação
 * respondesse sempre a mesma coisa. Sem isso, "turno sem política cai em
 * maia_react" passa por vacuidade numa função que devolve `maia_react` para
 * tudo — que é exatamente o estado que este módulo termina.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decideTurnEngine,
  _overrideTurnEnginePorts,
  _resetTurnEnginePorts,
  type TurnEnginePortsV1,
} from '@/runtime/engines/integration.js';
import { createMaiaEngine } from '@/runtime/engines/maia-engine.js';
import type { AgentEnginePortV1, EnginePinV1 } from '@/runtime/engines/contracts.js';
import type { TurnEngineState } from '@/db/repositories/engine-repos.js';

const ESCOPO = { tenant_id: 'tn', agent_id: 'ag', channel_id: 'ch' } as const;

const PIN_HERMES: EnginePinV1 = {
  engine: 'hermes',
  adapter_revision: 'hermes-engine-0.1.0',
  configuration_digest: 'd-hermes',
  protocol_version: 1,
};

function motorFalso(pin: EnginePinV1): AgentEnginePortV1 {
  return {
    pin,
    start: vi.fn(async () => ({ kind: 'accepted', remote_run_id: 'r' }) as const),
    observe: vi.fn(async () => ({ kind: 'not_found', proof: 'inconclusive' }) as const),
    cancel: vi.fn(async () => ({ kind: 'unknown' }) as const),
  };
}

const HERMES = motorFalso(PIN_HERMES);

/**
 * O pin da porta LOCAL, reproduzido pelos mesmos defaults de `createMaiaEngine`
 * em vez de copiado como literal. Copiar o digest deixaria a spec passar depois
 * de uma mudança de revisão que quebraria o casamento de verdade.
 */
const PIN_LOCAL = createMaiaEngine({
  runReasoning: async () => {
    throw new Error('não executado');
  },
}).pin;

/** Portas padrão do caso feliz-local: sem kill switch, sem linha, sem motor. */
function portas(over: Partial<TurnEnginePortsV1> = {}): {
  readPolicy: ReturnType<typeof vi.fn>;
  canaryAllowsHermes: ReturnType<typeof vi.fn>;
} {
  const readPolicy = vi.fn(async () => null);
  const canaryAllowsHermes = vi.fn(async () => true);
  _overrideTurnEnginePorts({
    killSwitch: () => false,
    readPolicy,
    canaryAllowsHermes,
    hermesEngine: () => null,
    ...over,
  });
  return { readPolicy, canaryAllowsHermes };
}

const NOVO: TurnEngineState = { kind: 'no_binding' };

const pinado = (
  engine: string,
  adapter_revision = 'hermes-engine-0.1.0',
  configuration_digest = 'd-hermes',
): TurnEngineState => ({
  kind: 'binding_without_open_run',
  pin: { engine, adapter_revision, configuration_digest },
});

afterEach(() => {
  _resetTurnEnginePorts();
  vi.restoreAllMocks();
});

describe('turno NOVO — a linha e o degrau decidem', () => {
  it('sem linha de agent_engine_policies, o turno é do maia_react', async () => {
    portas();
    expect(await decideTurnEngine({ state: NOVO, scope: ESCOPO })).toEqual({
      kind: 'local',
      source: 'no_policy',
    });
  });

  it('CONTRAPROVA — com linha `hermes` e degrau liberado, o turno é do motor remoto', async () => {
    portas({
      readPolicy: vi.fn(async () => ({ engine: 'hermes' as const })),
      hermesEngine: () => HERMES,
    });
    expect(await decideTurnEngine({ state: NOVO, scope: ESCOPO })).toEqual({
      kind: 'remote',
      engine: HERMES,
      source: 'policy',
    });
  });

  it('a escada do canário vence a linha: `canary_hold`, não `policy`', async () => {
    portas({
      readPolicy: vi.fn(async () => ({ engine: 'hermes' as const })),
      canaryAllowsHermes: vi.fn(async () => false),
      hermesEngine: () => HERMES,
    });
    expect(await decideTurnEngine({ state: NOVO, scope: ESCOPO })).toEqual({
      kind: 'local',
      source: 'canary_hold',
    });
  });

  it('linha `hermes` sem instância do motor degrada com motivo PRÓPRIO', async () => {
    // O desfecho é o mesmo de `canary_hold` — o turno é atendido pelo motor
    // incumbente —, mas a remediação é outra: aqui falta implantação, não
    // degrau. Colapsar os dois faria o operador subir um degrau que já está
    // certo.
    portas({
      readPolicy: vi.fn(async () => ({ engine: 'hermes' as const })),
      hermesEngine: () => null,
    });
    expect(await decideTurnEngine({ state: NOVO, scope: ESCOPO })).toEqual({
      kind: 'local',
      source: 'hermes_unavailable',
    });
  });

  it('kill switch vence a linha E não deixa a política ser lida', async () => {
    const { readPolicy } = portas({
      killSwitch: () => true,
      readPolicy: vi.fn(async () => ({ engine: 'hermes' as const })),
      hermesEngine: () => HERMES,
    });
    expect(await decideTurnEngine({ state: NOVO, scope: ESCOPO })).toEqual({
      kind: 'local',
      source: 'kill_switch',
    });
    // Forçar `maia_react` não pode depender de a tabela responder.
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it('CONTRAPROVA do kill switch — sem ele, a política É lida', async () => {
    const { readPolicy } = portas();
    await decideTurnEngine({ state: NOVO, scope: ESCOPO });
    expect(readPolicy).toHaveBeenCalledTimes(1);
  });

  it('sem canal resolvido não há linha possível: `no_channel`, e nada é lido', async () => {
    const { readPolicy } = portas({
      readPolicy: vi.fn(async () => ({ engine: 'hermes' as const })),
      hermesEngine: () => HERMES,
    });
    expect(await decideTurnEngine({ state: NOVO, scope: { ...ESCOPO, channel_id: null } })).toEqual(
      { kind: 'local', source: 'no_channel' },
    );
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it('lookup que FALHOU não vira "sem linha"', async () => {
    portas({
      readPolicy: vi.fn(async () => {
        throw new Error('banco fora');
      }),
      hermesEngine: () => HERMES,
    });
    expect(await decideTurnEngine({ state: NOVO, scope: ESCOPO })).toEqual({
      kind: 'local',
      source: 'policy_lookup_failed',
    });
  });

  it('o degrau só é consultado quando a linha de fato quer Hermes', async () => {
    const { canaryAllowsHermes } = portas({
      readPolicy: vi.fn(async () => ({ engine: 'maia_react' as const })),
    });
    expect(await decideTurnEngine({ state: NOVO, scope: ESCOPO })).toEqual({
      kind: 'local',
      source: 'policy',
    });
    expect(canaryAllowsHermes).not.toHaveBeenCalled();
  });
});

describe('turno JÁ PINADO — o pin vence, e retry não troca de motor', () => {
  it('pin `hermes` usa o motor remoto sem consultar política nenhuma', async () => {
    // A linha diz `maia_react` e o degrau está fechado: se a política fosse
    // consultada, o turno mudaria de motor no retry — o cenário que o §5.8.2
    // proíbe.
    const { readPolicy, canaryAllowsHermes } = portas({
      readPolicy: vi.fn(async () => ({ engine: 'maia_react' as const })),
      canaryAllowsHermes: vi.fn(async () => false),
      hermesEngine: () => HERMES,
    });
    expect(await decideTurnEngine({ state: pinado('hermes'), scope: ESCOPO })).toEqual({
      kind: 'remote',
      engine: HERMES,
      source: 'pin',
    });
    expect(readPolicy).not.toHaveBeenCalled();
    expect(canaryAllowsHermes).not.toHaveBeenCalled();
  });

  it('CONTRAPROVA — pin `maia_react` fica local mesmo com linha e degrau para Hermes', async () => {
    const { readPolicy } = portas({
      readPolicy: vi.fn(async () => ({ engine: 'hermes' as const })),
      hermesEngine: () => HERMES,
    });
    const pinLocal = pinado(
      'maia_react',
      PIN_LOCAL.adapter_revision,
      PIN_LOCAL.configuration_digest,
    );
    expect(await decideTurnEngine({ state: pinLocal, scope: ESCOPO })).toEqual({
      kind: 'local',
      source: 'pin',
    });
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it('pin `maia_react` com revisão divergente RECUSA — não cai no laço local', async () => {
    // A instância local tem `adapter_revision`/`configuration_digest` próprios;
    // um pin que não bate descreve outro build. Atender assim mesmo seria
    // servir um motor diferente do pinado, que é a troca proibida.
    portas({ hermesEngine: () => HERMES });
    expect(
      await decideTurnEngine({ state: pinado('maia_react', 'outra-revisao'), scope: ESCOPO }),
    ).toEqual({ kind: 'refused', reason: 'pinned_engine_mismatch' });
  });

  it('pin `hermes` sem instância RECUSA o turno em vez de atendê-lo localmente', async () => {
    portas({ hermesEngine: () => null });
    expect(await decideTurnEngine({ state: pinado('hermes'), scope: ESCOPO })).toEqual({
      kind: 'refused',
      reason: 'pinned_engine_unavailable',
    });
  });

  it('pin de motor desconhecido RECUSA', async () => {
    portas({ hermesEngine: () => HERMES });
    expect(await decideTurnEngine({ state: pinado('gpt'), scope: ESCOPO })).toEqual({
      kind: 'refused',
      reason: 'pinned_engine_unknown',
    });
  });

  it('pin `hermes` com revisão divergente RECUSA por mismatch, não por ausência', async () => {
    portas({ hermesEngine: () => HERMES });
    expect(
      await decideTurnEngine({ state: pinado('hermes', 'hermes-engine-9.9.9'), scope: ESCOPO }),
    ).toEqual({ kind: 'refused', reason: 'pinned_engine_mismatch' });
  });

  it('um turno com RUN ABERTO também respeita o pin (o seam de rota decide antes)', async () => {
    const { readPolicy } = portas({ hermesEngine: () => HERMES });
    const comRun: TurnEngineState = {
      kind: 'open_run',
      pin: { ...PIN_HERMES },
      run: {
        id: 'run-1',
        phase: 'running',
        generation_no: 1,
        row_version: 1,
        submit_count: 1,
        remote_run_id: null,
        request_key: 'rk',
      },
    };
    expect(await decideTurnEngine({ state: comRun, scope: ESCOPO })).toEqual({
      kind: 'remote',
      engine: HERMES,
      source: 'pin',
    });
    expect(readPolicy).not.toHaveBeenCalled();
  });
});

describe('portas de produção', () => {
  it('sem override, o motor remoto NÃO existe neste build', async () => {
    // Não é preferência: `createHermesSupervisor` exige `python_executable`,
    // `worker_cwd`, `hermes_sha` e `home_root`, e o contrato de env não declara
    // nenhuma delas. Este caso é o guarda dessa afirmação — o dia em que a
    // implantação existir, ele falha e obriga a atualizar o registro.
    _resetTurnEnginePorts();
    _overrideTurnEnginePorts({
      killSwitch: () => false,
      readPolicy: async () => ({ engine: 'hermes' as const }),
      canaryAllowsHermes: async () => true,
    });
    expect(await decideTurnEngine({ state: NOVO, scope: ESCOPO })).toEqual({
      kind: 'local',
      source: 'hermes_unavailable',
    });
  });
});
