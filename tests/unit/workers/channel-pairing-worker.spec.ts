/**
 * Issue #518 — worker que executa os comandos de pareamento vindos do Admin.
 *
 * O que trava aqui:
 *   - o QR chega do Baileys em claro e SAI da memória do worker já CIFRADO —
 *     `putPairingMaterial` nunca recebe o QR cru;
 *   - o ator administrativo do console é repassado à orquestração (a trilha
 *     do runtime cita quem pediu, não `system`);
 *   - restart no meio do pareamento vira `failed` retryable, NUNCA `verified`,
 *     e audita `pairing_session_expired`;
 *   - abort audita `pairing_session_aborted` sob o ALS do dono do canal;
 *   - falha de um comando não trava a fila (fail-isolated) e o comando é
 *     sempre limpo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const QR_RAW = '2@abcDEF/ghi+jkl=,mnoPQR/stu+vwx=';

const {
  repoMock,
  auditMock,
  auditCalls,
  startPairingMock,
  abortPairingMock,
  triggerRecoveryMock,
  sealMock,
  qrPngMock,
} = vi.hoisted(() => ({
  repoMock: {
    claimNextCommand: vi.fn(),
    clearCommand: vi.fn(async () => true),
    renewOwnerLeases: vi.fn(async () => 0),
    putPairingMaterial: vi.fn(async () => true),
    transition: vi.fn(async () => true),
    failStalePairings: vi.fn(async () => []),
    releaseStaleAborts: vi.fn(async () => []),
    expireStaleMaterial: vi.fn(async () => 0),
  },
  auditMock: vi.fn(async () => undefined),
  auditCalls: [] as Array<{ acao: string; ctx: unknown; metadata: unknown }>,
  startPairingMock: vi.fn(async () => ({ ok: true as const })),
  abortPairingMock: vi.fn(async () => undefined),
  triggerRecoveryMock: vi.fn(async () => undefined),
  sealMock: vi.fn(() => ({ envelope: Buffer.from('SEALED'), key_id: 'k1' })),
  qrPngMock: vi.fn(async () => Buffer.from('PNGBYTES')),
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/lib/metrics.js', () => ({ incCounter: vi.fn() }));
vi.mock('../../../src/governance/audit.js', () => ({ audit: auditMock }));
vi.mock('../../../src/db/repositories/channel-line-state-repos.js', () => ({
  channelLineStateRepo: repoMock,
}));
vi.mock('../../../src/setup/pairing-material.js', () => ({
  sealPairingMaterial: sealMock,
  PAIRING_MATERIAL_TTL_MS: 90_000,
}));
vi.mock('../../../src/setup/qr-png.js', () => ({ qrToPngBuffer: qrPngMock }));
vi.mock('../../../src/setup/line-pairing.js', () => ({
  startChannelPairing: startPairingMock,
  abortChannelPairing: abortPairingMock,
}));
vi.mock('../../../src/setup/recovery.js', () => ({ triggerRecovery: triggerRecoveryMock }));

import {
  runChannelPairingWorker,
  _internal,
} from '../../../src/workers/channel-pairing-worker.js';
import { tryGetCurrentContext } from '../../../src/db/tenant-context.js';

const CHANNEL_ID = 'channel-uuid-1';
const COMMAND_ID = 'command-uuid-1';

function commandRow(over: Record<string, unknown> = {}) {
  return {
    channel_id: CHANNEL_ID,
    tenant_id: 'tenant-A',
    agent_id: 'agent-a',
    command: 'start_pairing',
    command_method: 'qr',
    command_id: COMMAND_ID,
    actor_id: 'user-1',
    actor_role: 'owner',
    correlation_id: 'corr-1',
    external_id: '+5511900001111',
    channel_type: 'whatsapp',
    channel_active: false,
    ...over,
  };
}

/** Devolve o row uma vez e depois `null` — um comando por tick. */
function claimOnce(row: Record<string, unknown> | null): void {
  let served = false;
  repoMock.claimNextCommand.mockImplementation(async () => {
    if (served) return null;
    served = true;
    return row;
  });
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  auditCalls.length = 0;
  auditMock.mockImplementation(async (input: { acao: string; metadata?: unknown }) => {
    auditCalls.push({
      acao: input.acao,
      ctx: tryGetCurrentContext(),
      metadata: input.metadata,
    });
  });
  repoMock.failStalePairings.mockResolvedValue([]);
  repoMock.releaseStaleAborts.mockResolvedValue([]);
  repoMock.renewOwnerLeases.mockResolvedValue(0);
  repoMock.clearCommand.mockResolvedValue(true);
  repoMock.putPairingMaterial.mockResolvedValue(true);
  repoMock.transition.mockResolvedValue(true);
  startPairingMock.mockResolvedValue({ ok: true });
  sealMock.mockReturnValue({ envelope: Buffer.from('SEALED'), key_id: 'k1' });
  qrPngMock.mockResolvedValue(Buffer.from('PNGBYTES'));
  _internal.reset();
});

describe('start_pairing — o material só sai daqui cifrado', () => {
  it('o QR cru vira PNG e é SELADO antes de tocar o repo', async () => {
    let capturedHooks: {
      onMaterial?: (m: unknown) => void;
    } = {};
    startPairingMock.mockImplementation(async (args: { hooks?: typeof capturedHooks }) => {
      capturedHooks = args.hooks ?? {};
      return { ok: true };
    });
    claimOnce(commandRow());

    await runChannelPairingWorker();
    capturedHooks.onMaterial?.({ kind: 'qr', qr: QR_RAW });
    await flush();

    expect(qrPngMock).toHaveBeenCalledWith(QR_RAW);
    // Selado a partir do data URI, nunca do QR cru.
    const sealedArg = sealMock.mock.calls[0]![0] as { kind: string; png_data_uri: string };
    expect(sealedArg.kind).toBe('qr');
    expect(sealedArg.png_data_uri.startsWith('data:image/png;base64,')).toBe(true);

    const put = repoMock.putPairingMaterial.mock.calls[0]![0] as {
      envelope: Buffer;
      key_id: string;
      command_id: string;
    };
    expect(put.envelope.toString()).toBe('SEALED');
    expect(put.envelope.toString()).not.toContain(QR_RAW);
    expect(put.key_id).toBe('k1');
    // Guard de identidade: o material é amarrado à TENTATIVA.
    expect(put.command_id).toBe(COMMAND_ID);
  });

  it('o ator administrativo do console é repassado à orquestração', async () => {
    claimOnce(commandRow());
    await runChannelPairingWorker();
    const args = startPairingMock.mock.calls[0]![0] as {
      actor?: { actor_id: string; actor_role: string; correlation_id: string };
      method: string;
    };
    expect(args.method).toBe('qr');
    expect(args.actor).toEqual({
      actor_id: 'user-1',
      actor_role: 'owner',
      correlation_id: 'corr-1',
    });
  });

  it('verified persiste verified_offline (posse provada ≠ sessão conectada)', async () => {
    let hooks: { onPhase?: (p: unknown) => void } = {};
    startPairingMock.mockImplementation(async (args: { hooks?: typeof hooks }) => {
      hooks = args.hooks ?? {};
      return { ok: true };
    });
    claimOnce(commandRow());
    await runChannelPairingWorker();

    hooks.onPhase?.({ phase: 'verified' });
    await flush();

    const call = repoMock.transition.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(call.state).toBe('verified_offline');
    expect(call.expected_command_id).toBe(COMMAND_ID);
  });

  it('start rejeitado pela orquestração persiste failed com o reason tipado', async () => {
    startPairingMock.mockResolvedValue({ ok: false, error: 'already_active' });
    claimOnce(commandRow());
    await runChannelPairingWorker();

    expect(repoMock.transition).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failed', reason_code: 'already_active' }),
    );
  });

  it('o comando é SEMPRE limpo, mesmo quando a execução explode', async () => {
    startPairingMock.mockRejectedValue(new Error('boom'));
    claimOnce(commandRow());
    await runChannelPairingWorker();

    expect(repoMock.transition).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failed', reason_code: 'command_execution_failed' }),
    );
    expect(repoMock.clearCommand).toHaveBeenCalledWith({
      channel_id: CHANNEL_ID,
      command_id: COMMAND_ID,
      owner_instance: _internal.OWNER_INSTANCE,
    });
  });
});

describe('lease de posse — correção distribuída (review PR #528, P1)', () => {
  it('o tick RENOVA a lease antes de varrer — dono vivo nunca vira stale', async () => {
    claimOnce(null);
    await runChannelPairingWorker();

    expect(repoMock.renewOwnerLeases).toHaveBeenCalledWith(_internal.OWNER_INSTANCE);
    // Ordem importa: renovar DEPOIS de varrer deixaria a própria sessão viva
    // desta instância exposta a um tick perdido.
    const renewOrder = repoMock.renewOwnerLeases.mock.invocationCallOrder[0]!;
    const sweepOrder = repoMock.failStalePairings.mock.invocationCallOrder[0]!;
    expect(renewOrder).toBeLessThan(sweepOrder);
  });

  it('a varredura NÃO recebe owner_instance: o critério é a lease, não a identidade', async () => {
    claimOnce(null);
    await runChannelPairingWorker();

    const args = repoMock.failStalePairings.mock.calls[0]![0] as Record<string, unknown>;
    // Com `owner_instance` no filtro, a réplica B derrubava a sessão viva da
    // réplica A a cada tick — o bug que este teste tranca.
    expect(args).not.toHaveProperty('owner_instance');
    expect(args.reason_code).toBe('interrupted_retryable');
  });

  it('clearCommand é CAS por (channel_id, command_id, owner_instance)', async () => {
    claimOnce(commandRow());
    await runChannelPairingWorker();

    expect(repoMock.clearCommand).toHaveBeenCalledWith({
      channel_id: CHANNEL_ID,
      command_id: COMMAND_ID,
      owner_instance: _internal.OWNER_INSTANCE,
    });
  });

  it('transições terminais SOLTAM a posse (o heartbeat para de renovar)', async () => {
    let hooks: { onPhase?: (p: unknown) => void } = {};
    startPairingMock.mockImplementation(async (args: { hooks?: typeof hooks }) => {
      hooks = args.hooks ?? {};
      return { ok: true };
    });
    claimOnce(commandRow());
    await runChannelPairingWorker();

    hooks.onPhase?.({ phase: 'verified' });
    await flush();

    expect(repoMock.transition).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'verified_offline', release_owner: true }),
    );
  });

  it('uma falha no heartbeat não derruba o tick', async () => {
    repoMock.renewOwnerLeases.mockRejectedValue(new Error('db blip'));
    claimOnce(commandRow());
    await expect(runChannelPairingWorker()).resolves.toBeUndefined();
    expect(startPairingMock).toHaveBeenCalled();
  });
});

describe('abort e repair', () => {
  it('abort chama a orquestração e audita sob o ALS do dono do canal', async () => {
    claimOnce(commandRow({ command: 'abort_pairing', command_method: null }));
    await runChannelPairingWorker();

    expect(abortPairingMock).toHaveBeenCalledWith(CHANNEL_ID);
    const aborted = auditCalls.find((c) => c.acao === 'pairing_session_aborted');
    expect(aborted?.ctx).toMatchObject({ tenant_id: 'tenant-A', agent_id: 'agent-a' });
    expect(aborted?.metadata).toMatchObject({ actor_id: 'user-1', actor_role: 'owner' });
  });

  it('a linha só volta para declared DEPOIS que a sessão foi realmente abortada', async () => {
    const order: string[] = [];
    abortPairingMock.mockImplementation(async () => {
      order.push('abort');
    });
    repoMock.transition.mockImplementation(async (a: { state: string }) => {
      order.push(`transition:${a.state}`);
      return true;
    });
    claimOnce(commandRow({ command: 'abort_pairing', command_method: null }));
    await runChannelPairingWorker();

    // A ordem é o invariante: reabrir a linha ANTES de matar a sessão é
    // exatamente o que permitia a tentativa antiga concluir e ativar.
    expect(order).toEqual(['abort', 'transition:declared']);
    expect(repoMock.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'declared',
        reason_code: 'operator_abort',
        expected_command_id: COMMAND_ID,
        release_owner: true,
      }),
    );
  });

  it('aborts órfãos (dono morto) são resgatados no sweep', async () => {
    repoMock.releaseStaleAborts.mockResolvedValue([{ channel_id: CHANNEL_ID }]);
    claimOnce(null);
    await runChannelPairingWorker();
    expect(repoMock.releaseStaleAborts).toHaveBeenCalled();
  });

  it('repair delega ao recovery POR ALVO e devolve a linha para declared', async () => {
    claimOnce(commandRow({ command: 'repair', command_method: null }));
    await runChannelPairingWorker();

    expect(triggerRecoveryMock).toHaveBeenCalledWith({
      target: 'line',
      channel: {
        id: CHANNEL_ID,
        tenant_id: 'tenant-A',
        agent_id: 'agent-a',
        external_id: '+5511900001111',
      },
    });
    expect(repoMock.transition).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'declared', reason_code: 'repair_completed' }),
    );
  });
});

describe('restart no meio do pareamento', () => {
  it('tentativa órfã vira failed retryable — NUNCA verified — e audita expired', async () => {
    repoMock.failStalePairings.mockResolvedValue([
      { channel_id: CHANNEL_ID, tenant_id: 'tenant-A', agent_id: 'agent-a' },
    ]);
    claimOnce(null);

    await runChannelPairingWorker();

    const args = repoMock.failStalePairings.mock.calls[0]![0] as { reason_code: string };
    expect(args.reason_code).toBe('interrupted_retryable');

    const expired = auditCalls.find((c) => c.acao === 'pairing_session_expired');
    expect(expired?.ctx).toMatchObject({ tenant_id: 'tenant-A', agent_id: 'agent-a' });
    expect(auditCalls.some((c) => c.acao === 'pairing_session_verified')).toBe(false);
  });

  it('o material vencido é varrido junto', async () => {
    claimOnce(null);
    await runChannelPairingWorker();
    expect(repoMock.expireStaleMaterial).toHaveBeenCalled();
  });
});

describe('reentrância', () => {
  it('dois ticks concorrentes não processam a fila em paralelo', async () => {
    let resolveClaim: (v: unknown) => void = () => undefined;
    repoMock.claimNextCommand.mockImplementation(
      () => new Promise((r) => (resolveClaim = r as (v: unknown) => void)),
    );

    const first = runChannelPairingWorker();
    await flush(); // deixa o primeiro tick alcançar o claim (fica pendente)
    const second = runChannelPairingWorker();
    await second; // retorna imediatamente pelo guard `running`

    expect(repoMock.claimNextCommand).toHaveBeenCalledTimes(1);
    resolveClaim(null);
    await first;
  });
});
