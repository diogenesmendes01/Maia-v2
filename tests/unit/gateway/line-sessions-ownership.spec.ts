/**
 * Issue #513 §6 — POSSE EXCLUSIVA da linha, com lease e fencing token.
 *
 * ── O que estava aberto ────────────────────────────────────────────────
 *
 * A #518 registrava a posse (`session_owner_instance` + lease) para ENDEREÇAR
 * `stop_line`/`repair` à réplica dona. Isso é roteamento, não exclusividade: a
 * escrita é um upsert last-writer-wins feito DEPOIS de o socket já estar
 * aberto, e o caminho de boot (`startAdditionalLineSessions`) enumerava todas
 * as linhas ativas e abria um socket para cada uma sem reivindicar nada. Duas
 * réplicas `session-owner` abriam a MESMA linha, e a segunda simplesmente
 * sobrescrevia o registro da primeira.
 *
 * Esta suíte trava as duas metades do conserto:
 *   1. ADQUIRIR antes de abrir — e não abrir quando a posse é de outro, ou
 *      quando o banco não respondeu (posse ambígua ⇒ posse negada);
 *   2. FECHAR ao perder — o CAS do heartbeat falha ⇒ o socket morre na hora.
 *
 * Por que fechar em vez de só marcar: o WhatsApp não conhece fencing token, e
 * portanto não existe "recusar o envio do dono antigo no servidor". A única
 * defesa é o dono antigo parar, e parar significa não ter mais socket.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  makeSocketMock,
  handlerState,
  auditMock,
  auditCalls,
  managerMock,
  acquireMock,
  renewFencedMock,
  releaseMock,
} = vi.hoisted(() => {
  const state: {
    sockets: Array<{ handlers: Map<string, (...args: never[]) => unknown>; end: () => void }>;
  } = { sockets: [] };
  return {
    handlerState: state,
    auditMock: vi.fn(async () => undefined),
    auditCalls: [] as Array<{ acao: string; metadata: Record<string, unknown>; ctx: unknown }>,
    acquireMock: vi.fn(),
    renewFencedMock: vi.fn(async () => ({ renewed: [] as string[], lost: [] as string[] })),
    releaseMock: vi.fn(async () => 0),
    managerMock: {
      register: vi.fn(),
      markState: vi.fn(),
      isEnabled: vi.fn(() => true),
    },
    makeSocketMock: vi.fn(() => {
      const sock = {
        ev: {
          on: (event: string, handler: (...args: never[]) => unknown) => {
            state.sockets[state.sockets.length - 1]!.handlers.set(event, handler);
          },
        },
        end: vi.fn(),
        user: { id: '5511900002222:1@s.whatsapp.net' },
      };
      state.sockets.push({ handlers: new Map(), end: sock.end });
      return sock;
    }),
  };
});

vi.mock('@whiskeysockets/baileys', () => ({
  default: makeSocketMock,
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: vi.fn().mockResolvedValue({ state: {}, saveCreds: vi.fn() }),
  fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
}));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: () => true };
});
vi.mock('../../../src/config/env.js', () => ({
  config: { MAIA_MULTI_LINE: true, BAILEYS_AUTH_DIR: '/tmp/maia-line-ownership-test' },
}));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../../src/db/repositories/channel-repos.js', () => ({
  channelsRepo: { listActiveWhatsappLinesCrossTenant: vi.fn(async () => []) },
}));
vi.mock('../../../src/db/repositories/channel-line-state-repos.js', () => ({
  channelLineStateRepo: {
    upsertTransition: vi.fn(async () => undefined),
    acquireSessionLease: acquireMock,
    renewFencedSessionLeases: renewFencedMock,
    releaseSessionOwnership: releaseMock,
  },
}));
vi.mock('../../../src/gateway/baileys.js', () => ({
  ingressUpsertMessage: vi.fn(async () => 'handled' as const),
  handleMessagesUpdate: vi.fn(async () => undefined),
  getCurrentLineE164: vi.fn(() => '+5511900001111'),
  sendOutboundTextVia: vi.fn(),
  sendOutboundDocumentVia: vi.fn(),
  sendOutboundVoiceVia: vi.fn(),
}));
vi.mock('../../../src/gateway/presence.js', () => ({
  markReadVia: vi.fn(),
  startTypingVia: vi.fn(),
  sendReactionVia: vi.fn(),
  sendPollVia: vi.fn(),
}));
vi.mock('../../../src/gateway/line-session-manager.js', () => ({
  getLineSessionManager: () => managerMock,
  lineAuthDir: (id: string) => `/tmp/maia-line-ownership-test/lines/${id}`,
}));

import {
  _internal,
  listLocalLineSessions,
  heartbeatLineOwnership,
} from '../../../src/gateway/line-sessions.js';
import { tryGetCurrentContext } from '../../../src/db/tenant-context.js';

const CHANNEL = {
  id: '11111111-1111-4111-8111-111111111111',
  tenant_id: 'tenant-b',
  agent_id: 'agent-b',
  external_id: '+5511900002222',
};

function granted(fencing_token: number, previous_owner: string | null = null) {
  return {
    ok: true as const,
    takeover: previous_owner !== null,
    grant: {
      channel_id: CHANNEL.id,
      fencing_token,
      acquired_at: new Date(),
      previous_owner,
    },
  };
}

const HELD_BY_OTHER = {
  ok: false as const,
  reason: 'held_by_other' as const,
  owner_instance: 'other-replica:99',
  lease_expires_at: new Date(Date.now() + 60_000),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  handlerState.sockets.length = 0;
  auditCalls.length = 0;
  auditMock.mockImplementation(async (input: unknown) => {
    const i = input as { acao: string; metadata: Record<string, unknown> };
    auditCalls.push({ acao: i.acao, metadata: i.metadata, ctx: tryGetCurrentContext() });
  });
  acquireMock.mockResolvedValue(granted(1));
  renewFencedMock.mockResolvedValue({ renewed: [], lost: [] });
  _internal.sessions.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('aquisição da posse ANTES de abrir o socket', () => {
  it('reivindica a linha antes de construir o socket — nunca depois', async () => {
    await _internal.startLineSession(CHANNEL);

    expect(acquireMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: CHANNEL.id,
        tenant_id: CHANNEL.tenant_id,
        agent_id: CHANNEL.agent_id,
      }),
    );
    expect(makeSocketMock).toHaveBeenCalledTimes(1);
    // A ordem é o contrato inteiro: reivindicar DEPOIS de abrir é o que a
    // #518 fazia, e é o que permitia duas réplicas na mesma linha.
    expect(acquireMock.mock.invocationCallOrder[0]!).toBeLessThan(
      makeSocketMock.mock.invocationCallOrder[0]!,
    );
  });

  it('posse de OUTRA réplica ⇒ NENHUM socket é aberto (a segunda réplica desiste)', async () => {
    acquireMock.mockResolvedValue(HELD_BY_OTHER);

    await _internal.startLineSession(CHANNEL);

    expect(makeSocketMock).not.toHaveBeenCalled();
    expect(_internal.sessions.size).toBe(0);
    expect(listLocalLineSessions()).toEqual([]);
  });

  it('FALHA DE BANCO ⇒ não abre: posse ambígua é posse negada', async () => {
    // Abrir "otimisticamente" quando não se sabe quem é o dono é literalmente
    // como se cria um split-brain de sessão WhatsApp.
    acquireMock.mockRejectedValue(new Error('connection terminated'));

    await _internal.startLineSession(CHANNEL);

    expect(makeSocketMock).not.toHaveBeenCalled();
    expect(_internal.sessions.size).toBe(0);
  });

  it('guarda o fencing token concedido — é o CAS de toda renovação futura', async () => {
    acquireMock.mockResolvedValue(granted(7));
    await _internal.startLineSession(CHANNEL);

    expect(listLocalLineSessions()).toEqual([
      expect.objectContaining({ channel_id: CHANNEL.id, fencing_token: 7 }),
    ]);
  });

  it('audita a AQUISIÇÃO sob o ALS do dono do canal, com o token', async () => {
    acquireMock.mockResolvedValue(granted(3));
    await _internal.startLineSession(CHANNEL);

    const acquired = auditCalls.find((c) => c.acao === 'line_session_ownership_acquired');
    expect(acquired).toBeDefined();
    expect(acquired!.metadata).toMatchObject({ channel_id: CHANNEL.id, fencing_token: 3 });
    // Nunca no bucket `system`: metadata não corrige colunas nem labels.
    expect(acquired!.ctx).toMatchObject({
      tenant_id: CHANNEL.tenant_id,
      agent_id: CHANNEL.agent_id,
    });
  });

  it('TAKEOVER é auditado como tal, citando o dono anterior', async () => {
    acquireMock.mockResolvedValue(granted(4, 'dead-replica:7'));
    await _internal.startLineSession(CHANNEL);

    const takeover = auditCalls.find((c) => c.acao === 'line_session_ownership_taken_over');
    expect(takeover).toBeDefined();
    expect(takeover!.metadata).toMatchObject({
      previous_owner: 'dead-replica:7',
      fencing_token: 4,
    });
    // Um takeover NÃO é uma aquisição comum — o operador precisa distinguir
    // "assumi uma linha livre" de "tomei a linha de um processo morto".
    expect(auditCalls.some((c) => c.acao === 'line_session_ownership_acquired')).toBe(false);
  });

  it('material de auth NUNCA entra nos metadados de posse', async () => {
    acquireMock.mockResolvedValue(granted(1));
    await _internal.startLineSession(CHANNEL);

    for (const call of auditCalls) {
      const serialized = JSON.stringify(call.metadata);
      expect(serialized).not.toContain(CHANNEL.external_id);
      expect(serialized).not.toMatch(/auth|creds|qr|secret/i);
    }
  });
});

describe('heartbeat fail-closed — perder a lease FECHA o socket', () => {
  it('CAS falhou ⇒ a sessão local é encerrada imediatamente', async () => {
    await _internal.startLineSession(CHANNEL);
    expect(_internal.sessions.size).toBe(1);

    renewFencedMock.mockResolvedValue({ renewed: [], lost: [CHANNEL.id] });
    const result = await heartbeatLineOwnership();

    expect(result).toEqual({ renewed: 0, lost: 1 });
    expect(_internal.sessions.size).toBe(0);
    expect(handlerState.sockets[0]!.end).toHaveBeenCalled();
    // O transporte some do manager: a LineOutput passa a falhar fechada em vez
    // de despachar por um socket que já não nos pertence.
    expect(managerMock.markState).toHaveBeenCalledWith(CHANNEL.id, 'closed');
  });

  it('a perda cancela o timer de reconexão — o socket NÃO volta sozinho', async () => {
    await _internal.startLineSession(CHANNEL);
    // Close transiente agenda a reconexão…
    const handler = handlerState.sockets[0]!.handlers.get('connection.update')!;
    (handler as (u: unknown) => void)({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });

    // …mas nesse meio-tempo a posse foi perdida.
    renewFencedMock.mockResolvedValue({ renewed: [], lost: [CHANNEL.id] });
    await heartbeatLineOwnership();

    await vi.advanceTimersByTimeAsync(120_000);
    // Sem o clearTimeout, o callback reabriria o socket de uma linha que
    // pertence a outra réplica — split-brain com hora marcada.
    expect(makeSocketMock).toHaveBeenCalledTimes(1);
  });

  it('audita a PERDA com o token que deixou de valer', async () => {
    acquireMock.mockResolvedValue(granted(9));
    await _internal.startLineSession(CHANNEL);
    auditCalls.length = 0;

    renewFencedMock.mockResolvedValue({ renewed: [], lost: [CHANNEL.id] });
    await heartbeatLineOwnership();
    await vi.advanceTimersByTimeAsync(0);

    const lost = auditCalls.find((c) => c.acao === 'line_session_ownership_lost');
    expect(lost).toBeDefined();
    expect(lost!.metadata).toMatchObject({
      channel_id: CHANNEL.id,
      fencing_token: 9,
      reason: 'heartbeat_cas_failed',
    });
    expect(lost!.ctx).toMatchObject({
      tenant_id: CHANNEL.tenant_id,
      agent_id: CHANNEL.agent_id,
    });
  });

  it('renovação bem-sucedida NÃO mexe no socket', async () => {
    await _internal.startLineSession(CHANNEL);

    renewFencedMock.mockResolvedValue({ renewed: [CHANNEL.id], lost: [] });
    const result = await heartbeatLineOwnership();

    expect(result).toEqual({ renewed: 1, lost: 0 });
    expect(_internal.sessions.size).toBe(1);
    expect(handlerState.sockets[0]!.end).not.toHaveBeenCalled();
  });

  it('renova exatamente as linhas locais, com instância e token', async () => {
    acquireMock.mockResolvedValue(granted(5));
    await _internal.startLineSession(CHANNEL);

    await heartbeatLineOwnership();

    expect(renewFencedMock).toHaveBeenCalledWith(
      expect.any(String),
      [expect.objectContaining({ channel_id: CHANNEL.id, fencing_token: 5 })],
    );
  });

  it('sem sessão local o heartbeat é um no-op barato — nenhuma escrita', async () => {
    expect(await heartbeatLineOwnership()).toEqual({ renewed: 0, lost: 0 });
    expect(renewFencedMock).not.toHaveBeenCalled();
  });

  it('falha de BANCO no heartbeat não fecha nada (a lease ainda tem folga)', async () => {
    await _internal.startLineSession(CHANNEL);
    renewFencedMock.mockRejectedValue(new Error('db unreachable'));

    // Propaga para o chamador decidir; o que NÃO pode acontecer é fechar um
    // socket saudável por causa de um blip. O que fecha a sessão é a lease
    // VENCER — e aí o CAS do próximo tick que alcançar o banco falha.
    await expect(heartbeatLineOwnership()).rejects.toThrow(/db unreachable/);
    expect(_internal.sessions.size).toBe(1);
    expect(handlerState.sockets[0]!.end).not.toHaveBeenCalled();
  });
});

describe('reconexão da própria instância', () => {
  it('reabrir a MESMA linha renova a posse em vez de duplicar a sessão', async () => {
    await _internal.startLineSession(CHANNEL);
    acquireMock.mockResolvedValue(granted(1)); // mesmo token: é renovação
    await _internal.startLineSession(CHANNEL);

    expect(_internal.sessions.size).toBe(1);
    expect(acquireMock).toHaveBeenCalledTimes(2);
  });

  it('perder a posse durante um reconnect impede a reabertura', async () => {
    await _internal.startLineSession(CHANNEL);
    expect(makeSocketMock).toHaveBeenCalledTimes(1);

    // Outra réplica assumiu enquanto esta reconectava.
    acquireMock.mockResolvedValue(HELD_BY_OTHER);
    await _internal.startLineSession(CHANNEL);

    expect(makeSocketMock).toHaveBeenCalledTimes(1);
  });
});
