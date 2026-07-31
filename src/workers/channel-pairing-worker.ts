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
import { config } from '@/config/env.js';
import { runtimeInstanceId } from '@/runtime/instance-identity.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import { audit } from '@/governance/audit.js';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  channelLineStateRepo,
  type PairingMethod,
  type LineState,
} from '@/db/repositories/channel-line-state-repos.js';
import {
  sealPairingMaterial,
  PAIRING_MATERIAL_TTL_MS,
} from '@/setup/pairing-material.js';
import { qrToPngBuffer } from '@/setup/qr-png.js';
import { startChannelPairing, abortChannelPairing } from '@/setup/line-pairing.js';
import { evaluateLineReadiness } from '@/setup/line-readiness.js';
import { triggerRecovery } from '@/setup/recovery.js';
import { channelsRepo } from '@/db/repositories/channel-repos.js';

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
const OWNER_INSTANCE = runtimeInstanceId();

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

/**
 * O que a CONCLUSÃO atômica do comando deve gravar (rodada 2 do review
 * PR #528). Cada handler apenas DESCREVE o desfecho; quem escreve é um único
 * `completeCommand`, sob um único CAS. Separar "libera a posse" de "limpa o
 * comando" em dois statements foi exatamente o bug: o primeiro zerava o
 * `owner_instance` que o CAS do segundo comparava, o clear falhava e o comando
 * terminal voltava para a fila.
 */
interface CommandCompletion {
  /** `false` só para o `start_pairing` que deixou uma sessão viva AQUI. */
  release_owner: boolean;
  state?: LineState;
  reason_code?: string | null;
  /** A sessão desta linha foi confirmadamente derrubada. */
  clear_session_owner?: boolean;
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
}): Promise<CommandCompletion> {
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
    incCounter('maia_channel_pairing_total', { outcome: 'rejected' });
    logger.warn(
      { channel_id: row.channel_id, reason: result.error },
      'channel_pairing.start_rejected',
    );
    return { release_owner: true, state: 'failed', reason_code: result.error };
  }
  // A PairingSession ficou VIVA nesta instância: o comando foi consumido, mas
  // a posse permanece (o heartbeat continua renovando a lease) até o
  // `onPhase` terminal chegar, minutos depois.
  return { release_owner: false };
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
}): Promise<CommandCompletion> {
  await abortChannelPairing(row.channel_id);
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
  // A linha só reabre para um novo start AGORA, junto da limpeza do comando.
  return { release_owner: true, state: 'declared', reason_code: 'operator_abort' };
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
}): Promise<CommandCompletion> {
  // Review PR #528 (P1) — a ORDEM importa: derrubar o socket ANTES de apagar
  // o auth dir. Ao contrário, o Baileys ainda vivo pode regravar credenciais
  // em cima do dir recém-removido e a sessão zumbi coexiste com o pareamento
  // novo.
  const { stopLineSession } = await import('@/gateway/line-sessions.js');
  stopLineSession(row.channel_id);
  await triggerRecovery({
    target: 'line',
    channel: {
      id: row.channel_id,
      tenant_id: row.tenant_id,
      agent_id: row.agent_id,
      external_id: row.external_id,
    },
  });
  incCounter('maia_channel_pairing_total', { outcome: 'repaired' });
  return {
    release_owner: true,
    state: 'declared',
    reason_code: 'repair_completed',
    clear_session_owner: true,
  };
}

/**
 * Desabilitar uma linha (review PR #528, P1). O console já desativou a row —
 * o roteamento para na hora, que é a propriedade de segurança — mas só o
 * runtime tem o socket. Aqui a sessão é DERRUBADA de fato: timers cancelados,
 * socket encerrado, transporte removido. O estado `disabled` já foi gravado
 * pelo console e é protegido contra ressurreição por callback atrasado.
 */
async function executeStopLine(row: {
  channel_id: string;
  target_instance: string | null;
}): Promise<CommandCompletion> {
  const { stopLineSession } = await import('@/gateway/line-sessions.js');
  const stopped = stopLineSession(row.channel_id);
  incCounter('maia_channel_pairing_total', {
    outcome: stopped ? 'line_stopped' : 'line_already_stopped',
  });
  logger.info(
    { channel_id: row.channel_id, stopped, target: row.target_instance },
    'channel_pairing.stop_line_confirmed',
  );
  // Só chegamos aqui se ESTE processo é o destinatário (a lease do dono ainda
  // valia) ou se o dono registrado já não tem lease — nos dois casos não há
  // socket vivo para esta linha em lugar nenhum. É a CONFIRMAÇÃO que autoriza
  // concluir o comando e apagar o registro de posse da sessão.
  //
  // Sem `state`: a linha já está `disabled` por decisão do operador, e
  // sobrescrever isso apagaria a decisão.
  return { release_owner: true, clear_session_owner: true };
}

/**
 * Renova a posse das sessões que vivem NESTE processo — e FECHA as que a
 * perderam (issue #513 §6).
 *
 * Antes (#518) era só uma publicação: um upsert last-writer-wins que
 * registrava "quem segura o socket" para endereçar `stop_line`/`repair`.
 * Agora é o heartbeat de uma LEASE com fencing token: `heartbeatLineOwnership`
 * faz o CAS por `(instância, token)` e encerra imediatamente o socket de
 * qualquer linha cujo CAS falhou. É o mecanismo que permite mais de uma
 * réplica `session-owner` sem split-brain de sessão.
 *
 * Best-effort quanto ao BANCO: uma falha aqui só atrasa a renovação até o
 * próximo tick (≤5s) e a lease tem 60s de folga. O que NÃO é best-effort é a
 * perda comprovada — essa fecha o socket na hora.
 */
async function publishLocalSessionOwnership(): Promise<void> {
  try {
    const { heartbeatLineOwnership } = await import('@/gateway/line-sessions.js');
    const { lost } = await heartbeatLineOwnership();
    if (lost > 0) {
      incCounter('maia_channel_pairing_total', { outcome: 'session_ownership_lost' });
    }
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'channel_pairing.session_ownership_publish_failed',
    );
  }
}

/**
 * Issue #518 §4 / review PR #528 (P1) — revalidação de READINESS.
 *
 * Uma linha com posse provada mas sem política pronta fica `verified_offline`
 * e NÃO roteia. Sem esta varredura o operador teria que re-parear depois de
 * criar a política, o que é absurdo: a posse já foi provada. Aqui o backend
 * revalida periodicamente e ativa sozinho quando as condições aparecem.
 *
 * Fail-isolated por linha e auditado sob o ALS do dono do canal.
 */
async function promoteReadyVerifiedLines(): Promise<void> {
  const pending = await channelLineStateRepo.listVerifiedAwaitingActivation();
  for (const line of pending) {
    try {
      const readiness = await evaluateLineReadiness({
        id: line.channel_id,
        tenant_id: line.tenant_id,
        agent_id: line.agent_id,
      });
      if (!readiness.ready) continue;

      const act = await channelsRepo.activateVerified({
        tenant_id: line.tenant_id,
        agent_id: line.agent_id,
        channel_id: line.channel_id,
      });
      if (!act.ok) {
        // `already_active`: OUTRA RÉPLICA venceu o CAS neste mesmo tick. É um
        // perdedor benigno — a linha está ativa e com sessão subindo lá.
        // Marcá-la `failed` ou subir uma segunda sessão aqui é justamente o
        // bug que o CAS fecha (review PR #528 rodada 2).
        if (act.reason === 'already_active') {
          incCounter('maia_channel_pairing_total', { outcome: 'activation_lost_race' });
          logger.info(
            { channel_id: line.channel_id },
            'channel_pairing.activation_lost_race',
          );
          continue;
        }
        // `line_owned_elsewhere` (23505 do índice global) é fail-closed: a
        // linha pertence a outro workspace, esta não pode ativar.
        await channelLineStateRepo.transition({
          channel_id: line.channel_id,
          state: 'failed',
          reason_code: act.reason,
        });
        continue;
      }

      await runWithTenantContext(
        { tenant_id: line.tenant_id, agent_id: line.agent_id },
        () =>
          audit({
            acao: 'channel_activated',
            metadata: {
              channel_id: line.channel_id,
              line: line.external_id,
              trigger: 'readiness_revalidated',
            },
          }),
      );
      incCounter('maia_channel_pairing_total', { outcome: 'activated' });

      if (config.MAIA_MULTI_LINE) {
        const { _internal } = await import('@/gateway/line-sessions.js');
        await _internal
          .startLineSession({
            id: line.channel_id,
            tenant_id: line.tenant_id,
            agent_id: line.agent_id,
            external_id: line.external_id,
          })
          .catch((err) =>
            logger.error(
              { channel_id: line.channel_id, err: (err as Error).message },
              'channel_pairing.start_after_readiness_failed',
            ),
          );
      }
    } catch (err) {
      logger.error(
        { channel_id: line.channel_id, err: (err as Error).message },
        'channel_pairing.readiness_promotion_failed',
      );
    }
  }
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

    // Publica quais linhas têm o SOCKET nesta réplica. É a tabela de
    // roteamento que permite endereçar `disable`/`repair` à réplica dona —
    // sem ela, qualquer réplica "concluía" o stop chamando `stopLineSession`
    // num Map local vazio, e a linha seguia respondendo (review PR #528
    // rodada 2). Claim e heartbeat são a mesma escrita: a posse é
    // auto-corretiva a cada tick.
    await publishLocalSessionOwnership();

    if (tickCount % STALE_SWEEP_EVERY_TICKS === 0) {
      await sweepStalePairings();
      // Mesma cadência de ~1min: a linha verificada entra em roteamento assim
      // que a política ficar pronta, sem exigir um novo pareamento.
      await promoteReadyVerifiedLines();
    }
    tickCount += 1;

    for (let i = 0; i < MAX_COMMANDS_PER_TICK; i += 1) {
      const row = await channelLineStateRepo.claimNextCommand(OWNER_INSTANCE);
      if (!row) return;

      // Desfecho padrão: se algo explodir antes de o handler descrever o seu,
      // o comando é encerrado como falha — nunca fica pendente para outra
      // réplica reexecutar.
      let completion: CommandCompletion =
        row.command === 'stop_line'
          ? { release_owner: true }
          : { release_owner: true, state: 'failed', reason_code: 'command_execution_failed' };
      try {
        if (row.command === 'start_pairing') {
          completion = await executeStartPairing(row);
        } else if (row.command === 'abort_pairing') {
          completion = await executeAbort(row);
        } else if (row.command === 'repair') {
          completion = await executeRepair({
            channel_id: row.channel_id,
            tenant_id: row.tenant_id,
            agent_id: row.agent_id,
            external_id: row.external_id,
          });
        } else if (row.command === 'stop_line') {
          completion = await executeStopLine({
            channel_id: row.channel_id,
            target_instance: row.target_instance,
          });
        }
      } catch (err) {
        // Fail-isolated por comando: um canal problemático não trava a fila.
        // O `completion` já é o desfecho de falha declarado acima.
        logger.error(
          { channel_id: row.channel_id, command: row.command, err: (err as Error).message },
          'channel_pairing.command_failed',
        );
      } finally {
        // UM ÚNICO write, UM ÚNICO CAS por (channel_id, command_id,
        // owner_instance): limpa a ordem, aplica o estado terminal e libera a
        // posse de uma vez. Antes eram dois statements, e o primeiro
        // (`release_owner`) zerava justamente o `owner_instance` que o CAS do
        // segundo comparava — o clear falhava e o comando terminal voltava
        // para a fila (rodada 2 do review PR #528).
        const done = await channelLineStateRepo
          .completeCommand({
            channel_id: row.channel_id,
            command_id: row.command_id,
            owner_instance: OWNER_INSTANCE,
            release_owner: completion.release_owner,
            ...(completion.state ? { state: completion.state } : {}),
            ...(completion.reason_code !== undefined
              ? { reason_code: completion.reason_code }
              : {}),
            ...(completion.clear_session_owner ? { clear_session_owner: true } : {}),
          })
          .catch(() => false);
        if (!done) {
          // CAS recusado: o operador enfileirou um comando NOVO durante a
          // execução. Correto — o novo comando manda; nada a fazer.
          logger.info(
            { channel_id: row.channel_id, command: row.command },
            'channel_pairing.completion_superseded',
          );
        }
      }
    }
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'channel_pairing.tick_failed');
  } finally {
    running = false;
  }
}
