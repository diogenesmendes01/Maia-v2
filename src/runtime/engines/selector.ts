/**
 * P07 (spec §5.8.2 última linha, §6.11; K-10) e K-15 (§4.1) — qual motor atende
 * um turno.
 *
 * Duas perguntas, duas funções:
 *
 *  - **Turno já pinado** (`selectEngine`): o pin vive em `engine_turn_bindings`
 *    e não muda em retry (§5.7.1). Turno sem pin usa o motor LOCAL; turno
 *    pinado usa EXATAMENTE o motor e a revisão pinados. Nunca troca Hermes por
 *    Maia para "cobrir" indisponibilidade — trocar no meio de resultado ou
 *    efeito incerto é o que o §5.8.2 proíbe. Por isso o kill switch NÃO entra
 *    aqui: ele não muda turno já pinado.
 *  - **Turno novo, ainda sem pin** (`resolveEngineForNewTurn` /
 *    `lookupEngineForNewTurn`): lê a linha de `agent_engine_policies` do
 *    (tenant, agente, canal). Linha ausente = `maia_react`. O kill switch
 *    (`MAIA_HERMES_KILL_SWITCH`) vence a linha e só força `maia_react`; nenhuma
 *    flag global liga o Hermes. Falha de lookup recusa, nunca amplia.
 *
 * Não há call site de produção ainda: a fiação no `core.ts` é o P02.
 */
import type { AgentEnginePortV1, EngineKind } from './contracts.js';

export interface PersistedEnginePinV1 {
  engine: string;
  adapter_revision: string;
  configuration_digest: string;
}

export type EngineSelectionV1 =
  | { kind: 'ok'; engine: AgentEnginePortV1 }
  | { kind: 'refused'; reason: 'engine_unknown' | 'engine_unavailable' | 'pin_mismatch' };

export function selectEngine(input: {
  pin: PersistedEnginePinV1 | null;
  engines: { maia_react: AgentEnginePortV1; hermes: AgentEnginePortV1 | null };
}): EngineSelectionV1 {
  const { pin, engines } = input;
  if (pin === null) return { kind: 'ok', engine: engines.maia_react };
  let engine: AgentEnginePortV1 | null;
  if (pin.engine === 'maia_react') engine = engines.maia_react;
  else if (pin.engine === 'hermes') engine = engines.hermes;
  else return { kind: 'refused', reason: 'engine_unknown' };
  if (engine === null) return { kind: 'refused', reason: 'engine_unavailable' };
  if (
    engine.pin.engine !== pin.engine ||
    engine.pin.adapter_revision !== pin.adapter_revision ||
    engine.pin.configuration_digest !== pin.configuration_digest
  ) {
    return { kind: 'refused', reason: 'pin_mismatch' };
  }
  return { kind: 'ok', engine };
}

/** O que importa da linha de `agent_engine_policies` para decidir. */
export interface EnginePolicyV1 {
  engine: EngineKind;
}

export interface EnginePolicyScopeV1 {
  tenant_id: string;
  agent_id: string;
  channel_id: string;
}

/**
 * Decisão pura do turno novo. Kill switch vence a linha; linha ausente é
 * `maia_react`. Só a linha do escopo liga o Hermes.
 */
export function resolveEngineForNewTurn(input: {
  policy: EnginePolicyV1 | null;
  kill_switch: boolean;
}): EngineKind {
  if (input.kill_switch) return 'maia_react';
  if (input.policy === null) return 'maia_react';
  return input.policy.engine === 'hermes' ? 'hermes' : 'maia_react';
}

export type NewTurnEngineLookupV1 =
  | { kind: 'ok'; engine: EngineKind; source: 'kill_switch' | 'policy' | 'no_policy' }
  | { kind: 'refused'; reason: 'policy_lookup_failed' };

/**
 * A mesma decisão com a porta de leitura injetada (em produção,
 * `readEnginePolicyForScope`). Com o kill switch ligado a leitura nem acontece:
 * forçar `maia_react` não pode depender de a tabela responder. Sem ele, erro de
 * leitura é recusa tipada — diferente de "sem linha", que é `maia_react`.
 */
export async function lookupEngineForNewTurn(input: {
  scope: EnginePolicyScopeV1;
  kill_switch: boolean;
  readPolicy: (scope: EnginePolicyScopeV1) => Promise<EnginePolicyV1 | null>;
}): Promise<NewTurnEngineLookupV1> {
  if (input.kill_switch) return { kind: 'ok', engine: 'maia_react', source: 'kill_switch' };
  let policy: EnginePolicyV1 | null;
  try {
    policy = await input.readPolicy(input.scope);
  } catch {
    return { kind: 'refused', reason: 'policy_lookup_failed' };
  }
  return {
    kind: 'ok',
    engine: resolveEngineForNewTurn({ policy, kill_switch: false }),
    source: policy === null ? 'no_policy' : 'policy',
  };
}
