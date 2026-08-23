/**
 * P6 Task 8 — Role Selector Engine (orquestrador).
 *
 * Cola tudo: roda os dois suggesters em paralelo (determinístico + LLM),
 * resolve conflitos (determinístico vence por ser mais barato e previsível),
 * delega a decisão final ao policy decider e SEMPRE registra a auditoria
 * em `role_selector_decisions` — mesmo quando `action='keep_current'`.
 *
 * Invariante (critério #3 da spec P6 done): TODA chamada a `selectRole`
 * gera exatamente 1 row em `role_selector_decisions`. Testado em
 * `tests/unit/role-audit-always-recorded.spec.ts`.
 *
 * Resolução de conflito entre suggesters:
 *  - Ambos sugerem o mesmo role → determinístico (origem auditável).
 *  - Discordam → determinístico vence; conflito registrado em `conflicts[]`.
 *  - Apenas um sugere → vence o que sugeriu.
 *  - Nenhum sugere → candidato null vai pro policy decider (que devolve
 *    keep_current/policy_default).
 */
import { roleSelectorDecisionsRepo } from '@/db/repositories.js';
import { llmSuggester } from './llm-suggester.js';
import { deterministicSuggester } from './deterministic-classifier.js';
import { decidePolicy } from './policy-decider.js';
import { SuggestedBy, RoleDecisionAction } from '@/types/enums.js';
import type { RoleSelectorInput, RoleCandidate } from './types.js';
import type { Role } from '@/db/schema.js';
import { assertTurnOwnership } from '@/runtime/turns/execution-context.js';

export type RoleSelectorResult = {
  decided_role: Role;
  action: RoleDecisionAction;
  decision_id: string;
};

export async function selectRole(input: RoleSelectorInput): Promise<RoleSelectorResult> {
  // Run both suggesters in parallel
  const [detResult, llmResult] = await Promise.all([
    deterministicSuggester.suggest(input),
    llmSuggester.suggest(input),
  ]);

  const candidates: RoleCandidate[] = [detResult, llmResult].filter(
    (c): c is RoleCandidate => c !== null,
  );
  const conflicts: Array<{ a: string; b: string; reason: string }> = [];

  // Prefer deterministic if both present and they agree
  // If they disagree, deterministic wins (cheaper, more predictable, audited via conflicts)
  let chosenCandidate: RoleCandidate | null;
  if (detResult && llmResult) {
    if (detResult.role_id === llmResult.role_id) {
      chosenCandidate = detResult;
    } else {
      conflicts.push({
        a: detResult.role_key,
        b: llmResult.role_key,
        reason: 'suggesters_disagree',
      });
      chosenCandidate = detResult;
    }
  } else {
    chosenCandidate = detResult ?? llmResult;
  }

  const decision = await decidePolicy({ input, candidate: chosenCandidate });

  // Compute switch count for audit
  const baseCount = input.conversa_id
    ? await roleSelectorDecisionsRepo.countSwitchesInConversation(input.conversa_id)
    : 0;
  const newSwitchCount =
    decision.action === RoleDecisionAction.SWITCH ? baseCount + 1 : baseCount;

  // Issue #507 (achado 2 da revisão do dono) — LIMITE DE EFEITO.
  //
  // "TODA chamada a selectRole gera exatamente 1 row" continua valendo para
  // toda chamada que CONCLUI. O que não pode existir é a row de uma tentativa
  // que já perdeu a posse do turno: `role_selector_decisions` é estado do
  // turno, e escrevê-lo depois do takeover é a gravação sem posse que a #504
  // fecha. Lançar aqui faz `runCognitiveModule` classificar o node como
  // `cancelled` (o sinal está abortado) — não como erro.
  //
  // Fora de um turno reivindicado o guard é NO-OP e o invariante é literal.
  assertTurnOwnership('role_selector_decision');

  // ALWAYS record — even for keep_current (spec §9 P6 done criterion #3)
  const recorded = await roleSelectorDecisionsRepo.record({
    conversa_id: input.conversa_id,
    turno_id: input.turno_id,
    channel_id: input.channel_id,
    policy_id: input.policy.id,
    current_role_id: input.current_role.id,
    suggested_role_id: chosenCandidate?.role_id,
    decided_role_id: decision.decided_role.id,
    action: decision.action,
    candidates: candidates.map((c) => ({
      role_key: c.role_key,
      confidence: c.confidence,
      strength: c.strength,
      suggested_by: c.suggested_by,
      reason: c.reason,
    })),
    conflicts,
    suggested_by: chosenCandidate?.suggested_by ?? SuggestedBy.NONE,
    decided_by: decision.decided_by,
    suggested_strength: chosenCandidate?.strength,
    suggested_confidence: chosenCandidate?.confidence,
    reason: decision.reason,
    switch_count_in_conversation: newSwitchCount,
  });

  return {
    decided_role: decision.decided_role,
    action: decision.action,
    decision_id: recorded.id,
  };
}
