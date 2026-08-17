/**
 * Issue #504 — `jobId` determinístico do turno, contra Redis/BullMQ REAIS.
 *
 * O que só o Redis prova: que dois `add` com o mesmo id resultam em UM job, e
 * que a RETENÇÃO da fila (24h para `completed`, 7d para `failed`) não vira um
 * veto permanente ao rearme legítimo de um turno que voltou a ser elegível.
 * Um mock de BullMQ reproduziria a assinatura e nenhuma das duas coisas.
 *
 * A entrada é o PRODUTOR de produção (`enqueueAgent`), nunca `agentQueue.add`
 * montado aqui: um teste que armasse o job com o próprio harness continuaria
 * verde depois de alguém remover a derivação do `jobId` do produtor real.
 *
 * ─── Convivência com as outras suítes de Redis ──────────────────────────────
 *
 * A fila `agent` é REAL e COMPARTILHADA: `lifecycle-drain-queue.spec.ts` e
 * `debounce-flow.spec.ts` rodam em paralelo contra o mesmo Redis. Isso impõe
 * três regras a esta suíte, e cada uma delas já custou uma falha:
 *
 *  1. **Nada de `agentQueue.pause()`.** `Queue.pause()` é GLOBAL (grava no
 *     Redis): pausaria o worker das outras suítes. Os casos de deduplicação
 *     rodam ANTES de qualquer worker subir — sem consumidor, não há o que
 *     pausar.
 *  2. **O worker sobe o mais tarde possível e só onde é necessário.** Enquanto
 *     ele está de pé, a BullMQ entrega a ELE jobs de qualquer suíte. Ligá-lo no
 *     `beforeAll` transformaria o arquivo inteiro numa janela de roubo.
 *  3. **Toda asserção conta APENAS os `turn_id` desta suíte.** O worker vê jobs
 *     alheios, e uma contagem global sai do laço de espera cedo demais achando
 *     que já processou o que esperava.
 *
 * E, na direção oposta: nada de `obliterate({ force: true })` no `afterAll` —
 * ele limparia a fila inteira e apagaria os jobs das vizinhas no meio da
 * asserção delas.
 *
 * Skipped sem TEST_DB_URL (o job de CI que a define é o mesmo que sobe o Redis).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { lifecycle } from '@/runtime/lifecycle/controller.js';
import {
  agentQueue,
  enqueueAgent,
  startAgentWorker,
  awaitQueueReady,
  shutdownQueue,
} from '@/gateway/queue.js';
import { agentTurnJobId } from '@/runtime/turns/job.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('#504 — jobId determinístico do turno (Redis real)', () => {
  /** Turnos que o processador deve fazer FALHAR (para produzir job `failed`). */
  const poison = new Set<string>();
  /** Tudo que o worker viu — inclusive jobs de outras suítes. */
  const seen: string[] = [];
  /** jobIds armados por esta suíte — o único escopo que ela pode limpar. */
  const armed: string[] = [];

  /** Quantas vezes ESTE turno foi processado (ignora jobs alheios). */
  const runsOf = (turn_id: string) => seen.filter((t) => t === turn_id).length;

  /** `enqueueAgent` + registro do id para a limpeza escopada do `afterAll`. */
  async function arm(data: { mensagem_id: string; turn_id?: string }): Promise<void> {
    if (data.turn_id) armed.push(agentTurnJobId(data.turn_id));
    await enqueueAgent(data);
  }

  /** Espera até `predicate`, ou desiste depois de `ms`. Devolve se conseguiu. */
  async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 15_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await sleep(100);
    }
    return false;
  }

  beforeAll(async () => {
    // `includeWorkers: false` — nenhum worker sobe aqui, de propósito (regra 2).
    await awaitQueueReady({ includeWorkers: false });
  }, 30_000);

  afterAll(async () => {
    for (const id of armed) {
      await agentQueue
        .getJob(id)
        .then((j) => j?.remove())
        .catch(() => undefined);
    }
    await shutdownQueue();
  });

  beforeEach(() => {
    lifecycle._resetForTests();
    lifecycle.transitionTo('ready');
  });

  // ─── Deduplicação: sem worker de pé ───────────────────────────────────────

  it('dois enfileiramentos do MESMO turno colidem num único job', async () => {
    const turn_id = randomUUID();
    // Ingresso e recovery, que não se conhecem, armando o mesmo trabalho.
    await arm({ mensagem_id: randomUUID(), turn_id });
    await arm({ mensagem_id: randomUUID(), turn_id });

    const jobs = await agentQueue.getJobs(['waiting', 'delayed', 'paused', 'active']);
    const mine = jobs.filter((j) => j.data.turn_id === turn_id);
    expect(mine, 'dois add do mesmo turno deveriam produzir UM job').toHaveLength(1);
    expect(mine[0]!.id).toBe(agentTurnJobId(turn_id));
    await mine[0]!.remove().catch(() => undefined);
  }, 30_000);

  it('turnos DIFERENTES continuam produzindo jobs distintos', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await arm({ mensagem_id: randomUUID(), turn_id: a });
    await arm({ mensagem_id: randomUUID(), turn_id: b });
    const jobs = await agentQueue.getJobs(['waiting', 'delayed', 'paused', 'active']);
    const mine = jobs.filter((j) => [a, b].includes(j.data.turn_id!));
    expect(new Set(mine.map((j) => j.id)).size).toBe(2);
    for (const j of mine) await j.remove().catch(() => undefined);
  }, 30_000);

  it('sem turn_id o produtor NÃO impõe id — o caminho legado segue intacto', async () => {
    const mensagem_id = randomUUID();
    await arm({ mensagem_id });
    await arm({ mensagem_id });
    const jobs = await agentQueue.getJobs(['waiting', 'delayed', 'paused', 'active']);
    const mine = jobs.filter((j) => j.data.mensagem_id === mensagem_id);
    // Dois jobs: é o comportamento ANTERIOR, preservado durante a janela de
    // compatibilidade em que nem todo produtor conhece o turno.
    expect(mine).toHaveLength(2);
    for (const j of mine) await j.remove().catch(() => undefined);
  }, 30_000);

  it('um job VIVO NÃO é removido — a deduplicação continua valendo', async () => {
    // A assimetria é o ponto: cadáver sai do caminho, job vivo é respeitado. Se
    // a limpeza removesse jobs vivos, o rearme mataria o job que o worker está
    // prestes a pegar e criaria a duplicata que ele deveria evitar.
    const turn_id = randomUUID();
    await arm({ mensagem_id: randomUUID(), turn_id });
    const first = await agentQueue.getJob(agentTurnJobId(turn_id));
    expect(first).toBeTruthy();
    const firstTimestamp = first!.timestamp;

    await arm({ mensagem_id: randomUUID(), turn_id });
    const after = await agentQueue.getJob(agentTurnJobId(turn_id));
    expect(after).toBeTruthy();
    // Mesmo job, não um recriado: o timestamp original sobreviveu.
    expect(after!.timestamp).toBe(firstTimestamp);
    await after!.remove().catch(() => undefined);
  }, 30_000);

  // ─── Retenção: aqui, e só aqui, um worker precisa consumir ────────────────

  it('um job COMPLETED retido não bloqueia o rearme legítimo do turno', async () => {
    // Este é o preço do jobId determinístico que a issue manda pagar
    // explicitamente. A fila retém `completed` por 24h; sem a limpeza, um turno
    // que voltou a ser elegível (retry vencido, replay de dead letter, takeover
    // de lease) ficaria um dia inteiro sem conseguir ser rearmado.
    startAgentWorker(async (job) => {
      seen.push(job.data.turn_id ?? job.data.mensagem_id);
      if (job.data.turn_id && poison.has(job.data.turn_id)) {
        throw new Error('falha proposital do teste');
      }
    });
    await awaitQueueReady();

    const turn_id = randomUUID();
    await arm({ mensagem_id: randomUUID(), turn_id });
    expect(await waitFor(() => runsOf(turn_id) >= 1), 'o job deveria ter sido processado').toBe(
      true,
    );

    // O job continua lá, em `completed`.
    const retained = await agentQueue.getJob(agentTurnJobId(turn_id));
    expect(retained).toBeTruthy();
    expect(await retained!.getState()).toBe('completed');

    // Rearme: o produtor de produção remove o cadáver e arma de novo.
    await arm({ mensagem_id: randomUUID(), turn_id });
    expect(
      await waitFor(() => runsOf(turn_id) >= 2),
      'o turno deveria ter sido processado DUAS vezes (arme + rearme)',
    ).toBe(true);
  }, 90_000);

  it('um job FAILED retido também não bloqueia o rearme', async () => {
    const turn_id = randomUUID();
    poison.add(turn_id);
    await arm({ mensagem_id: randomUUID(), turn_id });

    // `enqueueAgent` arma com attempts=3 e backoff exponencial de 2s, então o
    // job só chega a `failed` depois de esgotar as três passagens.
    const failed = await waitFor(async () => {
      const job = await agentQueue.getJob(agentTurnJobId(turn_id));
      return (await job?.getState()) === 'failed';
    }, 40_000);
    expect(failed, 'o job deveria ter esgotado as tentativas e ficado em failed').toBe(true);

    // O turno volta a ser elegível (no mundo real: lease vencida / backoff
    // vencido) e o worker agora consegue processá-lo.
    poison.delete(turn_id);
    const before = runsOf(turn_id);
    await arm({ mensagem_id: randomUUID(), turn_id });
    expect(
      await waitFor(() => runsOf(turn_id) > before),
      'o job failed retido deveria ter sido removido para o rearme passar',
    ).toBe(true);
  }, 120_000);
});
