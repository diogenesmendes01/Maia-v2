/** Core consumer for the already-persisted, tool-free synthetic reply lane.
 * Never invokes the pipeline, starts an engine, or manufactures a new request.
 */
import {
  loadSyntheticHermesOutput,
  readSyntheticHermesHandoff,
} from '@/db/repositories/hermes-output-repo.js';
import { engineRunsRepo } from '@/db/repositories/engine-repos.js';
import { pessoasRepo, conversasRepo } from '@/db/repositories.js';
import { getTurnExecutionContext } from '@/runtime/turns/execution-context.js';
import { concludeTurn, type TurnHandle } from '@/runtime/turns/lifecycle.js';
import { coordinateOutput } from './coordinator.js';
import { safeDispatchOutput } from '@/agent/output-dispatch.js';
import { audit } from '@/governance/audit.js';
import type { Mensagem } from '@/db/schema.js';
import { config } from '@/config/env.js';
import { runWithEngineOutputOrigin } from '@/runtime/outbound/turn-scope.js';

/** Metadata maintenance only; no claim, start, adoption or send. Safe on the
 * early-return path after a crash between outbound commit and journal close. */
export async function closeSyntheticHermesHandoff(turn_id: string): Promise<void> {
  const proof = await readSyntheticHermesHandoff(turn_id);
  if (!proof) return;
  if (proof.outbound_status === 'delivered') {
    const { outboundRecoveryRepo } = await import('@/db/repositories/outbound-recovery-repo.js');
    await outboundRecoveryRepo.completeDeliveredWithHistoryTx(proof);
  }
  // This is DB-only metadata maintenance, not observation/remote I/O. The
  // close transaction already locks and rechecks phase, adoption and outbox
  // proof. Use the proof's CAS directly: a separate time reservation would
  // strand completed turns when a process dies before close (not_due != done).
  const closed = await engineRunsRepo.closeRunAfterHandoff({
    run_id: proof.run_id,
    turn_id,
    decision: 'handed_to_outbox',
    actor: { kind: 'recovery', actor_ref: 'core_synthetic_handoff' },
    expected_row_version: Number(proof.row_version),
  });
  // Do not acknowledge a failed CAS. BullMQ retains the failed job for retry;
  // redelivery rereads durable proof/version, without adoption or sending.
  if (!closed.ok) throw new Error(`synthetic_handoff_pending:${closed.reason}`);
}

export async function recoverSyntheticHermesOutput(input: {
  run_id: string;
  turn: TurnHandle;
  inbound: Mensagem;
}): Promise<boolean> {
  const execution = getTurnExecutionContext();
  // Never let this lane enter the legacy fail-open output regime.
  if (!execution || !config.FEATURE_OUTBOUND_DURABLE_COMMIT) return false;
  const loaded = await loadSyntheticHermesOutput(input.run_id, execution);
  if (!loaded || loaded.host.representative_message_id !== input.inbound.id) return false;
  const [pessoa, conversa] = await Promise.all([
    pessoasRepo.findById(loaded.host.pessoa_id),
    conversasRepo.byId(loaded.host.conversa_id),
  ]);
  if (!pessoa || !conversa) return false;
  const adopted = await engineRunsRepo.adoptTerminalResult({
    run_id: input.run_id,
    turn_id: input.turn.turn_id,
    claim_token: execution.claim_token,
    output_preparation: loaded.preparation,
    expected_row_version: loaded.row_version,
  });
  if (!adopted.ok) return false;
  try {
    await runWithEngineOutputOrigin(
      { run_id: input.run_id, terminal_hash: loaded.preparation.terminal_hash },
      () =>
        coordinateOutput(
          { pessoa, conversa, inbound: input.inbound, jid: loaded.host.remote_jid },
          loaded.assembled,
          {
            dispatch: safeDispatchOutput,
            egress: {
              kind: 'check',
              isAuthorized: async () =>
                (await loadSyntheticHermesOutput(input.run_id, execution)) !== null,
            },
            audit,
            // The reader rejects every tool receipt/claim, so there is nothing to flush.
            flushUnconfirmedToolSummaries: async () => {
              throw new Error('synthetic_tools_forbidden');
            },
          },
        ),
    );
    // Readback is stronger than the facade's delivery boolean. Only a complete,
    // correlated artifact permits normal lifecycle completion under this claim.
    const proof = await readSyntheticHermesHandoff(input.turn.turn_id);
    if (proof) {
      if (proof.outbound_status === 'delivered') {
        const { outboundRecoveryRepo } =
          await import('@/db/repositories/outbound-recovery-repo.js');
        await outboundRecoveryRepo.completeDeliveredWithHistoryTx(proof);
      }
      await concludeTurn(input.turn, 'reply_delivered', {
        pessoa_id: pessoa.id,
        mensagem_id: input.inbound.id,
      });
      await closeSyntheticHermesHandoff(input.turn.turn_id);
      return true;
    }
    return input.turn.status === 'outbound_pending';
  } finally {
    if (input.turn.status === 'outbound_pending') await input.turn.lease?.release();
  }
}
