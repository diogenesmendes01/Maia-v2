/**
 * Issue #536 — o varredor do TTL do export está mesmo AGENDADO, e só um por vez.
 *
 * ESTA SPEC DELIBERADAMENTE NÃO CONSTRÓI UM AGENDADOR PRÓPRIO. Um teste que
 * levanta um harness privado em volta de `runExportSweep` continua passando
 * depois que o call site de produção é apagado — ele prova que a função
 * funciona, não que alguém a chama. Um TTL que ninguém executa não é um TTL, e
 * era exatamente esse o estado que esta entrega existe para consertar: um
 * carimbo em `export_expires_at` sem varredor.
 *
 * Então tudo abaixo passa pelo REGISTRO REAL (`JOBS` em
 * `src/workers/index.ts`) e pelo ADAPTADOR REAL (`runPrivacyExportSweepJob` →
 * `runPrivacyExportSweep` → `withOpsLock`). Remover a entrada do registro, ou
 * desligar o varredor dela, reprova estes testes.
 *
 * Só as folhas são falsas: o pool do advisory lock (em memória, com a semântica
 * real de `pg_try_advisory_lock`), o repositório e o próprio `runExportSweep`.
 * Mesma disciplina de `restore-drill-scheduler.spec.ts`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const { sweepSpy, heldLocks, lockCalls, auditSpy, retentionRunSpy } = vi.hoisted(() => ({
  sweepSpy: vi.fn(),
  heldLocks: new Set<string>(),
  lockCalls: { count: 0 },
  auditSpy: vi.fn(async () => undefined),
  retentionRunSpy: vi.fn(async () => undefined),
}));

vi.mock('@/db/client.js', () => ({
  pool: {
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        const key = String(values?.[0] ?? '');
        if (text.includes('pg_try_advisory_lock')) {
          lockCalls.count += 1;
          if (heldLocks.has(key)) return { rows: [{ locked: false }] };
          heldLocks.add(key);
          return { rows: [{ locked: true }] };
        }
        if (text.includes('pg_advisory_unlock')) {
          heldLocks.delete(key);
          return { rows: [{}] };
        }
        return { rows: [] };
      },
      release: () => undefined,
    }),
  },
  db: {},
  withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  isDbConnected: () => true,
  probeDb: async () => true,
}));

vi.mock('@/db/repositories/ops-repos.js', () => ({
  readReadinessFacts: async () => ({
    last_local_verified_at: new Date(),
    last_offsite_verified_at: new Date(),
    last_restore_drill_at: new Date(),
    last_restore_drill_result: 'passed',
    last_restore_drill_duration_ms: 1,
    last_restore_drill_cleanup_status: 'clean',
    open_restore_drill_started_at: null,
    consecutive_failures: 0,
  }),
  restoreDrillStore: { createDrill: async () => undefined, finishDrill: async () => undefined },
  readTombstoneLedger: async () => ({ available: true, tombstones: [] }),
  readBackupWatermark: async () => null,
  readPrivacyRequest: async () => null,
  selectDrillCandidate: async () => null,
  anyActiveLegalHold: async () => false,
  listArtifactRuns: async () => [],
  markRunDeleted: async () => undefined,
  reclaimAbandonedRuns: async () => [],
  recordRetentionRun: retentionRunSpy,
  listExpiredExportArtifacts: async () => [],
  readExportBinding: async () => null,
  claimExportPurge: async () => undefined,
  finalizeExportPurge: async () => true,
  recordExportPurgeRefusal: async () => undefined,
  readPrivacyExportRow: async () => null,
}));

// As portas reais abririam conexão no momento da chamada; o executor em si é
// espionado abaixo, então um saco de portas vazio basta.
vi.mock('@/ops/privacy/export-sweeper-adapters.js', () => ({
  createExportSweepPorts: () => ({}),
}));

vi.mock('@/ops/privacy/export-sweeper.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/ops/privacy/export-sweeper.js')>();
  return { ...actual, runExportSweep: sweepSpy };
});

vi.mock('@/governance/audit.js', () => ({ audit: auditSpy }));
vi.mock('@/lib/alerts.js', () => ({ sendAlert: async () => undefined }));

function sweepOutcome(over: Record<string, unknown> = {}) {
  return {
    status: 'completed',
    scanned: 3,
    eligible: 2,
    purged: 2,
    already_absent: 0,
    skipped_held: 1,
    refused: 0,
    failed: 0,
    error_code: null,
    cursor_watermark: null,
    ...over,
  };
}

/**
 * O REGISTRO REAL, importado uma vez. `src/workers/index.ts` puxa a árvore
 * inteira de workers — caro no cache frio, então o custo é pago no `beforeAll`
 * com orçamento explícito (as asserções são sobre o registro, não sobre a
 * velocidade do esbuild de hoje).
 */
let JOBS: Array<{ name: string; cron: string; phase: number; fn: () => Promise<void> }>;

beforeAll(async () => {
  ({ JOBS } = await import('../../../src/workers/index.js'));
}, 120_000);

function registryJob() {
  const job = JOBS.find((j) => j.name === 'privacy_export_sweep');
  if (!job) throw new Error('o job privacy_export_sweep não está no registro de workers');
  return job;
}

beforeEach(() => {
  sweepSpy.mockReset();
  sweepSpy.mockResolvedValue(sweepOutcome());
  auditSpy.mockClear();
  retentionRunSpy.mockClear();
  heldLocks.clear();
  lockCalls.count = 0;
});

describe('privacy_export_sweep é uma entrada REAL do registro de workers', () => {
  it('está registrado, em fase 1, num tique horário', () => {
    const job = registryJob();
    // FASE 1: produção chama `startWorkers(1)`. Um job de fase > 1 nunca seria
    // agendado — a armadilha já documentada para os workers de trace.
    expect(job.phase).toBe(1);
    // HORÁRIO. O prazo é de dias, mas a granularidade da varredura é a JANELA
    // DE EXPOSIÇÃO de um pacote já vencido: um passe diário a leva a 24h.
    expect(job.cron).toBe('50 * * * *');
    expect(typeof job.fn).toBe('function');
  });

  it('não colide com o minuto dos outros jobs de ops', () => {
    const outros = JOBS.filter((j) =>
      ['nightly_backup', 'backup_retention', 'restore_drill', 'inactivity_sweep'].includes(
        j.name,
      ),
    ).map((j) => j.cron.split(' ')[0]);
    expect(outros).not.toContain('50');
  });
});

describe('o job registrado realmente varre', () => {
  it('uma execução do job chama o varredor exatamente uma vez', async () => {
    await registryJob().fn();
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * O default do `PRIVACY_EXPORT_SWEEP_DRY_RUN` é `false`, ao contrário de
   * `RETENTION_DRY_RUN`. É a inversão deliberada: aqui a direção segura é
   * EXECUTAR, porque um varredor inerte deixa o pacote cifrado do titular no
   * disco para sempre. Um default trocado devolveria o estado que a entrega
   * conserta, sem nenhum erro visível.
   */
  it('o passe agendado NÃO é dry-run por default', async () => {
    await registryJob().fn();
    expect(sweepSpy.mock.calls[0]?.[1]).toMatchObject({ dryRun: false });
  });

  it('o passe é bounded — nunca ilimitado, para não segurar o lock', async () => {
    await registryJob().fn();
    const opts = sweepSpy.mock.calls[0]?.[1] as { limit: number };
    expect(opts.limit).toBeGreaterThan(0);
    expect(Number.isFinite(opts.limit)).toBe(true);
  });

  /**
   * SINGLE-FLIGHT: com o lock já tomado, o job não inicia nada. Perder a
   * corrida não é erro — o outro passe está fazendo o trabalho.
   */
  it('não inicia nada quando outro passe detém o lock', async () => {
    heldLocks.add('maia_ops_privacy_export_sweep');
    await registryJob().fn();
    expect(sweepSpy).not.toHaveBeenCalled();
  });

  it('usa uma chave de lock PRÓPRIA, e não a da retenção', async () => {
    await registryJob().fn();
    // O lock foi liberado no fim; o que se verifica é qual chave foi tomada.
    expect(lockCalls.count).toBe(1);
    heldLocks.add('maia_ops_retention_run');
    sweepSpy.mockClear();
    await registryJob().fn();
    // Com a chave da RETENÇÃO tomada, o varredor ainda roda: são passes
    // diferentes sobre alvos diferentes.
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * A EVIDÊNCIA DO PASSE. Cada remoção já é auditada uma a uma; a linha em
   * `retention_runs` é o que responde "quanto a política apagou, e quando?"
   * na mesma tabela da retenção de artefatos, em vez de numa segunda fonte da
   * verdade que divergiria.
   */
  it('registra o passe em retention_runs com a classe do artefato', async () => {
    await registryJob().fn();
    expect(retentionRunSpy).toHaveBeenCalledTimes(1);
    expect(retentionRunSpy.mock.calls[0]?.[0]).toMatchObject({
      data_class: 'privacy.export',
      dry_run: false,
      status: 'completed',
      scanned: 3,
      eligible: 2,
      deleted: 2,
      skipped_held: 1,
    });
  });

  /**
   * Recusa e falha são coisas diferentes para o guarda, e a MESMA coisa para
   * quem lê a evidência: o artefato continua no host. Por isso as duas somam em
   * `failed` na linha do passe.
   */
  it('recusa do guarda entra na evidência do passe como falha', async () => {
    sweepSpy.mockResolvedValue(
      sweepOutcome({ status: 'failed', purged: 0, refused: 2, error_code: 'locator_refused' }),
    );
    await registryJob().fn();
    expect(retentionRunSpy.mock.calls[0]?.[0]).toMatchObject({
      status: 'failed',
      failed: 2,
      error_code: 'locator_refused',
    });
  });

  it('audita início e fim do passe', async () => {
    await registryJob().fn();
    const acoes = auditSpy.mock.calls.map((c) => (c[0] as { acao: string }).acao);
    expect(acoes).toContain('retention_run_started');
    expect(acoes).toContain('retention_run_completed');
  });

  it('um passe não conclusivo audita `retention_run_failed`, nunca `completed`', async () => {
    sweepSpy.mockResolvedValue(sweepOutcome({ status: 'partial', failed: 1 }));
    await registryJob().fn();
    const acoes = auditSpy.mock.calls.map((c) => (c[0] as { acao: string }).acao);
    expect(acoes).toContain('retention_run_failed');
    expect(acoes).not.toContain('retention_run_completed');
  });

  /**
   * A face do cron não lança: `runTick` loga `{ err }` CRU, e um erro de driver
   * carrega a URL de conexão com senha — o vazamento real que a #520 encontrou.
   */
  it('a falha do registro de evidência não derruba o passe', async () => {
    retentionRunSpy.mockRejectedValueOnce(new Error('db down'));
    await expect(registryJob().fn()).resolves.toBeUndefined();
    expect(sweepSpy).toHaveBeenCalledTimes(1);
  });
});
