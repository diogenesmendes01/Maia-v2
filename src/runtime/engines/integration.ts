/**
 * P02 · K-15 · P12 (spec §5.2, §5.7.1, §5.8.2, §10.1) — QUAL MOTOR ATENDE ESTE
 * TURNO, no caminho quente.
 *
 * ─── O buraco que este módulo fecha ─────────────────────────────────────────
 *
 * `lookupEngineForNewTurn` e `selectEngine` (`./selector.js`) existiam sem
 * nenhum call site de produção. A decisão "maia_react ou hermes" era pura,
 * testada e NUNCA TOMADA: todo turno caía no laço local por AUSÊNCIA de
 * decisão, não por decisão. A diferença não é filosófica — ela aparece no dia
 * em que alguém insere uma linha em `agent_engine_policies`, sobe o degrau do
 * canário, e nada acontece: sem log, sem métrica, sem nada para procurar.
 *
 * Este módulo é o invólucro de PRODUÇÃO dessa decisão, no mesmo desenho de
 * `@/runtime/decision/integration.ts`: as portas de banco entram por injeção
 * (e por import TARDIO, porque `engine-policy-repos` e `canary-policy-repos`
 * arrastam `../client.js`, que constrói o `pg.Pool` no import), e o `core.ts`
 * chama UMA função.
 *
 * ─── Por que a decisão é tomada logo depois do claim ────────────────────────
 *
 * No mesmo ponto do seam de rota (`routeExistingEngineRun`), e pelo mesmo
 * motivo: é o primeiro instante em que existe posse e em que o turno ainda não
 * reexecutou nada. Perguntar "qual motor?" na altura do reasoner responderia
 * tarde — o pipeline inteiro já teria rodado sob a premissa de um motor que
 * ninguém escolheu, e a resposta chegaria depois das pendências, das
 * procedures e das skills, que é exatamente o erro que o §5.2 nomeia.
 *
 * ─── O PIN vence a política, sempre ─────────────────────────────────────────
 *
 * Turno com binding em `engine_turn_bindings` não consulta política nenhuma:
 * ele usa EXATAMENTE o motor pinado (§5.7.1), e um pin que este processo não
 * consegue honrar RECUSA o turno em vez de trocar de motor. Trocar seria o
 * cenário que o §5.8.2 proíbe — reexecutar num motor diferente um turno cujo
 * resultado ou efeito é incerto.
 *
 * ─── O que este módulo NÃO faz, e o que falta para que possa fazer ──────────
 *
 * Ele não PINA o motor e não prepara run. `pinEngineAndPrepareRun`
 * (`@/db/repositories/engine-repos.ts:1045`) exige dois dados que não têm
 * produtor nenhum nesta árvore:
 *
 *  1. `control_id` de uma linha de `conversation_controls`. A migration 140
 *     declara `engine_runs.control_id uuid NOT NULL` com FK para aquela tabela
 *     (`migrations/140_engine_run_journal.sql:181,234`), e NADA em `src/`
 *     insere nela: `conversation-control-repo.ts` só faz UPDATE (pause/resume)
 *     e a 148 registra em comentário que "NULL = nao havia controle (equivale
 *     a modo bot)". Sem linha, `lockControl` devolve `not_found` e a
 *     preparação recusa.
 *  2. `manifest_digest` de um `RuntimeManifestV1` COMPILADO. `manifest.ts` só
 *     oferece `parseRuntimeManifest`/`computeManifestDigest`; ninguém COMPILA
 *     um. O schema exige `runtime_pin.hermes_sha`, `image_digest` e
 *     `dependency_lock_digest` — fatos de implantação que o contrato de env
 *     (`src/config/contract.ts`) não declara.
 *
 * Pinar um motor que este processo não consegue executar seria PIOR que não
 * pinar: o pin é imutável (§5.7.1), e um binding `hermes` num turno que o
 * `maia_react` atendeu é um registro durável que mente — e é sobre ele que o
 * recovery decide depois.
 */
import { config } from '@/config/env.js';
import { incCounter } from '@/lib/metrics.js';
import { logger } from '@/lib/logger.js';
import type { TurnEngineState } from '@/db/repositories/engine-repos.js';
import type { AgentEnginePortV1 } from './contracts.js';
import { createMaiaEngine } from './maia-engine.js';
import {
  lookupEngineForNewTurn,
  selectEngine,
  type EnginePolicyScopeV1,
  type EnginePolicyV1,
  type PersistedEnginePinV1,
} from './selector.js';

// ─── portas ─────────────────────────────────────────────────────────────────

/**
 * As portas que esta decisão precisa do mundo. Injetadas pela mesma razão que
 * em `MaiaEngine` e no gateway de tools: sem injeção, exercitar a decisão
 * exigiria Postgres, e o que se prova de um caminho assim é quase nada.
 */
export type TurnEnginePortsV1 = {
  /** `MAIA_HERMES_KILL_SWITCH`. Só DESLIGA o Hermes; nunca o liga. */
  killSwitch(): boolean;
  readPolicy(scope: EnginePolicyScopeV1): Promise<EnginePolicyV1 | null>;
  canaryAllowsHermes(): Promise<boolean>;
  /**
   * A instância do motor remoto neste processo, ou `null` quando ele não é
   * executável aqui.
   *
   * Fora de `withSyntheticCore`, permanece null: não inventa deployment live.
   * A composição async-scoped é backend-only e aceita apenas deployment
   * synthetic/local_ipc_v1. Admissão revalida canary/canal/policy no banco
   * antes de persistir request e antes de qualquer I/O do worker.
   */
  hermesEngine(): AgentEnginePortV1 | null;
};

import { getSyntheticCoreRuntime } from './synthetic-core-context.js';

const PRODUCTION_PORTS: TurnEnginePortsV1 = {
  killSwitch: () => config.MAIA_HERMES_KILL_SWITCH,
  async readPolicy(escopo) {
    const { readEnginePolicyForScope } = await import('@/db/repositories/engine-policy-repos.js');
    return readEnginePolicyForScope(escopo);
  },
  async canaryAllowsHermes() {
    const { canaryAllowsHermesLiveTurn, canaryPolicyRepo } =
      await import('@/db/repositories/canary-policy-repos.js');
    if (getSyntheticCoreRuntime()) return (await canaryPolicyRepo.find())?.stage === 'synthetic';
    return canaryAllowsHermesLiveTurn();
  },
  hermesEngine: () => getSyntheticCoreRuntime()?.engine ?? null,
};

let portasAtivas: TurnEnginePortsV1 = PRODUCTION_PORTS;

/** Substitui portas em teste. Só o que for passado muda. */
export function _overrideTurnEnginePorts(parcial: Partial<TurnEnginePortsV1>): void {
  portasAtivas = { ...portasAtivas, ...parcial };
}

export function _resetTurnEnginePorts(): void {
  portasAtivas = PRODUCTION_PORTS;
  portaLocal = null;
}

// ─── a porta local ──────────────────────────────────────────────────────────

/**
 * A instância do motor LOCAL atrás da porta.
 *
 * Ela existe para UMA pergunta: `selectEngine` compara o pin persistido com o
 * pin da instância, e para responder a um pin `maia_react` (ou para RECUSAR um
 * pin local com revisão divergente) ele precisa da instância local.
 *
 * Ela nunca é EXECUTADA neste build. O laço da casa ainda não passa pela porta
 * — a extração de `runReActLoop` para `RunReasoningV1` é fatia própria, e o
 * cabeçalho de `maia-engine.ts` a nomeia como tal —, então o `core.ts` continua
 * chamando o laço direto e a decisão `local` devolve ANTES de qualquer `start`.
 *
 * O `runReasoning` devolve `protocol_error` em vez de lançar por dois motivos:
 * o contrato da porta diz que `start` não lança (fora de perda de posse), e um
 * `throw` aqui seria capturado pelo próprio `MaiaEngine` e traduzido em
 * `reasoner_failed` — indistinguível de um modelo que falhou. `protocol_error`
 * é o código que significa "este build não sabe executar isto", que é o fato.
 */
let portaLocal: AgentEnginePortV1 | null = null;

function motorLocal(): AgentEnginePortV1 {
  portaLocal ??= createMaiaEngine({
    runReasoning: async () => ({
      stop: { kind: 'failed', code: 'protocol_error' },
      iterations: 0,
      observed_tool_call_ids: [],
      usage: {
        input_tokens: null,
        output_tokens: null,
        cost_microusd: null,
        source: 'unavailable',
      },
    }),
  });
  return portaLocal;
}

// ─── a decisão ──────────────────────────────────────────────────────────────

export type TurnEngineScopeV1 = {
  tenant_id: string;
  agent_id: string;
  /** `null` quando o canal não foi resolvido para este turno. */
  channel_id: string | null;
};

/**
 * Por que o turno terminou no motor que terminou. Fechado de propósito: o
 * valor vira rótulo de métrica e chave de log, e um motivo livre viraria
 * cardinalidade infinita e um rótulo que ninguém consegue procurar depois.
 *
 * `canary_hold` e `hermes_unavailable` são os dois que merecem existir
 * separados de `policy`: nos três o turno é atendido por `maia_react`, mas as
 * remediações são opostas — "suba o degrau", "configure o worker" e "mude a
 * linha". Colapsá-los faria o log dizer que a política escolheu o motor local,
 * quando a política escolheu o remoto e foi outra coisa que não deixou.
 */
export type TurnEngineSourceV1 =
  | 'kill_switch'
  | 'no_policy'
  | 'policy'
  | 'canary_hold'
  | 'no_channel'
  | 'policy_lookup_failed'
  | 'hermes_unavailable'
  | 'pin';

export type TurnEngineDecisionV1 =
  /** Segue o laço da casa, exatamente como sempre. */
  | { kind: 'local'; source: TurnEngineSourceV1 }
  /** O motor remoto atende. Instância resolvida, pronta para receber o run. */
  | { kind: 'remote'; engine: AgentEnginePortV1; source: 'policy' | 'pin' }
  /**
   * O turno tem pin e este processo NÃO consegue honrá-lo. Não é "atende com
   * o outro motor": isso é a troca que o §5.8.2 proíbe num turno pinado.
   */
  | {
      kind: 'refused';
      reason: 'pinned_engine_unavailable' | 'pinned_engine_mismatch' | 'pinned_engine_unknown';
    };

const RECUSA_DO_PIN = {
  engine_unavailable: 'pinned_engine_unavailable',
  pin_mismatch: 'pinned_engine_mismatch',
  engine_unknown: 'pinned_engine_unknown',
} as const;

/**
 * Qual motor atende este turno.
 *
 * `state` é o que o seam de rota já leu (`findTurnEngineState`): reusá-lo
 * evita uma segunda consulta e — o que importa mais — garante que a rota e a
 * escolha do motor olham para O MESMO instante do banco. Duas leituras
 * poderiam discordar entre si, e a discordância só apareceria sob recovery
 * concorrente, que é onde ninguém quer descobrir.
 */
export async function decideTurnEngine(input: {
  state: TurnEngineState;
  scope: TurnEngineScopeV1;
}): Promise<TurnEngineDecisionV1> {
  const portas = portasAtivas;
  const decisao =
    input.state.kind === 'no_binding'
      ? await decidirTurnoNovo(input.scope, portas)
      : decidirTurnoPinado(input.state.pin, portas);
  registrar(decisao, input.scope);
  return decisao;
}

function decidirTurnoPinado(
  pin: PersistedEnginePinV1,
  portas: TurnEnginePortsV1,
): TurnEngineDecisionV1 {
  const selecao = selectEngine({
    pin,
    engines: { maia_react: motorLocal(), hermes: portas.hermesEngine() },
  });
  if (selecao.kind === 'refused') {
    return { kind: 'refused', reason: RECUSA_DO_PIN[selecao.reason] };
  }
  return selecao.engine.pin.engine === 'hermes'
    ? { kind: 'remote', engine: selecao.engine, source: 'pin' }
    : { kind: 'local', source: 'pin' };
}

async function decidirTurnoNovo(
  escopo: TurnEngineScopeV1,
  portas: TurnEnginePortsV1,
): Promise<TurnEngineDecisionV1> {
  // Sem canal resolvido não existe linha de `agent_engine_policies` que possa
  // casar: a tabela é chaveada por (tenant, agente, CANAL). Perguntar com um
  // canal inventado — `'default'`, string vazia — leria a política de outro
  // escopo, que é o literal proibido do AGENTS.md §4.8. Ausência de canal é
  // ausência de linha, e ausência de linha é `maia_react`.
  if (escopo.channel_id === null) return { kind: 'local', source: 'no_channel' };

  const r = await lookupEngineForNewTurn({
    scope: {
      tenant_id: escopo.tenant_id,
      agent_id: escopo.agent_id,
      channel_id: escopo.channel_id,
    },
    kill_switch: portas.killSwitch(),
    readPolicy: portas.readPolicy,
    canaryAllowsHermes: portas.canaryAllowsHermes,
  });

  // Lookup que FALHOU não é "sem linha" — o repositório lança em vez de
  // devolver `null` justamente para que esta distinção exista. O turno segue
  // no motor incumbente (recusar atendimento porque uma tabela de política
  // está ilegível deixaria o usuário sem resposta por causa de um canário),
  // mas com motivo próprio e `ops_alert`: o desfecho é o mesmo de "sem linha",
  // a causa não é, e é a causa que alguém precisa consertar.
  if (r.kind === 'refused') return { kind: 'local', source: 'policy_lookup_failed' };
  if (r.engine !== 'hermes') return { kind: 'local', source: r.source };

  const hermes = portas.hermesEngine();
  if (hermes === null) return { kind: 'local', source: 'hermes_unavailable' };
  return { kind: 'remote', engine: hermes, source: 'policy' };
}

/**
 * A decisão vira métrica e log SEMPRE, inclusive no caminho trivial.
 *
 * O caminho trivial é justamente o que precisa ser contado: sem
 * `maia_turn_engine_selection_total{engine="maia_react",source="no_policy"}`
 * não existe denominador, e "zero turnos no Hermes" fica indistinguível de
 * "a decisão não está sendo tomada" — que é exatamente o estado que este
 * módulo termina.
 */
function registrar(decisao: TurnEngineDecisionV1, escopo: TurnEngineScopeV1): void {
  const engine =
    decisao.kind === 'remote' ? 'hermes' : decisao.kind === 'local' ? 'maia_react' : 'refused';
  const source = decisao.kind === 'refused' ? decisao.reason : decisao.source;
  incCounter('maia_turn_engine_selection_total', { engine, source });

  // `canary_hold`, `hermes_unavailable` e `policy_lookup_failed` são os três
  // em que alguém pediu o motor remoto e não o recebeu. Silenciá-los faria a
  // coorte do canário parecer vazia quando ela está configurada e retida.
  const alerta =
    decisao.kind === 'refused' ||
    (decisao.kind === 'local' &&
      (decisao.source === 'hermes_unavailable' || decisao.source === 'policy_lookup_failed'));

  const campos = {
    tenant_id: escopo.tenant_id,
    agent_id: escopo.agent_id,
    channel_id: escopo.channel_id,
    engine,
    source,
    ...(alerta ? { ops_alert: true } : {}),
  };

  if (alerta) logger.warn(campos, 'agent.turn_engine_selected');
  else logger.debug(campos, 'agent.turn_engine_selected');
}
