import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';

const TOKEN_FILE = (): string => join(config.BAILEYS_AUTH_DIR, 'setup-token.txt');

/**
 * Returns the current bootstrap token. If SETUP_TOKEN_OVERRIDE is set, returns
 * it (env-bypass for dev/test). Otherwise reads from `<BAILEYS_AUTH_DIR>/
 * setup-token.txt`. If missing, atomically creates a new 32-hex-char token
 * (mode 0o600) and emits `setup_token_rotated` audit with reason='cold_start'.
 *
 * Atomic create via `flag: 'wx'` — concurrent writers race-safely; the loser
 * re-reads the winner's file.
 */
export async function ensureToken(): Promise<string> {
  if (config.SETUP_TOKEN_OVERRIDE) return config.SETUP_TOKEN_OVERRIDE;

  const tokenPath = TOKEN_FILE();
  try {
    return (await readFile(tokenPath, 'utf-8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const token = randomBytes(16).toString('hex'); // 32 hex chars = 128 bits
  await mkdir(dirname(tokenPath), { recursive: true });
  try {
    await writeFile(tokenPath, token + '\n', { mode: 0o600, flag: 'wx' });
    await audit({ acao: 'setup_token_rotated', metadata: { reason: 'cold_start' } });
    return token;
  } catch (writeErr) {
    if ((writeErr as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lost the race; the winner already created it. Read and return their value.
      return (await readFile(tokenPath, 'utf-8')).trim();
    }
    throw writeErr;
  }
}

/**
 * Deletes the existing token file and creates a fresh one. Called from the
 * recovery flow (§4.3). Concurrent `rotateToken` calls are serialised by the
 * outer `recoveryPromise` lock; this function does NOT need its own lock.
 *
 * Emits `setup_token_rotated` audit with reason='recovery_or_pair'.
 */
export async function rotateToken(): Promise<string> {
  const tokenPath = TOKEN_FILE();
  await unlink(tokenPath).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  });
  const token = await ensureToken();
  await audit({ acao: 'setup_token_rotated', metadata: { reason: 'recovery_or_pair' } });
  return token;
}

/**
 * Timing-safe compare. Length mismatch short-circuits to false WITHOUT
 * leaking the actual length via timing — `timingSafeEqual` would throw on
 * length mismatch, so we check first. The short-circuit is OK because the
 * length of the correct token is itself a public constant (32 chars).
 */
export function verifyToken(presented: string, actual: string): boolean {
  if (presented.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(actual));
}
