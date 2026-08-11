/**
 * Sonda sintética (spec §1.4) — cenários. v1: 1 cenário de tool (efeito
 * colateral verificável) + liveness. Cada cenário expõe o prompt, a intenção
 * (para o judge §1.4c) e a asserção primária por efeito colateral.
 */
import { findPendingTransacao, hasOutboundReply } from './queries.js';
import { PROBE_ENTIDADE_ID } from './constants.js';

export type ScenarioAssertion = {
  /** asserção PRIMÁRIA: a row de efeito (tool) esperada existe e está correta. */
  effect_satisfied: boolean;
  /** liveness: existe uma `mensagens direcao='out'` respondendo à entrada. */
  liveness: boolean;
  detail: Record<string, unknown>;
};

export type ProbeScenario = {
  id: string;
  prompt: string;
  intent: string;
  /** Asserção por efeito colateral, correlacionada por `mensagem_id`. */
  assert(mensagem_id: string): Promise<ScenarioAssertion>;
};

/** Valor do cenário — casado com a asserção. */
export const REGISTER_TRANSACTION_VALOR = 50;

export const registerTransactionPendenteScenario: ProbeScenario = {
  id: 'register_transaction_pendente',
  // Direcionado EXPLICITAMENTE a status='pendente' (§1.4): a tool aceita
  // paga/recebida, que mutariam contas.saldo_atual e exigiriam compensação no
  // cleanup. "pendente" + "ainda não paguei" tornam a escolha determinística e
  // o cleanup vira um delete idempotente.
  prompt:
    'Preciso registrar uma despesa PENDENTE (ainda não paguei) de R$ 50,00 de ' +
    'almoço, com data de competência de hoje. Por favor registre com status pendente.',
  intent:
    'Registrar, via a ferramenta de transações, uma despesa de R$ 50 (almoço) com status pendente.',
  async assert(mensagem_id) {
    const txn = await findPendingTransacao({
      mensagem_id,
      entidade_id: PROBE_ENTIDADE_ID,
      valor: REGISTER_TRANSACTION_VALOR,
      natureza: 'despesa',
    });
    const liveness = await hasOutboundReply(mensagem_id);
    return {
      effect_satisfied: txn !== null,
      liveness,
      detail: { transacao_id: txn?.id ?? null, conta_id: txn?.conta_id ?? null },
    };
  },
};

export const SCENARIOS: ProbeScenario[] = [registerTransactionPendenteScenario];

/**
 * Escolhe o cenário de forma DETERMINÍSTICA por janela de tick (§1.1 passo 2):
 * índice derivado do `now` injetado — sem Date.now() na lógica testável.
 */
export function pickScenario(nowMs: number): ProbeScenario {
  const idx = Math.floor(nowMs / 600_000) % SCENARIOS.length;
  return SCENARIOS[idx]!;
}
