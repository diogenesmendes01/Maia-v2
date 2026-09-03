/**
 * Issue #510 (fatia F) — uma RÉPLICA DE TURNO que vai até o COMMIT DO OUTBOX.
 *
 * ─── O seam que este filho abre, e por que ele é honesto ────────────────────
 *
 * `tests/reliability/README.md` registrava
 * `after_response_built_before_outbox_commit` e
 * `after_outbox_commit_before_delivery_enqueue` como "sem call site", com a
 * justificativa de que seriam pontos DENTRO de uma transação. Isso vale para o
 * primeiro nome lido ao pé da letra ("dentro de `commitTurnOutboundTx`"), e é
 * falso para o ponto que a matriz FI-15/FI-16 descreve: a resposta é
 * CONSTRUÍDA pelo chamador e só então entregue a `commitOutboundIntent`
 * (`src/agent/output-dispatch.ts` faz exatamente isso em cada limite de
 * efeito). O intervalo entre as duas chamadas é um seam de PRODUÇÃO — o mesmo
 * tipo que FI-04/05 usam entre `acquireTurnLease` e `markRunning`, e FI-17/18
 * entre `beginInlineDelivery` e `recordInlineDelivery`.
 *
 * O gate mora aqui, entre duas chamadas reais. Nada de `src/` foi tocado, e
 * nada em `src/` conhece o nome do failpoint (o teste arquitetural de
 * `self-tests/failpoints.spec.ts` continua varrendo).
 *
 * ─── Por que este filho importa de `src/` ───────────────────────────────────
 *
 * Pelo mesmo motivo de `replica-de-turno.ts` e `replica-de-entrega.ts`: ele
 * chama `acquireTurnLease`, `agentTurnsRepo.markRunning`,
 * `runWithOutboundTurnScope` e `commitOutboundIntent` REAIS. Se ele montasse o
 * próprio `INSERT` no outbox, FI-15 continuaria verde depois de alguém apagar a
 * `logical_dedupe_key` do artefato de #630 — provaria o SQL do fixture.
 *
 * ─── Protocolo de saída (stdout, uma linha por evento) ──────────────────────
 *
 *   ##harness-ready## {…}   handshake, com o resultado do claim e do markRunning
 *   ##fi-claim## {…}        uma tentativa de claim (concedida ou recusada)
 *   ##fi-gate## {…}         chegou ao failpoint / foi liberado dele
 *   ##fi-commit## {…}       o veredito de `commitOutboundIntent`
 *   ##fi-enfileirado## {…}  o job de entrega armado por `enqueueOutboundDelivery`
 */
import { runWithTenantContext } from '@/db/tenant-context.js';
import { acquireTurnLease } from '@/runtime/turns/lease.js';
import { turnWorkerId } from '@/runtime/turns/claim.js';
import { agentTurnsRepo } from '@/db/repositories/turn-repos.js';
import { commitOutboundIntent } from '@/runtime/outbound/commit.js';
import { runWithOutboundTurnScope } from '@/runtime/outbound/turn-scope.js';
import { enqueueOutboundDelivery } from '@/gateway/queue.js';
import { outboundDeliveryJobId } from '@/runtime/outbound/delivery-job.js';
import type { TurnHandle } from '@/runtime/turns/lifecycle.js';
import type { TurnLease } from '@/runtime/turns/lease.js';
import { alcancar, barreira } from '../harness/failpoint-client.js';

const LINHA_PRONTO = '##harness-ready##';
const LINHA_FATAL = '##harness-fatal##';

function emitir(prefixo: string, carga: Record<string, unknown>): void {
  process.stdout.write(`${prefixo} ${JSON.stringify(carga)}\n`);
}

function exigir(nome: string): string {
  const v = process.env[nome];
  if (!v) throw new Error(`${nome} ausente — o filho não sabe o que commitar`);
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
const in_reply_to = exigir('TEST_FI_IN_REPLY_TO');
/** O texto da resposta. IGUAL entre réplicas = MESMA saída lógica. */
const texto = process.env.TEST_FI_TEXTO ?? 'resposta durável do cenário';
const sequencia = numero('TEST_FI_SEQUENCIA', 0);
const nomeDaBarreira = process.env.TEST_FI_BARREIRA ?? '';
const tentativas = numero('TEST_FI_TENTATIVAS', 1);
const intervaloMs = numero('TEST_FI_INTERVALO_MS', 250);
/** `sim` = chama `enqueueOutboundDelivery` depois do gate 2. */
const enfileirar = process.env.TEST_FI_ENFILEIRAR ?? 'nao';
/** Quantas vezes commitar a MESMA saída lógica. 2 = o controle de FI-15. */
const commits = numero('TEST_FI_COMMITS', 1);

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

  // A LARGADA. Ver `replica-de-turno.ts`.
  if (nomeDaBarreira !== '') await barreira(nomeDaBarreira);

  let posse: TurnLease | null = null;
  let claimToken: string | null = null;
  let attempt: number | null = null;
  let motivo = 'nenhuma_tentativa';

  for (let i = 0; i < tentativas && !parar; i += 1) {
    const r = await noEscopo(() => acquireTurnLease(turn_id));
    if (r.lease) {
      posse = r.lease;
      claimToken = r.lease.claim.claim_token;
      attempt = r.lease.claim.attempt;
      motivo = 'acquired';
      emitir('##fi-claim##', { tentativa: i + 1, result: 'acquired', attempt, worker_id });
      break;
    }
    motivo = r.result.ok ? 'acquired' : r.result.reason;
    emitir('##fi-claim##', { tentativa: i + 1, result: motivo, worker_id });
    if (i + 1 < tentativas) await dormir(intervaloMs);
  }

  if (posse === null || claimToken === null) {
    emitir(LINHA_PRONTO, {
      pid: process.pid,
      worker_id,
      acquired: false,
      claim_token: null,
      attempt,
      motivo,
    });
    // Uma réplica que perdeu a corrida continua VIVA e calada — é o que permite
    // ao cenário afirmar que ela não commitou nada.
    while (!parar) await dormir(intervaloMs);
    return;
  }

  // `running` é o único estado a partir do qual o commit é aceito
  // (`OUTBOUND_COMMIT_SOURCE_STATUSES`). A transição é a de PRODUÇÃO, fenced
  // pelo token do claim.
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
      claim_token: claimToken,
      attempt,
      motivo: `running_recusado:${rodando.conflict}`,
    });
    while (!parar) await dormir(intervaloMs);
    return;
  }

  // O HANDLE, montado com o que o banco acabou de devolver. `lease` é a posse
  // VIVA: é dela que `resolveCommitFence` tira o token, e é ela que devolve
  // `null` se o heartbeat já tiver desistido — o fence em memória de #504.
  const handle: TurnHandle = {
    turn_id,
    status: 'running',
    state_version: Number(rodando.turn.state_version),
    attempt_count: Number(rodando.turn.attempt_count),
    conversa_id,
    lease: posse,
  };

  emitir(LINHA_PRONTO, {
    pid: process.pid,
    worker_id,
    acquired: true,
    claim_token: claimToken,
    attempt,
    state_version: handle.state_version,
    motivo,
  });

  // ── A RESPOSTA, construída. Determinística de propósito: duas réplicas com o
  //    mesmo `TEST_FI_TEXTO` e a mesma `sequence_in_turn` derivam a MESMA
  //    `logical_dedupe_key`, que é o que FI-15 mede.
  const payload = { type: 'text' as const, text: texto };

  // GATE 1 — a resposta está PRONTA e NADA foi persistido. É a janela de FI-15:
  // um crash aqui não pode deixar rastro no outbox nem no canal.
  emitir('##fi-gate##', {
    fase: 'chegando',
    failpoint: 'after_response_built_before_outbox_commit',
  });
  await alcancar(
    'after_response_built_before_outbox_commit',
    { turn_id, attempt: attempt ?? -1, worker_id, claim_token: claimToken },
    { timeoutMs: 120_000 },
  );
  emitir('##fi-gate##', {
    fase: 'liberado',
    failpoint: 'after_response_built_before_outbox_commit',
  });

  // `TEST_FI_COMMITS=2` commita a MESMA saída lógica duas vezes — mesmo texto,
  // mesma `sequence_in_turn`, logo a mesma `logical_dedupe_key`. É o caso de
  // controle de FI-15: sem ele, "existe UMA linha" também passaria num sistema
  // em que a segunda tentativa simplesmente não aconteceu.
  let outbound_id: string | null = null;
  for (let i = 0; i < commits && !parar; i += 1) {
    const commit = await noEscopo(() =>
      runWithOutboundTurnScope(handle, () =>
        commitOutboundIntent({
          payload,
          channel: 'whatsapp',
          sequence_in_turn: sequencia,
          conversa_id,
          in_reply_to,
        }),
      ),
    );
    emitir('##fi-commit##', {
      tentativa: i + 1,
      committed: commit.committed,
      outbound_id: commit.committed ? commit.outbound_id : null,
      // `false` = a saída lógica JÁ existia. É o observável de idempotência do
      // retry, e o que separa "uma linha" de "ninguém tentou de novo".
      inserted: commit.committed ? commit.inserted : null,
      motivo: commit.committed ? null : commit.reason,
    });
    if (!commit.committed) {
      while (!parar) await dormir(intervaloMs);
      return;
    }
    outbound_id = commit.outbound_id;
  }
  if (outbound_id === null) {
    while (!parar) await dormir(intervaloMs);
    return;
  }

  // GATE 2 — o artefato está DURÁVEL e ninguém sabe que ele existe: nenhum job,
  // nenhuma entrega. É a janela de FI-16.
  emitir('##fi-gate##', {
    fase: 'chegando',
    failpoint: 'after_outbox_commit_before_delivery_enqueue',
  });
  await alcancar(
    'after_outbox_commit_before_delivery_enqueue',
    { turn_id, outbound_id, attempt: attempt ?? -1, worker_id },
    { timeoutMs: 120_000 },
  );
  emitir('##fi-gate##', {
    fase: 'liberado',
    failpoint: 'after_outbox_commit_before_delivery_enqueue',
  });

  if (enfileirar === 'sim') {
    await noEscopo(() => enqueueOutboundDelivery(outbound_id));
    emitir('##fi-enfileirado##', {
      outbound_id,
      job_id: outboundDeliveryJobId(outbound_id),
    });
  }

  while (!parar) await dormir(intervaloMs);
}

main().catch((erro: unknown) => {
  emitir(LINHA_FATAL, {
    erro: erro instanceof Error ? erro.message : String(erro),
    nome: erro instanceof Error ? erro.name : 'desconhecido',
  });
  process.exitCode = 1;
});
