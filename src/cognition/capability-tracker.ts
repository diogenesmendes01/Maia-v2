import { capabilitiesDomainRepo } from '@/db/repositories.js';
import { computeConfidence, daysSinceLastFailure } from './self-model.js';
import { logger } from '@/lib/logger.js';
import type { AgentCapabilityDomain } from '@/db/schema.js';

/**
 * P2 Task 14: capability-tracker — atualiza o self-model do agente quando
 * sinais de sucesso ou falha são observados.
 *
 * Em P2, `domain` é mantido simples ('general' default); P3+ refina a
 * extração (procedure context, topic detection). O `skill_name` é opcional
 * e fica reservado para P3+; em P2 só mexemos no nível de domínio.
 *
 * Confidence é recalculada deterministicamente via `computeConfidence`
 * (src/cognition/self-model.ts) — mesma fórmula usada pelo job de recompute.
 * Erros aqui NUNCA propagam: o tracker é fire-and-forget, o fluxo principal
 * (reflection/respose generation) não deve quebrar se a escrita falhar.
 */

const DEFAULT_DOMAIN = 'general';

// Cap on the failure_modes array — keeps the row small and gives us recency.
// Applied on write only via `.slice(-FAILURE_MODES_CAP)`; rows persisted under
// um cap maior continuam intactas até a próxima escrita, quando o trim os
// reduz. Lowering this constant não faz backfill — é eventual por design.
const FAILURE_MODES_CAP = 50;

export async function recordSuccess(args: { domain?: string }): Promise<void> {
  const domain = args.domain ?? DEFAULT_DOMAIN;
  try {
    const existing = await capabilitiesDomainRepo.findByDomain(domain);
    const success_count = (existing?.success_count ?? 0) + 1;
    const failure_count = existing?.failure_count ?? 0;
    const evidence_count = (existing?.evidence_count ?? 0) + 1;
    const last_failure = existing?.last_failure ?? null;
    const new_confidence = computeConfidence({
      success_count,
      failure_count,
      evidence_count,
      days_since_last_failure: daysSinceLastFailure(last_failure),
    });

    await capabilitiesDomainRepo.upsertConfidence(domain, {
      domain,
      success_count,
      failure_count,
      evidence_count,
      last_success: new Date(),
      last_failure,
      failure_modes: existing?.failure_modes ?? [],
      confidence: new_confidence.toFixed(3) as unknown as AgentCapabilityDomain['confidence'],
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, domain },
      'capability_tracker.success.failed',
    );
  }
}

export async function recordFailure(args: {
  domain?: string;
  failure_mode?: string;
}): Promise<void> {
  const domain = args.domain ?? DEFAULT_DOMAIN;
  try {
    const existing = await capabilitiesDomainRepo.findByDomain(domain);
    const success_count = existing?.success_count ?? 0;
    const failure_count = (existing?.failure_count ?? 0) + 1;
    const evidence_count = (existing?.evidence_count ?? 0) + 1;
    const existing_modes = (existing?.failure_modes as string[] | null) ?? [];
    const failure_modes = [
      ...existing_modes,
      args.failure_mode ?? 'unknown',
    ].slice(-FAILURE_MODES_CAP);
    const new_confidence = computeConfidence({
      success_count,
      failure_count,
      evidence_count,
      days_since_last_failure: 0, // just failed
    });

    await capabilitiesDomainRepo.upsertConfidence(domain, {
      domain,
      success_count,
      failure_count,
      evidence_count,
      last_success: existing?.last_success ?? null,
      last_failure: new Date(),
      failure_modes,
      confidence: new_confidence.toFixed(3) as unknown as AgentCapabilityDomain['confidence'],
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, domain },
      'capability_tracker.failure.failed',
    );
  }
}
