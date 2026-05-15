// P3c Task 10 — worker `procedure-metrics-refresh`.
//
// Behavior:
//   - Periodic worker (cron `*\/15 * * * *`) that refreshes the materialized
//     view `procedure_metrics` (created in Task 2 with a UNIQUE index on
//     `definition_id`, which is the prerequisite for `REFRESH ...
//     CONCURRENTLY`).
//   - Worker does NOT open tenant context — matview é cross-tenant e o
//     próprio REFRESH não passa por nenhum path tenant-aware.
//
// Test surface:
//   - happy path: `db.execute` chamado uma vez com SQL contendo
//     `REFRESH MATERIALIZED VIEW CONCURRENTLY procedure_metrics`.
//   - failure path: `db.execute` rejeita → worker re-lança E loga `error`.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbExecuteMock = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  db: {
    execute: dbExecuteMock,
  },
}));

const loggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
vi.mock('../../src/lib/logger.js', () => ({
  logger: loggerMock,
}));

// PR #85 fix P85-I4 — worker now emits a `system_health_events` row per
// run. Mock the repo to capture calls without touching the DB.
const healthRecordMock = vi.fn(async () => {});
vi.mock('../../src/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db/repositories.js')>(
    '../../src/db/repositories.js',
  );
  return {
    ...actual,
    healthRepo: {
      record: healthRecordMock,
      lastForComponent: vi.fn(async () => null),
    },
  };
});

beforeEach(() => {
  dbExecuteMock.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  loggerMock.debug.mockReset();
  healthRecordMock.mockReset();
  healthRecordMock.mockResolvedValue(undefined);
});

describe('runProcedureMetricsRefresh', () => {
  it('happy path: chama db.execute uma vez com REFRESH MATERIALIZED VIEW CONCURRENTLY procedure_metrics', async () => {
    dbExecuteMock.mockResolvedValueOnce(undefined);

    const { runProcedureMetricsRefresh } = await import(
      '../../src/workers/procedure-metrics-refresh.js'
    );
    await runProcedureMetricsRefresh();

    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    // drizzle's sql template produces an SQL object — extract its text
    // representation. The toSQL() shape is the public contract for inspecting
    // produced SQL in tests; queryChunks/sql fields are stable accessors.
    const arg = dbExecuteMock.mock.calls[0][0];
    const rendered = JSON.stringify(arg);
    expect(rendered).toContain('REFRESH MATERIALIZED VIEW CONCURRENTLY procedure_metrics');

    // Success path logs `procedure_metrics_refresh.done`.
    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    const [, msg] = loggerMock.info.mock.calls[0];
    expect(msg).toBe('procedure_metrics_refresh.done');
  });

  it('failure path: re-lança o erro de db.execute e loga error com `procedure_metrics_refresh.failed`', async () => {
    const boom = new Error('refresh blew up');
    dbExecuteMock.mockRejectedValueOnce(boom);

    const { runProcedureMetricsRefresh } = await import(
      '../../src/workers/procedure-metrics-refresh.js'
    );

    await expect(runProcedureMetricsRefresh()).rejects.toThrow('refresh blew up');

    expect(dbExecuteMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    const [ctx, msg] = loggerMock.error.mock.calls[0];
    expect(msg).toBe('procedure_metrics_refresh.failed');
    expect(ctx.err).toBe(boom);
    expect(loggerMock.info).not.toHaveBeenCalled();
  });

  // PR #85 fix P85-I4 — observability: each refresh emits a health row so
  // DLQ-monitor / dashboards can alert when refresh is stale.
  it('happy path: emite system_health_events row com status=ok e duration_ms', async () => {
    dbExecuteMock.mockResolvedValueOnce(undefined);

    const { runProcedureMetricsRefresh } = await import(
      '../../src/workers/procedure-metrics-refresh.js'
    );
    await runProcedureMetricsRefresh();

    expect(healthRecordMock).toHaveBeenCalledTimes(1);
    const arg = healthRecordMock.mock.calls[0]![0] as {
      component: string;
      status: string;
      duration_ms: number;
    };
    expect(arg.component).toBe('procedure_metrics_refresh');
    expect(arg.status).toBe('ok');
    expect(typeof arg.duration_ms).toBe('number');
  });

  it('failure path: emite system_health_events row com status=down e error', async () => {
    const boom = new Error('matview deadlocked');
    dbExecuteMock.mockRejectedValueOnce(boom);

    const { runProcedureMetricsRefresh } = await import(
      '../../src/workers/procedure-metrics-refresh.js'
    );
    await expect(runProcedureMetricsRefresh()).rejects.toThrow('matview deadlocked');

    expect(healthRecordMock).toHaveBeenCalledTimes(1);
    const arg = healthRecordMock.mock.calls[0]![0] as {
      component: string;
      status: string;
      duration_ms: number;
      error?: string;
    };
    expect(arg.component).toBe('procedure_metrics_refresh');
    expect(arg.status).toBe('down');
    expect(arg.error).toBe('matview deadlocked');
  });

  it('health write failure não mascara o sucesso/fracasso do refresh', async () => {
    dbExecuteMock.mockResolvedValueOnce(undefined);
    healthRecordMock.mockRejectedValueOnce(new Error('health insert failed'));

    const { runProcedureMetricsRefresh } = await import(
      '../../src/workers/procedure-metrics-refresh.js'
    );
    // Should NOT throw — health emission is best-effort.
    await runProcedureMetricsRefresh();

    expect(loggerMock.info).toHaveBeenCalledTimes(1); // refresh.done still logged
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'procedure_metrics_refresh.health_write_failed',
    );
  });
});
