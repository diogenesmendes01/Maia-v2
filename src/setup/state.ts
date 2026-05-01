import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/lib/logger.js';

export const PAIRING_CODE_TTL_MS = 180 * 1000; // 180s — Baileys' pairing code lifetime

export type SetupPhase =
  | { phase: 'unpaired' }
  | { phase: 'pairing_qr'; qr: string | null }
  | { phase: 'pairing_code'; code: string; expiresAt: Date }
  | { phase: 'connected'; connectedAt: Date }
  | { phase: 'disconnected_transient'; since: Date }
  | { phase: 'recovering'; since: Date };

let state: SetupPhase = { phase: 'unpaired' };

class SetupState {
  /** Cheap accessor; performs lazy `pairing_code` TTL expiry on each read. */
  current(): SetupPhase {
    if (state.phase === 'pairing_code' && Date.now() > state.expiresAt.getTime()) {
      state = { phase: 'unpaired' };
    }
    return state;
  }

  /**
   * Called by Baileys QR callback (`gateway/baileys.ts:67`).
   * Auto-transitions `unpaired → pairing_qr` and `disconnected_transient →
   * pairing_qr` (Baileys emits QR on cold start before operator clicks
   * anything; and on the 5s reconnect when re-pair is needed).
   * On `pairing_qr` already, just updates `qr`.
   * On `connected` / `recovering` / `pairing_code`: ignored with warn log.
   */
  setQr(qr: string): void {
    const phase = this.current().phase;
    if (phase === 'unpaired' || phase === 'disconnected_transient' || phase === 'pairing_qr') {
      state = { phase: 'pairing_qr', qr };
      return;
    }
    logger.warn({ phase }, 'setup.setQr_ignored_invalid_phase');
  }

  /** Called when `triggerPairingCode` succeeds. Only valid from `unpaired`. */
  setCode(code: string): void {
    const phase = this.current().phase;
    if (phase !== 'unpaired') {
      throw new Error(`setup.setCode_invalid_transition: from ${phase}`);
    }
    state = {
      phase: 'pairing_code',
      code,
      expiresAt: new Date(Date.now() + PAIRING_CODE_TTL_MS),
    };
  }

  /**
   * Called on Baileys `connection: 'open'`. Unconditional set — valid from
   * `pairing_qr`, `pairing_code`, `disconnected_transient` (transient reconnect
   * with a still-valid session, no new QR/code), and as a defensive fallback
   * from any other phase. The `pairing_completed` audit is gated by the caller
   * (`baileys.ts`) so transient reconnects don't pollute the audit log.
   */
  markPaired(): void {
    state = { phase: 'connected', connectedAt: new Date() };
  }

  /** Called on Baileys `connection: 'close'` with reason ≠ loggedOut. */
  markDisconnected(): void {
    state = { phase: 'disconnected_transient', since: new Date() };
  }

  /** Recovery sets phase. Used by `recovery.ts`. */
  setRecovering(): void {
    state = { phase: 'recovering', since: new Date() };
  }

  /** Recovery completes. Used by `recovery.ts`. */
  setUnpaired(): void {
    state = { phase: 'unpaired' };
  }
}

export const setupState = new SetupState();

/**
 * Returns true if `<authDir>/creds.json` exists AND has a `me` field with a
 * phone number (Baileys' `useMultiFileAuthState` writes this on first
 * successful pair). Used by `src/index.ts` to gate the cold-start log.
 */
export async function hasValidBaileysSession(authDir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(authDir, 'creds.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { me?: { id?: string } };
    return typeof parsed.me?.id === 'string';
  } catch {
    return false;
  }
}
