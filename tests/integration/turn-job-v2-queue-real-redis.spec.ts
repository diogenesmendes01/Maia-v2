/**
 * Issue #504 §Contrato do job — o PRODUTOR V2, contra Redis/BullMQ REAIS.
 *
 * ─── O que só o Redis prova aqui ────────────────────────────────────────────
 *
 * Que o payload que ATRAVESSA a fila é o payload V2 — não o objeto que o
 * produtor construiu antes de serializar. A issue exige "jobs V2 carregam
 * apenas `version` e `turn_id`", e a única leitura honesta dessa frase é a do
 * outro lado do transporte: `job.data` depois do round-trip pelo Redis.
 *
 * A entrada é sempre o produtor de produção (`enqueueAgent`), nunca
 * `agentQueue.add` montado aqui — um teste que armasse o job com o próprio
 * harness continuaria verde depois de alguém remover a emissão V2 do produtor.
 *
 * ─── Convivência com as outras suítes de Redis ──────────────────────────────
 *
 * A fila `agent` é REAL e COMPARTILHADA. Esta suíte NÃO sobe worker nenhum: o
 * lado do consumidor (parse dual + `maia_turn_job_version_total`) é provado em
 * `tests/unit/gateway/queue-job-version-metric.spec.ts`, que dirige o handler
 * REAL construído por `startAgentWorker` sem depender de qual processo a BullMQ
 * escolhe para entregar o job. Provar aquilo por aqui deixava a suíte
 * intermitente por um motivo que nada tem a ver com a propriedade — e um verde
 * que depende de sorteio não é evidência.
 *
 * Skipped sem TEST_DB_URL (o job de CI que a define é o mesmo que sobe o Redis).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

// `config/env.ts` congela o env no import. A flag do PRODUTOR tem de estar de
// pé antes de qualquer import içado — mesmo padrão de
// `turn-claim-core-barrier-real-db.spec.ts`.
const envAnterior = vi.hoisted(() => {
  const prev = {
    FEATURE_TURN_STATE_MACHINE: process.env.FEATURE_TURN_STATE_MACHINE,
    FEATURE_TURN_JOB_V2: process.env.FEATURE_TURN_JOB_V2,
  };
  process.env.FEATURE_TURN_STATE_MACHINE = 'true';
  process.env.FEATURE_TURN_JOB_V2 = 'true';
  return prev;
});

import { lifecycle } from '@/runtime/lifecycle/controller.js';
import {
  agentQueue,
  enqueueAgent,
  awaitQueueReady,
  shutdownQueue,
} from '@/gateway/queue.js';
import { agentTurnJobId } from '@/runtime/turns/job.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

d('#504 — o produtor emite o payload V2 (Redis real)', () => {
  /** jobIds armados por esta suíte — o único escopo que ela pode limpar. */
  const armed: string[] = [];
  beforeAll(async () => {
    await awaitQueueReady({ includeWorkers: false });
    lifecycle._resetForTests();
    lifecycle.transitionTo('ready');
  }, 30_000);

  afterAll(async () => {
    for (const id of armed) {
      await agentQueue
        .getJob(id)
        .then((j) => j?.remove())
        .catch(() => undefined);
    }
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await shutdownQueue();
  });

  it('com a flag ligada e o turno conhecido, o payload que chega ao Redis é EXATAMENTE {version, turn_id}', async () => {
    const turn_id = randomUUID();
    const jobId = agentTurnJobId(turn_id);
    armed.push(jobId);
    // O produtor recebe um `AgentJob` completo — mensagem, correlação e tudo.
    // O que ele ARMA tem de ser só a identidade durável: é aí que se vê se a
    // migração do produtor aconteceu de verdade.
    await enqueueAgent({
      mensagem_id: randomUUID(),
      turn_id,
      received_at_ms: Date.now() - 5_000,
    });

    const job = await agentQueue.getJob(jobId);
    expect(job, 'o job determinístico deveria existir').toBeTruthy();
    // Igualdade ESTRITA de chaves: `toEqual` com um objeto de duas chaves
    // reprova se o produtor deixar `mensagem_id`, `trace_id` ou
    // `received_at_ms` vazarem para o payload.
    expect(job!.data).toEqual({ version: 2, turn_id });
  }, 30_000);

  it('sem `turn_id` o produtor CONTINUA armando V1 — é o que mantém a janela de compatibilidade', async () => {
    // O ingresso de uma row anterior à máquina de estados (ou com a flag de
    // #503 desligada) não conhece turno nenhum. Ele não pode virar V2: não há
    // identidade durável a transportar.
    const mensagem_id = randomUUID();
    await enqueueAgent({ mensagem_id, received_at_ms: Date.now() });
    // Estados TERMINAIS entram na busca de propósito. Sem `turn_id` não há
    // `jobId` determinístico, então o job só pode ser reencontrado varrendo a
    // fila — e a fila é COMPARTILHADA: o worker de outra suíte pode ter
    // consumido este job antes desta linha, movendo-o para `completed`. A
    // propriedade sob teste é a FORMA do payload, não em que estado ele está.
    // `'paused'` saiu da lista na migração para a BullMQ 6: lá pausar a fila
    // grava um campo no hash `meta` e deixa os jobs em `wait`, então `'paused'`
    // não é mais estado de job (saiu de `JobType`) e a consulta por esse nome
    // devolve `[]` sempre. `'waiting'` cobre o caso que ele cobria.
    const jobs = await agentQueue.getJobs([
      'waiting',
      'delayed',
      'active',
      'completed',
      'failed',
    ]);
    const mine = jobs.filter(
      (j) => (j.data as { mensagem_id?: string }).mensagem_id === mensagem_id,
    );
    expect(mine, 'o job V1 deveria ter sido armado').toHaveLength(1);
    expect(mine[0]!.data).toMatchObject({ mensagem_id });
    expect((mine[0]!.data as { version?: number }).version).toBeUndefined();
    await mine[0]!.remove().catch(() => undefined);
    // Idem para o caso V2 do teste anterior: ele é reencontrado pelo `jobId`
    // determinístico, então não depende de estado nenhum.
  }, 30_000);
});
