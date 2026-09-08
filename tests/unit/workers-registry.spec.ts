import { describe, it, expect, vi } from 'vitest';

/**
 * Issue #726 — o registro de workers não pode custar o grafo de produção.
 *
 * Antes, este arquivo mockava 20 dos 43 módulos de worker com no-ops e
 * `import('../../src/workers/index.js')` carregava os outros 23 de verdade —
 * e, por eles, 407 arquivos de `src/` (4,9 MB de TS): repositórios, agente,
 * cognição, gateway. Medido: 4,4 s isolado com cache quente, 10,7 s a frio,
 * 13–21 s na suíte completa sob carga — o primeiro caso deste arquivo estourava
 * os 20 s e era "recuperado pela segunda tentativa".
 *
 * Agora `JOBS` declara cada handler com `lazy(() => import('./x.js'), ...)`
 * (ver `src/workers/index.ts`): o módulo só é avaliado no primeiro tick. Os
 * mocks abaixo NÃO são no-ops — são SENTINELAS. O factory de cada um anota o
 * nome do módulo em `avaliados`, e o vitest só executa o factory quando alguém
 * importa o módulo. Logo:
 *
 *   - se importar o registro voltar a avaliar qualquer módulo de worker, o
 *     caso "as sentinelas ficam caladas" reprova com o nome do módulo — é a
 *     sonda de regressão do custo de boot;
 *   - o caso de CONTROLE no fim chama `job.fn()` de verdade e exige que a
 *     sentinela de `backup.js` tenha disparado: prova que ela está armada,
 *     senão "nenhum módulo carregou" passaria também com mocks que nunca
 *     rodam.
 *
 * O que continua real: o array `JOBS` de produção, com nome, cadência, grupo,
 * fase e a forma do handler. Nada aqui monta um registro paralelo.
 *
 * `config` NÃO é mockada — `tests/setup.ts` popula `process.env` e o registro
 * lê `config.FEATURE_*` no carregamento para o `featureFlag` de alguns jobs.
 */

const { mockSchedule, sentinela, avaliados } = vi.hoisted(() => {
  const mockSchedule = vi.fn(() => ({ stop: vi.fn(), start: vi.fn() }));
  /** Módulos de worker cujo factory de mock rodou — isto é, que foram importados. */
  const avaliados: string[] = [];
  const sentinela = (modulo: string) => () => {
    avaliados.push(modulo);
    // Sem exports de propósito: um handler chamado a partir daqui falha com
    // "No export is defined on the mock", que é o suficiente para o controle.
    return {};
  };
  return { mockSchedule, sentinela, avaliados };
});

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// node-cron v4: ScheduledTask is an interface with stop() / start() / etc.
vi.mock('node-cron', () => ({
  default: { schedule: mockSchedule },
}));

// Os 43 módulos que `src/workers/index.ts` referencia em `JOBS`. A lista é
// fechada de propósito: um worker novo que nasça com import estático no
// registro não é pego por ela — é pego pelo custo, na lista de mais lentos
// do reporter. O que ela trava é o REGRESSO dos que já são lazy.
vi.mock('../../src/workers/audit-mode-expirer.js', sentinela('audit-mode-expirer.js'));
vi.mock('../../src/workers/audit-watcher.js', sentinela('audit-watcher.js'));
vi.mock('../../src/workers/backup.js', sentinela('backup.js'));
vi.mock('../../src/workers/briefings.js', sentinela('briefings.js'));
vi.mock('../../src/workers/channel-pairing-worker.js', sentinela('channel-pairing-worker.js'));
vi.mock('../../src/workers/confidence-recompute.js', sentinela('confidence-recompute.js'));
vi.mock('../../src/workers/conversation-summarizer.js', sentinela('conversation-summarizer.js'));
vi.mock('../../src/workers/cost-monitor.js', sentinela('cost-monitor.js'));
vi.mock('../../src/workers/dlq-monitor.js', sentinela('dlq-monitor.js'));
vi.mock('../../src/workers/drift-monitor.js', sentinela('drift-monitor.js'));
vi.mock('../../src/workers/gap-escalation-monitor.js', sentinela('gap-escalation-monitor.js'));
vi.mock('../../src/workers/health-monitor.js', sentinela('health-monitor.js'));
vi.mock('../../src/workers/idempotency-cleanup.js', sentinela('idempotency-cleanup.js'));
vi.mock('../../src/workers/idempotency-outbox-relayer.js', sentinela('idempotency-outbox-relayer.js'));
vi.mock('../../src/workers/inactivity-sweep.js', sentinela('inactivity-sweep.js'));
vi.mock('../../src/workers/knowledge-state-promoter.js', sentinela('knowledge-state-promoter.js'));
vi.mock('../../src/workers/legacy-memory-reclassifier.js', sentinela('legacy-memory-reclassifier.js'));
vi.mock('../../src/workers/mcp-sync-worker.js', sentinela('mcp-sync-worker.js'));
vi.mock('../../src/workers/message-recovery.js', sentinela('message-recovery.js'));
vi.mock('../../src/workers/objective-execute-worker.js', sentinela('objective-execute-worker.js'));
vi.mock('../../src/workers/onboarding-expirer.js', sentinela('onboarding-expirer.js'));
vi.mock('../../src/workers/outbound-messages-sweeper.js', sentinela('outbound-messages-sweeper.js'));
vi.mock('../../src/workers/outbound-recovery.js', sentinela('outbound-recovery.js'));
vi.mock('../../src/workers/outbox-drain-worker.js', sentinela('outbox-drain-worker.js'));
vi.mock('../../src/workers/pattern-detector.js', sentinela('pattern-detector.js'));
vi.mock('../../src/workers/pending-expirer.js', sentinela('pending-expirer.js'));
vi.mock('../../src/workers/pending-reminder.js', sentinela('pending-reminder.js'));
vi.mock('../../src/workers/playground-turn-worker.js', sentinela('playground-turn-worker.js'));
vi.mock('../../src/workers/privacy.js', sentinela('privacy.js'));
vi.mock('../../src/workers/procedure-candidate-consumer.js', sentinela('procedure-candidate-consumer.js'));
vi.mock('../../src/workers/procedure-execution-reaper.js', sentinela('procedure-execution-reaper.js'));
vi.mock('../../src/workers/procedure-metrics-refresh.js', sentinela('procedure-metrics-refresh.js'));
vi.mock('../../src/workers/reflection-batch.js', sentinela('reflection-batch.js'));
vi.mock('../../src/workers/scheduling-tick.js', sentinela('scheduling-tick.js'));
vi.mock('../../src/workers/series-next-scheduler.js', sentinela('series-next-scheduler.js'));
vi.mock('../../src/workers/stream-debounce-closer.js', sentinela('stream-debounce-closer.js'));
vi.mock('../../src/workers/synthetic-probe.js', sentinela('synthetic-probe.js'));
vi.mock('../../src/workers/tool-request-triage.js', sentinela('tool-request-triage.js'));
vi.mock('../../src/workers/trace-body-recoverer.js', sentinela('trace-body-recoverer.js'));
vi.mock('../../src/workers/trace-body-writer.js', sentinela('trace-body-writer.js'));
vi.mock('../../src/workers/trace-matview-refresh.js', sentinela('trace-matview-refresh.js'));
vi.mock('../../src/workers/unrouted-recovery.js', sentinela('unrouted-recovery.js'));
vi.mock('../../src/workers/workflow-engine-tick.js', sentinela('workflow-engine-tick.js'));

describe('workers registry', () => {
  // Renamed from `cloud_backup_rotation` in the #520 round-1 fix: it is no
  // longer a cloud-only, mtime-driven prune. Same slot, same phase.
  it('registers backup_retention as a weekly Sunday 04:00 phase-1 job', async () => {
    const { JOBS } = await import('../../src/workers/index.js');
    const job = JOBS.find((j) => j.name === 'backup_retention');
    expect(job).toBeDefined();
    // Sundays at 04:00 in America/Sao_Paulo
    expect(job!.cron).toBe('0 4 * * 0');
    expect(job!.phase).toBe(1);
  });

  it('also keeps nightly_backup on its existing schedule (no regression)', async () => {
    const { JOBS } = await import('../../src/workers/index.js');
    const job = JOBS.find((j) => j.name === 'nightly_backup');
    expect(job).toBeDefined();
    expect(job!.cron).toBe('0 3 * * *');
    expect(job!.phase).toBe(1);
  });

  // Round-2 finding #1 — trace workers must be at phase 1 so startWorkers(1) includes them.
  describe('P10b trace workers (round-2 finding #1)', () => {
    it('trace_body_writer registered at phase 1', async () => {
      const { JOBS } = await import('../../src/workers/index.js');
      const job = JOBS.find((j) => j.name === 'trace_body_writer');
      expect(job).toBeDefined();
      expect(job!.phase).toBe(1);
      expect(job!.cron).toBe('* * * * *');
    });

    it('trace_body_recoverer registered at phase 1', async () => {
      const { JOBS } = await import('../../src/workers/index.js');
      const job = JOBS.find((j) => j.name === 'trace_body_recoverer');
      expect(job).toBeDefined();
      expect(job!.phase).toBe(1);
    });

    it('trace_matview_refresh registered at phase 1', async () => {
      const { JOBS } = await import('../../src/workers/index.js');
      const job = JOBS.find((j) => j.name === 'trace_matview_refresh');
      expect(job).toBeDefined();
      expect(job!.phase).toBe(1);
    });

    it('boot test: all 3 trace jobs are at phase 1 so startWorkers(1) can reach them', async () => {
      // Round-2 finding #1: trace jobs were at phase 6; production calls
      // startWorkers(1). Fix: jobs are now phase 1 and run unconditionally.
      const { JOBS } = await import('../../src/workers/index.js');
      const traceJobs = JOBS.filter((j) =>
        ['trace_body_writer', 'trace_body_recoverer', 'trace_matview_refresh'].includes(j.name),
      );

      // All 3 trace jobs must exist and be at phase 1.
      expect(traceJobs).toHaveLength(3);
      for (const j of traceJobs) {
        expect(j.phase).toBe(1);
      }
    });
  });

  // Issue #292 — outbound_messages sweeper (#227/#233 follow-up).
  describe('outbound_messages_sweeper (issue #292)', () => {
    it('registered as phase-1 job with */5 * * * * cadence', async () => {
      const { JOBS } = await import('../../src/workers/index.js');
      const job = JOBS.find((j) => j.name === 'outbound_messages_sweeper');
      expect(job).toBeDefined();
      // 5-min cadence — stale_pending cutoff default is also 5min, so a single
      // missed tick is the worst-case detection latency (~10min total).
      expect(job!.cron).toBe('*/5 * * * *');
      expect(job!.phase).toBe(1);
      // No featureFlag — always on once merged (it's pure housekeeping +
      // recovery; no UX-visible behaviour change).
      expect(job!.featureFlag).toBeUndefined();
    });
  });

  // Issue #345 Batch D — workflow_engine_tick extracted to a per-tenant
  // dispatcher (job shape MUST be unchanged: same name/cadence/phase).
  describe('workflow_engine_tick (issue #345 Batch D)', () => {
    it('registered with unchanged shape: */30s sub-minute cadence, phase 1, no featureFlag', async () => {
      const { JOBS } = await import('../../src/workers/index.js');
      const job = JOBS.find((j) => j.name === 'workflow_engine_tick');
      expect(job).toBeDefined();
      // Sub-minute (6-field) cron — every 30 seconds — preserved from the inline job.
      expect(job!.cron).toBe('*/30 * * * * *');
      expect(job!.phase).toBe(1);
      // Never gated — the extraction only changed the handler, not the schedule.
      expect(job!.featureFlag).toBeUndefined();
      // The handler is the extracted dispatcher function (registered by reference).
      expect(typeof job!.fn).toBe('function');
    });
  });

  // Issue #316 — transactional effect outbox relayer.
  describe('idempotency_outbox_relayer (issue #316)', () => {
    it('registered as phase-1 job with */1 * * * * cadence and no featureFlag', async () => {
      const { JOBS } = await import('../../src/workers/index.js');
      const job = JOBS.find((j) => j.name === 'idempotency_outbox_relayer');
      expect(job).toBeDefined();
      // Every minute so proactive-message latency stays low.
      expect(job!.cron).toBe('*/1 * * * *');
      expect(job!.phase).toBe(1);
      // No featureFlag — it's the ONLY dispatch path for these effects once
      // merged (the tool no longer sends inline), so it must always run.
      expect(job!.featureFlag).toBeUndefined();
    });
  });

  // Issue #726 — o custo de boot do registro.
  describe('custo de boot (issue #726)', () => {
    it('importar o registro não avalia nenhum módulo de worker (as sentinelas ficam caladas)', async () => {
      // Se qualquer `fn: runX` voltar a ser import estático, o nome do módulo
      // aparece em `avaliados` já no import do registro.
      const { JOBS } = await import('../../src/workers/index.js');
      expect(JOBS.length).toBeGreaterThanOrEqual(43);
      for (const job of JOBS) expect(typeof job.fn).toBe('function');
      expect(avaliados).toEqual([]);
    });

    it('CONTROLE: a sentinela está armada — o primeiro tick de um job avalia o módulo dele', async () => {
      // Anti-vacuidade: o caso acima só significa algo se um módulo de
      // worker REALMENTE dispara a sentinela quando é carregado. Chamar o
      // handler é o que carrega. O mock não tem `runBackupRetention`, então a
      // chamada rejeita — o que importa é a anotação, não a rejeição.
      const { JOBS } = await import('../../src/workers/index.js');
      const job = JOBS.find((j) => j.name === 'backup_retention')!;
      expect(avaliados).not.toContain('backup.js');
      await job.fn().catch(() => undefined);
      expect(avaliados).toContain('backup.js');
    });
  });
});
