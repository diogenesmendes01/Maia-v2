/**
 * Review #498 (alto 4) — PairingSession no LineSessionManager:
 *   - reserva SÍNCRONA por canal: chamada concorrente lança
 *     `pairing_in_progress` (duas sessões jamais compartilham o auth dir);
 *   - falha de filesystem na promoção (rm/rename) REJEITA a promise externa
 *     (antes ficava pendente para sempre — pairing preso);
 *   - `abortPairing` RESOLVE a promise pendente (matched: false);
 *   - TTL resolve via abort — nenhuma promise fica pendente;
 *   - um segundo `open` (socket zumbi) não repete a promoção.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { makeSocketMock, socketState, fsMocks } = vi.hoisted(() => {
  const state: {
    sockets: Array<{
      handlers: Map<string, (...args: never[]) => unknown>;
      end: ReturnType<typeof vi.fn>;
      user: { id: string };
    }>;
  } = { sockets: [] };
  return {
    socketState: state,
    fsMocks: {
      rename: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
    },
    makeSocketMock: vi.fn(() => {
      const record = {
        handlers: new Map<string, (...args: never[]) => unknown>(),
        end: vi.fn(),
        user: { id: '5511900002222:1@s.whatsapp.net' },
      };
      state.sockets.push(record);
      return {
        ev: {
          on: (event: string, handler: (...args: never[]) => unknown) => {
            record.handlers.set(event, handler);
          },
        },
        end: record.end,
        get user() {
          return record.user;
        },
        requestPairingCode: vi.fn(async () => '12345678'),
      };
    }),
  };
});

vi.mock('@whiskeysockets/baileys', () => ({
  default: makeSocketMock,
  useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, mkdirSync: vi.fn(), existsSync: () => false };
});
vi.mock('node:fs/promises', () => ({
  rename: fsMocks.rename,
  rm: fsMocks.rm,
}));
vi.mock('../../../src/config/env.js', () => ({
  config: { BAILEYS_AUTH_DIR: '/tmp/maia-baileys-pairing-mgr-test', MAIA_MULTI_LINE: false },
}));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getLineSessionManager,
  pairingAuthDir,
  lineAuthDir,
} from '../../../src/gateway/line-session-manager.js';

const CHANNEL_ID = '0b0e8a1c-1111-4222-8333-444455556666';
const DECLARED = '+5511900002222';

function openLastSocket(): void {
  const record = socketState.sockets[socketState.sockets.length - 1]!;
  const handler = record.handlers.get('connection.update');
  expect(handler).toBeDefined();
  (handler as (u: unknown) => void)({ connection: 'open' });
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  socketState.sockets.length = 0;
  getLineSessionManager()._resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startPairingSession — serialização por canal (review #498 alto 4)', () => {
  it('chamada concorrente para o MESMO canal lança pairing_in_progress', async () => {
    const manager = getLineSessionManager();
    const first = manager.startPairingSession({
      channel_id: CHANNEL_ID,
      declared_line: DECLARED,
    });
    // A reserva é síncrona: a segunda chamada falha ANTES de tocar o auth dir.
    await expect(
      manager.startPairingSession({ channel_id: CHANNEL_ID, declared_line: DECLARED }),
    ).rejects.toMatchObject({ code: 'pairing_in_progress' });
    expect(makeSocketMock).toHaveBeenCalledTimes(1);

    await flush();
    openLastSocket();
    await expect(first).resolves.toEqual({ matched: true, actual_line: DECLARED });
  });

  it('match promove o auth dir (rename pairing → lines) e resolve matched', async () => {
    const manager = getLineSessionManager();
    const p = manager.startPairingSession({ channel_id: CHANNEL_ID, declared_line: DECLARED });
    await flush();
    openLastSocket();

    await expect(p).resolves.toEqual({ matched: true, actual_line: DECLARED });
    expect(fsMocks.rename).toHaveBeenCalledWith(
      pairingAuthDir(CHANNEL_ID),
      lineAuthDir(CHANNEL_ID),
    );
    // Sessão encerrada e slot liberado — um novo pairing pode abrir.
    expect(socketState.sockets[0]!.end).toHaveBeenCalled();
  });

  it('falha de filesystem na promoção REJEITA a promise (nada fica pendente)', async () => {
    fsMocks.rename.mockRejectedValueOnce(new Error('EACCES: rename failed'));
    const manager = getLineSessionManager();
    const p = manager.startPairingSession({ channel_id: CHANNEL_ID, declared_line: DECLARED });
    await flush();
    openLastSocket();

    await expect(p).rejects.toThrow('EACCES: rename failed');
    // Auth dir de pareamento destruído best-effort (sem promoção não há posse).
    expect(fsMocks.rm).toHaveBeenCalledWith(pairingAuthDir(CHANNEL_ID), {
      recursive: true,
      force: true,
    });
  });

  it('abortPairing RESOLVE a promise pendente com matched: false', async () => {
    const manager = getLineSessionManager();
    const p = manager.startPairingSession({ channel_id: CHANNEL_ID, declared_line: DECLARED });
    await flush();

    await manager.abortPairing(CHANNEL_ID, 'operator_abort');
    await expect(p).resolves.toEqual({ matched: false, actual_line: null });
    expect(fsMocks.rm).toHaveBeenCalledWith(pairingAuthDir(CHANNEL_ID), {
      recursive: true,
      force: true,
    });
  });

  it('TTL expira ⇒ promise resolve matched: false (fake timers)', async () => {
    vi.useFakeTimers();
    const manager = getLineSessionManager();
    const p = manager.startPairingSession({ channel_id: CHANNEL_ID, declared_line: DECLARED });
    await vi.advanceTimersByTimeAsync(16 * 60_000);

    await expect(p).resolves.toEqual({ matched: false, actual_line: null });
  });

  it('segundo open (socket zumbi) não repete a promoção nem destrói o auth promovido', async () => {
    const manager = getLineSessionManager();
    const p = manager.startPairingSession({ channel_id: CHANNEL_ID, declared_line: DECLARED });
    await flush();
    openLastSocket();
    openLastSocket(); // zumbi — deve ser ignorado pelo guard `settled`

    await expect(p).resolves.toEqual({ matched: true, actual_line: DECLARED });
    await flush();
    expect(fsMocks.rename).toHaveBeenCalledTimes(1);
  });
});
