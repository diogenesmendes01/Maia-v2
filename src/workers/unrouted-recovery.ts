/**
 * §1.4 do roteamento multi-linha (spec 2026-07-09 Draft v4) — recovery sweep
 * do staging de inbound não-roteado (`unrouted-job-recovery`, mesmo padrão do
 * runMessageRecovery):
 *
 *   1. EXPIRA rows pending vencidas (TTL 72h) + audit — o operador sabe o
 *      que se perdeu por nunca ter ganhado rota;
 *   2. RE-ARMA o job de replay de rows pending órfãs (crash entre o commit e
 *      o queue.add, ou job cujo retry esgotou) — o jobId estável torna o
 *      re-add idempotente: NUNCA dois jobs vivos para a mesma row;
 *   3. CANÁRIO do keyring: grita quando uma chave referenciada por rows
 *      pending saiu do keyring (regra operacional: chave só sai quando
 *      nenhuma pending a referencia).
 *
 * Roda todo minuto; barato quando a tabela está vazia (partial indexes).
 */
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';
import { audit } from '@/governance/audit.js';
import { inboundUnroutedRepo } from '@/db/repositories/inbound-unrouted-repos.js';
import { enqueueUnroutedReplay } from '@/gateway/queue.js';
import { parseKeyring } from '@/gateway/staging-crypto.js';

const STALE_AFTER_MS = 2 * 60_000;
const SWEEP_LIMIT = 200;

export async function runUnroutedRecovery(): Promise<void> {
  // 1. TTL: pending vencidas viram 'expired' (fail-loud via audit).
  const expired = await inboundUnroutedRepo.expireOverdue(SWEEP_LIMIT);
  if (expired.length > 0) {
    await audit({
      acao: 'inbound_unrouted_expired',
      metadata: {
        count: expired.length,
        unrouted_ids: expired.slice(0, 50).map((r) => r.id),
      },
    });
    logger.warn({ count: expired.length }, 'unrouted_recovery.expired');
  }

  // 2. Re-arma órfãs (idempotente pelo jobId estável).
  const stale = await inboundUnroutedRepo.listPendingStale(STALE_AFTER_MS, SWEEP_LIMIT);
  let rearmed = 0;
  for (const row of stale) {
    try {
      await enqueueUnroutedReplay({
        unrouted_id: row.id,
        line_external_id: row.line_external_id,
        whatsapp_message_id: row.whatsapp_message_id,
      });
      rearmed++;
    } catch (err) {
      logger.warn(
        { unrouted_id: row.id, err: (err as Error).message },
        'unrouted_recovery.rearm_failed',
      );
    }
  }
  if (rearmed > 0) logger.info({ rearmed }, 'unrouted_recovery.rearmed');

  // 3. Canário do keyring — só relevante quando há pendings.
  if (stale.length > 0 || expired.length > 0 || config.MAIA_CHANNEL_ROUTING_MODE === 'strict') {
    try {
      const pendingKeys = await inboundUnroutedRepo.listPendingKeyIds();
      if (pendingKeys.length > 0) {
        const keyring = parseKeyring();
        const missing = pendingKeys.filter((k) => !keyring.keys.has(k));
        if (missing.length > 0) {
          logger.error(
            { missing_key_ids: missing },
            'unrouted_recovery.keyring_missing_referenced_keys — rows pendentes ficarão indecifráveis; devolva a chave ao keyring',
          );
        }
      }
    } catch (err) {
      // Keyring ausente com pendings é o MESMO problema do canário.
      logger.error(
        { err: (err as Error).message },
        'unrouted_recovery.keyring_unavailable',
      );
    }
  }
}
