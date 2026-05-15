/**
 * P6 Task 7 — Oscillation tracker.
 *
 * Trava anti-oscilação consultada pelo policy decider (by_context). Conta
 * decisões action='switch' já registradas na conversa atual e bloqueia novas
 * trocas quando o limite `max_switches` é atingido. Defesa do criterio #4
 * da spec P6 (`by_context` com travas anti-osc previne >3 trocas/conversa
 * por default).
 *
 * Sem `conversa_id` (fluxo legacy/anônimo) → nunca bloqueia (não há histórico
 * para limitar). DB scope: o repo já filtra por tenant_id+agent_id via
 * tenant context.
 */
import { roleSelectorDecisionsRepo } from '@/db/repositories.js';

export async function shouldBlockSwitchByOscillation(args: {
  conversa_id: string;
  max_switches: number;
}): Promise<{ blocked: boolean; current_switches: number }> {
  if (!args.conversa_id) return { blocked: false, current_switches: 0 };
  const count = await roleSelectorDecisionsRepo.countSwitchesInConversation(args.conversa_id);
  return { blocked: count >= args.max_switches, current_switches: count };
}
