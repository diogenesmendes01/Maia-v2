/** New-message consumer. All preparation precedes start; polling never resubmits.
 * Durable terminal callbacks remain authoritative; unavailable/timeout is unknown,
 * never proof of no execution. Existing-run recovery stays ahead of this path.
 */
import { audit } from '@/governance/audit.js';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareSyntheticHermesAdmission } from '@/db/repositories/hermes-admission-repo.js';
import { engineRunsRepo } from '@/db/repositories/engine-repos.js';
import { loadHermesLaunchContext } from '@/db/repositories/hermes-launch-repo.js';
import { getTurnExecutionContext } from '@/runtime/turns/execution-context.js';
import { failTurnRetryable, type TurnHandle } from '@/runtime/turns/lifecycle.js';
import type { Mensagem } from '@/db/schema.js';
import { getSyntheticCoreRuntime } from './synthetic-core-context.js';
import { recoverSyntheticHermesOutput } from './recover-synthetic-output.js';

export async function runSyntheticHermesAdmission(input: {
  turn: TurnHandle;
  inbound: Mensagem;
}): Promise<boolean> {
  const runtime = getSyntheticCoreRuntime(),
    execution = getTurnExecutionContext();
  if (!runtime || !execution) return false;
  const run_id = await prepareSyntheticHermesAdmission({
    message_id: input.inbound.id,
    execution,
    runtime,
  });
  if (!run_id) {
    await audit({
      acao: 'hermes_admission_refused',
      alvo_id: execution.turn_id,
      metadata: {
        evidence_class: 'synthetic',
        reason: 'admission_fenced',
        attempt: execution.attempt,
      },
    });
    await failTurnRetryable(input.turn, {
      code: 'synthetic_admission_fenced',
      mensagem_id: input.inbound.id,
    });
    return true;
  }
  const started = await runtime.startPrepared(run_id);
  if (started.kind === 'accepted') {
    while (!execution.signal.aborted && Date.now() < execution.deadline.getTime()) {
      const state = await engineRunsRepo.findTurnEngineState({ turn_id: execution.turn_id });
      if (state.kind !== 'open_run' || state.run.id !== run_id) break;
      if (state.run.phase === 'result_ready') {
        if (await recoverSyntheticHermesOutput({ ...input, run_id })) return true;
        break;
      }
      if (!(await loadHermesLaunchContext(run_id, execution))) break;
      const observation = await runtime.engine.observe(
        {
          run_id,
          request_key: state.run.request_key,
          remote_instance_id: runtime.remoteInstanceId,
          remote_run_id: started.remote_run_id,
        },
        execution.signal,
      );
      if (observation.kind === 'unavailable' || observation.kind === 'not_found') break;
      // Terminal observation can precede the journal callback commit. Read back
      // on the next pass instead of adopting unpersisted in-memory output.
      await delay(50);
    }
  }
  // Terminal callback may commit between the phase read and launch revalidation.
  if (await recoverSyntheticHermesOutput({ ...input, run_id })) return true;
  await failTurnRetryable(input.turn, {
    code: 'synthetic_run_requires_reconciliation',
    mensagem_id: input.inbound.id,
  });
  return true;
}
