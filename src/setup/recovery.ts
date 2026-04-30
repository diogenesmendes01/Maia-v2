import { rm } from 'node:fs/promises';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { setupState } from './state.js';
import { rotateToken } from './token.js';
import { sendAlert } from '@/lib/alerts.js';

/** Mutable container — avoids Vitest live-binding getter wrapping of bare `let`. */
const _state = { recoveryPromise: null as Promise<void> | null };

const RECOVERY_ALERT_BODY = `A sessão WhatsApp da Maia foi derrubada (LoggedOut). Limpamos a sessão
antiga e geramos um novo bootstrap token automaticamente.

Para re-parear:
  1. SSH na VPS e leia o token novo:
     cat ${config.BAILEYS_AUTH_DIR}/setup-token.txt
  2. Abra no browser: <SUA_URL>/setup
  3. Cole o token na URL: ?token=<TOKEN>
  4. Escolha QR ou código de 8 dígitos.

Status atual: aguardando re-pareamento.
Token anterior está revogado.`;

/**
 * Triggered on Baileys `connection: 'close'` with `reason ===
 * DisconnectReason.loggedOut`. Idempotent via singleton in-flight promise:
 * concurrent triggers join the same execution.
 *
 * Steps (in order — note phase=unpaired BEFORE alert send so the alert body's
 * "aguardando re-pareamento" matches what /setup actually shows):
 *  1. setRecovering
 *  2. audit pairing_recovery_started
 *  3. shutdownBaileys (caller passes via injection)
 *  4. rm BAILEYS_AUTH_DIR
 *  5. rotateToken
 *  6. setUnpaired
 *  7. sendAlert (best-effort)
 *  8. audit pairing_recovery_completed
 *  9. startBaileys (caller passes via injection)
 */
export function triggerRecovery(deps: {
  shutdownBaileys: () => Promise<void>;
  startBaileys: () => Promise<void>;
}): Promise<void> {
  if (_state.recoveryPromise) return _state.recoveryPromise;
  _state.recoveryPromise = doRecovery(deps).finally(() => {
    _state.recoveryPromise = null;
  });
  return _state.recoveryPromise;
}

async function doRecovery(deps: {
  shutdownBaileys: () => Promise<void>;
  startBaileys: () => Promise<void>;
}): Promise<void> {
  setupState.setRecovering();
  await audit({ acao: 'pairing_recovery_started' });
  try {
    await deps.shutdownBaileys();
    await rm(config.BAILEYS_AUTH_DIR, { recursive: true, force: true });
    await rotateToken();
    setupState.setUnpaired();
    await sendAlert({
      subject: 'Maia desconectada — re-pareamento necessário',
      body: RECOVERY_ALERT_BODY,
    }).catch((err) => logger.warn({ err }, 'setup.recovery_alert_failed'));
    await audit({ acao: 'pairing_recovery_completed' });
    await deps.startBaileys();
  } catch (err) {
    logger.error({ err }, 'setup.recovery_failed_state_stays_recovering');
    // Don't reset phase — operator must SSH to investigate.
    throw err;
  }
}

/** Test-only export so we can verify the singleton lock from unit tests. */
export const _internal = {
  isRecovering: () => _state.recoveryPromise !== null,
  reset: () => {
    _state.recoveryPromise = null;
  },
};
