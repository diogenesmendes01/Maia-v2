/**
 * P07 (spec §5.8.2 última linha, §6.11; K-10) — qual motor atende um turno.
 *
 * O pin vive em `engine_turn_bindings` e não muda em retry (§5.7.1). Esta
 * função só cumpre o pin: turno sem pin usa o motor LOCAL (não há política de
 * engine por agente ainda, K-15), e turno pinado usa EXATAMENTE o motor e a
 * revisão pinados. Nunca troca Hermes por Maia para "cobrir" uma indisponibilidade
 * — trocar no meio de resultado ou efeito incerto é o que o §5.8.2 proíbe.
 */
import type { AgentEnginePortV1 } from './contracts.js';

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
