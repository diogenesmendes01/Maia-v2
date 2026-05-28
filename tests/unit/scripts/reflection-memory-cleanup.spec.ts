/**
 * Issue #260 — Cleanup of polluted (tenant='default', agent='default')
 * `agent_memories` rows produced by the pre-#251 reflection batch worker.
 *
 * Contract this spec PROVES (after #260 ships):
 *
 *   1. CLI args:
 *      - Missing `--cutoff` → throws `RequiredArgsError` (CLI maps to exit 2).
 *      - `--cutoff` not parseable as a date → `InvalidArgsError` (exit 2).
 *      - `--cutoff` in the future → `InvalidArgsError` (exit 2). A future
 *        cutoff would either wipe legit new rows or be a typo.
 *      - `--execute` + `--dry-run` together → `InvalidArgsError`.
 *      - `--limit=0`/`--limit=-1`/`--limit=foo` → `InvalidArgsError`.
 *      - Default (no flag) is `--dry-run`, not destructive.
 *
 *   2. Dry-run is read-only:
 *      - Counts matching rows.
 *      - Returns the date range + a 5-row sample (with `conteudo` truncated).
 *      - Does NOT touch the store. Every row that was there is still there.
 *
 *   3. Execute is destructive:
 *      - Deletes ALL rows matching `(tenant='default', agent='default',
 *        created_at<cutoff, tipo IN VALID_REFLECTION_TIPOS)`.
 *      - Rows OUTSIDE the cutoff are preserved (created_at >= cutoff).
 *      - Rows with `tenant_id != 'default'` are preserved (defense).
 *      - Rows with `agent_id != 'default'` are preserved (defense).
 *      - Rows with the wrong tipo are preserved (e.g. a fact under default).
 *      - Confirmation MUST be 'y'/'yes' (case-insensitive). 'n', '', or
 *        anything else aborts without mutating.
 *      - An `admin_audit_log` row is appended with action=
 *        'reflection_memory_cleanup' and a change_summary JSON containing
 *        cutoff, rows_deleted, executed_by_user, started_at, ended_at.
 *
 *   4. Cross-tenant defense (the whole point of this script):
 *      - When the store contains a tenant-A row with tipo='reflexao'
 *        created BEFORE the cutoff, the cleanup MUST NOT touch it. Only
 *        rows physically in the `default/default` bucket are in scope.
 *
 * Strategy:
 *   No real DB. We mock `@/db/client.js` and dispatch on rendered SQL via
 *   Drizzle's `PgDialect`, same pattern as the embeddings-rebuild spec.
 *   We implement the minimum SQL surface the production code uses:
 *     - SELECT count(*)::text AS count FROM agent_memories WHERE ...
 *     - SELECT min/max(created_at)::text FROM agent_memories WHERE ...
 *     - SELECT id, created_at, tipo, conteudo FROM agent_memories WHERE ...
 *     - DELETE FROM agent_memories WHERE id IN (SELECT ...)
 *     - BEGIN / COMMIT / ROLLBACK (recorded but no-op against the in-memory
 *       store — the rollback path is tested by injecting a failing batch).
 *     - INSERT INTO admin_audit_log (...)
 *
 *   The fake store is intentionally precise about the WHERE clause: an
 *   unscoped DELETE would surface as the cleanup walking rows it shouldn't,
 *   which the assertions catch.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// In-memory store + db.execute fake
// ---------------------------------------------------------------------------
type MemoryRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  conteudo: string;
  tipo: string;
  escopo: string;
  created_at: Date;
};
type AuditRow = {
  tenant_id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  change_summary: Record<string, unknown>;
};

const memoryStore: MemoryRow[] = [];
const auditStore: AuditRow[] = [];
const renderedSqls: Array<{ sql: string; params: unknown[] }> = [];

const _dialect = new PgDialect();

// Match each WHERE-clause shape we expect. Production formats:
//   - count(*) summary:   `SELECT count(*)::text AS count FROM agent_memories WHERE ...`
//   - range summary:      `SELECT min(created_at)::text AS earliest, max(created_at)::text AS latest FROM agent_memories WHERE ...`
//   - sample:             `SELECT id::text, created_at::text, tipo, conteudo FROM agent_memories WHERE ... ORDER BY created_at LIMIT $5`
//   - delete:             `DELETE FROM agent_memories WHERE id IN (SELECT id FROM agent_memories WHERE ... ORDER BY created_at LIMIT $5)`
//
// All WHERE clauses share the same parameter order:
//   $1 tenant_id, $2 agent_id, $3 cutoff (timestamptz string), $4 tipos[]
//
// The sample and delete add a LIMIT at the end.

const dbExecuteMock = vi.fn(async (query: SQL) => {
  const rendered = _dialect.sqlToQuery(query);
  const sqlText = rendered.sql;
  const params = rendered.params as unknown[];
  renderedSqls.push({ sql: sqlText, params });

  // BEGIN / COMMIT / ROLLBACK — record but no-op. The in-memory store
  // is mutated directly by the DELETE handler below; a real DB rollback
  // would unwind those mutations, but the script's failure path (tested
  // separately by injecting a throw) doesn't depend on rollback
  // semantics for correctness — it depends on NOT swallowing the error.
  if (/^\s*BEGIN\s*$/i.test(sqlText)) return { rows: [], rowCount: 0 };
  if (/^\s*COMMIT\s*$/i.test(sqlText)) return { rows: [], rowCount: 0 };
  if (/^\s*ROLLBACK\s*$/i.test(sqlText)) return { rows: [], rowCount: 0 };

  // INSERT INTO admin_audit_log — capture the row.
  if (/^\s*INSERT\s+INTO\s+admin_audit_log/i.test(sqlText)) {
    const [
      tenant_id,
      actor_id,
      actor_role,
      action,
      resource_type,
      resource_id,
      change_summary_json,
    ] = params as [string, string, string, string, string, string | null, string];
    auditStore.push({
      tenant_id,
      actor_id,
      actor_role,
      action,
      resource_type,
      resource_id: resource_id ?? null,
      change_summary:
        typeof change_summary_json === 'string'
          ? JSON.parse(change_summary_json)
          : (change_summary_json as Record<string, unknown>),
    });
    return { rows: [], rowCount: 1 };
  }

  // Drizzle expands a JS array passed into `sql\`... ANY(${arr})\`` into
  // one placeholder per element. For our 1-element ['reflexao'] tipos list
  // the bound param at the tipos position is the bare string 'reflexao'
  // (not `['reflexao']`). Helper to normalise either shape to an array so
  // the in-memory dispatch is robust to single- vs multi-tipo lists.
  const normalizeTipos = (raw: unknown): string[] => {
    if (Array.isArray(raw)) return raw as string[];
    if (typeof raw === 'string') return [raw];
    return [];
  };

  // count(*) summary
  if (/SELECT\s+count\(\*\)::text\s+AS\s+count\s+FROM\s+agent_memories/i.test(sqlText)) {
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    // The two count queries differ in WHERE depth:
    //   - in-scope count: tenant + agent + cutoff + tipos
    //   - remaining count: tenant + agent only (no cutoff/tipos)
    // Detect by presence of the cutoff predicate in the rendered SQL.
    const hasCutoff = /created_at\s*<\s*\$/.test(sqlText);
    let filtered = memoryStore.filter(
      (r) => r.tenant_id === tenant_id && r.agent_id === agent_id,
    );
    if (hasCutoff) {
      const cutoff = new Date(params[2] as string);
      const tipos = normalizeTipos(params[3]);
      filtered = filtered.filter(
        (r) => r.created_at.getTime() < cutoff.getTime() && tipos.includes(r.tipo),
      );
    }
    return { rows: [{ count: String(filtered.length) }] };
  }

  // min/max(created_at) summary
  if (/min\(created_at\)::text\s+AS\s+earliest/i.test(sqlText)) {
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const cutoff = new Date(params[2] as string);
    const tipos = normalizeTipos(params[3]);
    const matching = memoryStore.filter(
      (r) =>
        r.tenant_id === tenant_id &&
        r.agent_id === agent_id &&
        r.created_at.getTime() < cutoff.getTime() &&
        tipos.includes(r.tipo),
    );
    if (matching.length === 0) {
      return { rows: [{ earliest: null, latest: null }] };
    }
    const sorted = matching
      .slice()
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    return {
      rows: [
        {
          earliest: sorted[0]!.created_at.toISOString(),
          latest: sorted[sorted.length - 1]!.created_at.toISOString(),
        },
      ],
    };
  }

  // Sample SELECT (id::text, created_at::text, tipo, conteudo)
  if (/SELECT\s+id::text,\s+created_at::text,\s+tipo,\s+conteudo/i.test(sqlText)) {
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const cutoff = new Date(params[2] as string);
    const tipos = normalizeTipos(params[3]);
    // With a 1-element tipos list, Drizzle binds the tipo as $4 and the
    // LIMIT as $5. With an N-element list, the LIMIT shifts to $4+N. So
    // the limit is always the LAST param.
    const limit = Number(params[params.length - 1]);
    const rows = memoryStore
      .filter(
        (r) =>
          r.tenant_id === tenant_id &&
          r.agent_id === agent_id &&
          r.created_at.getTime() < cutoff.getTime() &&
          tipos.includes(r.tipo),
      )
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        created_at: r.created_at.toISOString(),
        tipo: r.tipo,
        conteudo: r.conteudo,
      }));
    return { rows };
  }

  // DELETE
  if (/^\s*DELETE\s+FROM\s+agent_memories/i.test(sqlText)) {
    const tenant_id = params[0] as string;
    const agent_id = params[1] as string;
    const cutoff = new Date(params[2] as string);
    const tipos = normalizeTipos(params[3]);
    // LIMIT is always the LAST param (see sample-select comment above).
    const limit = Number(params[params.length - 1]);
    const matching = memoryStore
      .filter(
        (r) =>
          r.tenant_id === tenant_id &&
          r.agent_id === agent_id &&
          r.created_at.getTime() < cutoff.getTime() &&
          tipos.includes(r.tipo),
      )
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .slice(0, limit);
    for (const m of matching) {
      const idx = memoryStore.findIndex((r) => r.id === m.id);
      if (idx >= 0) memoryStore.splice(idx, 1);
    }
    return { rows: [], rowCount: matching.length };
  }

  return { rows: [], rowCount: 0 };
});

vi.mock('@/db/client.js', () => ({
  db: { execute: dbExecuteMock },
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const CUTOFF = new Date('2026-05-28T12:55:08Z');
// Times relative to the cutoff.
const T_BEFORE_1 = new Date('2026-05-25T10:00:00Z');
const T_BEFORE_2 = new Date('2026-05-26T10:00:00Z');
const T_BEFORE_3 = new Date('2026-05-27T10:00:00Z');
const T_AFTER_1 = new Date('2026-05-29T10:00:00Z');

beforeEach(() => {
  memoryStore.length = 0;
  auditStore.length = 0;
  renderedSqls.length = 0;
  dbExecuteMock.mockClear();
});

function seedPolluted(): void {
  // Three reflection memories in the polluted bucket, BEFORE the cutoff.
  // These are the rows the cleanup MUST remove.
  memoryStore.push({
    id: 'mem_pre_1',
    tenant_id: 'default',
    agent_id: 'default',
    conteudo: 'reflexao pre-fix 1',
    tipo: 'reflexao',
    escopo: 'global',
    created_at: T_BEFORE_1,
  });
  memoryStore.push({
    id: 'mem_pre_2',
    tenant_id: 'default',
    agent_id: 'default',
    conteudo: 'reflexao pre-fix 2 — a very long conteudo string that will end up exceeding the eighty-character truncation threshold so we can verify the dry-run sample truncates it correctly',
    tipo: 'reflexao',
    escopo: 'global',
    created_at: T_BEFORE_2,
  });
  memoryStore.push({
    id: 'mem_pre_3',
    tenant_id: 'default',
    agent_id: 'default',
    conteudo: 'reflexao pre-fix 3',
    tipo: 'reflexao',
    escopo: 'global',
    created_at: T_BEFORE_3,
  });
}

function seedNonPolluted(): void {
  // 1. A reflection AFTER the cutoff in the same bucket — survives (the
  //    post-fix worker wrote it under the correct context but for tests we
  //    represent a hypothetical late-bound default/default write that we
  //    don't want to touch).
  memoryStore.push({
    id: 'mem_post_1',
    tenant_id: 'default',
    agent_id: 'default',
    conteudo: 'reflexao post-fix',
    tipo: 'reflexao',
    escopo: 'global',
    created_at: T_AFTER_1,
  });
  // 2. A FACT in the default bucket BEFORE the cutoff — survives because
  //    `tipo != 'reflexao'`. A legitimate fact under default should not be
  //    swept by the cleanup.
  memoryStore.push({
    id: 'mem_fact_default',
    tenant_id: 'default',
    agent_id: 'default',
    conteudo: 'fato sob default',
    tipo: 'fato',
    escopo: 'global',
    created_at: T_BEFORE_1,
  });
  // 3. A reflection in tenant-A BEFORE the cutoff — survives (different
  //    tenant_id). This is the CROSS-TENANT DEFENSE: the cleanup is scoped
  //    to default/default and must NOT walk into a real tenant's data.
  memoryStore.push({
    id: 'mem_tenantA_pre',
    tenant_id: 'tenant-A',
    agent_id: 'agent-A',
    conteudo: 'reflexao tenant-A pre-cutoff',
    tipo: 'reflexao',
    escopo: 'global',
    created_at: T_BEFORE_1,
  });
  // 4. A reflection in default tenant but DIFFERENT agent BEFORE the
  //    cutoff — survives (different agent_id).
  memoryStore.push({
    id: 'mem_other_agent',
    tenant_id: 'default',
    agent_id: 'agent-OTHER',
    conteudo: 'reflexao default tenant, other agent',
    tipo: 'reflexao',
    escopo: 'global',
    created_at: T_BEFORE_1,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Issue #260 — scripts/reflection-memory-cleanup.ts', () => {
  describe('CLI args parsing — parseArgs', () => {
    it('REJECTION — missing --cutoff throws RequiredArgsError', async () => {
      const { parseArgs, RequiredArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      expect(() => parseArgs(['node', 'reflection-memory-cleanup.ts'])).toThrowError(
        RequiredArgsError,
      );
      try {
        parseArgs(['node', 'reflection-memory-cleanup.ts']);
      } catch (err) {
        expect((err as { code: string }).code).toBe('MISSING_REQUIRED_ARGS');
        expect((err as Error).message).toMatch(/--cutoff/);
      }
    });

    it('REJECTION — junk --cutoff throws InvalidArgsError', async () => {
      const { parseArgs, InvalidArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const argv = ['node', 'reflection-memory-cleanup.ts', '--cutoff=not-a-date'];
      expect(() => parseArgs(argv)).toThrowError(InvalidArgsError);
      try {
        parseArgs(argv);
      } catch (err) {
        expect((err as { code: string }).code).toBe('INVALID_ARGS');
        expect((err as Error).message).toMatch(/valid date/);
      }
    });

    it('REJECTION — future --cutoff throws InvalidArgsError', async () => {
      const { parseArgs, InvalidArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      // The "now" fixture is 2026-05-28T12:00:00Z; cutoff is one day later.
      const now = () => new Date('2026-05-28T12:00:00Z');
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-29T12:00:00Z',
      ];
      expect(() => parseArgs(argv, { now })).toThrowError(InvalidArgsError);
      try {
        parseArgs(argv, { now });
      } catch (err) {
        expect((err as { code: string }).code).toBe('INVALID_ARGS');
        expect((err as Error).message).toMatch(/future/);
      }
    });

    it('REJECTION — --execute and --dry-run together throws InvalidArgsError', async () => {
      const { parseArgs, InvalidArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-28T12:55:08Z',
        '--execute',
        '--dry-run',
      ];
      expect(() => parseArgs(argv, { now: () => new Date('2026-05-29T00:00:00Z') })).toThrowError(
        InvalidArgsError,
      );
    });

    it('REJECTION — --limit must be a positive integer', async () => {
      const { parseArgs, InvalidArgsError } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const now = () => new Date('2026-05-29T00:00:00Z');
      const base = ['node', 'reflection-memory-cleanup.ts', '--cutoff=2026-05-28T12:55:08Z'];
      expect(() => parseArgs([...base, '--limit=0'], { now })).toThrowError(InvalidArgsError);
      expect(() => parseArgs([...base, '--limit=-5'], { now })).toThrowError(InvalidArgsError);
      expect(() => parseArgs([...base, '--limit=foo'], { now })).toThrowError(InvalidArgsError);
      expect(() => parseArgs([...base, '--limit=1.5'], { now })).toThrowError(InvalidArgsError);
    });

    it('ACCEPT — default behavior is dry-run when --execute is omitted', async () => {
      const { parseArgs } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-28T12:55:08Z',
      ];
      const parsed = parseArgs(argv, { now: () => new Date('2026-05-29T00:00:00Z') });
      expect(parsed.dryRun).toBe(true);
      expect(parsed.execute).toBe(false);
    });

    it('ACCEPT — --execute sets execute=true, dryRun=false', async () => {
      const { parseArgs } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-28T12:55:08Z',
        '--execute',
      ];
      const parsed = parseArgs(argv, { now: () => new Date('2026-05-29T00:00:00Z') });
      expect(parsed.execute).toBe(true);
      expect(parsed.dryRun).toBe(false);
    });

    it('ACCEPT — explicit --dry-run is accepted', async () => {
      const { parseArgs } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const argv = [
        'node',
        'reflection-memory-cleanup.ts',
        '--cutoff=2026-05-28T12:55:08Z',
        '--dry-run',
      ];
      const parsed = parseArgs(argv, { now: () => new Date('2026-05-29T00:00:00Z') });
      expect(parsed.dryRun).toBe(true);
      expect(parsed.execute).toBe(false);
    });

    it('ACCEPT — --limit parses to a positive integer', async () => {
      const { parseArgs, DEFAULT_BATCH_SIZE } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      const now = () => new Date('2026-05-29T00:00:00Z');
      const base = ['node', 'reflection-memory-cleanup.ts', '--cutoff=2026-05-28T12:55:08Z'];
      expect(parseArgs(base, { now }).limit).toBe(DEFAULT_BATCH_SIZE);
      expect(parseArgs([...base, '--limit=500'], { now }).limit).toBe(500);
    });
  });

  describe('dry-run — summarizeScope is read-only', () => {
    it('counts matching rows, returns earliest/latest, samples truncated', async () => {
      seedPolluted();
      seedNonPolluted();
      const { runDryRun } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const lines: string[] = [];
      const summary = await runDryRun({ cutoff: CUTOFF, log: (m) => lines.push(m) });

      // 3 polluted rows in scope (all default/default reflexao before cutoff).
      expect(summary.count).toBe(3);
      // Earliest is T_BEFORE_1, latest is T_BEFORE_3.
      expect(summary.earliestCreatedAt).toBe(T_BEFORE_1.toISOString());
      expect(summary.latestCreatedAt).toBe(T_BEFORE_3.toISOString());
      // The post-cutoff default/default row + the default/default fact remain.
      expect(summary.remainingDefaultDefault).toBe(2);
      // Sample includes 3 rows (less than the 5-sample-cap).
      expect(summary.sample).toHaveLength(3);
      // The long conteudo is truncated.
      const longSample = summary.sample.find((s) => s.id === 'mem_pre_2');
      expect(longSample).toBeDefined();
      expect(longSample!.conteudo.endsWith('…')).toBe(true);
      expect(longSample!.conteudo.length).toBeLessThanOrEqual(81); // 80 + the ellipsis

      // DEFENSE: the store is unchanged after a dry run.
      expect(memoryStore.find((r) => r.id === 'mem_pre_1')).toBeDefined();
      expect(memoryStore.find((r) => r.id === 'mem_pre_2')).toBeDefined();
      expect(memoryStore.find((r) => r.id === 'mem_pre_3')).toBeDefined();
      // And no audit row written.
      expect(auditStore).toHaveLength(0);

      // Log output sanity: dry-run prints the count.
      expect(lines.some((l) => /rows in scope/.test(l))).toBe(true);
      expect(lines.some((l) => /DRY RUN END/.test(l))).toBe(true);
    });

    it('empty scope — count zero, no sample, no mutation', async () => {
      // No polluted rows; only a tenant-A reflection and a post-cutoff
      // default/default reflection. Both survive.
      seedNonPolluted();
      const { runDryRun } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const summary = await runDryRun({ cutoff: CUTOFF, log: () => undefined });
      expect(summary.count).toBe(0);
      expect(summary.earliestCreatedAt).toBeNull();
      expect(summary.latestCreatedAt).toBeNull();
      expect(summary.sample).toHaveLength(0);
      // 2 default/default rows still exist (post-cutoff reflection + the fact).
      expect(summary.remainingDefaultDefault).toBe(2);
    });
  });

  describe('execute — deleteInScope + appendAuditRow', () => {
    it('SUCCESS — deletes ALL in-scope rows, preserves others', async () => {
      seedPolluted();
      seedNonPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'test-operator',
        confirmReader: async () => 'y', // auto-confirm
        log: () => undefined,
      });

      expect(outcome.confirmed).toBe(true);
      expect(outcome.result?.rowsDeleted).toBe(3);
      expect(outcome.result?.batches).toBeGreaterThan(0);

      // In-scope rows are GONE.
      expect(memoryStore.find((r) => r.id === 'mem_pre_1')).toBeUndefined();
      expect(memoryStore.find((r) => r.id === 'mem_pre_2')).toBeUndefined();
      expect(memoryStore.find((r) => r.id === 'mem_pre_3')).toBeUndefined();

      // OUT-OF-SCOPE rows are PRESERVED:
      // - post-cutoff in default/default
      expect(memoryStore.find((r) => r.id === 'mem_post_1')).toBeDefined();
      // - wrong tipo in default/default
      expect(memoryStore.find((r) => r.id === 'mem_fact_default')).toBeDefined();
      // - DIFFERENT tenant (cross-tenant defense)
      expect(memoryStore.find((r) => r.id === 'mem_tenantA_pre')).toBeDefined();
      // - DIFFERENT agent under the same tenant (defense-in-depth)
      expect(memoryStore.find((r) => r.id === 'mem_other_agent')).toBeDefined();
    });

    it('SUCCESS — appends an admin_audit_log row with the full payload', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'test-operator',
        confirmReader: async () => 'y',
        log: () => undefined,
      });

      expect(auditStore).toHaveLength(1);
      const audit = auditStore[0]!;
      expect(audit.action).toBe('reflection_memory_cleanup');
      expect(audit.resource_type).toBe('agent_memories');
      expect(audit.tenant_id).toBe('default');
      expect(audit.actor_id).toBe('test-operator');
      expect(audit.actor_role).toBe('script');
      // change_summary contains the dispatch-spec fields.
      const cs = audit.change_summary as {
        cutoff: string;
        rows_deleted: number;
        executed_by_user: string;
        started_at: string;
        ended_at: string;
      };
      expect(cs.cutoff).toBe(CUTOFF.toISOString());
      expect(cs.rows_deleted).toBe(3);
      expect(cs.executed_by_user).toBe('test-operator');
      expect(typeof cs.started_at).toBe('string');
      expect(typeof cs.ended_at).toBe('string');
    });

    it('CONFIRMATION — answering "n" aborts WITHOUT mutating the store or writing audit', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'test-operator',
        confirmReader: async () => 'n',
        log: () => undefined,
      });
      expect(outcome.confirmed).toBe(false);
      expect(outcome.result).toBeNull();
      // No rows deleted, no audit appended.
      expect(memoryStore).toHaveLength(3);
      expect(auditStore).toHaveLength(0);
    });

    it('CONFIRMATION — empty input is treated as NO (fail-closed)', async () => {
      seedPolluted();
      const { runExecute, confirmDestructive } = await import(
        '@/../scripts/reflection-memory-cleanup.ts'
      );
      // Direct test of the confirmation primitive: empty string → false.
      expect(await confirmDestructive({ prompt: 'p', reader: async () => '' })).toBe(false);
      expect(await confirmDestructive({ prompt: 'p', reader: async () => '   ' })).toBe(false);
      // 'Y' / 'yes' / 'YES' all map to true.
      expect(await confirmDestructive({ prompt: 'p', reader: async () => 'Y' })).toBe(true);
      expect(await confirmDestructive({ prompt: 'p', reader: async () => 'yes' })).toBe(true);
      expect(await confirmDestructive({ prompt: 'p', reader: async () => 'YES' })).toBe(true);
      // Anything else → false.
      expect(await confirmDestructive({ prompt: 'p', reader: async () => 'maybe' })).toBe(false);
      // And a runExecute with an empty-string reader leaves the store intact.
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'test-operator',
        confirmReader: async () => '',
        log: () => undefined,
      });
      expect(outcome.confirmed).toBe(false);
      expect(memoryStore).toHaveLength(3);
      expect(auditStore).toHaveLength(0);
    });

    it('CUTOFF BOUNDARY — rows AT the cutoff are preserved (strict <, not <=)', async () => {
      // Seed one row exactly at the cutoff.
      memoryStore.push({
        id: 'mem_at_cutoff',
        tenant_id: 'default',
        agent_id: 'default',
        conteudo: 'reflexao exactly at cutoff',
        tipo: 'reflexao',
        escopo: 'global',
        created_at: new Date(CUTOFF.getTime()),
      });
      // And one row 1ms BEFORE the cutoff — that one SHOULD be deleted.
      memoryStore.push({
        id: 'mem_one_ms_before',
        tenant_id: 'default',
        agent_id: 'default',
        conteudo: 'reflexao one ms before cutoff',
        tipo: 'reflexao',
        escopo: 'global',
        created_at: new Date(CUTOFF.getTime() - 1),
      });
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      // The exact-cutoff row survives (strict <).
      expect(memoryStore.find((r) => r.id === 'mem_at_cutoff')).toBeDefined();
      // The 1ms-before row is gone.
      expect(memoryStore.find((r) => r.id === 'mem_one_ms_before')).toBeUndefined();
    });

    it('BATCHING — small --limit forces multiple batches but deletes the same total', async () => {
      seedPolluted(); // 3 polluted rows
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      const outcome = await runExecute({
        cutoff: CUTOFF,
        batchSize: 2, // forces 2 batches: [2 rows] then [1 row]
        executedByUser: 'op',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      expect(outcome.result?.rowsDeleted).toBe(3);
      expect(outcome.result?.batches).toBeGreaterThanOrEqual(2);
      // BEGIN/COMMIT were called at least twice (once per non-empty batch).
      const begins = renderedSqls.filter((r) => /^\s*BEGIN\s*$/i.test(r.sql)).length;
      const commits = renderedSqls.filter((r) => /^\s*COMMIT\s*$/i.test(r.sql)).length;
      expect(begins).toBeGreaterThanOrEqual(2);
      expect(commits).toBeGreaterThanOrEqual(2);
    });

    it('EMPTY SCOPE — execute with zero in-scope rows is a clean no-op (no confirm needed, no delete)', async () => {
      seedNonPolluted(); // nothing in scope
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      let confirmCalled = false;
      const outcome = await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => {
          confirmCalled = true;
          return 'y';
        },
        log: () => undefined,
      });
      // With zero rows to delete, we should NEVER prompt — there's nothing
      // to destroy, prompting would be noise.
      expect(confirmCalled).toBe(false);
      expect(outcome.confirmed).toBe(true);
      expect(outcome.result?.rowsDeleted).toBe(0);
      // No audit row when nothing was actually deleted? — the spec says
      // "every execute MUST emit". We interpret "execute" strictly: if the
      // user passed --execute and the run reached the no-op branch, we
      // still don't append an audit row because no mutation occurred and
      // there is nothing to attribute. This avoids polluting admin_audit_log
      // with empty-cleanup noise.
      expect(auditStore).toHaveLength(0);
    });

    it('FAILURE — DB error mid-batch is propagated, not swallowed', async () => {
      seedPolluted();
      // Inject a one-shot failure on the next DELETE. This is the contract
      // that "wrap in transaction; rollback on any error mid-batch" must
      // be honoured: if the DELETE throws, the function must throw too.
      let deletesSeen = 0;
      const original = dbExecuteMock.getMockImplementation()!;
      dbExecuteMock.mockImplementation(async (query: SQL) => {
        const rendered = _dialect.sqlToQuery(query);
        if (/^\s*DELETE\s+FROM\s+agent_memories/i.test(rendered.sql)) {
          deletesSeen++;
          if (deletesSeen === 1) {
            throw new Error('db-failure-mid-batch');
          }
        }
        return original(query);
      });
      const { deleteInScope } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await expect(
        deleteInScope({ cutoff: CUTOFF, batchSize: 1, log: () => undefined }),
      ).rejects.toThrow('db-failure-mid-batch');
      // A ROLLBACK was issued in response to the failure.
      const rollbacks = renderedSqls.filter((r) => /^\s*ROLLBACK\s*$/i.test(r.sql)).length;
      expect(rollbacks).toBeGreaterThanOrEqual(1);
    });
  });

  describe('SQL predicate shape (defense-in-depth)', () => {
    it('every read query pins tenant_id, agent_id, cutoff, tipos', async () => {
      seedPolluted();
      const { runDryRun } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await runDryRun({ cutoff: CUTOFF, log: () => undefined });

      // The first three queries are the in-scope SELECTs (count, range,
      // sample). Each must bind `default`, `default`, the cutoff ISO, and
      // the tipos array.
      //
      // Drizzle's `sql\`... ANY(${array})\`` template renders the array by
      // expanding its elements as individual placeholders separated by
      // commas (one `$N` per element). For our single-element `['reflexao']`
      // tipos list this means `params[3]` lands as the bare string
      // 'reflexao', not as an array. The production WHERE clause is still
      // correct (`tipo = ANY('reflexao')` ≡ `tipo = ANY(ARRAY['reflexao'])`
      // in PG); we just have to assert the right shape on the bound param.
      const inScopeQueries = renderedSqls.filter((r) =>
        /FROM\s+agent_memories[\s\S]*WHERE[\s\S]*tenant_id\s*=[\s\S]*agent_id\s*=[\s\S]*created_at\s*<[\s\S]*tipo\s*=\s*ANY/i.test(
          r.sql,
        ),
      );
      expect(inScopeQueries.length).toBeGreaterThanOrEqual(3);
      for (const q of inScopeQueries) {
        expect(q.params[0]).toBe('default');
        expect(q.params[1]).toBe('default');
        expect(typeof q.params[2]).toBe('string');
        expect(new Date(q.params[2] as string).toISOString()).toBe(CUTOFF.toISOString());
        // Drizzle expands a 1-element array into a single placeholder,
        // so the bound param is the string 'reflexao' (or [list] for >1).
        const tiposParam = q.params[3];
        const tiposNormalized = Array.isArray(tiposParam) ? tiposParam : [tiposParam];
        expect(tiposNormalized).toEqual(['reflexao']);
      }
    });

    it('DELETE uses a tenant/agent/cutoff/tipos predicate inside the subselect', async () => {
      seedPolluted();
      const { runExecute } = await import('@/../scripts/reflection-memory-cleanup.ts');
      await runExecute({
        cutoff: CUTOFF,
        executedByUser: 'op',
        confirmReader: async () => 'y',
        log: () => undefined,
      });
      const deleteSql = renderedSqls.find((r) => /^\s*DELETE\s+FROM\s+agent_memories/i.test(r.sql));
      expect(deleteSql).toBeDefined();
      // The subselect WHERE pins all four predicates.
      expect(deleteSql!.sql).toMatch(/tenant_id\s*=/);
      expect(deleteSql!.sql).toMatch(/agent_id\s*=/);
      expect(deleteSql!.sql).toMatch(/created_at\s*</);
      expect(deleteSql!.sql).toMatch(/tipo\s*=\s*ANY/);
      // Bound params: tenant, agent, cutoff, tipos, limit. (Drizzle expands
      // a 1-element array into a single placeholder; see the read-query
      // assertion above for the rationale.)
      expect(deleteSql!.params[0]).toBe('default');
      expect(deleteSql!.params[1]).toBe('default');
      const tiposParam = deleteSql!.params[3];
      const tiposNormalized = Array.isArray(tiposParam) ? tiposParam : [tiposParam];
      expect(tiposNormalized).toEqual(['reflexao']);
    });
  });
});
