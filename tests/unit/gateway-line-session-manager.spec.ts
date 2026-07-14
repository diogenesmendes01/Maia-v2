/**
 * LineSessionManager (spec roteamento v4 §1.5/§2.5, fases 1–3):
 *   - transportFor é FAIL-CLOSED: linha sem sessão viva ⇒ TypedError — nunca
 *     devolve a sessão de outra linha;
 *   - auth dirs derivam do UUID do canal com validação path.resolve
 *     (traversal rejeitado — review v3);
 *   - isLineConnected reflete registro + estado + transporte.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/env.js', () => ({
  config: { BAILEYS_AUTH_DIR: '/tmp/maia-test-auth', MAIA_MULTI_LINE: false },
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  getLineSessionManager,
  lineAuthDir,
  pairingAuthDir,
  type LineTransport,
} from '../../src/gateway/line-session-manager.js';

function fakeTransport(connected = true): LineTransport {
  return {
    sendText: vi.fn(async () => 'wid'),
    sendDocument: vi.fn(async () => 'wid'),
    sendVoice: vi.fn(async () => 'wid'),
    sendPoll: vi.fn(async () => ({
      whatsapp_id: 'w',
      message_secret: 's',
      creator_jid: 'c',
    })),
    sendReaction: vi.fn(),
    startTyping: vi.fn(() => ({ stop: vi.fn() })),
    markRead: vi.fn(),
    isConnected: () => connected,
  };
}

beforeEach(() => {
  getLineSessionManager()._resetForTests();
});

describe('LineSessionManager — posse fail-closed das sessões por linha', () => {
  it('transportFor lança line_session_unavailable para canal sem sessão — nunca outra linha', () => {
    const manager = getLineSessionManager();
    manager.register('ch-other', fakeTransport(), {
      line_external_id: '+551190000',
      is_primary: true,
    });
    expect(() => manager.transportFor('ch-without-session')).toThrowError(
      expect.objectContaining({ code: 'line_session_unavailable' }),
    );
  });

  it('transportFor devolve o transporte registrado da PRÓPRIA linha', () => {
    const manager = getLineSessionManager();
    const t = fakeTransport();
    manager.register('ch-1', t, { line_external_id: '+551191111', is_primary: false });
    expect(manager.transportFor('ch-1')).toBe(t);
  });

  it("markState('closed') remove o transporte — envio subsequente falha fechado", () => {
    const manager = getLineSessionManager();
    manager.register('ch-1', fakeTransport(), {
      line_external_id: '+551191111',
      is_primary: false,
    });
    manager.markState('ch-1', 'closed');
    expect(() => manager.transportFor('ch-1')).toThrowError(
      expect.objectContaining({ code: 'line_session_unavailable' }),
    );
    expect(manager.isLineConnected('ch-1')).toBe(false);
  });

  it('isLineConnected exige registro + estado connected + transporte conectado', () => {
    const manager = getLineSessionManager();
    expect(manager.isLineConnected('ch-none')).toBe(false);
    manager.register('ch-1', fakeTransport(true), {
      line_external_id: '+551191111',
      is_primary: false,
    });
    expect(manager.isLineConnected('ch-1')).toBe(true);
    manager.markState('ch-1', 'recovering');
    expect(manager.isLineConnected('ch-1')).toBe(false);
  });

  it('listSessions expõe o estado por canal (observabilidade fase 1)', () => {
    const manager = getLineSessionManager();
    manager.register('ch-1', fakeTransport(), {
      line_external_id: '+551191111',
      is_primary: true,
    });
    expect(manager.listSessions()).toEqual([
      {
        channel_id: 'ch-1',
        line_external_id: '+551191111',
        state: 'connected',
        is_primary: true,
      },
    ]);
  });
});

describe('auth dirs — UUID do canal, traversal rejeitado (review v3)', () => {
  it('deriva lines/<channel_id> e pairing/<channel_id> sob a raiz', () => {
    expect(lineAuthDir('0b0e8a1c-1111-4222-8333-444455556666')).toBe(
      '/tmp/maia-test-auth/lines/0b0e8a1c-1111-4222-8333-444455556666',
    );
    expect(pairingAuthDir('0b0e8a1c-1111-4222-8333-444455556666')).toBe(
      '/tmp/maia-test-auth/pairing/0b0e8a1c-1111-4222-8333-444455556666',
    );
  });

  it('rejeita channelId com traversal (../) — defesa em profundidade', () => {
    expect(() => lineAuthDir('../../etc/passwd')).toThrowError(
      expect.objectContaining({ code: 'auth_dir_escape' }),
    );
    expect(() => pairingAuthDir('..')).toThrowError(
      expect.objectContaining({ code: 'auth_dir_escape' }),
    );
  });
});
