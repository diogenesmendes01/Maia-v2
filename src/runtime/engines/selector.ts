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
 *    flag global liga o Hermes. Falha de lookup recusa, nunca amplia. E a
 *    ESCADA do canário (§10.1, P12) também vence a linha: ligar o Hermes é
 *    conjunção de "a linha quer" e "o degrau já permite".
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
 *
 * ─── P12 (§10.1) — a ESCADA também vence a linha ───────────────────────────
 *
 * `canary_allows_hermes` é a resposta de `canaryAllows(policy,
 * 'hermes_live_turn')`, e ela entra aqui porque este é o único ponto do código
 * onde "este agente passa a usar o motor remoto" acontece. A escada do §10.1
 * põe `hermes_live_turn` em `live_informational`: abaixo disso, ligar o Hermes
 * numa conversa de verdade é pular degrau.
 *
 * Sem este gate, `agent_engine_policies` (145) sozinha bastava para ligar o
 * Hermes — uma linha de tabela, sem coorte cadastrada e sem evidência de
 * aceite. A escada existia como dado e como regra e não era consultada por
 * ninguém; era documentação executável, exatamente como a PR do P12 admitiu.
 *
 * As duas condições são CONJUNTAS e nenhuma implica a outra: a linha diz
 * "queremos Hermes neste canal", a escada diz "este agente já pode". Faltando
 * qualquer uma, `maia_react` — nunca recusa. Um agente fora do canário não
 * fica sem atendimento; ele é atendido pelo motor incumbente.
 */
export function resolveEngineForNewTurn(input: {
  policy: EnginePolicyV1 | null;
  kill_switch: boolean;
  canary_allows_hermes: boolean;
}): EngineKind {
  if (input.kill_switch) return 'maia_react';
  if (input.policy === null) return 'maia_react';
  if (input.policy.engine !== 'hermes') return 'maia_react';
  return input.canary_allows_hermes ? 'hermes' : 'maia_react';
}

export type NewTurnEngineLookupV1 =
  | {
      kind: 'ok';
      engine: EngineKind;
      /**
       * `canary_hold` é a linha `hermes` que a escada segurou. Ela é `ok` e
       * não recusa — o turno segue no motor incumbente —, mas precisa de nome
       * próprio: colapsá-la em `policy` faria o log dizer que a política
       * escolheu `maia_react`, quando a política escolheu `hermes` e foi o
       * degrau que não deixou. São as duas remediações opostas ("suba o
       * degrau" e "mude a linha") do mesmo desfecho observável.
       */
      source: 'kill_switch' | 'policy' | 'no_policy' | 'canary_hold';
    }
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
  /**
   * P12 — a escada. Em produção, `canaryCapabilityAllowed('hermes_live_turn')`
   * (`@/db/repositories/canary-policy-repos.js`), que já devolve `false` em
   * falha de leitura em vez de lançar: o degrau é um gate de capacidade, e uma
   * indisponibilidade de banco pode negar capacidade, nunca concedê-la.
   *
   * Injetada como `readPolicy`, e pelo mesmo motivo: este módulo é puro e
   * `canary-policy-repos` arrasta `../client.js`, que constrói o `pg.Pool` no
   * import.
   */
  canaryAllowsHermes: () => Promise<boolean>;
}): Promise<NewTurnEngineLookupV1> {
  if (input.kill_switch) return { kind: 'ok', engine: 'maia_react', source: 'kill_switch' };
  let policy: EnginePolicyV1 | null;
  try {
    policy = await input.readPolicy(input.scope);
  } catch {
    return { kind: 'refused', reason: 'policy_lookup_failed' };
  }
  if (policy === null) return { kind: 'ok', engine: 'maia_react', source: 'no_policy' };
  if (policy.engine !== 'hermes') return { kind: 'ok', engine: 'maia_react', source: 'policy' };

  // A escada só é consultada quando a linha de fato quer Hermes. Uma linha
  // `maia_react` já decidiu, e ler o degrau para confirmar o que não muda
  // seria uma consulta por turno sem pergunta por trás.
  const permitido = await input.canaryAllowsHermes();
  return permitido
    ? { kind: 'ok', engine: 'hermes', source: 'policy' }
    : { kind: 'ok', engine: 'maia_react', source: 'canary_hold' };
}
