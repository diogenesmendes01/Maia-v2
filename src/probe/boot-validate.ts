/**
 * Sonda sintética (spec §1.3 / review P1-C) — inicialização do sink no boot.
 *
 * DUAS coisas, uma SEMPRE e outra gated pela flag:
 *  1. SEMPRE (independente de MAIA_SYNTHETIC_PROBE): carrega o conjunto dos
 *     `channels.id` marcados `is_synthetic=true` no gate do sink. Assim a
 *     impossibilidade de envio físico a um canal sintético vale mesmo com a
 *     flag off / no kill-switch / após restart, cobrindo um job antigo ainda
 *     na fila que chegue a `buildOutput`.
 *  2. SÓ com a flag on: valida fail-fast que o canal do triplete CONFIGURADO é
 *     exclusivamente sintético (is_synthetic=true, tenant ≠ primary). Se não
 *     for, o boot FALHA — nunca sobe a sonda apontando para um recurso real.
 *
 * Deve rodar ANTES do worker de agente (para o sink já estar carregado quando
 * qualquer job for processado).
 */
import { config } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { syntheticProbeRepo } from '../db/repositories/synthetic-probe-repos.js';
import { loadSyntheticChannelIds, syntheticChannelCount } from './sink-guard.js';
import { PROBE_SCOPE } from './constants.js';

export async function initSyntheticProbe(): Promise<void> {
  // 1. SEMPRE — sink flag-independente.
  const ids = await syntheticProbeRepo.listSyntheticChannelIds();
  loadSyntheticChannelIds(ids);
  logger.info({ synthetic_channels: syntheticChannelCount() }, 'synthetic_probe.sink_loaded');

  // 2. Flag-gated — validação fail-fast do triplete configurado.
  if (!config.MAIA_SYNTHETIC_PROBE) return;
  const check = await syntheticProbeRepo.checkChannelSynthetic(PROBE_SCOPE);
  if (!check.ok) {
    throw new Error(
      `synthetic_probe_boot_validation_failed: o canal ${PROBE_SCOPE.channel_id} ` +
        `(tenant ${PROBE_SCOPE.tenant_id}) não é exclusivamente sintético (${check.reason}). ` +
        `Recusando subir a sonda apontando para um recurso não-sintético. ` +
        `Rode a migração 094 e garanta que o seed da sonda está íntegro.`,
    );
  }
  logger.info(
    { scope: PROBE_SCOPE, llm_judge: config.MAIA_PROBE_LLM_JUDGE, cron: config.MAIA_PROBE_CRON },
    'synthetic_probe.boot_validated',
  );
}
