/**
 * Issue #510 (fatia B) — uma RÉPLICA DE WORKER de verdade, disputando um turno.
 *
 * ─── Por que este filho importa de `src/` ───────────────────────────────────
 *
 * Pelo mesmo motivo de `replica-de-canal.ts` (#513, fatia D): se ele
 * reescrevesse o `UPDATE … WHERE` do claim, os cenários FI continuariam verdes
 * depois de alguém apagar a condição de lease de
 * `src/db/repositories/turn-repos.ts` — provariam o SQL do fixture. Aqui ele
 * chama `acquireTurnLease` (que é o que `src/runtime/turns/job-consumer.ts`
 * chama) e `agentTurnsRepo.markRunning` REAIS.
 *
 * ─── As duas réplicas são o MESMO binário ───────────────────────────────────
 *
 * Não há modo "dono" e modo "pretendente". Quem ganha é decidido pelo
 * PostgreSQL, exatamente como em produção — e o que separa as duas é
 * `turnWorkerId()`, que deriva do hostname e do pid.
 *
 * ─── A escrita fenced usa o token CAPTURADO, e isso é o ponto ───────────────
 *
 * Depois do gate, a réplica tenta `markRunning` com o `claim_token` que ela
 * guardou NO MOMENTO DO CLAIM — e não com `lease.token`, que já devolveria
 * `null` para quem perdeu a posse. A diferença é a fatia inteira de FI-07: com
 * `lease.token` o teste provaria o guard EM MEMÓRIA do processo zumbi; com o
 * token capturado ele prova o `WHERE claim_token = …` do BANCO, que é a única
 * defesa que sobrevive a um processo que perdeu a noção do próprio estado.
 *
 * ─── Protocolo de saída (stdout, uma linha por evento) ──────────────────────
 *
 *   ##harness-ready## {…}   handshake, com o resultado do claim
 *   ##fi-claim## {…}        uma tentativa de claim (concedida ou recusada)
 *   ##fi-gate## {…}         chegou ao failpoint / foi liberado dele
 *   ##fi-escrita## {…}      o veredito da gravação fenced
 *   ##fi-batida## {…}       estado da lease em memória, a cada amostragem
 */
import { runWithTenantContext } from '@/db/tenant-context.js';
import { acquireTurnLease } from '@/runtime/turns/lease.js';
import { turnWorkerId } from '@/runtime/turns/claim.js';
import { agentTurnsRepo } from '@/db/repositories.js';
import type { TurnLease } from '@/runtime/turns/lease.js';
import { alcancar, barreira } from '../harness/failpoint-client.js';

/** Os mesmos prefixos de `harness/process-supervisor.ts`, repetidos de */
/** propósito: o fixture não arrasta o harness inteiro para dentro do filho. */
const LINHA_PRONTO = '##harness-ready##';
const LINHA_FATAL = '##harness-fatal##';

function emitir(prefixo: string, carga: Record<string, unknown>): void {
  process.stdout.write(`${prefixo} ${JSON.stringify(carga)}\n`);
}

function exigir(nome: string): string {
  const v = process.env[nome];
  if (!v) throw new Error(`${nome} ausente — o filho não sabe qual turno disputar`);
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
const nomeDaBarreira = process.env.TEST_FI_BARREIRA ?? '';
/** Quantas vezes insistir no claim. 1 = uma única tentativa (a corrida). */
const tentativas = numero('TEST_FI_TENTATIVAS', 1);
const intervaloMs = numero('TEST_FI_INTERVALO_MS', 250);
/** `running` = tenta a gravação fenced depois do gate; `nenhuma` = só observa. */
const escrever = process.env.TEST_FI_ESCREVER ?? 'nenhuma';

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

  // A LARGADA. Sem ela, quem vence a corrida do claim é quem terminou de
  // importar o grafo de módulos primeiro — segundos de diferença que não têm
  // nada a ver com a exclusão mútua que o cenário quer provar.
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

  emitir(LINHA_PRONTO, {
    pid: process.pid,
    worker_id,
    acquired: posse !== null,
    claim_token: claimToken,
    attempt,
    motivo,
  });

  if (posse === null) {
    // Uma réplica que perdeu a corrida continua VIVA e calada. É o que permite
    // ao cenário afirmar que ela não gravou nada — uma réplica que sai não
    // provaria isso, provaria só que ela saiu.
    while (!parar) await dormir(intervaloMs);
    return;
  }

  // O GATE. Daqui o cenário decide: liberar, congelar o processo, matá-lo.
  emitir('##fi-gate##', { fase: 'chegando', failpoint: 'after_turn_claim_before_running' });
  await alcancar(
    'after_turn_claim_before_running',
    { turn_id, attempt: attempt ?? -1, worker_id, claim_token: claimToken ?? '' },
    { timeoutMs: 120_000 },
  );
  emitir('##fi-gate##', { fase: 'liberado', failpoint: 'after_turn_claim_before_running' });

  if (escrever === 'running') {
    // O TOKEN CAPTURADO, e não `posse.token`. Ver o cabeçalho.
    const resultado = await noEscopo(() =>
      agentTurnsRepo.markRunning({
        turn_id,
        expected_claim_token: claimToken as string,
        bump_attempt: false,
      }),
    );
    emitir('##fi-escrita##', {
      operacao: 'markRunning',
      ok: resultado.ok,
      conflict: resultado.ok ? null : resultado.conflict,
      lease_viva_em_memoria: posse.alive,
      lease_perdida_por: posse.lostReason,
    });
  }

  while (!parar) {
    emitir('##fi-batida##', { alive: posse.alive, lost: posse.lostReason });
    await dormir(intervaloMs);
  }
}

main().catch((erro: unknown) => {
  emitir(LINHA_FATAL, {
    erro: erro instanceof Error ? erro.message : String(erro),
    nome: erro instanceof Error ? erro.name : 'desconhecido',
  });
  process.exitCode = 1;
});
