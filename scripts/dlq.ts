/**
 * Inspeção e rearmamento manual da dead-letter — o comando de OPERADOR que a
 * issue #504 §"Retry, recovery e DLQ" exige ("deve existir comando/runbook para
 * inspeção e rearmamento manual seguro").
 *
 * Duas dead-letters convivem e NÃO são a mesma coisa:
 *
 *  - `dead_letter_jobs` (subcomandos `list`/`retry`/`resolve`): a DLQ do
 *    TRANSPORTE. Uma row por job da BullMQ que esgotou tentativas. `retry`
 *    reenfileira o payload cru.
 *  - `agent_turns.status = 'dead_letter'` (subcomando `replay-turn`): a DLQ do
 *    ESTADO, de #503/#504. O turno é a unidade durável; o job é só o despertar.
 *
 * O `replay-turn` é o único caminho SUPORTADO para ressuscitar um turno morto,
 * e faz as três coisas que fazê-lo à mão não faz:
 *   1. resolve o dono do turno pela fronteira de confiança
 *      (`resolveTurnJobScope`) em vez de adivinhar o tenant;
 *   2. transiciona `dead_letter -> queued` por CAS auditado
 *      (`replayDeadLetteredTurn`), que é a única porta de escrita da máquina de
 *      estados;
 *   3. REARMA o job com o `jobId` determinístico, removendo antes o cadáver
 *      retido pela BullMQ. Sem este passo o turno voltaria a `queued` e ficaria
 *      lá: fora do modo autoritativo, nada o rearma sozinho.
 */
import { dlqRepo } from '@/db/repositories.js';
import { agentQueue } from '@/gateway/queue.js';
import { replayTurnByOperator } from '@/ops/turn-replay.js';
import { TurnScopeUnresolvedError } from '@/runtime/turns/scope-resolver.js';

async function listOpen() {
  const items = await dlqRepo.listOpen(50);
  if (items.length === 0) {
    console.log('DLQ vazia.');
    return;
  }
  for (const it of items) {
    console.log(`- ${it.id}  queue=${it.queue_name}  job=${it.job_id}  attempts=${it.attempts}`);
    console.log(`  error: ${it.error.slice(0, 200)}`);
    console.log(`  created_at: ${it.created_at}`);
  }
}

async function retry(id: string) {
  const items = await dlqRepo.listOpen(1000);
  const item = items.find((x) => x.id === id);
  if (!item) {
    console.error(`not found: ${id}`);
    process.exit(1);
  }
  await agentQueue.add('process-message', item.payload as { mensagem_id: string }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
  await dlqRepo.resolve(id);
  console.log(`re-enqueued and resolved ${id}`);
}

async function resolve(id: string) {
  await dlqRepo.resolve(id);
  console.log(`resolved ${id}`);
}

/**
 * Adaptador de CLI em volta de `replayTurnByOperator` (`src/ops/turn-replay.ts`),
 * onde a operação — e a ordem fail-closed dos seus três passos — de fato vive.
 * Aqui só há tradução de desfecho para mensagem e exit code.
 */
async function replayTurn(turn_id: string, args: { actor: string; reason: string }) {
  let outcome;
  try {
    outcome = await replayTurnByOperator({ turn_id, ...args });
  } catch (err) {
    if (err instanceof TurnScopeUnresolvedError) {
      console.error(`escopo do turno recusado (reason=${err.reason}): ${err.turn_id}`);
      console.error(
        'Nada foi alterado. `scope_mismatch` significa que a mensagem representativa pertence a ' +
          'outro (tenant, agent) que o turno — investigue antes de qualquer rearme.',
      );
      process.exit(1);
    }
    throw err;
  }

  if (!outcome.replayed) {
    console.error(
      `replay recusado para ${outcome.scope.turn_id}: o turno não está em dead_letter (ou o ` +
        `estado mudou entre a leitura e a escrita). Nada foi rearmado.`,
    );
    process.exit(1);
  }
  console.log(
    `turno ${outcome.scope.turn_id} replayed (tenant=${outcome.scope.tenant_id} ` +
      `agent=${outcome.scope.agent_id}) e rearmado na fila agent; actor=${args.actor}`,
  );
}

/** `--flag valor` e `--flag=valor`. */
function flag(argv: readonly string[], name: string): string | null {
  const long = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === long) return argv[i + 1] ?? null;
    if (a.startsWith(`${long}=`)) return a.slice(long.length + 1);
  }
  return null;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = argv[1];

const USAGE =
  'usage: tsx scripts/dlq.ts list | retry <id> | resolve <id> | ' +
  'replay-turn <turn_id> --reason "<motivo>" [--actor <quem>]';

(async () => {
  if (cmd === 'list') await listOpen();
  else if (cmd === 'retry' && arg) await retry(arg);
  else if (cmd === 'resolve' && arg) await resolve(arg);
  else if (cmd === 'replay-turn' && arg) {
    const reason = flag(argv, 'reason');
    if (!reason) {
      // `reason` é OBRIGATÓRIO: ele vai para a row de auditoria `turn_replayed`,
      // e um replay sem motivo registrado é uma intervenção manual que ninguém
      // consegue reconstruir depois.
      console.error('replay-turn exige --reason "<motivo>" — ele vai para a auditoria.');
      console.error(USAGE);
      process.exit(2);
    }
    await replayTurn(arg, { actor: flag(argv, 'actor') ?? 'dlq-cli', reason });
  } else {
    console.log(USAGE);
    process.exit(2);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
