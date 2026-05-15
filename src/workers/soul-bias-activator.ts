/**
 * P8b — soul-bias-activator worker (event-driven).
 *
 * Consome eventos de aprovação de `capability_proposals` cujo
 * `capability_type='soul_bias'` e materializa um row em `soul_biases`
 * via `soulBiasesRepo.propose()` + `soulBiasesRepo.activate()`.
 *
 * Quando deve ser chamado:
 *   - capability_proposal transição `submitted → approved` (event emitter)
 *   - manual replay via Admin UI (botão "Reprocess approved proposal")
 *
 * Idempotência: a função verifica se já existe bias com `proposal_id` igual
 * ao approved proposal. Se sim, no-op (já materializada).
 *
 * Falhas:
 *   - proposal não existe ou tipo errado → log + return early
 *   - propose falha → log + return early (proposta fica em "approved" sem bias)
 *   - activate falha por one_active conflict → log; bias fica como proposed
 *     no DB para owner reconciliar
 */
import { soulBiasesRepo } from '@/control-plane/soul/soul-biases-repo.js';
import type { SoulBiasProposalSpec } from '@/cognition/capability-proposer.js';
import { logger } from '@/lib/logger.js';

export type ActivatorResult =
  | { ok: true; bias_id: string; action: 'created_and_activated' | 'already_materialized' }
  | { ok: false; reason: string };

/**
 * Materializa uma soul_bias a partir de uma proposal aprovada.
 *
 * Assumes:
 *   - caller já validou que proposal existe e tem capability_type='soul_bias'
 *   - caller já validou que proposal.status === 'approved'
 *   - caller passa o `decided_by` para attribuir `approved_by` no bias
 *
 * Não chama o repo de proposals — separação de responsabilidades.
 * O wiring entre proposal approval → este worker fica em
 * `src/workers/index.ts` (event listener).
 */
export async function processSoulBiasProposalApproval(args: {
  proposal_id: string;
  spec: SoulBiasProposalSpec;
  decided_by: string;
}): Promise<ActivatorResult> {
  // Idempotência: se já existe bias com este proposal_id no tenant atual,
  // não cria duplicata. Verificamos via listProposed + findActiveForScope.
  // Em prod, um índice em soul_biases.proposal_id facilita a busca.
  const existing = await findExistingBiasForProposal(args.proposal_id);
  if (existing) {
    return {
      ok: true,
      bias_id: existing.id,
      action: 'already_materialized',
    };
  }

  // 1) Create proposed row
  let bias;
  try {
    bias = await soulBiasesRepo.propose({
      scope: args.spec.scope,
      scope_value: args.spec.scope_value,
      principle: args.spec.principle,
      guidance: args.spec.guidance,
      origin: args.spec.suggested_origin,
      strength: args.spec.suggested_strength,
      activation_context: args.spec.suggested_activation_context,
      proposed_by: `approval:${args.decided_by}`,
      proposed_reason: `approved from capability_proposal ${args.proposal_id}`,
      proposal_id: args.proposal_id,
      source_drift_alert_id: args.spec.source_drift_alert_id,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(
      { proposal_id: args.proposal_id, err: msg },
      'soul_bias_activator.propose_failed',
    );
    return { ok: false, reason: `propose_failed:${msg}` };
  }

  // 2) Activate (transição atomic deprecate-incumbent if needed)
  const activation = await soulBiasesRepo.activate({
    id: bias.id,
    approved_by: args.decided_by,
  });

  if (!activation.ok) {
    logger.warn(
      {
        proposal_id: args.proposal_id,
        bias_id: bias.id,
        reason: activation.reason,
      },
      'soul_bias_activator.activate_failed',
    );
    return { ok: false, reason: activation.reason };
  }

  logger.info(
    {
      proposal_id: args.proposal_id,
      bias_id: activation.bias.id,
      principle: activation.bias.principle,
    },
    'soul_bias_activator.activated',
  );

  return { ok: true, bias_id: activation.bias.id, action: 'created_and_activated' };
}

/**
 * Procura bias existente para este proposal_id (idempotência).
 * Usa listProposed + listVersions — não há método by-proposal-id no repo
 * ainda; em prod adicionar `findByProposalId` é trivial.
 */
async function findExistingBiasForProposal(
  proposal_id: string,
): Promise<{ id: string } | null> {
  // Busca em proposed + active (já materializadas).
  // Em P8b a busca varre as duas listas; performance OK para inboxes
  // pequenas, otimizar via index em soul_biases.proposal_id se necessário.
  const proposed = await soulBiasesRepo.listProposed({ limit: 100 });
  const active = await soulBiasesRepo.findActiveForScope({ limit: 100 });
  const all = [...proposed, ...active];
  return all.find((b) => b.proposal_id === proposal_id) ?? null;
}
