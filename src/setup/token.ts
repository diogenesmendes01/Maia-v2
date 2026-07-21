import { readFile, writeFile, unlink, mkdir, rename, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';

/**
 * Auditoria P0 cap. 7 — o token vive em `control/`, FORA de qualquer alvo de
 * recovery por-linha: o recovery da primária remove `primary/`, o de uma
 * linha remove `lines/<id>` — nenhum deles pode levar o token junto (o
 * layout legado guardava o token direto na raiz, e o recovery antigo a
 * destruía inteira).
 */
const TOKEN_FILE = (): string => join(config.BAILEYS_AUTH_DIR, 'control', 'setup-token.txt');

/** Caminho legado (pré-cap. 7) — token direto na raiz do auth dir. */
const LEGACY_TOKEN_FILE = (): string => join(config.BAILEYS_AUTH_DIR, 'setup-token.txt');

/**
 * Migração transparente do token legado: se `<raiz>/setup-token.txt` existe
 * e `control/setup-token.txt` NÃO, move (rename; fallback copy+unlink para
 * EXDEV/filesystems distintos) ANTES da lógica normal — o token vigente
 * continua válido através do upgrade, sem rotação. Se o novo já existe, o
 * novo é o canônico e o legado fica para o `rotateToken` limpar. Best-effort
 * na presença de corrida: o conteúdo migrado passa pelas MESMAS validações
 * de formato do fluxo normal logo depois.
 */
async function migrateLegacyTokenFile(): Promise<void> {
  const legacyPath = LEGACY_TOKEN_FILE();
  const tokenPath = TOKEN_FILE();
  const legacyExists = await stat(legacyPath).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!legacyExists) return;
  const targetExists = await stat(tokenPath).then(
    () => true,
    () => false,
  );
  if (targetExists) return;
  await mkdir(dirname(tokenPath), { recursive: true });
  try {
    await rename(legacyPath, tokenPath);
  } catch {
    // Fallback copy+unlink (ex.: EXDEV). `wx` preserva a semântica atômica:
    // se um concorrente venceu a corrida, o vencedor é o canônico.
    const content = await readFile(legacyPath);
    try {
      await writeFile(tokenPath, content, { mode: 0o600, flag: 'wx' });
    } catch (writeErr) {
      if ((writeErr as NodeJS.ErrnoException).code !== 'EEXIST') throw writeErr;
    }
    await unlink(legacyPath).catch(() => undefined);
  }
}

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
 * `<BAILEYS_AUTH_DIR>/control/setup-token.txt` (migrando o arquivo legado da
 * raiz de forma transparente). If missing OR present-but-corrupted
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

  // Cap. 7 — honra (e move) o token legado da raiz antes da lógica normal.
  await migrateLegacyTokenFile();

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
 * PRIMARY recovery flow (§4.3). Concurrent `rotateToken` calls are serialised
 * by the outer per-target recovery lock (key `'primary'` — só a recovery da
 * primária rotaciona); this function does NOT need its own lock.
 *
 * Emits exactly one `setup_token_rotated` audit with reason `'recovery_or_pair'`.
 */
export async function rotateToken(): Promise<string> {
  const tokenPath = TOKEN_FILE();
  await unlink(tokenPath).catch((err) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  });
  // Cap. 7 — remove também o arquivo LEGADO na raiz (se sobrou): um token
  // revogado não pode continuar legível no caminho antigo que os runbooks
  // pré-migração apontavam.
  await unlink(LEGACY_TOKEN_FILE()).catch((err) => {
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
