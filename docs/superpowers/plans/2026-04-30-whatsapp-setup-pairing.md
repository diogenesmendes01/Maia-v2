# WhatsApp Setup — Pairing (QR + Code + HTTP + Auto-Recovery) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the SSH-dependent QR-on-stdout pairing flow with an HTTP-accessible `/setup` endpoint that supports both QR code AND 8-digit pairing code, with automatic recovery on `LoggedOut` (auth dir cleanup + token rotation + alert).

**Architecture:** New `src/setup/` module (state machine + bootstrap token + Fastify routes + Tailwind-CDN HTML templates + QR PNG generator). Mounted always in `src/server.ts` (no flag). `src/gateway/baileys.ts` modified at three points: QR emission feeds the state machine; `connection: 'open'` marks paired; `connection: 'close'` with `LoggedOut` triggers the recovery promise. `src/index.ts` boot ensures the bootstrap token file exists. New `qrcode@^1.5` dep (~30KB pure-JS, no native bindings).

**Tech Stack:** TypeScript, Fastify (existing in `src/server.ts`), `@whiskeysockets/baileys` 6.7 (`socket.requestPairingCode` confirmed at `node_modules/.../socket.d.ts:38`), `qrcode@^1.5` (new), Tailwind via CDN (zero build), vitest.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/config/env.ts` | Modify | Add `SETUP_TOKEN_OVERRIDE` (optional) after `FEATURE_PDF_REPORTS` |
| `src/governance/audit-actions.ts` | Modify | Append 8 new audit actions after `'outbound_sent_voice'` |
| `package.json` | Modify | Add `qrcode@^1.5` dep (+ `@types/qrcode` devDep) |
| `src/setup/state.ts` | Create | `setupState` singleton: state machine + lazy TTL expiry + `hasValidBaileysSession` helper |
| `src/setup/token.ts` | Create | `ensureToken` / `rotateToken` / `verifyToken` — file-backed, atomic, timing-safe |
| `src/setup/qr-png.ts` | Create | `qrToPngBuffer(qrString)` — wraps `qrcode.toBuffer` with our default opts |
| `src/setup/templates.ts` | Create | HTML templates (Tailwind via CDN) for chooser / qr / code / connected / waiting / recovering pages |
| `src/setup/recovery.ts` | Create | `triggerRecovery()` with singleton-promise lock. Lives separately from state.ts to keep state pure. |
| `src/setup/index.ts` | Create | Fastify route registrar: `GET /setup`, `GET /setup/qr.png`, `POST /setup/start`, `GET /setup/status`, `GET /setup/done` |
| `src/server.ts` | Modify | Register setup routes alongside `/health`, `/metrics`, `/dashboard*` |
| `src/gateway/baileys.ts` | Modify | (a) feed QR to state, (b) mark paired on `open`, (c) trigger recovery on `LoggedOut`, (d) export `triggerPairingCode` |
| `src/index.ts` | Modify | After `ensureRedisConnect()`, call `ensureToken()` and warn-log if no valid session |
| `tests/unit/setup-state.spec.ts` | Create | State transitions, recovery idempotency, TTL expiry |
| `tests/unit/setup-token.spec.ts` | Create | ensureToken/rotateToken/verifyToken unit tests |
| `tests/unit/setup-routes.spec.ts` | Create | Fastify `app.inject()` integration covering all 5 routes + security headers + token mismatch |

No DB migration. No new feature flag for the feature itself.

---

## Task 1: Foundation — env var + 8 audit actions

**Files:**
- Modify: `src/config/env.ts` (insert after line 120, before the closing `})`)
- Modify: `src/governance/audit-actions.ts` (append after the last entry — currently `'outbound_sent_voice'` from B4)

- [ ] **Step 1: Add `SETUP_TOKEN_OVERRIDE` to env schema**

In `src/config/env.ts`, locate `FEATURE_PDF_REPORTS` block (currently lines 117-120). After it, before the closing `})` on line 121, insert:

```typescript
    FEATURE_PDF_REPORTS: z
      .string()
      .default('false')
      .transform((s) => s === 'true' || s === '1'),
    // SETUP: optional override for the bootstrap token. When set, bypasses
    // the file-backed token. Discouraged in prod (env vars leak more than
    // file mode 0o600). Useful for dev / scripted deploys / E2E tests.
    SETUP_TOKEN_OVERRIDE: z.string().optional(),
  })
```

Note: B4's `FEATURE_OUTBOUND_VOICE` may already be in the file (PR #19) before this lands. If so, insert AFTER `FEATURE_OUTBOUND_VOICE`. Use a grep to find the actual last-FEATURE-block before adding.

- [ ] **Step 2: Append 8 new audit actions**

In `src/governance/audit-actions.ts`, locate the closing `] as const;` (currently line 89-90 area; after `'outbound_sent_document'` and possibly `'outbound_sent_voice'` if B4 is in). Append the 8 new strings before `] as const;`:

```typescript
  'outbound_sent_voice',                          // (or whatever is currently last)
  'pairing_qr_displayed',
  'pairing_code_requested',
  'pairing_completed',
  'pairing_logged_out',
  'pairing_recovery_started',
  'pairing_recovery_completed',
  'setup_token_rotated',
  'setup_unauthorized_access',
] as const;
```

- [ ] **Step 3: Verify build passes**

Run: `npm run build`
Expected: zero NEW TypeScript errors. (Pre-existing 3 errors in `db/client.ts`, `gateway/queue.ts`, `lib/alerts.ts` unchanged.)

- [ ] **Step 4: Commit**

```bash
git add src/config/env.ts src/governance/audit-actions.ts
git commit -m "feat(setup): foundation — SETUP_TOKEN_OVERRIDE env + 8 pairing audit actions"
```

---

## Task 2: Install `qrcode` dependency

**Files:**
- Modify: `package.json`
- Auto-modified: `package-lock.json`

- [ ] **Step 1: Install runtime + types**

```bash
npm install qrcode@^1.5.0
npm install --save-dev @types/qrcode@^1.5.0
```

- [ ] **Step 2: Verify the lib loads on Node**

Run:
```bash
npx tsx -e "import('qrcode').then(m => console.log('qrcode load ok:', typeof m.toBuffer))"
```
Expected: `qrcode load ok: function`.

- [ ] **Step 3: Verify it produces a PNG**

```bash
npx tsx -e "import('qrcode').then(async (m) => { const b = await m.toBuffer('test', { errorCorrectionLevel: 'M', width: 320 }); console.log('size:', b.length, 'magic:', b.subarray(0,4).toString('hex')); })"
```
Expected: size > 200 bytes, magic = `89504e47` (PNG file signature).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(setup): install qrcode@^1.5 for setup endpoint PNG generation"
```

---

## Task 3: `src/setup/token.ts` — bootstrap token

**Files:**
- Create: `src/setup/token.ts`
- Create: `tests/unit/setup-token.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/setup-token.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, rm, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SANDBOX = join(tmpdir(), 'maia-setup-token-test-' + Date.now());

let configState: { BAILEYS_AUTH_DIR: string; SETUP_TOKEN_OVERRIDE?: string } = {
  BAILEYS_AUTH_DIR: SANDBOX,
};

vi.mock('../../src/config/env.js', () => ({
  config: new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === 'BAILEYS_AUTH_DIR') return configState.BAILEYS_AUTH_DIR;
      if (prop === 'SETUP_TOKEN_OVERRIDE') return configState.SETUP_TOKEN_OVERRIDE;
      return undefined;
    },
  }),
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(async () => {
  configState = { BAILEYS_AUTH_DIR: SANDBOX };
  await rm(SANDBOX, { recursive: true, force: true });
  await mkdir(SANDBOX, { recursive: true });
  vi.resetModules();
});
afterAll(async () => {
  await rm(SANDBOX, { recursive: true, force: true });
});

describe('setup-token — ensureToken', () => {
  it('creates token file with mode 0o600 when missing', async () => {
    const { ensureToken } = await import('../../src/setup/token.js');
    const token = await ensureToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const filePath = join(SANDBOX, 'setup-token.txt');
    const fileContent = (await readFile(filePath, 'utf-8')).trim();
    expect(fileContent).toBe(token);
    const s = await stat(filePath);
    // On Windows, mode bits don't fully apply; on Unix, expect 0o600.
    if (process.platform !== 'win32') {
      expect(s.mode & 0o777).toBe(0o600);
    }
  });

  it('returns existing token when file exists (idempotent)', async () => {
    const { ensureToken } = await import('../../src/setup/token.js');
    const token1 = await ensureToken();
    vi.resetModules();
    const { ensureToken: ensureToken2 } = await import('../../src/setup/token.js');
    const token2 = await ensureToken2();
    expect(token2).toBe(token1);
  });

  it('SETUP_TOKEN_OVERRIDE env bypasses file', async () => {
    configState.SETUP_TOKEN_OVERRIDE = 'override-token-123';
    const { ensureToken } = await import('../../src/setup/token.js');
    const token = await ensureToken();
    expect(token).toBe('override-token-123');
  });
});

describe('setup-token — rotateToken', () => {
  it('deletes existing and regenerates a new value', async () => {
    const { ensureToken, rotateToken } = await import('../../src/setup/token.js');
    const token1 = await ensureToken();
    const token2 = await rotateToken();
    expect(token2).not.toBe(token1);
    expect(token2).toMatch(/^[0-9a-f]{32}$/);
  });

  it('handles ENOENT on unlink (file already gone)', async () => {
    const { rotateToken } = await import('../../src/setup/token.js');
    // No prior ensureToken → file doesn't exist; rotateToken should still succeed
    const token = await rotateToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('setup-token — verifyToken', () => {
  it('returns true on exact match', async () => {
    const { verifyToken } = await import('../../src/setup/token.js');
    expect(verifyToken('abc123', 'abc123')).toBe(true);
  });

  it('returns false on mismatch (same length)', async () => {
    const { verifyToken } = await import('../../src/setup/token.js');
    expect(verifyToken('abc123', 'abc124')).toBe(false);
  });

  it('returns false on length mismatch (short-circuit)', async () => {
    const { verifyToken } = await import('../../src/setup/token.js');
    expect(verifyToken('abc', 'abc123')).toBe(false);
    expect(verifyToken('abc123', 'abc')).toBe(false);
  });

  it('returns false on empty input vs non-empty actual', async () => {
    const { verifyToken } = await import('../../src/setup/token.js');
    expect(verifyToken('', 'abc123')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/setup-token.spec.ts`
Expected: FAIL — `src/setup/token.js` does not exist.

- [ ] **Step 3: Create `src/setup/token.ts`**

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/setup-token.spec.ts`
Expected: PASS — 9 tests across 3 describe blocks.

- [ ] **Step 5: Commit**

```bash
git add src/setup/token.ts tests/unit/setup-token.spec.ts
git commit -m "feat(setup): bootstrap token (ensureToken/rotateToken/verifyToken)"
```

---

## Task 4: `src/setup/state.ts` — state machine + `hasValidBaileysSession`

**Files:**
- Create: `src/setup/state.ts`
- Create: `src/setup/recovery.ts` (separate file for the recovery lock — keeps `state.ts` pure)
- Create: `tests/unit/setup-state.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/setup-state.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(async () => {
  vi.resetModules();
});

describe('setup-state — phase transitions', () => {
  it('initialises in unpaired phase', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    expect(setupState.current().phase).toBe('unpaired');
  });

  it('setQr from unpaired auto-transitions to pairing_qr', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setQr('qr-string-1');
    const c = setupState.current();
    expect(c.phase).toBe('pairing_qr');
    if (c.phase === 'pairing_qr') expect(c.qr).toBe('qr-string-1');
  });

  it('setQr while in pairing_qr just updates the qr', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setQr('qr-1');
    setupState.setQr('qr-2');
    const c = setupState.current();
    if (c.phase === 'pairing_qr') expect(c.qr).toBe('qr-2');
  });

  it('setQr from disconnected_transient auto-transitions to pairing_qr', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.markPaired();
    setupState.markDisconnected();
    expect(setupState.current().phase).toBe('disconnected_transient');
    setupState.setQr('qr-after-reconnect');
    expect(setupState.current().phase).toBe('pairing_qr');
  });

  it('setCode from unpaired transitions to pairing_code with expiresAt', async () => {
    const { setupState, PAIRING_CODE_TTL_MS } = await import('../../src/setup/state.js');
    const before = Date.now();
    setupState.setCode('12345678');
    const c = setupState.current();
    expect(c.phase).toBe('pairing_code');
    if (c.phase === 'pairing_code') {
      expect(c.code).toBe('12345678');
      expect(c.expiresAt.getTime()).toBeGreaterThanOrEqual(before + PAIRING_CODE_TTL_MS - 100);
      expect(c.expiresAt.getTime()).toBeLessThanOrEqual(before + PAIRING_CODE_TTL_MS + 100);
    }
  });

  it('pairing_code lazily expires to unpaired on current() read after TTL', async () => {
    vi.useFakeTimers();
    const { setupState, PAIRING_CODE_TTL_MS } = await import('../../src/setup/state.js');
    setupState.setCode('12345678');
    expect(setupState.current().phase).toBe('pairing_code');
    vi.advanceTimersByTime(PAIRING_CODE_TTL_MS + 1000);
    expect(setupState.current().phase).toBe('unpaired');
    vi.useRealTimers();
  });

  it('markPaired transitions from pairing_qr to connected', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setQr('qr');
    setupState.markPaired();
    expect(setupState.current().phase).toBe('connected');
  });

  it('markDisconnected transitions from connected to disconnected_transient', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setQr('qr');
    setupState.markPaired();
    setupState.markDisconnected();
    expect(setupState.current().phase).toBe('disconnected_transient');
  });

  it('illegal transitions throw — setCode from connected', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setQr('qr');
    setupState.markPaired();
    expect(() => setupState.setCode('11111111')).toThrow();
  });
});

describe('setup-state — hasValidBaileysSession', () => {
  const SANDBOX = join(tmpdir(), 'maia-setup-state-test-' + Date.now());

  it('returns false when creds.json missing', async () => {
    await mkdir(SANDBOX, { recursive: true });
    const { hasValidBaileysSession } = await import('../../src/setup/state.js');
    expect(await hasValidBaileysSession(SANDBOX)).toBe(false);
    await rm(SANDBOX, { recursive: true, force: true });
  });

  it('returns false when creds.json present but missing me field', async () => {
    await mkdir(SANDBOX, { recursive: true });
    await writeFile(join(SANDBOX, 'creds.json'), JSON.stringify({ noteworthy: 'data' }));
    const { hasValidBaileysSession } = await import('../../src/setup/state.js');
    expect(await hasValidBaileysSession(SANDBOX)).toBe(false);
    await rm(SANDBOX, { recursive: true, force: true });
  });

  it('returns true when creds.json has me field', async () => {
    await mkdir(SANDBOX, { recursive: true });
    await writeFile(join(SANDBOX, 'creds.json'), JSON.stringify({ me: { id: '5511...' } }));
    const { hasValidBaileysSession } = await import('../../src/setup/state.js');
    expect(await hasValidBaileysSession(SANDBOX)).toBe(true);
    await rm(SANDBOX, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/setup-state.spec.ts`
Expected: FAIL — `src/setup/state.js` does not exist.

- [ ] **Step 3: Create `src/setup/state.ts`**

```typescript
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

  /** Called on Baileys `connection: 'open'`. */
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/setup-state.spec.ts`
Expected: PASS — 12 tests (9 transitions + 3 hasValidBaileysSession).

- [ ] **Step 5: Create `src/setup/recovery.ts`**

```typescript
import { rm } from 'node:fs/promises';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { setupState } from './state.js';
import { rotateToken } from './token.js';
import { sendAlert } from '@/lib/alerts.js';

let recoveryPromise: Promise<void> | null = null;

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
export async function triggerRecovery(deps: {
  shutdownBaileys: () => Promise<void>;
  startBaileys: () => Promise<void>;
}): Promise<void> {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = doRecovery(deps).finally(() => {
    recoveryPromise = null;
  });
  return recoveryPromise;
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
  isRecovering: () => recoveryPromise !== null,
  reset: () => {
    recoveryPromise = null;
  },
};
```

- [ ] **Step 6: Add recovery-lock test**

Append to `tests/unit/setup-state.spec.ts` (this file is the closest existing home; alternatively create `tests/unit/setup-recovery.spec.ts`):

```typescript
describe('setup-recovery — concurrency lock', () => {
  it('triggerRecovery is idempotent: concurrent calls share the same promise', async () => {
    vi.resetModules();
    vi.doMock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
    vi.doMock('../../src/lib/alerts.js', () => ({ sendAlert: vi.fn().mockResolvedValue(undefined) }));
    vi.doMock('../../src/setup/token.js', () => ({
      rotateToken: vi.fn().mockResolvedValue('new-token'),
    }));
    vi.doMock('../../src/config/env.js', () => ({
      config: { BAILEYS_AUTH_DIR: '/tmp/maia-recovery-test-stub' },
    }));
    vi.doMock('node:fs/promises', async (orig) => {
      const real = await orig<typeof import('node:fs/promises')>();
      return { ...real, rm: vi.fn().mockResolvedValue(undefined) };
    });

    const shutdownBaileys = vi.fn().mockResolvedValue(undefined);
    const startBaileys = vi.fn().mockResolvedValue(undefined);

    const { triggerRecovery, _internal } = await import('../../src/setup/recovery.js');
    const p1 = triggerRecovery({ shutdownBaileys, startBaileys });
    const p2 = triggerRecovery({ shutdownBaileys, startBaileys });
    expect(p1).toBe(p2); // same promise reference
    await p1;
    expect(shutdownBaileys).toHaveBeenCalledTimes(1);
    expect(startBaileys).toHaveBeenCalledTimes(1);
    expect(_internal.isRecovering()).toBe(false);
  });
});
```

- [ ] **Step 7: Run the full test file**

Run: `npx vitest run tests/unit/setup-state.spec.ts`
Expected: PASS — 13 tests.

- [ ] **Step 8: Commit**

```bash
git add src/setup/state.ts src/setup/recovery.ts tests/unit/setup-state.spec.ts
git commit -m "feat(setup): state machine + recovery lock + hasValidBaileysSession"
```

---

## Task 5: `src/setup/qr-png.ts` + `src/setup/templates.ts`

**Files:**
- Create: `src/setup/qr-png.ts`
- Create: `src/setup/templates.ts`

These two are pure utility modules with no behavior to test in isolation (the `qrcode` lib is already vetted; templates are HTML strings consumed by route tests in Task 6).

- [ ] **Step 1: Create `src/setup/qr-png.ts`**

```typescript
import QRCode from 'qrcode';

/**
 * Convert a Baileys QR string to a 320×320 PNG buffer. Used by
 * `GET /setup/qr.png`. Defaults match WhatsApp's expectation
 * (medium error correction, square output).
 */
export async function qrToPngBuffer(qrString: string): Promise<Buffer> {
  return QRCode.toBuffer(qrString, {
    errorCorrectionLevel: 'M',
    width: 320,
    margin: 1,
  });
}
```

- [ ] **Step 2: Create `src/setup/templates.ts`**

```typescript
const BASE_HEAD = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Maia — Pareamento</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  /* Minimal fallback if Tailwind CDN is unreachable */
  body { font: 14px/1.5 system-ui; max-width: 480px; margin: 60px auto; padding: 0 20px; }
  button { padding: 12px 20px; margin: 8px; border-radius: 8px; cursor: pointer; }
</style>
</head>
<body class="bg-slate-50 min-h-screen flex items-center justify-center p-4">
<div class="bg-white rounded-2xl shadow-lg max-w-md w-full p-8">
<h1 class="text-2xl font-bold mb-6">Maia — Pareamento WhatsApp</h1>`;

const STATUS_AND_FOOT = (statusText: string, token: string, autoRefreshSec?: number): string => `
<div class="status mt-6 p-3 rounded-lg bg-slate-100 text-sm text-slate-700">
  <span class="font-medium">Status atual:</span>
  <span id="status-text">${escapeHtml(statusText)}</span>
</div>
</div>
<script>
(function() {
  const TOKEN = ${JSON.stringify(token)};
  const POLL_INTERVAL_MS = 2000;
  let prevPhase = null;
  async function poll() {
    try {
      const res = await fetch('/setup/status?token=' + encodeURIComponent(TOKEN), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (prevPhase && prevPhase !== data.phase) {
        if (data.phase === 'connected') {
          document.getElementById('status-text').textContent = 'Conectado com sucesso. Redirecionando…';
          setTimeout(() => { window.location.href = '/setup/done'; }, 1500);
          return;
        }
        // Phase changed; reload to render the new state's HTML.
        window.location.reload();
        return;
      }
      prevPhase = data.phase;
    } catch (e) { /* network blip; keep polling */ }
  }
  setInterval(poll, POLL_INTERVAL_MS);
  poll();
})();
</script>${autoRefreshSec ? `<meta http-equiv="refresh" content="${autoRefreshSec}">` : ''}
</body></html>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

export function renderChooser(token: string): string {
  return `${BASE_HEAD}
<p class="text-slate-700 mb-6">Escolha como quer parear o WhatsApp da Maia:</p>
<form method="POST" action="/setup/start?token=${encodeURIComponent(token)}" class="space-y-3">
  <button type="submit" name="method" value="qr"
    class="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium">
    📱 Parear com QR Code
  </button>
  <button type="submit" name="method" value="code"
    class="w-full py-3 px-4 bg-slate-200 hover:bg-slate-300 text-slate-900 rounded-lg font-medium">
    🔢 Parear com Código de 8 dígitos
  </button>
</form>
${STATUS_AND_FOOT('Aguardando você escolher o método de pareamento.', token)}`;
}

export function renderQr(token: string, qr: string | null): string {
  const body = qr
    ? `<div class="text-center">
        <img src="/setup/qr.png?token=${encodeURIComponent(token)}" alt="QR Code"
          class="mx-auto rounded-lg border border-slate-200" width="320" height="320">
        <p class="mt-4 text-sm text-slate-600">
          Abra <strong>WhatsApp</strong> → <strong>Aparelhos conectados</strong> → <strong>Conectar aparelho</strong> e aponte a câmera.
        </p>
      </div>`
    : `<div class="text-center py-8">
        <div class="inline-block animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent"></div>
        <p class="mt-4 text-slate-700">Gerando QR Code…</p>
      </div>`;
  const status = qr ? 'Aguardando leitura do QR Code no WhatsApp.' : 'Gerando QR Code…';
  return `${BASE_HEAD}${body}${STATUS_AND_FOOT(status, token)}`;
}

export function renderCode(token: string, code: string, expiresAt: Date): string {
  const formatted = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4, 8)}` : code;
  const expiresIso = expiresAt.toISOString();
  return `${BASE_HEAD}
<div class="text-center">
  <div id="code-display" class="text-5xl font-mono font-bold tracking-widest text-slate-900 my-6 select-all">
    ${escapeHtml(formatted)}
  </div>
  <button id="copy-btn" type="button"
    class="px-4 py-2 bg-slate-200 hover:bg-slate-300 rounded-lg text-sm font-medium">
    📋 Copiar
  </button>
  <p class="mt-4 text-sm text-slate-600">
    Abra <strong>WhatsApp</strong> → <strong>Aparelhos conectados</strong> → <strong>Conectar com número de telefone</strong> → digite este código.
  </p>
  <p class="mt-3 text-xs text-slate-500">
    Válido por <span id="countdown">--:--</span>
  </p>
</div>
<script>
(function() {
  const code = ${JSON.stringify(code)};
  const expiresAt = new Date(${JSON.stringify(expiresIso)}).getTime();
  document.getElementById('copy-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      const btn = document.getElementById('copy-btn');
      btn.textContent = '✅ Copiado!';
      setTimeout(() => { btn.textContent = '📋 Copiar'; }, 1500);
    } catch (e) {
      // Clipboard API unavailable — select-all fallback works via .select-all class
      const el = document.getElementById('code-display');
      const range = document.createRange();
      range.selectNode(el);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
  });
  function tick() {
    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    document.getElementById('countdown').textContent = m + ':' + s;
  }
  tick();
  setInterval(tick, 1000);
})();
</script>
${STATUS_AND_FOOT('Código gerado. Aguardando confirmação no WhatsApp.', token)}`;
}

export function renderConnected(connectedAt: Date, dashboardEnabled: boolean): string {
  const tsBR = connectedAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const dashLink = dashboardEnabled
    ? `<a href="/dashboard" class="text-blue-600 hover:underline">→ Dashboard</a>`
    : '';
  return `${BASE_HEAD}
<div class="text-center">
  <div class="text-5xl mb-3">✅</div>
  <h2 class="text-xl font-semibold mb-2">Maia já está pareada</h2>
  <p class="text-slate-700 mb-1">Status: <strong>conectado</strong></p>
  <p class="text-sm text-slate-500 mb-6">desde ${escapeHtml(tsBR)}</p>
  <p class="text-sm text-slate-600">
    Para re-parear, desconecte pelo app do WhatsApp da Maia ou consulte o runbook.
  </p>
  <div class="mt-6 space-x-3">
    <a href="/setup/done" class="text-blue-600 hover:underline">→ Confirmação</a>
    ${dashLink}
  </div>
</div>
</div></body></html>`;
}

export function renderTransientDisconnect(token: string): string {
  return `${BASE_HEAD}
<div class="text-center py-4">
  <div class="inline-block animate-pulse text-3xl mb-3">⏳</div>
  <p class="text-slate-700">Conexão perdida temporariamente.</p>
  <p class="text-sm text-slate-500 mt-2">Reconectando… costuma levar 5-10s.</p>
</div>
${STATUS_AND_FOOT('Conexão perdida temporariamente. Reconectando…', token, 5)}`;
}

export function renderRecovering(token: string): string {
  return `${BASE_HEAD}
<div class="text-center py-4">
  <div class="inline-block animate-spin text-3xl mb-3">🔄</div>
  <p class="text-slate-700">Limpando sessão antiga e gerando novo token…</p>
  <p class="text-sm text-slate-500 mt-2">~3s. Verifique seu canal de alertas (email/telegram) para o novo token.</p>
</div>
${STATUS_AND_FOOT('Limpando sessão antiga e gerando novo token…', token, 5)}`;
}

export function renderDone(): string {
  return `${BASE_HEAD}
<div class="text-center py-4">
  <div class="text-5xl mb-3">🎉</div>
  <h2 class="text-xl font-semibold mb-2">Pareamento completo</h2>
  <p class="text-slate-700">A Maia está pronta para receber mensagens.</p>
  <p class="text-sm text-slate-500 mt-4">Você pode fechar essa página.</p>
</div>
</div></body></html>`;
}
```

- [ ] **Step 3: Verify build still passes**

Run: `npm run build`
Expected: zero new TS errors.

- [ ] **Step 4: Commit**

```bash
git add src/setup/qr-png.ts src/setup/templates.ts
git commit -m "feat(setup): qr-png helper + HTML templates (Tailwind via CDN)"
```

---

## Task 6: `src/setup/index.ts` — Fastify routes + integration test

**Files:**
- Create: `src/setup/index.ts`
- Create: `tests/unit/setup-routes.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/setup-routes.spec.ts`. Uses Fastify's built-in `app.inject()` for in-process integration:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const triggerPairingCode = vi.fn();

vi.mock('../../src/gateway/baileys.js', () => ({
  triggerPairingCode,
  isBaileysConnected: () => false,
}));

vi.mock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: '/tmp/maia-setup-routes-test',
    SETUP_TOKEN_OVERRIDE: 'TEST-TOKEN',
    WHATSAPP_NUMBER_MAIA: '+5511999999999',
    FEATURE_DASHBOARD: false,
  },
}));

let app: FastifyInstance;

beforeEach(async () => {
  vi.resetModules();
  triggerPairingCode.mockReset();
  // Re-mock everything per test (vi.resetModules clears state)
  vi.doMock('../../src/gateway/baileys.js', () => ({
    triggerPairingCode,
    isBaileysConnected: () => false,
  }));
  vi.doMock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
  vi.doMock('../../src/lib/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('../../src/config/env.js', () => ({
    config: {
      BAILEYS_AUTH_DIR: '/tmp/maia-setup-routes-test',
      SETUP_TOKEN_OVERRIDE: 'TEST-TOKEN',
      WHATSAPP_NUMBER_MAIA: '+5511999999999',
      FEATURE_DASHBOARD: false,
    },
  }));
  app = Fastify();
  const { registerSetupRoutes } = await import('../../src/setup/index.js');
  // Reset state to unpaired for each test
  const { setupState } = await import('../../src/setup/state.js');
  // setupState is a singleton; force back to unpaired
  // (state.ts doesn't expose a reset; but we can call setUnpaired which is allowed from any phase)
  try { setupState.setUnpaired(); } catch {}
  await registerSetupRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('setup routes — auth', () => {
  it('GET /setup without token returns 403 with security headers', async () => {
    const r = await app.inject({ method: 'GET', url: '/setup' });
    expect(r.statusCode).toBe(403);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });

  it('GET /setup with wrong token returns 403', async () => {
    const r = await app.inject({ method: 'GET', url: '/setup?token=wrong' });
    expect(r.statusCode).toBe(403);
  });

  it('GET /setup with correct token returns 200 + chooser HTML', async () => {
    const r = await app.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.body).toContain('Parear com QR Code');
    expect(r.body).toContain('Parear com Código de 8 dígitos');
  });
});

describe('setup routes — POST /setup/start', () => {
  it('method=qr from unpaired returns 200 (server-side no-op)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      payload: { method: 'qr' },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
  });

  it('method=code from unpaired calls triggerPairingCode and returns 200', async () => {
    triggerPairingCode.mockResolvedValueOnce('12345678');
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      payload: { method: 'code' },
    });
    expect(triggerPairingCode).toHaveBeenCalledWith('+5511999999999');
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.phase).toBe('pairing_code');
  });

  it('method=code returns 503 with retry_after_s when triggerPairingCode throws baileys_socket_not_ready', async () => {
    triggerPairingCode.mockRejectedValueOnce(new Error('baileys_socket_not_ready'));
    const r = await app.inject({
      method: 'POST',
      url: '/setup/start?token=TEST-TOKEN',
      payload: { method: 'code' },
    });
    expect(r.statusCode).toBe(503);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(false);
    expect(body.retry_after_s).toBe(2);
  });
});

describe('setup routes — phase-dependent rendering', () => {
  it('GET /setup with qr=null shows "Gerando QR Code"', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setQr(''); // setQr empty triggers transition with qr=empty; we want null
    // Workaround: use the auto-transition path properly
    setupState.setUnpaired();
    setupState.setQr('test-qr-string');
    const r = await app.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('/setup/qr.png?token=TEST-TOKEN');
  });

  it('GET /setup on connected returns 410 with friendly HTML', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setQr('q');
    setupState.markPaired();
    const r = await app.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(410);
    expect(r.body).toContain('Maia já está pareada');
  });

  it('GET /setup on pairing_code shows the formatted code', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setCode('12345678');
    const r = await app.inject({ method: 'GET', url: '/setup?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('1234-5678');
    expect(r.body).toContain('Copiar');
  });
});

describe('setup routes — GET /setup/qr.png', () => {
  it('returns PNG buffer when phase=pairing_qr with qr set', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setQr('test-qr-string');
    const r = await app.inject({ method: 'GET', url: '/setup/qr.png?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    // PNG magic bytes
    expect(r.rawPayload.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('returns 404 when phase is not pairing_qr', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    const r = await app.inject({ method: 'GET', url: '/setup/qr.png?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(404);
  });
});

describe('setup routes — GET /setup/status', () => {
  it('returns phase JSON with correct shape', async () => {
    const { setupState } = await import('../../src/setup/state.js');
    setupState.setUnpaired();
    setupState.setQr('test-qr-string');
    const r = await app.inject({ method: 'GET', url: '/setup/status?token=TEST-TOKEN' });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.phase).toBe('pairing_qr');
    expect(body.qr).toBe('available');
    // Raw QR string MUST NOT appear in JSON
    expect(JSON.stringify(body)).not.toContain('test-qr-string');
  });
});

describe('setup routes — GET /setup/done', () => {
  it('returns 200 with confirmation HTML (no token required)', async () => {
    const r = await app.inject({ method: 'GET', url: '/setup/done' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Pareamento completo');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/unit/setup-routes.spec.ts`
Expected: FAIL — `src/setup/index.js` does not exist.

- [ ] **Step 3: Create `src/setup/index.ts`**

```typescript
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '@/config/env.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { setupState } from './state.js';
import { ensureToken, verifyToken } from './token.js';
import { qrToPngBuffer } from './qr-png.js';
import {
  renderChooser,
  renderQr,
  renderCode,
  renderConnected,
  renderTransientDisconnect,
  renderRecovering,
  renderDone,
} from './templates.js';
import { triggerPairingCode } from '@/gateway/baileys.js';

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

function applyHeaders(reply: FastifyReply): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    reply.header(k, v);
  }
}

async function authGate(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const presented =
    typeof (req.query as { token?: string }).token === 'string'
      ? (req.query as { token: string }).token
      : '';
  const actual = await ensureToken();
  applyHeaders(reply);
  if (!verifyToken(presented, actual)) {
    await audit({
      acao: 'setup_unauthorized_access',
      metadata: {
        ip: (req.ip ?? 'unknown').slice(0, 64),
        ua: (req.headers['user-agent'] ?? 'unknown').slice(0, 200),
      },
    });
    reply.code(403).type('text/plain').send('forbidden');
    return false;
  }
  return true;
}

export async function registerSetupRoutes(app: FastifyInstance): Promise<void> {
  app.get('/setup', async (req, reply) => {
    if (!(await authGate(req, reply))) return;

    const token = (req.query as { token: string }).token;
    const phaseObj = setupState.current();

    switch (phaseObj.phase) {
      case 'unpaired':
        return reply.type('text/html').send(renderChooser(token));
      case 'pairing_qr':
        return reply.type('text/html').send(renderQr(token, phaseObj.qr));
      case 'pairing_code':
        return reply.type('text/html').send(
          renderCode(token, phaseObj.code, phaseObj.expiresAt),
        );
      case 'connected':
        return reply
          .code(410)
          .type('text/html')
          .send(renderConnected(phaseObj.connectedAt, !!config.FEATURE_DASHBOARD));
      case 'disconnected_transient':
        return reply.code(503).type('text/html').send(renderTransientDisconnect(token));
      case 'recovering':
        return reply.code(503).type('text/html').send(renderRecovering(token));
    }
  });

  app.get('/setup/qr.png', async (req, reply) => {
    if (!(await authGate(req, reply))) return;

    const phaseObj = setupState.current();
    if (phaseObj.phase !== 'pairing_qr' || !phaseObj.qr) {
      return reply.code(404).type('text/plain').send('not found');
    }
    try {
      const buf = await qrToPngBuffer(phaseObj.qr);
      return reply.type('image/png').send(buf);
    } catch (err) {
      logger.error({ err }, 'setup.qr_png_render_failed');
      return reply.code(500).type('text/plain').send('qr render failed');
    }
  });

  app.post('/setup/start', async (req, reply) => {
    if (!(await authGate(req, reply))) return;

    const body = (req.body ?? {}) as { method?: 'qr' | 'code' };
    if (body.method !== 'qr' && body.method !== 'code') {
      return reply.code(400).send({ ok: false, error: 'invalid_method' });
    }
    const phase = setupState.current().phase;

    if (body.method === 'qr') {
      // Server-side no-op: Baileys' QR auto-transitions the state when emitted.
      // This endpoint exists for HTML form clarity. Conflict only if currently
      // in a non-unpaired/non-pairing_qr phase.
      if (phase !== 'unpaired' && phase !== 'pairing_qr') {
        return reply.code(409).send({ ok: false, phase });
      }
      return reply.send({ ok: true, phase: setupState.current().phase });
    }

    // method === 'code'
    if (phase !== 'unpaired') {
      return reply.code(409).send({ ok: false, phase });
    }
    try {
      const code = await triggerPairingCode(config.WHATSAPP_NUMBER_MAIA);
      setupState.setCode(code);
      await audit({ acao: 'pairing_code_requested' });
      return reply.send({ ok: true, phase: 'pairing_code' });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('baileys_socket_not_ready')) {
        return reply.code(503).send({ ok: false, retry_after_s: 2 });
      }
      logger.error({ err }, 'setup.trigger_pairing_code_failed');
      return reply.code(500).send({ ok: false, error: 'trigger_failed' });
    }
  });

  app.get('/setup/status', async (req, reply) => {
    if (!(await authGate(req, reply))) return;

    const phaseObj = setupState.current();
    // Build a status payload that NEVER includes the raw QR string. The QR
    // is delivered as a PNG via /setup/qr.png; only metadata is exposed here.
    const out: Record<string, unknown> = { phase: phaseObj.phase };
    if (phaseObj.phase === 'pairing_qr') {
      out.qr = phaseObj.qr ? 'available' : 'pending';
    }
    if (phaseObj.phase === 'pairing_code') {
      out.expiresAt = phaseObj.expiresAt.toISOString();
    }
    if (phaseObj.phase === 'connected') {
      out.connectedAt = phaseObj.connectedAt.toISOString();
    }
    return reply.type('application/json').send(out);
  });

  app.get('/setup/done', async (_req, reply) => {
    applyHeaders(reply);
    return reply.type('text/html').send(renderDone());
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/unit/setup-routes.spec.ts`
Expected: PASS — 13 tests across 6 describe blocks (3 auth + 3 POST start + 3 phase rendering + 2 qr.png + 1 status + 1 done = 13).

- [ ] **Step 5: Commit**

```bash
git add src/setup/index.ts tests/unit/setup-routes.spec.ts
git commit -m "feat(setup): Fastify routes (chooser/qr/code/status/done) + auth + 13 tests"
```

---

## Task 7: Wire into `server.ts` + `index.ts` boot + `baileys.ts` integration

**Files:**
- Modify: `src/server.ts` (register setup routes)
- Modify: `src/index.ts` (ensure token + log warn on cold start)
- Modify: `src/gateway/baileys.ts` (3 surgery points + new `triggerPairingCode` export)

This task does NOT add new test files — the integration is verified manually on the PR (per spec §10).

- [ ] **Step 1: Register setup routes in `src/server.ts`**

In `src/server.ts`, after `await registerDashboardRoutes(app);` (line 25), add:

```typescript
  // Setup pairing routes — mounted always (no flag gate). See spec §4.5.
  const { registerSetupRoutes } = await import('@/setup/index.js');
  await registerSetupRoutes(app);
```

- [ ] **Step 2: Bootstrap token in `src/index.ts`**

In `src/index.ts`, after the existing `await sweepPdfTmp().catch(...)` block (line 19-20), add:

```typescript
  // SETUP: ensure bootstrap token exists (cold-start / first deploy).
  // Token NOT logged in plaintext — operator must SSH and read the file.
  const { ensureToken } = await import('@/setup/token.js');
  const { hasValidBaileysSession } = await import('@/setup/state.js');
  await ensureToken();
  if (!(await hasValidBaileysSession(config.BAILEYS_AUTH_DIR))) {
    logger.warn(
      { setup_token_path: '<BAILEYS_AUTH_DIR>/setup-token.txt' },
      'setup.bootstrap_token_ready — run `cat $BAILEYS_AUTH_DIR/setup-token.txt` and visit /setup',
    );
  }
```

- [ ] **Step 3: Modify `src/gateway/baileys.ts`** — 4 changes

(a) **Imports** — add at the top (alongside existing imports):

```typescript
import { setupState } from '@/setup/state.js';
import { triggerRecovery } from '@/setup/recovery.js';
```

(b) **QR emission** — replace line 67:

```typescript
// OLD:
//   if (qr) qrcodeTerminal.generate(qr, { small: true });
// NEW:
if (qr) {
  const phaseBefore = setupState.current().phase;
  setupState.setQr(qr);
  if (phaseBefore !== 'pairing_qr') {
    await audit({ acao: 'pairing_qr_displayed', metadata: {} });
  }
  qrcodeTerminal.generate(qr, { small: true });    // keep stdout for dev/log spelunking
}
```

(c) **Connection open** — after the existing `await audit({ acao: 'whatsapp_connected' });` (line 71), add:

```typescript
      setupState.markPaired();
      await audit({ acao: 'pairing_completed' });
```

(d) **Connection close** — replace lines 78-84 (the existing `if (reason !== DisconnectReason.loggedOut) { ... } else { logger.error('baileys.logged_out — manual re-pair required'); }`) with:

```typescript
      if (reason === DisconnectReason.loggedOut) {
        await audit({ acao: 'pairing_logged_out', metadata: { reason } });
        triggerRecovery({ shutdownBaileys, startBaileys }).catch((err) => {
          logger.error({ err }, 'setup.recovery_failed');
        });
      } else {
        setupState.markDisconnected();
        setTimeout(() => {
          startBaileys().catch((e) => logger.error({ err: e }, 'baileys.reconnect_failed'));
        }, 5000);
      }
```

(e) **New `triggerPairingCode` export** — append after `sendOutboundVoice` (or wherever the last export is):

```typescript
/**
 * SETUP: request an 8-digit pairing code from WhatsApp. Used when the
 * operator chooses "Pair with phone number" in the /setup endpoint.
 * Throws `baileys_socket_not_ready` if the socket hasn't been initialised
 * yet (boot race: startServer() runs before startBaileys()). Caller (the
 * /setup/start route) translates the throw into 503 + retry_after_s.
 */
export async function triggerPairingCode(phone: string): Promise<string> {
  if (!socket) throw new Error('baileys_socket_not_ready');
  return socket.requestPairingCode(phone);
}
```

- [ ] **Step 4: Verify build passes**

Run: `npm run build`
Expected: zero new TS errors. The `triggerRecovery` call passes `{ shutdownBaileys, startBaileys }` — both are functions defined in `baileys.ts` (existing for `shutdownBaileys`, the function being defined for `startBaileys`).

- [ ] **Step 5: Run the focused test suites to verify no regressions**

Run: `npx vitest run tests/unit/setup-token.spec.ts tests/unit/setup-state.spec.ts tests/unit/setup-routes.spec.ts tests/unit/baileys-view-once.spec.ts tests/unit/baileys-send-document.spec.ts tests/unit/baileys-send-voice.spec.ts`
Expected: ALL pass. (The setup tests cover the new code; the baileys-* tests cover B3a/B3b/B4 to confirm the modifications didn't regress them.)

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/index.ts src/gateway/baileys.ts
git commit -m "feat(setup): wire setup routes into server + baileys recovery integration"
```

---

## Task 8: Final pass — typecheck, full suite, manual checklist, PR open

- [ ] **Step 1: Full typecheck**

Run: `npm run build`
Expected: zero NEW TS errors. Pre-existing 3 errors (`db/client.ts`, `gateway/queue.ts`, `lib/alerts.ts`) unchanged.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: all NEW tests pass (setup-token, setup-state, setup-routes — ~33 new tests). Pre-existing 1 unrelated failure in `pending-deprecation.spec.ts` is unchanged.

- [ ] **Step 3: Push branch + open PR**

```bash
git checkout -b feat/whatsapp-setup-pairing
git push -u origin feat/whatsapp-setup-pairing
gh pr create --title "feat(setup): WhatsApp pairing — QR + code + HTTP + auto-recovery" --body "$(cat <<'EOF'
## Summary

Replaces the SSH-dependent QR-on-stdout pairing flow with an HTTP-accessible `/setup` endpoint that supports both QR code AND 8-digit pairing code, with automatic recovery on `LoggedOut`.

**Operator pareia a Maia pelo browser.** SSH é necessário só **uma vez** para copiar o bootstrap token (`cat $BAILEYS_AUTH_DIR/setup-token.txt`). Re-pair após `LoggedOut` é totalmente automático: process detecta, apaga `.baileys-auth/`, rotaciona token, manda alerta via `ALERT_CHANNELS`, expõe novo `/setup`.

- New `src/setup/` module: state machine (singleton + lazy TTL expiry), bootstrap token (file-backed mode 0o600 + atomic create + timing-safe verify), Fastify routes (chooser / qr / code / status / done / connected), QR PNG generator (`qrcode@^1.5`), Tailwind via CDN templates with copy button + countdown + status pane.
- Recovery flow with singleton-promise lock — concurrent `LoggedOut` events join the same execution.
- Security headers on every `/setup*` response: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
- Alert body **never** contains the token (operator must SSH).
- 8 new audit actions cover the full pairing lifecycle.
- `pairing_completed` / `pairing_qr_displayed` / `pairing_recovery_*` / `setup_token_rotated` / `setup_unauthorized_access`.

## Spec & Plan

- Spec: `docs/superpowers/specs/2026-04-30-whatsapp-setup-pairing-design.md` (iter-2 approved, 9 blockers + 5 advisory addressed in iter-1).
- Plan: `docs/superpowers/plans/2026-04-30-whatsapp-setup-pairing.md` (8 tasks, this PR).

## Acceptance criteria

All verified by code inspection + ~33 new unit tests:

- [x] `setup-token.txt` created with mode 0o600 on cold start; audit `setup_token_rotated` with `reason: 'cold_start'`.
- [x] `GET /setup?token=<correct>` on `unpaired` returns chooser HTML.
- [x] `GET /setup?token=<wrong>` returns 403; audit `setup_unauthorized_access` written without token in metadata.
- [x] All `/setup*` responses include `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`.
- [x] `POST /setup/start {method:'qr'}` 200 (server-side no-op when `unpaired`).
- [x] `POST /setup/start {method:'code'}` calls `triggerPairingCode(WHATSAPP_NUMBER_MAIA)`; transitions to `pairing_code`. 503 + `retry_after_s: 2` when socket not ready (boot race).
- [x] `GET /setup/qr.png` returns valid PNG (magic bytes verified).
- [x] `GET /setup/status` returns JSON without raw QR string.
- [x] `connected` phase → 410 with friendly HTML + dashboard link only when `FEATURE_DASHBOARD=true`.
- [x] `triggerRecovery()` is idempotent (singleton-promise lock verified).
- [x] Pairing code TTL (180s) expires lazily on `current()` read.
- [x] Existing WhatsApp flows (B0/B1/B2/B3a/B3b/B4) untouched.

## Test plan

- [x] `npx vitest run tests/unit/setup-*.spec.ts` — all new tests pass (~33 across 3 files).
- [x] `npx vitest run tests/unit/baileys-*.spec.ts` — B3a/B3b/B4 baileys tests still pass (no regressions from `connection.update` modifications).
- [ ] **Manual on VPS**:
  1. Cold deploy (no `.baileys-auth/` yet) → log shows `setup.bootstrap_token_ready`. SSH `cat .baileys-auth/setup-token.txt` → browser to `/setup?token=...` → click "QR" → scan with WhatsApp on Maia phone → page redirects to `/setup/done` (or `/dashboard` if flag on).
  2. Same with code: click "Código" → 8-digit code shown with copy button + countdown. WhatsApp app → "Conectar com número" → enter code → page transitions to connected.
  3. Logout via WhatsApp app → process auto-recovers: log shows `setup.recovery_started`, then `recovery_completed`. Alert email/telegram received WITHOUT token in body. SSH cat new token → re-pair.

## Notes

- New `qrcode@^1.5` dep (~30KB pure-JS). No native bindings.
- Tailwind via CDN — zero build, ~30KB JIT runtime. Minimal `<style>` fallback if CDN unreachable.
- No new feature flag — pareamento é fundamental, sempre disponível. `SETUP_TOKEN_OVERRIDE` env var optional (dev/test).
- Pre-existing TS errors in `db/client.ts`, `gateway/queue.ts`, `lib/alerts.ts` unchanged.
- Pre-existing ESLint v9 config migration also unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Verification matrix (maps to spec §12 acceptance criteria)

| AC bullet | Plan task | Test |
|---|---|---|
| Cold boot creates `setup-token.txt` mode 0o600 | 3, 7 | `setup-token.spec.ts` "creates token file with mode 0o600 when missing" |
| `GET /setup` correct token → chooser | 6 | `setup-routes.spec.ts` "with correct token returns 200 + chooser HTML" |
| Wrong token → 403 + audit | 6 | `setup-routes.spec.ts` "with wrong token returns 403" |
| Security headers on every response | 6 | `setup-routes.spec.ts` "without token returns 403 with security headers" |
| QR method → no-op + later auto-transition | 6 | `setup-routes.spec.ts` "method=qr from unpaired returns 200" |
| Code method → triggerPairingCode + state | 6 | `setup-routes.spec.ts` "method=code from unpaired calls triggerPairingCode" |
| Code method 503 retry_after_s | 6 | `setup-routes.spec.ts` "method=code returns 503 with retry_after_s" |
| QR PNG endpoint | 6 | `setup-routes.spec.ts` "returns PNG buffer when phase=pairing_qr" |
| Status JSON shape (no raw QR) | 6 | `setup-routes.spec.ts` "returns phase JSON with correct shape" |
| Connected → 410 + dashboard-conditional link | 6 | `setup-routes.spec.ts` "GET /setup on connected returns 410" |
| Recovery idempotent (singleton promise) | 4 | `setup-state.spec.ts` "triggerRecovery is idempotent" |
| Pairing code TTL expiry | 4 | `setup-state.spec.ts` "pairing_code lazily expires on current() read after TTL" |
| Auto-transition `unpaired → pairing_qr` via setQr | 4 | `setup-state.spec.ts` "setQr from unpaired auto-transitions" |
| `disconnected_transient → pairing_qr` | 4 | `setup-state.spec.ts` "setQr from disconnected_transient auto-transitions" |
| `hasValidBaileysSession` for boot gate | 4 | `setup-state.spec.ts` "hasValidBaileysSession" describe block (3 tests) |
| Pre-existing tests don't regress | 7 | Manual: `npx vitest run tests/unit/baileys-*.spec.ts` |

---

## Dependencies and prerequisites

All prior WhatsApp sub-projects merged or in flight:
- sub-A (`sendOutboundText` opts) — PR #11
- B0 (pending-gate) — PR #12
- B1 (one-tap) — PR #15
- B2 (message-update + reminder) — PR #16
- B3a (view-once) — PR #17
- B3b (PDF reports) — PR #18
- B4 (outbound voice) — PR #19

This new sub-project (setup-pairing) is **architecturally independent** of the B-axis. The only shared modification points are:
- `src/gateway/baileys.ts` `connection.update` handler (touched by all of B0-B4 indirectly; setup-pairing modifies the close + open paths)
- `src/governance/audit-actions.ts` (each B-task appended actions; setup-pairing appends 8 more)
- `src/config/env.ts` (each B-task added a `FEATURE_*` flag; setup-pairing adds `SETUP_TOKEN_OVERRIDE`)

If main moves significantly between this plan and execution, Task 1 (env.ts/audit-actions.ts append points) and Task 7 (baileys.ts surgery points) may need a small rebase against the latest line numbers. Anchor texts (`FEATURE_PDF_REPORTS` block, `'outbound_sent_voice'` entry, `connection.update` handler shape) should be stable.

---

## Out of scope (carry to follow-ups)

| Item | Defer to |
|---|---|
| Setup wizard via WhatsApp (chicken-and-egg) | Not pursued |
| Multi-tenant pairing | Not pursued (single-process Maia) |
| Custom 8-digit code chosen by owner | Defer; auto-generated is fine |
| IP whitelist / VPN-only access to `/setup` | Layer in front (nginx) if desired |
| Cookie-based CSRF defense after first GET | Post-merge polish if needed |
| Browser-based QR scanner | Operator scans with the Maia phone, same as today |
| Calendarized token rotation | Only on pair / re-pair / manual |
| `/setup` rate limiting | Operator surface, not public |
