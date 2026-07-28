/**
 * Review #498 (alto 4 + alto 2) — orquestração do pareamento (§2.5):
 *   - a reserva do slot é SÍNCRONA: duas chamadas concorrentes nunca sobem
 *     duas PairingSessions para o mesmo canal (antes, o acesso ao DB entre o
 *     teste `pairing_in_progress` e o set deixava ambas passarem);
 *   - falha de validação restaura o slot anterior (novo pairing pode abrir);
 *   - rejeição da PairingSession (ex.: falha de filesystem na promoção)
 *     encerra o pareamento com `failed` — nunca fica preso em `pairing`;
 *   - abort do operador volta a `idle` e o settle atrasado da sessão
 *     abortada NÃO sobrescreve o slot (guard de identidade);
 *   - todos os audits rodam sob o ALS do (tenant, agent) dono do canal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { auditMock, auditCalls, channelsRepoMock, managerMock, rmMock } = vi.hoisted(() => ({
  auditMock: vi.fn(async () => undefined),
  auditCalls: [] as Array<{
    acao: string;
    ctx: { tenant_id: string; agent_id: string } | null;
  }>,
  channelsRepoMock: {
    getByIdCrossTenant: vi.fn(),
    activateVerified: vi.fn(),
  },
  managerMock: {
    startPairingSession: vi.fn(),
    abortPairing: vi.fn(async () => undefined),
  },
  rmMock: vi.fn(async () => undefined),
}));

vi.mock('node:fs/promises', () => ({ rm: rmMock }));
vi.mock('../../../src/config/env.js', () => ({
  config: { MAIA_MULTI_LINE: false, BAILEYS_AUTH_DIR: '/tmp/maia-pairing-orch-test' },
}));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../../src/db/repositories/channel-repos.js', () => ({
  channelsRepo: channelsRepoMock,
  normalizeWhatsappLine: (raw: string) => (raw.startsWith('+') ? raw : null),
}));
vi.mock('../../../src/gateway/line-session-manager.js', () => ({
  getLineSessionManager: () => managerMock,
  lineAuthDir: (id: string) => `/tmp/maia-pairing-orch-test/lines/${id}`,
}));

import {
  startChannelPairing,
  abortChannelPairing,
  channelPairingStatus,
  _resetChannelPairingsForTests,
} from '../../../src/setup/line-pairing.js';
import { tryGetCurrentContext } from '../../../src/db/tenant-context.js';

const CHANNEL = {
  id: 'channel-declared-uuid',
  tenant_id: 'tenant-pair',
  agent_id: 'agent-pair',
  channel_type: 'whatsapp',
  external_id: '+5511900003333',
  active: false,
};

function pendingPairing(): {
  promise: Promise<{ matched: boolean; actual_line: string | null }>;
  resolve: (r: { matched: boolean; actual_line: string | null }) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (r: { matched: boolean; actual_line: string | null }) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<{ matched: boolean; actual_line: string | null }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  auditCalls.length = 0;
  auditMock.mockImplementation(async (input: { acao: string }) => {
    const ctx = tryGetCurrentContext();
    auditCalls.push({
      acao: input.acao,
      ctx: ctx ? { tenant_id: ctx.tenant_id, agent_id: ctx.agent_id } : null,
    });
  });
  channelsRepoMock.getByIdCrossTenant.mockResolvedValue(CHANNEL);
  channelsRepoMock.activateVerified.mockResolvedValue({ ok: true });
  _resetChannelPairingsForTests();
});

describe('startChannelPairing — serialização concorrente (review #498 alto 4)', () => {
  it('duas chamadas CONCORRENTES: só uma sobe PairingSession; a outra recebe pairing_in_progress', async () => {
    managerMock.startPairingSession.mockReturnValue(pendingPairing().promise);

    const [r1, r2] = await Promise.all([
      startChannelPairing({ channel_id: CHANNEL.id, method: 'qr' }),
      startChannelPairing({ channel_id: CHANNEL.id, method: 'qr' }),
    ]);

    const oks = [r1, r2].filter((r) => r.ok);
    const errors = [r1, r2].filter((r) => !r.ok) as Array<{ ok: false; error: string }>;
    expect(oks).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBe('pairing_in_progress');
    expect(managerMock.startPairingSession).toHaveBeenCalledTimes(1);
    expect(channelPairingStatus(CHANNEL.id).phase).toBe('pairing');
  });

  it('falha de validação LIBERA a reserva: a tentativa seguinte abre normalmente', async () => {
    channelsRepoMock.getByIdCrossTenant.mockResolvedValueOnce(null);
    const r1 = await startChannelPairing({ channel_id: CHANNEL.id, method: 'qr' });
    expect(r1).toEqual({ ok: false, error: 'channel_not_found' });
    expect(channelPairingStatus(CHANNEL.id).phase).toBe('idle');

    managerMock.startPairingSession.mockReturnValue(pendingPairing().promise);
    const r2 = await startChannelPairing({ channel_id: CHANNEL.id, method: 'qr' });
    expect(r2).toEqual({ ok: true });
  });

  it('rejeição da PairingSession (falha de filesystem) encerra com failed — nunca preso em pairing', async () => {
    const gate = pendingPairing();
    managerMock.startPairingSession.mockReturnValue(gate.promise);
    expect(await startChannelPairing({ channel_id: CHANNEL.id, method: 'qr' })).toEqual({
      ok: true,
    });

    gate.reject(new Error('EACCES: rename failed'));
    await flush();

    const status = channelPairingStatus(CHANNEL.id);
    expect(status.phase).toBe('failed');
    expect(status.error).toContain('EACCES');
    expect(auditCalls.map((c) => c.acao)).toContain('pairing_session_failed');
  });

  it('abort do operador: slot volta a idle e o settle atrasado NÃO sobrescreve (guard de identidade)', async () => {
    const gate = pendingPairing();
    managerMock.startPairingSession.mockReturnValue(gate.promise);
    await startChannelPairing({ channel_id: CHANNEL.id, method: 'qr' });
    expect(channelPairingStatus(CHANNEL.id).phase).toBe('pairing');

    await abortChannelPairing(CHANNEL.id);
    expect(managerMock.abortPairing).toHaveBeenCalledWith(CHANNEL.id, 'operator_abort');
    expect(channelPairingStatus(CHANNEL.id).phase).toBe('idle');

    // O abort no manager resolve a promise pendente (matched: false); o
    // callback atrasado não pode reverter o slot para failed.
    gate.resolve({ matched: false, actual_line: null });
    await flush();
    expect(channelPairingStatus(CHANNEL.id).phase).toBe('idle');
  });
});

describe('resultado SUPERSEDED não ativa a linha (review PR #528, P1)', () => {
  it('abort DURANTE a promoção: matched=true chega tarde, o canal NÃO é ativado', async () => {
    const gate = pendingPairing();
    managerMock.startPairingSession.mockReturnValue(gate.promise);
    await startChannelPairing({ channel_id: CHANNEL.id, method: 'qr' });

    // O operador cancela. A PairingSession, porém, já tinha disparado `open`
    // — `abortPairing` não consegue mais resolver a promise dela, e ela
    // resolve sozinha com matched=true logo depois.
    await abortChannelPairing(CHANNEL.id);
    gate.resolve({ matched: true, actual_line: CHANNEL.external_id });
    await flush();

    // ESTE é o bug que a #528 apontou: antes, a tentativa cancelada ativava a
    // linha assim mesmo.
    expect(channelsRepoMock.activateVerified).not.toHaveBeenCalled();
    expect(channelPairingStatus(CHANNEL.id).phase).toBe('idle');
    // O auth promovido é destruído — manter permitiria subir uma sessão de
    // uma linha que o operador acabou de recusar.
    expect(rmMock).toHaveBeenCalled();
    const failed = auditCalls.find((c) => c.acao === 'pairing_session_failed');
    expect(failed?.ctx).toEqual({ tenant_id: 'tenant-pair', agent_id: 'agent-pair' });
  });

  it('uma tentativa NOVA também invalida o resultado da anterior', async () => {
    const first = pendingPairing();
    managerMock.startPairingSession.mockReturnValueOnce(first.promise);
    await startChannelPairing({ channel_id: CHANNEL.id, method: 'qr' });

    await abortChannelPairing(CHANNEL.id);
    const second = pendingPairing();
    managerMock.startPairingSession.mockReturnValueOnce(second.promise);
    await startChannelPairing({ channel_id: CHANNEL.id, method: 'code' });

    first.resolve({ matched: true, actual_line: CHANNEL.external_id });
    await flush();

    expect(channelsRepoMock.activateVerified).not.toHaveBeenCalled();
    expect(channelPairingStatus(CHANNEL.id).phase).toBe('pairing');
  });
});

describe('audits sob ALS do dono do canal (review #498 alto 2)', () => {
  it('started/verified auditam com tenant/agent do canal — nunca bucket system', async () => {
    const gate = pendingPairing();
    managerMock.startPairingSession.mockReturnValue(gate.promise);
    await startChannelPairing({ channel_id: CHANNEL.id, method: 'qr' });

    gate.resolve({ matched: true, actual_line: CHANNEL.external_id });
    await flush();

    expect(channelPairingStatus(CHANNEL.id).phase).toBe('verified');
    const byAction = new Map(auditCalls.map((c) => [c.acao, c.ctx]));
    expect(byAction.get('pairing_session_started')).toEqual({
      tenant_id: 'tenant-pair',
      agent_id: 'agent-pair',
    });
    expect(byAction.get('pairing_session_verified')).toEqual({
      tenant_id: 'tenant-pair',
      agent_id: 'agent-pair',
    });
  });

  it('mismatch de linha audita pairing_session_failed sob o ALS do canal', async () => {
    const gate = pendingPairing();
    managerMock.startPairingSession.mockReturnValue(gate.promise);
    await startChannelPairing({ channel_id: CHANNEL.id, method: 'qr' });

    gate.resolve({ matched: false, actual_line: '+5511900009999' });
    await flush();

    const status = channelPairingStatus(CHANNEL.id);
    expect(status.phase).toBe('failed');
    expect(status.error).toBe('line_mismatch');
    expect(status.actual_line).toBe('+5511900009999');
    const failed = auditCalls.find((c) => c.acao === 'pairing_session_failed');
    expect(failed?.ctx).toEqual({ tenant_id: 'tenant-pair', agent_id: 'agent-pair' });
  });
});
