/**
 * FIX 1 [HIGH] — importing the gateway/baileys module must have NO filesystem
 * side effects.
 *
 * Regression: `baileys.ts` ran `mkdirSync(MEDIA_ROOT, ...)` at module top
 * level, so merely IMPORTING it (which the admin-ui does transitively via the
 * tool registry → send-proactive-message → baileys) wrote `media/` dirs to
 * disk. An admin-ui process must never touch the backend's media tree.
 *
 * This test imports the REAL baileys module (heavy transitive Redis/queue deps
 * are stubbed, but `node:fs`, `MEDIA_ROOT`, and `ensureMediaDirs` are real) and
 * asserts:
 *   - `MEDIA_ROOT` does NOT exist after import (no side effect), and
 *   - `ensureMediaDirs()` creates `<MEDIA_ROOT>` and `<MEDIA_ROOT>/tmp`.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// A fresh, guaranteed-absent media root for this test run.
const { AUTH_DIR, MEDIA_DIR } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');
  const base = path.join(os.tmpdir(), 'maia-baileys-side-effect-' + Date.now());
  return { AUTH_DIR: path.join(base, '.baileys'), MEDIA_DIR: path.join(base, 'media') };
});

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(),
  DisconnectReason: {},
  useMultiFileAuthState: vi.fn(),
  downloadMediaMessage: vi.fn(),
  fetchLatestBaileysVersion: vi.fn(),
}));
vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() } }));
vi.mock('../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: AUTH_DIR,
    FEATURE_MESSAGE_UPDATE: false,
    FEATURE_ONE_TAP: false,
    FEATURE_VIEW_ONCE_SENSITIVE: false,
  },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/governance/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../../src/db/repositories.js', () => ({ mensagensRepo: {} }));
vi.mock('../../src/db/tenant-context.js', () => ({ runWithTenantContext: vi.fn() }));
// Redis-touching transitive modules — stub so import doesn't open a socket.
vi.mock('../../src/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
}));
vi.mock('../../src/gateway/queue.js', () => ({ enqueueAgent: vi.fn() }));
vi.mock('../../src/gateway/dedup.js', () => ({ isDuplicate: vi.fn(), markSeen: vi.fn() }));
vi.mock('../../src/gateway/presence.js', () => ({ markRead: vi.fn() }));
vi.mock('../../src/gateway/debouncer.js', () => ({ scheduleDebouncedAgent: vi.fn() }));
vi.mock('../../src/gateway/bot-detection.js', () => ({ checkBotAndMaybeBlock: vi.fn() }));
vi.mock('../../src/agent/one-tap.js', () => ({
  dispatchReactionAsAnswer: vi.fn(),
  dispatchPollVote: vi.fn(),
}));
vi.mock('../../src/agent/message-update.js', () => ({ routeMessageUpdate: vi.fn() }));
vi.mock('../../src/setup/state.js', () => ({ setupState: {} }));
vi.mock('../../src/setup/recovery.js', () => ({ triggerRecovery: vi.fn() }));

afterAll(() => {
  rmSync(join(MEDIA_DIR, '..'), { recursive: true, force: true });
});

describe('gateway/baileys — no module-load filesystem side effects (FIX 1)', () => {
  it('importing the module does NOT create the media directory', async () => {
    // Sanity: nothing exists before import.
    expect(existsSync(MEDIA_DIR)).toBe(false);

    const mod = await import('../../src/gateway/baileys.js');

    // MEDIA_ROOT is computed (side-effect free) but the dir is NOT created.
    expect(mod.MEDIA_ROOT).toBe(MEDIA_DIR);
    expect(existsSync(MEDIA_DIR)).toBe(false);
    expect(existsSync(join(MEDIA_DIR, 'tmp'))).toBe(false);
  });

  it('ensureMediaDirs() creates MEDIA_ROOT and MEDIA_ROOT/tmp (idempotent)', async () => {
    const mod = await import('../../src/gateway/baileys.js');
    mod.ensureMediaDirs();
    expect(existsSync(MEDIA_DIR)).toBe(true);
    expect(existsSync(join(MEDIA_DIR, 'tmp'))).toBe(true);
    // Idempotent: a second call doesn't throw.
    expect(() => mod.ensureMediaDirs()).not.toThrow();
  });
});
