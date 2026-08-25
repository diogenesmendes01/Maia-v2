import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { AUDIT_ACTIONS } from '../../src/governance/audit-actions.js';
import { SYSTEM_TENANT_ID, SYSTEM_AGENT_ID } from '../../src/db/tenant-context.js';

const sendAlertMock = vi.fn().mockResolvedValue(undefined);
const dbExecuteMock = vi.fn();

vi.mock('../../src/db/client.js', () => ({ db: { execute: dbExecuteMock } }));
vi.mock('../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(async () => {
  vi.resetModules();
  vi.doMock('../../src/db/client.js', () => ({ db: { execute: dbExecuteMock } }));
  vi.doMock('../../src/lib/alerts.js', () => ({ sendAlert: sendAlertMock }));
  vi.doMock('../../src/lib/logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }));
  sendAlertMock.mockClear();
  dbExecuteMock.mockReset();
});

/**
 * A `acao` de cada regra entra na consulta como PARÂMETRO (`$1`), então
 * reconhecer "a consulta do disjuntor" por grep no texto do SQL não funciona —
 * as duas regras `stuck` renderizam o mesmo esqueleto. Estes dois helpers
 * casam pelo parâmetro, que é o que de fato distingue uma da outra.
 */
function isQueryFor(q: unknown, acao: string): boolean {
  return new PgDialect().sqlToQuery(q as SQL).params.includes(acao);
}

/**
 * As duas formas de regra devolvem SHAPES diferentes: `threshold` devolve uma
 * linha com `c`, `stuck` devolve UMA LINHA POR INSTÂNCIA presa (achado 4). Um
 * `mockResolvedValue` único para as duas faz a regra `stuck` ler "uma
 * instância presa" onde o caso queria dizer "nada" — verde ou vermelho por
 * acidente do stub, não pelo comportamento.
 */
function isStuckQuery(q: unknown): boolean {
  return new PgDialect().sqlToQuery(q as SQL).sql.includes('NOT EXISTS');
}

function stubDb(count: number, stuckGroups: unknown[] = []) {
  return async (q: unknown) =>
    isStuckQuery(q) ? { rows: stuckGroups } : { rows: [{ c: count }] };
}

function renderedFor(mock: { mock: { calls: unknown[][] } }, acao: string): string | undefined {
  const dialect = new PgDialect();
  const call = mock.mock.calls.find((c) => isQueryFor(c[0], acao));
  return call ? dialect.sqlToQuery(call[0] as SQL).sql : undefined;
}

describe('audit-watcher', () => {
  it('fires alert when threshold rule meets the count', async () => {
    // Every threshold query returns 100 (well above all thresholds in the
    // rule list); the stuck rules see nothing. The first rule in RULES
    // (setup_unauthorized_farm, threshold 3) will trip.
    dbExecuteMock.mockImplementation(stubDb(100));
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await runAuditWatcher();
    expect(sendAlertMock).toHaveBeenCalled();
    const subjects = sendAlertMock.mock.calls.map((c) => c[0].subject as string);
    expect(subjects.some((s) => s.includes('setup_unauthorized_farm'))).toBe(true);
    expect(subjects.some((s) => s.includes('CRITICAL'))).toBe(true);
  });

  it('does not fire when threshold rule is below count', async () => {
    dbExecuteMock.mockImplementation(stubDb(0));
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await runAuditWatcher();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('throttles repeat alerts within the 30-min window', async () => {
    dbExecuteMock.mockImplementation(stubDb(100));
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await runAuditWatcher();
    const firstCount = sendAlertMock.mock.calls.length;
    expect(firstCount).toBeGreaterThan(0);

    // Second tick same minute — throttle must suppress every alert.
    sendAlertMock.mockClear();
    dbExecuteMock.mockImplementation(stubDb(100));
    await runAuditWatcher();
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('survives a DB error in one rule and continues to the next', async () => {
    // First call (first rule) throws, subsequent calls succeed with 0 — only
    // the throwing rule should be skipped, others still run.
    dbExecuteMock.mockRejectedValueOnce(new Error('connection lost'));
    dbExecuteMock.mockImplementation(stubDb(0));
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await expect(runAuditWatcher()).resolves.toBeUndefined();
    // No alerts because subsequent rules return 0
    expect(sendAlertMock).not.toHaveBeenCalled();
  });

  it('exposes a stable RULES list for ops dashboards', async () => {
    const { _internal } = await import('../../src/workers/audit-watcher.js');
    const ids = _internal.RULES.map((r) => r.id);
    expect(ids).toContain('setup_unauthorized_farm');
    expect(ids).toContain('pairing_recovery_stuck');
    expect(ids).toContain('llm_circuit_long_open');
    expect(ids).toContain('bot_volume_burst');
    // Issue #536 — a recusa do guarda de locator do export. Threshold 1: a
    // taxa normal desta ação é ZERO, então agrupá-la por volume esconderia o
    // primeiro evento, que é o único que importa.
    expect(ids).toContain('privacy_export_locator_refused');
  });

  // Regression: a rule referencing a non-existent audit action would never
  // fire (born-dead). Assert every rule's `acao`/`mate_acao` is a registered
  // AuditAction so we can't merge a born-dead rule again.
  it('every rule references actions that exist in AUDIT_ACTIONS', async () => {
    const { _internal } = await import('../../src/workers/audit-watcher.js');
    const registry = new Set<string>(AUDIT_ACTIONS);
    for (const rule of _internal.RULES) {
      expect(registry.has(rule.acao), `acao "${rule.acao}" of rule "${rule.id}"`).toBe(true);
      if (rule.kind === 'stuck') {
        expect(
          registry.has(rule.mate_acao),
          `mate_acao "${rule.mate_acao}" of rule "${rule.id}"`,
        ).toBe(true);
      }
    }
  });

  // Issue #323 phase 2: the watcher is a cross-tenant aggregate that runs as
  // GLOBAL maintenance under the reserved `system` sentinel — NOT the legacy
  // `default/default` literal. Read the live ALS context from inside the
  // (mocked) `db.execute` to prove the wrapper. We resolve the context module
  // dynamically so it shares the registry instance the worker uses after
  // `vi.resetModules()`.
  it('runs every query under the reserved system context (not default/default)', async () => {
    const observed: Array<{ tenant_id: string; agent_id: string }> = [];
    dbExecuteMock.mockImplementation(async () => {
      const { tryGetCurrentContext } = await import('../../src/db/tenant-context.js');
      const ctx = tryGetCurrentContext();
      if (ctx) observed.push({ tenant_id: ctx.tenant_id, agent_id: ctx.agent_id });
      return { rows: [] };
    });
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await runAuditWatcher();

    expect(observed.length).toBeGreaterThan(0);
    for (const ctx of observed) {
      expect(ctx.tenant_id).toBe(SYSTEM_TENANT_ID);
      expect(ctx.agent_id).toBe(SYSTEM_AGENT_ID);
      expect(ctx.tenant_id).not.toBe('default');
    }
  });

  // ---------------------------------------------------------------------
  // Achado 4 da re-review do owner na PR #541 — correlação das regras `stuck`.
  //
  // A prova de ponta a ponta (circuito A preso × circuito B que fecha) é
  // integração contra Postgres real, em
  // `tests/integration/llm-circuit-audit-real-db.spec.ts`. O que se trava aqui
  // é o que aquela suíte NÃO pode travar sem banco: que a consulta emitida
  // carrega o predicado de correlação, e que nenhuma regra `stuck` nova pode
  // nascer sem escolher por quê correlacionar.
  // ---------------------------------------------------------------------
  it('toda regra `stuck` declara explicitamente `correlate_by`', async () => {
    const { _internal } = await import('../../src/workers/audit-watcher.js');
    const stuck = _internal.RULES.filter((r) => r.kind === 'stuck');
    expect(stuck.length).toBeGreaterThan(0);
    for (const rule of stuck) {
      expect(Array.isArray(rule.correlate_by), `regra "${rule.id}"`).toBe(true);
    }
    // E as duas que existem hoje NÃO são singletons globais: o disjuntor é por
    // (provider, workload) e por réplica; a recuperação de pareamento é por
    // alvo. `[]` em qualquer uma delas é o defeito de volta.
    const byId = new Map(stuck.map((r) => [r.id, r.correlate_by]));
    expect(byId.get('llm_circuit_long_open')).toEqual(['provider', 'workload', 'replica']);
    expect(byId.get('pairing_recovery_stuck')).toEqual(['target']);
  });

  it('a consulta `stuck` amarra o par pela identidade, não só pela ordem', async () => {
    dbExecuteMock.mockImplementation(stubDb(0));
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await runAuditWatcher();

    // A `acao` viaja como PARÂMETRO, não no texto — a consulta se reconhece
    // pelos params, não por grep no SQL.
    const circuitQuery = renderedFor(dbExecuteMock, 'llm_circuit_opened');
    expect(circuitQuery, 'nenhuma consulta `stuck` foi emitida').toBeDefined();
    expect(circuitQuery).toContain('NOT EXISTS');

    // O defeito era um NOT EXISTS que só olhava `created_at`. Cada chave de
    // correlação precisa aparecer AMARRANDO b a a.
    for (const key of ['provider', 'workload', 'replica']) {
      expect(
        circuitQuery,
        `a consulta não correlaciona por "${key}": qualquer fechamento fecharia qualquer abertura`,
      ).toContain(`b.metadata->>'${key}' IS NOT DISTINCT FROM a.metadata->>'${key}'`);
    }
    // `=` deixaria a comparação NULL quando a chave falta dos dois lados, e o
    // NOT EXISTS passaria a valer sempre: alarme falso permanente.
    expect(circuitQuery).not.toMatch(/b\.metadata->>'provider' = /);
  });

  it('o alerta NOMEIA a instância presa, e não só quantas são', async () => {
    dbExecuteMock.mockImplementation(async (q: unknown) =>
      isQueryFor(q, 'llm_circuit_opened')
        ? {
            rows: [
              {
                identity: 'anthropic/reasoner/host-a:1#aaaa1111',
                n: 3,
                oldest: new Date('2026-01-01T00:00:00.000Z'),
              },
            ],
          }
        : stubDb(0)(q),
    );
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await runAuditWatcher();

    const call = sendAlertMock.mock.calls.find((c) =>
      (c[0].subject as string).includes('llm_circuit_long_open'),
    );
    expect(call, 'a regra do disjuntor não alertou').toBeDefined();
    const body = call![0].body as string;
    expect(body).toContain('anthropic/reasoner/host-a:1#aaaa1111');
    expect(body).toContain('provider/workload/replica');
    expect(body).toContain('2026-01-01T00:00:00.000Z');
  });

  it('um carimbo ausente vira `unknown` em vez de matar o alerta', async () => {
    // `new Date(null).toISOString()` lança; lançar aqui faria o `catch` de
    // `runAuditWatcher` engolir a regra como `check_failed` e o plantão veria
    // silêncio no lugar de um circuito preso.
    dbExecuteMock.mockImplementation(async (q: unknown) =>
      isQueryFor(q, 'llm_circuit_opened')
        ? { rows: [{ identity: 'anthropic/reasoner/x', n: 1, oldest: null }] }
        : stubDb(0)(q),
    );
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await runAuditWatcher();

    const call = sendAlertMock.mock.calls.find((c) =>
      (c[0].subject as string).includes('llm_circuit_long_open'),
    );
    expect(call).toBeDefined();
    expect(call![0].body as string).toContain('oldest unknown');
  });

  // Regression: the original PR queried `FROM auditoria`, which doesn't exist
  // in the schema — the real table is `audit_log`. The watcher now interpolates
  // the imported `audit_log` schema reference. Render the SQL the watcher
  // hands to `db.execute` through Drizzle's PgDialect and assert the rendered
  // text references `audit_log` and never the legacy name.
  it('queries reference the audit_log table, not auditoria', async () => {
    dbExecuteMock.mockImplementation(stubDb(0));
    const { runAuditWatcher } = await import('../../src/workers/audit-watcher.js');
    await runAuditWatcher();
    expect(dbExecuteMock).toHaveBeenCalled();

    const dialect = new PgDialect();
    for (const call of dbExecuteMock.mock.calls) {
      const rendered = dialect.sqlToQuery(call[0] as SQL).sql;
      expect(rendered).not.toMatch(/\bauditoria\b/);
      expect(rendered).toMatch(/\baudit_log\b/);
    }
  });
});
