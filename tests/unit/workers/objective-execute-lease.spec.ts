/**
 * Issue #469, fatia A do work loop — o CALL SITE de produção do lease.
 *
 * O teste de integração (`tests/integration/objective-task-lease.spec.ts`)
 * prova que o REPO faz a coisa certa contra Postgres real. Ele não prova que
 * o worker CHAMA o repo direito, e é aí que a regressão barata mora: apagar a
 * chamada do reaper, ou deixar de passar `expect_claim_token`, deixa o repo
 * perfeito e o sistema quebrado. Este arquivo trava o que
 * `runObjectiveExecuteWorker` faz:
 *
 *  1. o reaper roda UMA vez por tick e ANTES do primeiro claim — uma tarefa
 *     órfã volta para a fila e é reexecutada NESTE tick, não no próximo;
 *  2. ele roda com TETO (`max_attempts` finito) — sem isso uma poison task
 *     que derruba o processo é reanimada para sempre;
 *  3. TODA transição carrega `tenant_id`/`agent_id` da row e o
 *     `expect_claim_token` DAQUELE claim — é o que impede o worker de lease
 *     vencida de agir uma segunda vez sobre a mesma tarefa;
 *  4. quando a transição é recusada pelo fencing (`false`), o worker NÃO
 *     tenta de novo e NÃO reexecuta o kind — ele registra e segue. Um loop
 *     que "trabalha sozinho" precisa provar que PARA;
 *  5. o drain sobrevive a um reaper quebrado (fail-isolado): trabalho novo
 *     continua valendo mesmo com a varredura de lease em pane;
 *  6. o loop TERMINA no orçamento de drain (não é um `while(true)`).
 *
 * Relógio: o drain é um laço de ~50s com poll de 3s. Com timers falsos o
 * relógio anda por `advanceTimersByTimeAsync`, então o teste custa
 * milissegundos e o orçamento continua sendo exercido de verdade — em vez de
 * ser encurtado por uma constante só de teste, que provaria outro código.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Claim = {
  task: { id: string; tenant_id: string; agent_id: string; natural_key: string; payload: unknown };
  objective: { id: string; kind: string; status: string };
  claim_token: string;
};

/** Ordem das chamadas ao repo — é o que prova "reaper ANTES do claim". */
let callLog: string[] = [];
let claimQueue: Claim[] = [];
let transitions: Array<Record<string, unknown>> = [];
let transitionResult = true;
let reapImpl: () => Promise<{ requeued: string[]; failed: string[] }> = async () => ({
  requeued: [],
  failed: [],
});
let reapCalls: Array<{ limit: number; max_attempts: number }> = [];
let executedTasks: string[] = [];

vi.mock('@/db/repositories.js', () => ({
  objectivesRepo: {
    async reclaimExpiredTaskLeases(args: { limit: number; max_attempts: number }) {
      callLog.push('reap');
      reapCalls.push(args);
      return await reapImpl();
    },
    async claimNextPendingTask(_args: { worker_id: string; lease_seconds: number }) {
      callLog.push('claim');
      return claimQueue.shift() ?? null;
    },
    async transitionTask(args: Record<string, unknown>) {
      callLog.push('transition');
      transitions.push(args);
      return transitionResult;
    },
  },
}));

vi.mock('@/governance/audit.js', () => ({ audit: vi.fn(async () => undefined) }));

vi.mock('@/objectives/kinds.js', () => ({
  getObjectiveKind: (id: string) =>
    id === 'manual'
      ? {
          id: 'manual',
          async execute({ task }: { task: { id: string } }) {
            executedTasks.push(task.id);
            return { transition: 'done' as const, outcome: { ok: true } };
          },
        }
      : null,
}));

function makeClaim(id: string, token: string): Claim {
  return {
    task: {
      id,
      tenant_id: `tenant-${id}`,
      agent_id: `agent-${id}`,
      natural_key: `nk-${id}`,
      payload: {},
    },
    objective: { id: `obj-${id}`, kind: 'manual', status: 'active' },
    claim_token: token,
  };
}

/**
 * Roda o worker até o fim do orçamento de drain. O laço só cede ao relógio no
 * `sleep` do caminho ocioso, então a fila DEVE terminar vazia — o que é o
 * caso real (fila drenada) e o que faz o teste terminar.
 */
async function runDrain(): Promise<void> {
  const { runObjectiveExecuteWorker } = await import('@/workers/objective-execute-worker.js');
  const p = runObjectiveExecuteWorker();
  // 60s > o orçamento de 50s: o laço sai pelo prazo, não pelo fim dos timers.
  await vi.advanceTimersByTimeAsync(60_000);
  await p;
}

describe('runObjectiveExecuteWorker — lease, fencing e reaper (#469 fatia A)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    callLog = [];
    claimQueue = [];
    transitions = [];
    reapCalls = [];
    executedTasks = [];
    transitionResult = true;
    reapImpl = async () => ({ requeued: [], failed: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reclama leases vencidas UMA vez e ANTES do primeiro claim', async () => {
    reapImpl = async () => ({ requeued: ['t-orfa'], failed: [] });
    claimQueue = [makeClaim('a', 'tok-a')];

    await runDrain();

    expect(reapCalls).toHaveLength(1);
    expect(callLog[0]).toBe('reap');
    expect(callLog.indexOf('reap')).toBeLessThan(callLog.indexOf('claim'));
    // A tarefa reanimada é candidata ao drain DESTE tick.
    expect(executedTasks).toEqual(['a']);
  });

  it('o reaper roda com TETO finito de tentativas (sem isso, poison task é eterna)', async () => {
    await runDrain();

    expect(reapCalls).toHaveLength(1);
    expect(reapCalls[0]!.max_attempts).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(reapCalls[0]!.max_attempts)).toBe(true);
    expect(reapCalls[0]!.limit).toBeGreaterThan(0);
  });

  it('toda transição carrega tenant, agent e o token DAQUELE claim', async () => {
    claimQueue = [makeClaim('a', 'tok-a'), makeClaim('b', 'tok-b')];

    await runDrain();

    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      task_id: 'a',
      expect_claim_token: 'tok-a',
      status: 'done',
    });
    expect(transitions[1]).toMatchObject({
      tenant_id: 'tenant-b',
      agent_id: 'agent-b',
      task_id: 'b',
      expect_claim_token: 'tok-b',
      status: 'done',
    });
    // Nenhum token trocado entre tarefas — o fencing é por claim, não global.
    expect(transitions[0]!.expect_claim_token).not.toBe(transitions[1]!.expect_claim_token);
  });

  it('transição RECUSADA pelo fencing não vira retry nem segunda execução', async () => {
    transitionResult = false;
    claimQueue = [makeClaim('a', 'tok-velho')];

    await runDrain();

    // Uma execução, uma tentativa de transição. O worker perdeu a corrida e
    // PAROU — quem reexecuta é o dono novo, com o token novo.
    expect(executedTasks).toEqual(['a']);
    expect(transitions).toHaveLength(1);
  });

  it('reaper quebrado NÃO impede o drain (fail-isolado)', async () => {
    reapImpl = async () => {
      throw new Error('lease scan exploded');
    };
    claimQueue = [makeClaim('a', 'tok-a')];

    await runDrain();

    expect(executedTasks).toEqual(['a']);
    expect(transitions).toHaveLength(1);
  });

  it('o drain TERMINA — o orçamento é um prazo, não um `while(true)`', async () => {
    const { runObjectiveExecuteWorker } = await import('@/workers/objective-execute-worker.js');
    let done = false;
    const p = runObjectiveExecuteWorker().then(() => {
      done = true;
    });

    // Metade do orçamento: ainda drenando.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(40_000);
    await p;
    expect(done).toBe(true);
  });
});
