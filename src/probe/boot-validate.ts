/**
 * Sonda sintética (spec §1.3) — validação FAIL-FAST de boot + armamento do sink.
 *
 * Chamada no boot (src/index.ts) SÓ quando `MAIA_SYNTHETIC_PROBE=true`. Prova no
 * DB que o canal do triplete de sonda existe e é EXCLUSIVAMENTE sintético
 * (is_synthetic=true, tenant ≠ primary). Se não for, o boot FALHA — nunca sobe
 * com o sink armado apontando para um recurso não-sintético (o blast radius do
 * §1.3: silenciar todo o outbound de um tenant real). Só após a prova o sink é
 * ARMADO (sink-guard). Inerte (no-op) com a flag off.
 */
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { syntheticProbeRepo } from '../db/repositories/synthetic-probe-repos.js';
import { armProbeSink } from './sink-guard.js';
import { PROBE_SCOPE } from './constants.js';

export async function validateAndArmSyntheticProbe(): Promise<void> {
  if (!config.MAIA_SYNTHETIC_PROBE) return; // inerte com a flag off

  const check = await syntheticProbeRepo.checkChannelSynthetic(PROBE_SCOPE);
  if (!check.ok) {
    throw new Error(
      `synthetic_probe_boot_validation_failed: o canal ${PROBE_SCOPE.channel_id} ` +
        `(tenant ${PROBE_SCOPE.tenant_id}) não é exclusivamente sintético (${check.reason}). ` +
        `Recusando subir com o sink armado — ele poderia silenciar um tenant real. ` +
        `Rode a migração 094 e garanta que o seed da sonda está íntegro.`,
    );
  }

  armProbeSink();
  logger.info(
    { scope: PROBE_SCOPE, llm_judge: config.MAIA_PROBE_LLM_JUDGE, cron: config.MAIA_PROBE_CRON },
    'synthetic_probe.boot_validated_and_armed',
  );
}
