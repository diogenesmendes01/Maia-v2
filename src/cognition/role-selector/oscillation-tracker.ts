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

/**
 * [P88-H4] Cooldown window check. Blocks a switch when there was already
 * a switch in the last `cooldown_turns` decisions for this conversation.
 * Examines the N most recent rows and returns blocked=true if any of them
 * has action='switch'. Without conversa_id (legacy/anonymous flow) we
 * cannot enforce, so we never block.
 */
export async function isWithinCooldownWindow(args: {
  conversa_id: string;
  cooldown_turns: number;
}): Promise<{ blocked: boolean; recent_switches: number }> {
  if (!args.conversa_id || args.cooldown_turns <= 0) {
    return { blocked: false, recent_switches: 0 };
  }
  const recentSwitches = await roleSelectorDecisionsRepo.countSwitchesInLastNTurns({
    conversa_id: args.conversa_id,
    n: args.cooldown_turns,
  });
  return { blocked: recentSwitches > 0, recent_switches: recentSwitches };
}
