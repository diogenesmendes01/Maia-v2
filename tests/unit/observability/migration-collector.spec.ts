/**
 * Issue #516 §Observabilidade — o estado do schema como série raspada.
 *
 * `getSchemaReadiness()` decide desde a #516 se esta build pode servir tráfego
 * contra este banco, e até aqui NADA publicava esse veredito: ele existia só
 * para quem perguntava no instante (`/readyz`, `maia doctor`, `migrate
 * status`). Um banco que passou dez horas com uma migration `dirty` não deixava
 * rastro em série nenhuma. Estes testes seguram a fiação que transforma o
 * veredito em métrica — registrada no registry REAL e renderizada pelo
 * renderizador REAL do `/metrics`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetMigrationCollectorForTests,
  migrationGaugeSnapshot,
  registerMigrationGauges,
  type MigrationCollectorDeps,
} from '../../../src/observability/migration-collector.js';
import { renderPrometheus, _resetForTests as resetMetrics } from '../../../src/lib/metrics.js';
import type {
  MigrationEntryStatus,
  SchemaReadiness,
} from '../../../src/migrations/types.js';

const MANIFEST = {
  schema_manifest_version: 1,
  expected_head: '003_c.sql',
  min_supported_migration: null,
  max_supported_migration: null,
} as const;

function entry(over: Partial<MigrationEntryStatus> & { id: string }): MigrationEntryStatus {
  return {
    state: 'applied',
    blocking: false,
    checksum: 'a'.repeat(64),
    ledger_checksum: 'a'.repeat(64),
    checksum_source: 'runner',
    no_transaction: false,
    applied_at: null,
    execution_ms: null,
    error_class: null,
    ...over,
  };
}

/** Veredito de um banco saudável: três migrations, todas aplicadas. */
function healthy(over: Partial<SchemaReadiness> = {}): SchemaReadiness {
  return {
    ready: true,
    state: 'ready',
    reason: null,
    blockers: [],
    manifest: MANIFEST,
    expected_head: '003_c.sql',
    applied_head: '003_c.sql',
    pending_count: 0,
    dirty_count: 0,
    checked_at: '2026-08-22T12:00:00.000Z',
    status: {
      ledger_present: true,
      ledger_version: 2,
      expected_head: '003_c.sql',
      applied_head: '003_c.sql',
      entries: [
        entry({ id: '001_a.sql', applied_at: '2026-08-01T10:00:00.000Z', execution_ms: 12 }),
        entry({ id: '002_b.sql', applied_at: '2026-08-02T10:00:00.000Z', execution_ms: 340 }),
        entry({ id: '003_c.sql', applied_at: '2026-08-03T10:00:00.000Z', execution_ms: 7_100 }),
      ],
      pending: [],
      out_of_order: [],
      counts: {
        total: 3,
        applied: 3,
        pending: 0,
        dirty: 0,
        failed: 0,
        running: 0,
        orphaned_running: 0,
        checksum_mismatch: 0,
        checksum_unknown: 0,
        missing_file: 0,
      },
      problems: [],
    },
    ...over,
  };
}

function deps(verdict: SchemaReadiness | Error): MigrationCollectorDeps {
  return {
    readVerdict: async () => {
      if (verdict instanceof Error) throw verdict;
      return verdict;
    },
  };
}

const HEAD = 'maia_schema_migration_head';

beforeEach(() => {
  _resetMigrationCollectorForTests();
});

describe('head esperado vs. aplicado', () => {
  it('coincidem quando o banco está no head desta build', async () => {
    const g = await migrationGaugeSnapshot(deps(healthy()));
    expect(g[`${HEAD}:expected`]).toBe(3);
    expect(g[`${HEAD}:applied`]).toBe(3);
  });

  it('a distância entre eles é quantas migrations o banco está atrás', async () => {
    // O banco parou em 001; 002 e 003 continuam pendentes. `expected - applied`
    // é a leitura que o alerta faz, sem precisar conhecer o head da release.
    const g = await migrationGaugeSnapshot(
      deps(
        healthy({
          ready: false,
          state: 'blocked',
          applied_head: '001_a.sql',
          pending_count: 2,
        }),
      ),
    );
    expect(g[`${HEAD}:expected`]).toBe(3);
    expect(g[`${HEAD}:applied`]).toBe(1);
    expect(g.maia_schema_migrations_pending).toBe(2);
  });

  it('banco virgem lê 0 aplicado — que é verdade, e por isso falha NÃO pode ler 0', async () => {
    const g = await migrationGaugeSnapshot(deps(healthy({ applied_head: null, pending_count: 3 })));
    expect(g[`${HEAD}:applied`]).toBe(0);
  });

  it('é NaN quando o banco rodou uma migration que esta build não conhece', async () => {
    // `missing_file`: fingir uma posição para esse id seria inventar ordem onde
    // não há. O bloqueio de readiness já cobre o caso; a série não mente sobre
    // ele.
    const g = await migrationGaugeSnapshot(deps(healthy({ applied_head: '099_de_outra_build.sql' })));
    expect(g[`${HEAD}:applied`]).toBeNaN();
  });
});

describe('pendentes, dirty e duração da última execução', () => {
  it('publica a contagem de dirty — o estado que exige intervenção humana', async () => {
    const g = await migrationGaugeSnapshot(
      deps(healthy({ ready: false, state: 'blocked', dirty_count: 1 })),
    );
    expect(g.maia_schema_migrations_dirty).toBe(1);
  });

  it('a duração é a da migration aplicada mais recentemente pelo RELÓGIO, não pelo número', async () => {
    // Uma migration de branch antiga pode ser aplicada depois de uma de número
    // maior (`out_of_order`). O que interessa para tendência é a última
    // execução no tempo — aqui, os 55ms de `001`, aplicada por último.
    const v = healthy();
    const g = await migrationGaugeSnapshot(
      deps({
        ...v,
        status: {
          ...v.status!,
          entries: [
            entry({ id: '001_a.sql', applied_at: '2026-08-09T10:00:00.000Z', execution_ms: 55 }),
            entry({ id: '002_b.sql', applied_at: '2026-08-02T10:00:00.000Z', execution_ms: 340 }),
            entry({ id: '003_c.sql', applied_at: '2026-08-03T10:00:00.000Z', execution_ms: 7_100 }),
          ],
        },
      }),
    );
    expect(g.maia_schema_migration_last_duration_ms).toBe(55);
  });
});

describe('fail-closed — 0 é uma leitura válida, então falha tem de ser NaN', () => {
  /**
   * O caso que separa este coletor de um que "mantém o último valor". `0`
   * pendente e `0` dirty são exatamente a leitura saudável, então um coletor
   * que devolvesse 0 ao falhar reportaria "schema no head, nada sujo" DURANTE a
   * indisponibilidade do banco — o alerta afirmando que está tudo bem por não
   * ter conseguido olhar.
   */
  it('não reserve o último snapshot bom quando a leitura seguinte falha', async () => {
    let clock = 1_000_000;
    let broken = false;
    const flaky: MigrationCollectorDeps = {
      now: () => clock,
      readVerdict: async () => {
        if (broken) throw new Error('postgres://maia:sup3rs3cr3t@db:5432/maia is unreachable');
        return healthy();
      },
    };

    expect((await migrationGaugeSnapshot(flaky)).maia_schema_migrations_pending).toBe(0);

    broken = true;
    clock += 60_000;
    const g = await migrationGaugeSnapshot(flaky);
    expect(g.maia_schema_migrations_pending).toBeNaN();
    expect(g.maia_schema_migrations_dirty).toBeNaN();
    expect(g[`${HEAD}:applied`]).toBeNaN();
  });

  it('o veredito `unknown` (nada legível) também é NaN, nunca 0', async () => {
    const g = await migrationGaugeSnapshot(
      deps({
        ready: false,
        state: 'unknown',
        reason: 'schema state could not be determined (ECONNREFUSED) — failing closed',
        blockers: [],
        manifest: MANIFEST,
        expected_head: null,
        applied_head: null,
        pending_count: 0,
        dirty_count: 0,
        checked_at: '2026-08-22T12:00:00.000Z',
        status: null,
      }),
    );
    expect(g.maia_schema_migrations_pending).toBeNaN();
    expect(g.maia_schema_migrations_dirty).toBeNaN();
  });
});

describe('as séries chegam ao /metrics', () => {
  it('renderiza pelo renderizador Prometheus REAL, com o label `kind`', async () => {
    resetMetrics();
    _resetMigrationCollectorForTests();
    registerMigrationGauges(
      deps(healthy({ ready: false, state: 'blocked', applied_head: '001_a.sql', pending_count: 2, dirty_count: 1 })),
    );
    const body = await renderPrometheus();
    expect(body).toMatch(/^maia_schema_migration_head\{kind="expected"\} 3$/m);
    expect(body).toMatch(/^maia_schema_migration_head\{kind="applied"\} 1$/m);
    expect(body).toMatch(/^maia_schema_migrations_pending 2$/m);
    expect(body).toMatch(/^maia_schema_migrations_dirty 1$/m);
    expect(body).toMatch(/^maia_schema_migration_last_duration_ms 7100$/m);
  });

  /**
   * ANTI-ARMADILHA-DO-ESPELHO. O caso acima registra o coletor ELE MESMO, então
   * continuaria verde com a fiação de produção deletada. Este passa por
   * `registerRuntimeObservability()` — o único ponto que o boot chama — e
   * afirma que as séries existem depois. Remova a chamada de
   * `src/observability/register.ts` e este caso reprova.
   *
   * Robusto com e sem banco: o veredito canônico nunca lança, e uma leitura que
   * falha produz `NaN` — que é uma SÉRIE, não a ausência dela.
   */
  it('é fiado a partir de registerRuntimeObservability, o ponto de registro do boot', async () => {
    resetMetrics();
    _resetMigrationCollectorForTests();
    const { registerRuntimeObservability } = await import(
      '../../../src/observability/register.js'
    );
    await registerRuntimeObservability();
    const body = await renderPrometheus();
    expect(body).toMatch(/^maia_schema_migrations_pending (NaN|\d+)$/m);
    expect(body).toMatch(/^maia_schema_migrations_dirty (NaN|\d+)$/m);
    expect(body).toMatch(/^maia_schema_migration_head\{kind="expected"\} (NaN|\d+)$/m);
    expect(body).toMatch(/^maia_schema_migration_head\{kind="applied"\} (NaN|\d+)$/m);
  }, 30_000);
});
