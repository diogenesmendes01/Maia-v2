/**
 * Issue #510 (fatia F) — uma RÉPLICA DE WORKER que ESGOTA as tentativas de um
 * turno e deixa a POLÍTICA DE POISON decidir.
 *
 * ─── O que ela roda, e por que não é uma reimplementação ────────────────────
 *
 * `failTurnRetryable` (`src/runtime/turns/lifecycle.ts`) é o caminho pelo qual
 * uma tentativa falha. Quando `attempt_count >= MAX_TURN_ATTEMPTS`, ele mesmo
 * desvia para `deadLetterTurn`, que classifica o erro (`classifyPoison`),
 * consulta a política (`poisonDisposition` sobre
 * `TURN_POISON_BLOCK_CATEGORIES`) e desce o VEREDITO até o repositório, onde a
 * interdição da conversa é gravada na MESMA transação do CAS terminal.
 *
 * O filho não classifica nada e não escolhe nada: ele reivindica o turno, marca
 * `running` e reporta a falha com um CÓDIGO. Toda a decisão é de `src/`. Se ele
 * chamasse `markDeadLetter` direto com `block_stream` montado à mão, FI-14
 * continuaria verde depois de alguém apagar a consulta à política — provaria o
 * argumento do fixture.
 *
 * ─── Protocolo de saída (stdout, uma linha por evento) ──────────────────────
 *
 *   ##fi-claim## {…}        a tentativa de claim
 *   ##fi-veneno## {…}       o estado do handle DEPOIS de `failTurnRetryable`
 *   ##harness-ready## {…}   handshake, com o desfecho
 */
import { runWithTenantContext } from '@/db/tenant-context.js';
import { acquireTurnLease } from '@/runtime/turns/lease.js';
import { turnWorkerId } from '@/runtime/turns/claim.js';
import { agentTurnsRepo } from '@/db/repositories/turn-repos.js';
import { failTurnRetryable, MAX_TURN_ATTEMPTS } from '@/runtime/turns/lifecycle.js';
import type { TurnHandle } from '@/runtime/turns/lifecycle.js';
import type { TurnLease } from '@/runtime/turns/lease.js';
import { barreira } from '../harness/failpoint-client.js';

const LINHA_PRONTO = '##harness-ready##';
const LINHA_FATAL = '##harness-fatal##';

function emitir(prefixo: string, carga: Record<string, unknown>): void {
  process.stdout.write(`${prefixo} ${JSON.stringify(carga)}\n`);
}

function exigir(nome: string): string {
  const v = process.env[nome];
  if (!v) throw new Error(`${nome} ausente — o filho não sabe qual turno envenenar`);
  return v;
}

function numero(nome: string, padrao: number): number {
  const v = process.env[nome];
  if (v === undefined || v === '') return padrao;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${nome}="${v}" não é número`);
  return n;
}

const tenant_id = exigir('TEST_FI_TENANT_ID');
const agent_id = exigir('TEST_FI_AGENT_ID');
const turn_id = exigir('TEST_FI_TURN_ID');
const conversa_id = exigir('TEST_FI_CONVERSA_ID');
/** O CÓDIGO do erro. É ele que a política classifica — e o cenário varia. */
const codigo = exigir('TEST_FI_ERRO');
const nomeDaBarreira = process.env.TEST_FI_BARREIRA ?? '';
const tentativas = numero('TEST_FI_TENTATIVAS', 1);
const intervaloMs = numero('TEST_FI_INTERVALO_MS', 250);

const noEscopo = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithTenantContext({ tenant_id, agent_id }, fn);

const dormir = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

let parar = false;
process.on('SIGTERM', () => {
  parar = true;
  process.exit(0);
});

async function main(): Promise<void> {
  const worker_id = turnWorkerId();
  if (nomeDaBarreira !== '') await barreira(nomeDaBarreira);

  let posse: TurnLease | null = null;
  let claimToken: string | null = null;
  let motivo = 'nenhuma_tentativa';

  for (let i = 0; i < tentativas && !parar; i += 1) {
    const r = await noEscopo(() => acquireTurnLease(turn_id));
    if (r.lease) {
      posse = r.lease;
      claimToken = r.lease.claim.claim_token;
      motivo = 'acquired';
      emitir('##fi-claim##', {
        tentativa: i + 1,
        result: 'acquired',
        attempt: r.lease.claim.attempt,
        worker_id,
      });
      break;
    }
    motivo = r.result.ok ? 'acquired' : r.result.reason;
    emitir('##fi-claim##', { tentativa: i + 1, result: motivo, worker_id });
    if (i + 1 < tentativas) await dormir(intervaloMs);
  }

  if (posse === null || claimToken === null) {
    emitir(LINHA_PRONTO, { pid: process.pid, worker_id, acquired: false, motivo });
    while (!parar) await dormir(intervaloMs);
    return;
  }

  const rodando = await noEscopo(() =>
    agentTurnsRepo.markRunning({
      turn_id,
      conversa_id,
      expected_claim_token: claimToken,
      bump_attempt: false,
    }),
  );
  if (!rodando.ok) {
    emitir(LINHA_PRONTO, {
      pid: process.pid,
      worker_id,
      acquired: true,
      motivo: `running_recusado:${rodando.conflict}`,
    });
    while (!parar) await dormir(intervaloMs);
    return;
  }

  const handle: TurnHandle = {
    turn_id,
    status: 'running',
    state_version: Number(rodando.turn.state_version),
    attempt_count: Number(rodando.turn.attempt_count),
    conversa_id,
    lease: posse,
  };

  // A FALHA. `attempt_count >= MAX_TURN_ATTEMPTS` faz `failTurnRetryable`
  // desviar para o dead letter — e é lá que a política decide entre liberar a
  // conversa e interditá-la. O filho não escolhe: ele só falha, com um código.
  await noEscopo(() => failTurnRetryable(handle, { code: codigo }));

  emitir('##fi-veneno##', {
    codigo,
    attempt_count: handle.attempt_count,
    teto: MAX_TURN_ATTEMPTS,
    esgotou: handle.attempt_count >= MAX_TURN_ATTEMPTS,
    status_apos: handle.status,
  });
  emitir(LINHA_PRONTO, {
    pid: process.pid,
    worker_id,
    acquired: true,
    motivo,
    status_apos: handle.status,
    attempt_count: handle.attempt_count,
  });

  while (!parar) await dormir(intervaloMs);
}

main().catch((erro: unknown) => {
  emitir(LINHA_FATAL, {
    erro: erro instanceof Error ? erro.message : String(erro),
    nome: erro instanceof Error ? erro.name : 'desconhecido',
  });
  process.exitCode = 1;
});
