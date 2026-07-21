/**
 * Auditoria P0 cap. 7 — migração do layout do auth dir no boot da primária:
 *  - layout LEGADO (creds.json direto na raiz) migra para `primary/` via
 *    staging + rename atômico, SEM tocar lines/, pairing/, control/, media/
 *    nem o setup-token.txt legado;
 *  - instalação nova só cria `primary/`;
 *  - idempotente (primary/ existente ⇒ retorna direto);
 *  - staging órfão de um boot interrompido com creds.json é PROMOVIDO;
 *  - falha no meio da migração faz rollback e o boot SEGUE NA RAIZ legada
 *    (nenhum arquivo fica meio-migrado sem sessão utilizável).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const { BASE, fsCtl } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  return {
    BASE: path.join(os.tmpdir(), 'maia-baileys-auth-migration-' + Date.now()),
    fsCtl: { failNextRename: false },
  };
});
const AUTH_DIR = join(BASE, '.baileys-auth');

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: vi.fn(async (a: string, b: string) => {
      if (fsCtl.failNextRename) {
        fsCtl.failNextRename = false;
        throw new Error('EACCES: simulated rename failure');
      }
      return real.rename(a, b);
    }),
  };
});

vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(),
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
  downloadMediaMessage: vi.fn(),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
}));
vi.mock('qrcode-terminal', () => ({ default: { generate: vi.fn() } }));
vi.mock('../../../src/config/env.js', () => ({
  config: {
    BAILEYS_AUTH_DIR: BASE + '/.baileys-auth',
    FEATURE_MESSAGE_UPDATE: false,
    FEATURE_ONE_TAP: false,
  },
}));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));
vi.mock('../../../src/db/repositories.js', () => ({ mensagensRepo: {} }));
vi.mock('../../../src/db/tenant-context.js', () => ({ runWithTenantContext: vi.fn() }));
vi.mock('../../../src/db/repositories/channel-repos.js', () => ({
  channelsRepo: { findByExternalCrossTenant: vi.fn() },
}));
vi.mock('../../../src/lib/redis.js', () => ({
  redis: {},
  isRedisConnected: () => false,
  ensureRedisConnect: vi.fn(),
}));
vi.mock('../../../src/gateway/queue.js', () => ({ enqueueAgent: vi.fn() }));
vi.mock('../../../src/gateway/dedup.js', () => ({ isDuplicate: vi.fn(), markSeen: vi.fn() }));
vi.mock('../../../src/gateway/presence.js', () => ({
  markRead: vi.fn(),
  startTyping: vi.fn(),
  sendReaction: vi.fn(),
  sendPoll: vi.fn(),
}));
vi.mock('../../../src/gateway/debouncer.js', () => ({ scheduleDebouncedAgent: vi.fn() }));
vi.mock('../../../src/gateway/bot-detection.js', () => ({ checkBotAndMaybeBlock: vi.fn() }));
vi.mock('../../../src/agent/one-tap.js', () => ({
  dispatchReactionAsAnswer: vi.fn(),
  dispatchPollVote: vi.fn(),
}));
vi.mock('../../../src/agent/message-update.js', () => ({ routeMessageUpdate: vi.fn() }));
vi.mock('../../../src/setup/state.js', () => ({ setupState: {} }));
vi.mock('../../../src/setup/recovery.js', () => ({ triggerRecovery: vi.fn() }));

import { _internal } from '../../../src/gateway/baileys.js';

function seedLegacyLayout(): void {
  mkdirSync(AUTH_DIR, { recursive: true });
  // Sessão legada solta na raiz.
  writeFileSync(join(AUTH_DIR, 'creds.json'), '{"me":{"id":"legacy"}}');
  writeFileSync(join(AUTH_DIR, 'pre-key-1.json'), '{}');
  mkdirSync(join(AUTH_DIR, 'sender-keys'), { recursive: true });
  writeFileSync(join(AUTH_DIR, 'sender-keys', 'k.json'), '{}');
  // Entradas RESERVADAS — a migração NUNCA as move.
  mkdirSync(join(AUTH_DIR, 'lines', 'ch-1'), { recursive: true });
  writeFileSync(join(AUTH_DIR, 'lines', 'ch-1', 'creds.json'), '{"me":{"id":"line"}}');
  mkdirSync(join(AUTH_DIR, 'pairing', 'ch-2'), { recursive: true });
  writeFileSync(join(AUTH_DIR, 'pairing', 'ch-2', 'creds.json'), '{"me":{"id":"pair"}}');
  mkdirSync(join(AUTH_DIR, 'control'), { recursive: true });
  writeFileSync(join(AUTH_DIR, 'control', 'setup-token.txt'), 'tok\n');
  mkdirSync(join(AUTH_DIR, 'media'), { recursive: true });
  writeFileSync(join(AUTH_DIR, 'setup-token.txt'), 'legacy-tok\n');
}

beforeEach(async () => {
  vi.clearAllMocks();
  fsCtl.failNextRename = false;
  await rm(BASE, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(BASE, { recursive: true, force: true });
});

describe('ensurePrimaryAuthDirMigrated — layout legado → primary/ (cap. 7)', () => {
  it('migra a sessão legada da raiz para primary/ sem tocar as entradas reservadas', async () => {
    seedLegacyLayout();
    const dir = await _internal._ensurePrimaryAuthDirMigrated();

    expect(dir).toBe(join(AUTH_DIR, 'primary'));
    // Sessão movida para dentro de primary/.
    expect(readFileSync(join(dir, 'creds.json'), 'utf-8')).toContain('legacy');
    expect(existsSync(join(dir, 'pre-key-1.json'))).toBe(true);
    expect(existsSync(join(dir, 'sender-keys', 'k.json'))).toBe(true);
    // Raiz limpa da sessão legada…
    expect(existsSync(join(AUTH_DIR, 'creds.json'))).toBe(false);
    expect(existsSync(join(AUTH_DIR, 'sender-keys'))).toBe(false);
    // …mas as reservadas ficam onde estavam.
    expect(existsSync(join(AUTH_DIR, 'lines', 'ch-1', 'creds.json'))).toBe(true);
    expect(existsSync(join(AUTH_DIR, 'pairing', 'ch-2', 'creds.json'))).toBe(true);
    expect(existsSync(join(AUTH_DIR, 'control', 'setup-token.txt'))).toBe(true);
    expect(existsSync(join(AUTH_DIR, 'media'))).toBe(true);
    expect(readFileSync(join(AUTH_DIR, 'setup-token.txt'), 'utf-8').trim()).toBe('legacy-tok');
    // Nenhum staging sobrando.
    const { readdirSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    expect(readdirSync(AUTH_DIR).filter((n) => n.startsWith('.primary-migration-'))).toEqual([]);
  });

  it('instalação nova (sem creds legado) apenas cria primary/', async () => {
    const dir = await _internal._ensurePrimaryAuthDirMigrated();
    expect(dir).toBe(join(AUTH_DIR, 'primary'));
    expect(existsSync(dir)).toBe(true);
  });

  it('idempotente: primary/ existente retorna direto sem mexer na raiz', async () => {
    seedLegacyLayout();
    const first = await _internal._ensurePrimaryAuthDirMigrated();
    const second = await _internal._ensurePrimaryAuthDirMigrated();
    expect(second).toBe(first);
  });

  it('staging órfão COM creds.json (boot interrompido) é promovido a primary/', async () => {
    mkdirSync(join(AUTH_DIR, '.primary-migration-999-1'), { recursive: true });
    writeFileSync(
      join(AUTH_DIR, '.primary-migration-999-1', 'creds.json'),
      '{"me":{"id":"staged"}}',
    );
    const dir = await _internal._ensurePrimaryAuthDirMigrated();
    expect(dir).toBe(join(AUTH_DIR, 'primary'));
    expect(readFileSync(join(dir, 'creds.json'), 'utf-8')).toContain('staged');
    expect(existsSync(join(AUTH_DIR, '.primary-migration-999-1'))).toBe(false);
  });

  it('falha no meio da migração: rollback e boot SEGUE na raiz legada', async () => {
    seedLegacyLayout();
    fsCtl.failNextRename = true;

    const dir = await _internal._ensurePrimaryAuthDirMigrated();

    // Caminho legado mantido para ESTE boot (fail-safe).
    expect(dir).toBe(AUTH_DIR);
    // Sessão legada intacta na raiz (rollback), primary/ não criado.
    expect(existsSync(join(AUTH_DIR, 'creds.json'))).toBe(true);
    expect(existsSync(join(AUTH_DIR, 'pre-key-1.json'))).toBe(true);
    expect(existsSync(join(AUTH_DIR, 'primary'))).toBe(false);
    // Reservadas intocadas.
    expect(existsSync(join(AUTH_DIR, 'lines', 'ch-1', 'creds.json'))).toBe(true);
    expect(existsSync(join(AUTH_DIR, 'control', 'setup-token.txt'))).toBe(true);
  });
});
