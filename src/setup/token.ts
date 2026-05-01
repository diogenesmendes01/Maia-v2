import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';

const TOKEN_FILE = (): string => join(config.BAILEYS_AUTH_DIR, 'setup-token.txt');

/**
 * Canonical bootstrap-token format: lowercase 32-char hex string (128 bits
 * from `randomBytes(16).toString('hex')`). Files whose trimmed content does
 * NOT match this pattern are treated as missing and rotated, with an audit.
 * This closes a defence gap: an empty/corrupted file used to be returned
 * verbatim, and `verifyToken('', '')` short-circuited to true under
 * `timingSafeEqual`, authenticating an attacker who omits `?token=` entirely.
 */
const VALID_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Tracks whether the current process has ever successfully observed a token —
 * either by reading an existing file, by being explicitly rotated, or by
 * creating a fresh one on cold start. Lets `ensureToken` distinguish a true
 * cold start (`cold_start`) from a token that vanished mid-process
 * (`unexpected_missing`, per spec §9). Reset between tests via `vi.resetModules`.
 */
let hasInitialised = false;

/**
 * Creates a fresh token file atomically with mode 0o600. On EEXIST (lost a
 * concurrent create race), re-reads and returns the winner's value. Does NOT
 * audit — the caller picks the appropriate `reason` per spec §9.
 */
async function createTokenFile(tokenPath: string): Promise<string> {
  const token = randomBytes(16).toString('hex'); // 32 hex chars = 128 bits
  await mkdir(dirname(tokenPath), { recursive: true });
  try {
    await writeFile(tokenPath, token + '\n', { mode: 0o600, flag: 'wx' });
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
 * Returns the current bootstrap token. If `SETUP_TOKEN_OVERRIDE` is set, returns
 * it (env-bypass for dev/test). Otherwise reads from
 * `<BAILEYS_AUTH_DIR>/setup-token.txt`. If missing OR present-but-corrupted
 * (empty / not 32-hex), creates a new 32-hex-char token (mode 0o600) and emits
 * `setup_token_rotated` audit with reason `'cold_start'` (first run) or
 * `'unexpected_missing'` (file vanished/corrupted after the process already
 * saw a valid token, per spec §9 Error handling).
 *
 * Atomic create via `flag: 'wx'` — concurrent writers race-safely; the loser
 * re-reads the winner's file (no audit emitted in that branch — the winner
 * already audited).
 */
export async function ensureToken(): Promise<string> {
  if (config.SETUP_TOKEN_OVERRIDE) return config.SETUP_TOKEN_OVERRIDE;

  const tokenPath = TOKEN_FILE();
  let existing: string | null = null;
  try {
    existing = (await readFile(tokenPath, 'utf-8')).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (existing !== null && VALID_TOKEN_PATTERN.test(existing)) {
    hasInitialised = true;
    return existing;
  }

  // Either ENOENT, empty, or content that doesn't match the canonical
  // pattern. Rotate. If the file exists with bad content, unlink first so
  // createTokenFile (flag: 'wx') doesn't trip EEXIST and re-read the bad
  // value via the race-recovery branch.
  const reason = hasInitialised ? 'unexpected_missing' : 'cold_start';
  if (existing !== null) {
    await unlink(tokenPath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  }
  const token = await createTokenFile(tokenPath);
  await audit({ acao: 'setup_token_rotated', metadata: { reason } });
  hasInitialised = true;
  return token;
}

/**
 * Deletes the existing token file and creates a fresh one. Called from the
 * recovery flow (§4.3). Concurrent `rotateToken` calls are serialised by the
 * outer `recoveryPromise` lock; this function does NOT need its own lock.
 *
 * Emits exactly one `setup_token_rotated` audit with reason `'recovery_or_pair'`.
 */
export async function rotateToken(): Promise<string> {
  const tokenPath = TOKEN_FILE();
  await unlink(tokenPath).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  });
  const token = await createTokenFile(tokenPath);
  await audit({ acao: 'setup_token_rotated', metadata: { reason: 'recovery_or_pair' } });
  hasInitialised = true;
  return token;
}

/**
 * Timing-safe compare. Length mismatch short-circuits to false WITHOUT
 * leaking the actual length via timing — `timingSafeEqual` would throw on
 * length mismatch, so we check first. The short-circuit is OK because the
 * length of the correct token is itself a public constant (32 chars).
 *
 * Defence-in-depth: explicit zero-length reject so that even if `actual`
 * ever leaks an empty string (corrupted file / tester misuse), an
 * attacker omitting `?token=` cannot match an empty buffer via
 * `timingSafeEqual` and authenticate. `ensureToken` is the primary
 * guardrail (rotates corrupted files); this is the second line.
 */
export function verifyToken(presented: string, actual: string): boolean {
  if (presented.length === 0 || actual.length === 0) return false;
  if (presented.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(actual));
}
