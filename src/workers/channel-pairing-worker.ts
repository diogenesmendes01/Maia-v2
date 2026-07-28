/**
 * Issue #518 — ponte Admin→runtime do pareamento de linhas WhatsApp.
 *
 * O console (Next.js) NÃO tem o socket Baileys: ele escreve um comando
 * durável em `channel_line_state` (migration 103) junto com o ATOR
 * administrativo; este worker — que roda no processo do runtime — reivindica
 * o comando (`FOR UPDATE SKIP LOCKED`), executa a PairingSession e devolve o
 * estado. Nenhum bootstrap token atravessa a fronteira, nenhum segredo entra
 * em query string.
 *
 * Por que fila em Postgres e não uma API interna: é o padrão já estabelecido
 * no repo (`mcp.requestOp` + `mcp-sync-worker`, `playground.enqueueUserTurn` +
 * `playground-turn-worker`), não exige secret novo nem superfície de rede
 * nova, e a issue a sanciona explicitamente ("command queue durável, desde
 * que QR/código não sejam persistidos em plaintext e o owner da sessão possa
 * ser localizado" — `owner_instance`).
 *
 * Material sensível: o QR sai daqui JÁ RENDERIZADO como PNG data URI e
 * CIFRADO (`setup/pairing-material.ts`); o código de 8 dígitos idem. Nada
 * disso é logado nem auditado.
 */
import { hostname } from 'node:os';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import { audit } from '@/governance/audit.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  channelLineStateRepo,
  type PairingMethod,
} from '@/db/repositories/channel-line-state-repos.js';
import {
  sealPairingMaterial,
  PAIRING_MATERIAL_TTL_MS,
} from '@/setup/pairing-material.js';
import { qrToPngBuffer } from '@/setup/qr-png.js';
import { startChannelPairing, abortChannelPairing } from '@/setup/line-pairing.js';
import { triggerRecovery } from '@/setup/recovery.js';

/** Máximo de comandos executados por tick — mantém o tick curto e previsível. */
const MAX_COMMANDS_PER_TICK = 10;

/**
 * A varredura de pairings órfãos (restart/TTL) roda 1x por minuto, não a cada
 * tick: é um UPDATE, e o tick é de segundos.
 */
const STALE_SWEEP_EVERY_TICKS = 12;

/**
 * Identidade da INSTÂNCIA do runtime. Muda a cada restart de propósito: é
 * exatamente assim que `failStalePairings` reconhece uma tentativa cuja
 * PairingSession morreu com o processo anterior.
 */
const OWNER_INSTANCE = `${hostname()}:${process.pid}`;

let running = false;
let tickCount = 0;

/** Test-only: reseta o guard de reentrância entre casos. */
export const _internal = {
  OWNER_INSTANCE,
  reset(): void {
    running = false;
    tickCount = 0;
  },
};

/**
 * Persiste o material EM CLARO recebido do Baileys já cifrado. Best-effort:
 * uma falha aqui deixa o operador sem QR na tela (ele repete), mas NUNCA
 * degrada para gravar em claro. O erro é logado sem o material.
 */
function persistMaterial(
  channel_id: string,
  command_id: string | null,
  material: { kind: 'qr'; qr: string } | { kind: 'code'; code: string },
): void {
  void (async () => {
    try {
      const payload =
        material.kind === 'qr'
          ? {
              kind: 'qr' as const,
              png_data_uri: `data:image/png;base64,${(await qrToPngBuffer(material.qr)).toString('base64')}`,
            }
          : { kind: 'code' as const, code: material.code };
      const { envelope, key_id } = sealPairingMaterial(payload);
      await channelLineStateRepo.putPairingMaterial({
        channel_id,
        command_id,
        envelope,
        key_id,
        kind: material.kind as PairingMethod,
        expires_at: new Date(Date.now() + PAIRING_MATERIAL_TTL_MS),
      });
    } catch (err) {
      // `err.message` de staging-crypto/qrcode nunca contém o material.
      logger.error(
        { channel_id, kind: material.kind, err: (err as Error).message },
        'channel_pairing.material_persist_failed',
      );
    }
  })();
}

async function executeStartPairing(row: {
  channel_id: string;
  tenant_id: string;
  agent_id: string;
  command_id: string | null;
  command_method: string | null;
  actor_id: string | null;
  actor_role: string | null;
  correlation_id: string | null;
}): Promise<void> {
  const method: PairingMethod = row.command_method === 'code' ? 'code' : 'qr';
  const actor =
    row.actor_id && row.actor_role
      ? {
          actor_id: row.actor_id,
          actor_role: row.actor_role,
          correlation_id: row.correlation_id ?? row.command_id ?? row.channel_id,
        }
      : undefined;

  const result = await startChannelPairing({
    channel_id: row.channel_id,
    method,
    ...(actor ? { actor } : {}),
    hooks: {
      onMaterial: (m) => persistMaterial(row.channel_id, row.command_id, m),
      onPhase: (p) => {
        if (p.phase === 'pairing') return; // a row já está em `pairing`.
        void channelLineStateRepo
          .transition({
            channel_id: row.channel_id,
            state: p.phase === 'verified' ? 'verified_offline' : 'failed',
            reason_code: p.reason_code ?? null,
            expected_command_id: row.command_id,
            ...(p.phase === 'verified' ? { verified_at: new Date() } : {}),
            // Terminal: a PairingSession acabou, nada mais roda em memória
            // para este canal — solta a lease para o heartbeat parar de
            // renová-la (senão o canal ficaria "ocupado" por 60s à toa).
            release_owner: true,
          })
          .then(() =>
            incCounter('maia_channel_pairing_total', {
              outcome: p.phase === 'verified' ? 'verified' : 'failed',
            }),
          )
          .catch((err) =>
            logger.error(
              { channel_id: row.channel_id, err: (err as Error).message },
              'channel_pairing.transition_persist_failed',
            ),
          );
      },
    },
  });

  if (!result.ok) {
    await channelLineStateRepo.transition({
      channel_id: row.channel_id,
      state: 'failed',
      reason_code: result.error,
      expected_command_id: row.command_id,
      release_owner: true,
    });
    incCounter('maia_channel_pairing_total', { outcome: 'rejected' });
    logger.warn(
      { channel_id: row.channel_id, reason: result.error },
      'channel_pairing.start_rejected',
    );
  }
}

/**
 * Cancelamento. A row já está em `aborting` (o console a colocou lá), o que
 * BLOQUEIA um novo `start_pairing` — é isto que impede a sequência
 * start → cancelar → tentar de novo de sobrescrever o abort e deixar a sessão
 * antiga viva (review PR #528, P1).
 *
 * Só DEPOIS de `abortChannelPairing` resolver — a sessão realmente morreu — a
 * linha volta para `declared` e aceita um novo pareamento.
 */
async function executeAbort(row: {
  channel_id: string;
  tenant_id: string;
  agent_id: string;
  command_id: string | null;
  actor_id: string | null;
  actor_role: string | null;
  correlation_id: string | null;
}): Promise<void> {
  await abortChannelPairing(row.channel_id);
  await channelLineStateRepo.transition({
    channel_id: row.channel_id,
    state: 'declared',
    reason_code: 'operator_abort',
    expected_command_id: row.command_id,
    release_owner: true,
  });
  await runWithTenantContext({ tenant_id: row.tenant_id, agent_id: row.agent_id }, () =>
    audit({
      acao: 'pairing_session_aborted',
      metadata: {
        channel_id: row.channel_id,
        actor_id: row.actor_id,
        actor_role: row.actor_role,
        correlation_id: row.correlation_id,
        origin: 'admin_ui',
      },
    }),
  );
  incCounter('maia_channel_pairing_total', { outcome: 'aborted' });
}

/**
 * Re-pareamento pedido pelo operador: `triggerRecovery` por ALVO desativa o
 * canal no DB (fail-closed) e remove APENAS `lines/<channel_id>`, deixando a
 * linha pronta para um `start_pairing` novo. Credenciais das OUTRAS linhas
 * e da primária não são tocadas.
 */
async function executeRepair(row: {
  channel_id: string;
  tenant_id: string;
  agent_id: string;
  external_id: string;
}): Promise<void> {
  await triggerRecovery({
    target: 'line',
    channel: {
      id: row.channel_id,
      tenant_id: row.tenant_id,
      agent_id: row.agent_id,
      external_id: row.external_id,
    },
  });
  await channelLineStateRepo.transition({
    channel_id: row.channel_id,
    state: 'declared',
    reason_code: 'repair_completed',
    release_owner: true,
  });
  incCounter('maia_channel_pairing_total', { outcome: 'repaired' });
}

/**
 * Restart no meio do pareamento: a PairingSession vivia em memória e morreu.
 * Toda tentativa órfã vira `failed` (retryable) — NUNCA `verified` — e é
 * auditada como `pairing_session_expired` sob o ALS do dono do canal.
 */
async function sweepStalePairings(): Promise<void> {
  // O critério é a LEASE VENCIDA, não "o dono é outro" — ver
  // `failStalePairings`. Com N réplicas, a instância que varre pode
  // perfeitamente não ser a dona da sessão viva, e derrubá-la seria um bug de
  // produção (review PR #528, P1).
  const stale = await channelLineStateRepo.failStalePairings({
    reason_code: 'interrupted_retryable',
  });
  for (const row of stale) {
    incCounter('maia_channel_pairing_total', { outcome: 'expired' });
    await runWithTenantContext({ tenant_id: row.tenant_id, agent_id: row.agent_id }, () =>
      audit({
        acao: 'pairing_session_expired',
        metadata: {
          channel_id: row.channel_id,
          reason: 'interrupted_retryable',
          owner_instance: OWNER_INSTANCE,
        },
      }),
    ).catch(() => undefined);
  }
  // Aborts órfãos: o processo que detinha a sessão morreu antes de confirmar.
  // A morte já cumpriu o efeito do abort — a linha volta a ser pareável em vez
  // de ficar presa em `aborting` para sempre.
  for (const row of await channelLineStateRepo.releaseStaleAborts()) {
    logger.info({ channel_id: row.channel_id }, 'channel_pairing.stale_abort_released');
  }
  await channelLineStateRepo.expireStaleMaterial();
}

export async function runChannelPairingWorker(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Heartbeat ANTES de qualquer varredura: renova a lease do que ESTA
    // instância está tocando agora. Se este processo morrer, para de renovar e
    // outra réplica assume — é a única forma correta de distinguir dono morto
    // de dono vivo (review PR #528, P1).
    await channelLineStateRepo
      .renewOwnerLeases(OWNER_INSTANCE)
      .catch((err) =>
        logger.warn({ err: (err as Error).message }, 'channel_pairing.lease_renew_failed'),
      );

    if (tickCount % STALE_SWEEP_EVERY_TICKS === 0) {
      await sweepStalePairings();
    }
    tickCount += 1;

    for (let i = 0; i < MAX_COMMANDS_PER_TICK; i += 1) {
      const row = await channelLineStateRepo.claimNextCommand(OWNER_INSTANCE);
      if (!row) return;
      try {
        if (row.command === 'start_pairing') {
          await executeStartPairing(row);
        } else if (row.command === 'abort_pairing') {
          await executeAbort(row);
        } else if (row.command === 'repair') {
          await executeRepair({
            channel_id: row.channel_id,
            tenant_id: row.tenant_id,
            agent_id: row.agent_id,
            external_id: row.external_id,
          });
        }
      } catch (err) {
        // Fail-isolated por comando: um canal problemático não trava a fila.
        logger.error(
          { channel_id: row.channel_id, command: row.command, err: (err as Error).message },
          'channel_pairing.command_failed',
        );
        await channelLineStateRepo
          .transition({
            channel_id: row.channel_id,
            state: 'failed',
            reason_code: 'command_execution_failed',
            expected_command_id: row.command_id,
            release_owner: true,
          })
          .catch(() => undefined);
      } finally {
        // CAS: só limpa SE o comando ainda for este e a posse ainda for nossa.
        // O `finally` incondicional anterior apagava um comando NOVO que o
        // operador tivesse enfileirado durante a execução (review PR #528, P1).
        await channelLineStateRepo
          .clearCommand({
            channel_id: row.channel_id,
            command_id: row.command_id,
            owner_instance: OWNER_INSTANCE,
          })
          .catch(() => undefined);
      }
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'channel_pairing.tick_failed');
  } finally {
    running = false;
  }
}
