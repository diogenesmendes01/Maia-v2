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
  stopLineSessionMock,
  listLocalSessionsMock,
  heartbeatOwnershipMock,
  readinessMock,
  activateVerifiedMock,
  sealMock,
  qrPngMock,
} = vi.hoisted(() => ({
  repoMock: {
    claimNextCommand: vi.fn(),
    completeCommand: vi.fn(async () => true),
    renewOwnerLeases: vi.fn(async () => 0),
    renewSessionLeases: vi.fn(async () => 0),
    putPairingMaterial: vi.fn(async () => true),
    transition: vi.fn(async () => true),
    failStalePairings: vi.fn(async () => []),
    releaseStaleAborts: vi.fn(async () => []),
    listVerifiedAwaitingActivation: vi.fn(async () => []),
    expireStaleMaterial: vi.fn(async () => 0),
  },
  readinessMock: vi.fn(async () => ({ ready: true })),
  activateVerifiedMock: vi.fn(async () => ({ ok: true })),
  auditMock: vi.fn(async () => undefined),
  auditCalls: [] as Array<{ acao: string; ctx: unknown; metadata: unknown }>,
  startPairingMock: vi.fn(async () => ({ ok: true as const })),
  abortPairingMock: vi.fn(async () => undefined),
  triggerRecoveryMock: vi.fn(async () => undefined),
  stopLineSessionMock: vi.fn(() => true),
  listLocalSessionsMock: vi.fn((): Array<{ channel_id: string; tenant_id: string; agent_id: string }> => []),
  // #513 — o heartbeat de posse vive no gateway (é ele que tem o Map de
  // sessões e é ele que fecha o socket quando o CAS falha). O worker só o
  // dispara e conta o resultado.
  heartbeatOwnershipMock: vi.fn(async () => ({ renewed: 0, lost: 0 })),
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
vi.mock('../../../src/gateway/line-sessions.js', () => ({
  stopLineSession: stopLineSessionMock,
  listLocalLineSessions: listLocalSessionsMock,
  heartbeatLineOwnership: heartbeatOwnershipMock,
  _internal: { startLineSession: vi.fn(async () => undefined) },
}));
vi.mock('../../../src/setup/line-readiness.js', () => ({
  evaluateLineReadiness: readinessMock,
}));
vi.mock('../../../src/db/repositories/channel-repos.js', () => ({
  channelsRepo: { activateVerified: activateVerifiedMock },
}));
vi.mock('../../../src/config/env.js', () => ({ config: { MAIA_MULTI_LINE: false } }));

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
  repoMock.listVerifiedAwaitingActivation.mockResolvedValue([]);
  repoMock.renewOwnerLeases.mockResolvedValue(0);
  repoMock.renewSessionLeases.mockResolvedValue(0);
  listLocalSessionsMock.mockReturnValue([]);
  heartbeatOwnershipMock.mockResolvedValue({ renewed: 0, lost: 0 });
  readinessMock.mockResolvedValue({ ready: true });
  activateVerifiedMock.mockResolvedValue({ ok: true });
  repoMock.completeCommand.mockResolvedValue(true);
  repoMock.putPairingMaterial.mockResolvedValue(true);
  repoMock.transition.mockResolvedValue(true);
  startPairingMock.mockResolvedValue({ ok: true });
  stopLineSessionMock.mockReturnValue(true);
  triggerRecoveryMock.mockResolvedValue(undefined);
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

    // O estado terminal viaja na PRÓPRIA conclusão do comando, não num
    // statement separado (rodada 2 do review PR #528).
    expect(repoMock.completeCommand).toHaveBeenCalledWith({
      channel_id: CHANNEL_ID,
      command_id: COMMAND_ID,
      owner_instance: _internal.OWNER_INSTANCE,
      release_owner: true,
      state: 'failed',
      reason_code: 'already_active',
    });
  });

  it('o comando é SEMPRE concluído, mesmo quando a execução explode', async () => {
    startPairingMock.mockRejectedValue(new Error('boom'));
    claimOnce(commandRow());
    await runChannelPairingWorker();

    expect(repoMock.completeCommand).toHaveBeenCalledWith({
      channel_id: CHANNEL_ID,
      command_id: COMMAND_ID,
      owner_instance: _internal.OWNER_INSTANCE,
      release_owner: true,
      state: 'failed',
      reason_code: 'command_execution_failed',
    });
  });

  it('start bem-sucedido NÃO libera a posse — a PairingSession segue viva aqui', async () => {
    claimOnce(commandRow());
    await runChannelPairingWorker();

    const call = repoMock.completeCommand.mock.calls[0]![0] as Record<string, unknown>;
    // Liberar aqui faria o próprio sweep matar a sessão recém-aberta.
    expect(call.release_owner).toBe(false);
    expect(call.state).toBeUndefined();
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

  it('completeCommand é CAS por (channel_id, command_id, owner_instance)', async () => {
    claimOnce(commandRow());
    await runChannelPairingWorker();

    expect(repoMock.completeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: CHANNEL_ID,
        command_id: COMMAND_ID,
        owner_instance: _internal.OWNER_INSTANCE,
      }),
    );
  });

  /**
   * RODADA 2 do review PR #528 — o bug central: `release_owner: true` numa
   * transição SEPARADA zerava o `owner_instance` que o CAS do clear seguinte
   * comparava. O clear falhava, o comando ficava setado e voltava a ser
   * elegível imediatamente.
   */
  it('caminho terminal: limpeza e liberação de posse saem num ÚNICO write', async () => {
    claimOnce(commandRow({ command: 'abort_pairing', command_method: null }));
    await runChannelPairingWorker();

    // Nenhuma transição avulsa com release_owner antes da conclusão.
    for (const call of repoMock.transition.mock.calls) {
      expect((call[0] as Record<string, unknown>).release_owner).not.toBe(true);
    }
    expect(repoMock.completeCommand).toHaveBeenCalledTimes(1);
    expect(repoMock.completeCommand).toHaveBeenCalledWith({
      channel_id: CHANNEL_ID,
      command_id: COMMAND_ID,
      owner_instance: _internal.OWNER_INSTANCE,
      release_owner: true,
      state: 'declared',
      reason_code: 'operator_abort',
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
    repoMock.completeCommand.mockImplementation(async (a: { state?: string }) => {
      order.push(`complete:${a.state ?? 'none'}`);
      return true;
    });
    claimOnce(commandRow({ command: 'abort_pairing', command_method: null }));
    await runChannelPairingWorker();

    // A ordem é o invariante: reabrir a linha ANTES de matar a sessão é
    // exatamente o que permitia a tentativa antiga concluir e ativar.
    expect(order).toEqual(['abort', 'complete:declared']);
  });

  it('aborts órfãos (dono morto) são resgatados no sweep', async () => {
    repoMock.releaseStaleAborts.mockResolvedValue([{ channel_id: CHANNEL_ID }]);
    claimOnce(null);
    await runChannelPairingWorker();
    expect(repoMock.releaseStaleAborts).toHaveBeenCalled();
  });

  it('repair DERRUBA o socket ANTES de apagar o auth dir (review PR #528, P1)', async () => {
    const order: string[] = [];
    stopLineSessionMock.mockImplementation(() => {
      order.push('stop');
      return true;
    });
    triggerRecoveryMock.mockImplementation(async () => {
      order.push('recovery');
    });
    claimOnce(commandRow({ command: 'repair', command_method: null }));
    await runChannelPairingWorker();

    // Ao contrário, o Baileys ainda vivo regrava credenciais em cima do dir
    // recém-removido e a sessão zumbi coexiste com o pareamento novo.
    expect(order).toEqual(['stop', 'recovery']);
    expect(stopLineSessionMock).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it('stop_line derruba a sessão da linha', async () => {
    claimOnce(commandRow({ command: 'stop_line', command_method: null }));
    await runChannelPairingWorker();
    expect(stopLineSessionMock).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it('stop_line CONFIRMADO apaga o registro de posse da sessão', async () => {
    claimOnce(
      commandRow({
        command: 'stop_line',
        command_method: null,
        target_instance: _internal.OWNER_INSTANCE,
      }),
    );
    await runChannelPairingWorker();

    expect(repoMock.completeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ release_owner: true, clear_session_owner: true }),
    );
  });

  it('repair também confirma a derrubada e solta a posse da sessão', async () => {
    claimOnce(commandRow({ command: 'repair', command_method: null }));
    await runChannelPairingWorker();

    expect(repoMock.completeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ clear_session_owner: true, state: 'declared' }),
    );
  });

  it('o tick RENOVA a posse das linhas com socket nesta réplica', async () => {
    claimOnce(null);
    await runChannelPairingWorker();

    // Sem esta renovação, `disable` não teria como endereçar o comando à
    // réplica dona e a linha continuaria respondendo (review PR #528 rodada 2).
    // Desde a #513 o heartbeat também é o que FECHA um socket cuja posse foi
    // perdida — o worker delega essa decisão inteira ao gateway, que é quem
    // tem o Map de sessões.
    expect(heartbeatOwnershipMock).toHaveBeenCalled();
  });

  it('posse perdida no heartbeat é contabilizada (o socket já foi fechado)', async () => {
    heartbeatOwnershipMock.mockResolvedValueOnce({ renewed: 1, lost: 2 });
    claimOnce(null);
    await expect(runChannelPairingWorker()).resolves.toBeUndefined();
    expect(heartbeatOwnershipMock).toHaveBeenCalled();
  });

  it('uma falha no heartbeat NÃO derruba o tick (o resto do trabalho segue)', async () => {
    heartbeatOwnershipMock.mockRejectedValueOnce(new Error('db down'));
    claimOnce(null);
    await expect(runChannelPairingWorker()).resolves.toBeUndefined();
    // O sweep do tick continuou rodando apesar do heartbeat ter falhado.
    expect(repoMock.failStalePairings).toHaveBeenCalled();
  });

  it('stop_line que falha NÃO marca a linha como failed (ela está disabled)', async () => {
    stopLineSessionMock.mockImplementation(() => {
      throw new Error('boom');
    });
    claimOnce(commandRow({ command: 'stop_line', command_method: null }));
    await runChannelPairingWorker();

    // Marcar `failed` aqui apagaria a decisão do operador de desabilitar.
    expect(repoMock.transition).not.toHaveBeenCalled();
    expect(repoMock.completeCommand).toHaveBeenCalled();
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
    expect(repoMock.completeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'declared',
        reason_code: 'repair_completed',
        release_owner: true,
      }),
    );
  });
});

/**
 * RODADA 2 do review PR #528, achados `:396` e `:274`.
 *
 * O caminho terminal ficava REELEGÍVEL: `release_owner: true` numa transição
 * separada zerava o `owner_instance`, o CAS do `clearCommand` seguinte
 * falhava, o comando continuava setado e a próxima varredura o servia de novo
 * — abort/falha reexecutados, potencialmente por outra réplica.
 *
 * Este bloco percorre a SEQUÊNCIA REAL do worker contra um fake de repositório
 * que implementa a semântica de fila, e prova que o comando não reaparece.
 */
describe('sequência real: request → claim → terminal → clear (o comando não reaparece)', () => {
  interface FakeRow {
    channel_id: string;
    tenant_id: string;
    agent_id: string;
    command: string | null;
    command_method: string | null;
    command_id: string | null;
    owner_instance: string | null;
    owner_lease_expires_at: Date | null;
    state: string;
    reason_code: string | null;
    external_id: string;
    channel_type: string;
    channel_active: boolean;
  }

  let row: FakeRow;

  /** Fake com a MESMA semântica de CAS/lease do repositório real. */
  function installQueueFake(): void {
    repoMock.claimNextCommand.mockImplementation(async (owner: string) => {
      if (row.command === null) return null;
      const leaseAlive =
        row.owner_lease_expires_at !== null && row.owner_lease_expires_at.getTime() > Date.now();
      if (row.owner_instance !== null && leaseAlive) return null; // já reivindicado
      row.owner_instance = owner;
      row.owner_lease_expires_at = new Date(Date.now() + 60_000);
      return { ...row };
    });

    repoMock.completeCommand.mockImplementation(
      async (a: {
        channel_id: string;
        command_id: string | null;
        owner_instance: string;
        release_owner: boolean;
        state?: string;
        reason_code?: string | null;
      }) => {
        // CAS exatamente como o UPDATE real.
        if (row.command_id !== a.command_id || row.owner_instance !== a.owner_instance) {
          return false;
        }
        row.command = null;
        row.command_method = null;
        if (a.release_owner) {
          row.owner_instance = null;
          row.owner_lease_expires_at = null;
        } else {
          row.owner_lease_expires_at = new Date(Date.now() + 60_000);
        }
        if (a.state) {
          row.state = a.state;
          row.reason_code = a.reason_code ?? null;
        }
        return true;
      },
    );
  }

  function request(command: string, command_id: string): void {
    row.command = command;
    row.command_id = command_id;
    row.command_method = command === 'start_pairing' ? 'qr' : null;
    row.owner_instance = null;
    row.owner_lease_expires_at = null;
  }

  beforeEach(() => {
    row = {
      channel_id: CHANNEL_ID,
      tenant_id: 'tenant-A',
      agent_id: 'agent-a',
      command: null,
      command_method: null,
      command_id: null,
      owner_instance: null,
      owner_lease_expires_at: null,
      state: 'declared',
      reason_code: null,
      external_id: '+5511900001111',
      channel_type: 'whatsapp',
      channel_active: false,
    };
    installQueueFake();
  });

  it('abort: após o tick, o comando some e NÃO é servido de novo', async () => {
    request('abort_pairing', 'cmd-abort');
    await runChannelPairingWorker();

    expect(row.command).toBeNull();
    expect(row.owner_instance).toBeNull();
    expect(row.state).toBe('declared');

    // O tick seguinte não encontra nada — antes, o abort era reexecutado.
    _internal.reset();
    abortPairingMock.mockClear();
    await runChannelPairingWorker();
    expect(abortPairingMock).not.toHaveBeenCalled();
  });

  it('repair: idem — recovery roda UMA vez, não a cada tick', async () => {
    request('repair', 'cmd-repair');
    await runChannelPairingWorker();
    expect(row.command).toBeNull();
    expect(triggerRecoveryMock).toHaveBeenCalledTimes(1);

    _internal.reset();
    await runChannelPairingWorker();
    expect(triggerRecoveryMock).toHaveBeenCalledTimes(1);
  });

  it('start REJEITADO: vira failed e não é retentado sozinho', async () => {
    startPairingMock.mockResolvedValue({ ok: false, error: 'already_active' });
    request('start_pairing', 'cmd-start');
    await runChannelPairingWorker();

    expect(row.command).toBeNull();
    expect(row.state).toBe('failed');
    expect(row.reason_code).toBe('already_active');

    _internal.reset();
    startPairingMock.mockClear();
    await runChannelPairingWorker();
    expect(startPairingMock).not.toHaveBeenCalled();
  });

  it('start com EXCEÇÃO: comando encerrado como failed, sem reexecução', async () => {
    startPairingMock.mockRejectedValue(new Error('boom'));
    request('start_pairing', 'cmd-start');
    await runChannelPairingWorker();

    expect(row.command).toBeNull();
    expect(row.state).toBe('failed');
    expect(row.reason_code).toBe('command_execution_failed');

    _internal.reset();
    startPairingMock.mockClear();
    await runChannelPairingWorker();
    expect(startPairingMock).not.toHaveBeenCalled();
  });

  it('start BEM-SUCEDIDO: comando consumido, posse RETIDA (sessão viva aqui)', async () => {
    request('start_pairing', 'cmd-start');
    await runChannelPairingWorker();

    expect(row.command).toBeNull();
    // A posse fica: soltá-la faria o sweep matar a PairingSession recém-aberta.
    expect(row.owner_instance).toBe(_internal.OWNER_INSTANCE);
    expect(row.owner_lease_expires_at).not.toBeNull();
  });

  it('comando NOVO durante a execução sobrevive: o CAS da conclusão antiga é recusado', async () => {
    request('start_pairing', 'cmd-start');
    startPairingMock.mockImplementation(async () => {
      // O operador cancela enquanto o start roda.
      request('abort_pairing', 'cmd-abort');
      row.owner_instance = _internal.OWNER_INSTANCE; // ainda reivindicado
      row.owner_lease_expires_at = new Date(Date.now() + 60_000);
      return { ok: true };
    });

    await runChannelPairingWorker();

    // A conclusão do start não pode apagar o abort recém-enfileirado.
    expect(row.command).toBe('abort_pairing');
    expect(row.command_id).toBe('cmd-abort');
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

describe('readiness — a linha verificada só roteia quando estiver pronta (#518 §4)', () => {
  const AWAITING = {
    channel_id: CHANNEL_ID,
    tenant_id: 'tenant-A',
    agent_id: 'agent-a',
    external_id: '+5511900001111',
  };

  it('linha verificada SEM política pronta continua inativa', async () => {
    repoMock.listVerifiedAwaitingActivation.mockResolvedValue([AWAITING]);
    readinessMock.mockResolvedValue({ ready: false, reason_code: 'missing_policy' });
    claimOnce(null);

    await runChannelPairingWorker();

    expect(activateVerifiedMock).not.toHaveBeenCalled();
    expect(auditCalls.some((c) => c.acao === 'channel_activated')).toBe(false);
  });

  it('quando a política fica pronta, o backend ATIVA sozinho — sem novo pareamento', async () => {
    repoMock.listVerifiedAwaitingActivation.mockResolvedValue([AWAITING]);
    readinessMock.mockResolvedValue({ ready: true });
    claimOnce(null);

    await runChannelPairingWorker();

    expect(activateVerifiedMock).toHaveBeenCalledWith({
      tenant_id: 'tenant-A',
      agent_id: 'agent-a',
      channel_id: CHANNEL_ID,
    });
    const activated = auditCalls.find((c) => c.acao === 'channel_activated');
    expect(activated?.ctx).toMatchObject({ tenant_id: 'tenant-A', agent_id: 'agent-a' });
    expect(activated?.metadata).toMatchObject({ trigger: 'readiness_revalidated' });
  });

  /**
   * P1 NOVO da rodada 2 (`channel-pairing-worker.ts:281`): duas réplicas
   * varrendo no mesmo tick listavam a MESMA linha `verified_offline`, as duas
   * recebiam `ok: true` de `activateVerified` e cada uma subia um socket —
   * DOIS sockets Baileys para a mesma linha WhatsApp.
   */
  it('duas réplicas concorrentes: só o VENCEDOR do CAS inicia sessão', async () => {
    repoMock.listVerifiedAwaitingActivation.mockResolvedValue([AWAITING]);
    // O CAS sobre `active = false` só deixa UM UPDATE encontrar a row.
    let winnerTaken = false;
    activateVerifiedMock.mockImplementation(async () => {
      if (winnerTaken) return { ok: false, reason: 'already_active' };
      winnerTaken = true;
      return { ok: true };
    });
    const sessions = await import('../../../src/gateway/line-sessions.js');
    const startLineSession = vi.mocked(sessions._internal.startLineSession);
    startLineSession.mockClear();
    claimOnce(null);

    // Dois sweepers concorrentes (duas réplicas, mesmo tick).
    _internal.reset();
    await runChannelPairingWorker();
    _internal.reset();
    await runChannelPairingWorker();

    expect(activateVerifiedMock).toHaveBeenCalledTimes(2);
    // Exatamente uma ativação vencedora e, portanto, uma única auditoria.
    expect(auditCalls.filter((c) => c.acao === 'channel_activated')).toHaveLength(1);
  });

  it('perdedor da corrida NÃO marca a linha como failed', async () => {
    repoMock.listVerifiedAwaitingActivation.mockResolvedValue([AWAITING]);
    activateVerifiedMock.mockResolvedValue({ ok: false, reason: 'already_active' });
    claimOnce(null);

    await runChannelPairingWorker();

    // A linha está ativa e com sessão subindo na outra réplica: marcá-la
    // `failed` aqui seria mentira, e subir sessão seria o segundo socket.
    expect(repoMock.transition).not.toHaveBeenCalled();
    expect(auditCalls.some((c) => c.acao === 'channel_activated')).toBe(false);
  });

  it('linha que pertence a outro workspace falha fechado, não ativa', async () => {
    repoMock.listVerifiedAwaitingActivation.mockResolvedValue([AWAITING]);
    activateVerifiedMock.mockResolvedValue({ ok: false, reason: 'line_owned_elsewhere' });
    claimOnce(null);

    await runChannelPairingWorker();

    expect(repoMock.transition).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failed', reason_code: 'line_owned_elsewhere' }),
    );
    expect(auditCalls.some((c) => c.acao === 'channel_activated')).toBe(false);
  });

  it('uma linha problemática não impede a promoção das demais', async () => {
    repoMock.listVerifiedAwaitingActivation.mockResolvedValue([
      AWAITING,
      { ...AWAITING, channel_id: 'outro-canal' },
    ]);
    readinessMock
      .mockRejectedValueOnce(new Error('db blip'))
      .mockResolvedValue({ ready: true });
    claimOnce(null);

    await runChannelPairingWorker();

    expect(activateVerifiedMock).toHaveBeenCalledTimes(1);
    expect(activateVerifiedMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: 'outro-canal' }),
    );
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
