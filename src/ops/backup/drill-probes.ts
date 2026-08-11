/**
 * Issue #536 §1 (continuação da #520 §7) — the sanity probes a restore drill
 * runs against the RESTORED snapshot.
 *
 * BASELINE GAP. `scripts/restore-test.ts` ran exactly one probe:
 * `SELECT count(*) FROM transacoes`. That answers "did `pg_restore` create a
 * table" and nothing else — a snapshot missing every tenant, with orphaned
 * messages, or restored from a schema older than the ledger would all pass it.
 * "Backup restaurável" stayed an assertion.
 *
 * DESIGN. Each probe is a (SQL, pure grader) pair:
 *
 *  - the SQL is a single-row query returning COUNTS and BOOLEANS only. Issue
 *    §7 is explicit — "guarda BOOLEANOS e CONTAGENS — nunca valores de linha".
 *    A drill runs against a full copy of every tenant's personal data; a probe
 *    that echoed a row value would copy that data into `restore_drills.probes`,
 *    which is itself inside the next dump;
 *  - the grader is PURE, so every verdict (including the adversarial ones: the
 *    query failed, the table is missing, the count is zero) is unit-testable
 *    with no Postgres anywhere.
 *
 * REQUIRED vs INFORMATIONAL. A failing REQUIRED probe fails the drill — an
 * unverifiable restore is not a good restore. Informational probes still get
 * recorded, because their NUMBER is the operator's input to runbook step 3.7
 * (what must be reconciled before traffic is released); they do not by
 * themselves prove the artifact unusable.
 */

/** Tables whose absence means the snapshot is not a Maia database. */
export const CRITICAL_TABLES: readonly string[] = Object.freeze([
  'tenants',
  'agents',
  'pessoas',
  'conversas',
  'mensagens',
  'transacoes',
  'audit_logs',
  'agent_turns',
  'data_tombstones',
  'backup_runs',
  'schema_migrations',
]);

export interface ProbeContext {
  /** Migration head the SIGNED manifest claims for this snapshot. */
  manifest_migration_head: string | null;
}

/** One row of scalars, exactly as the driver returns it. */
export type ProbeRow = Record<string, unknown>;

export interface ProbeVerdict {
  ok: boolean;
  /**
   * Counts, booleans and stable codes ONLY. Never a row value, never a path,
   * never an identifier belonging to a person.
   */
  detail: Record<string, number | string | boolean | null>;
}

export interface ProbeSpec {
  /** Stable id — safe as a metric label and as a JSON key in `probes`. */
  id: string;
  /** A failing required probe FAILS the drill. */
  required: boolean;
  /** Single-row query. Returns only counts/booleans/migration filenames. */
  sql: string;
  /** PURE grader. `row === null` means the query itself failed. */
  grade(row: ProbeRow | null, ctx: ProbeContext): ProbeVerdict;
}

/** Coerce a driver scalar to a number; `null` when it is not numeric. */
function num(row: ProbeRow, key: string): number | null {
  const raw = row[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  if (typeof raw === 'bigint') return Number(raw);
  return null;
}

/** The verdict for a probe whose query never returned. Always a failure. */
const QUERY_FAILED: ProbeVerdict = Object.freeze({
  ok: false,
  detail: Object.freeze({ error: 'query_failed' }),
}) as ProbeVerdict;

const tableList = CRITICAL_TABLES.map((t) => `'${t}'`).join(', ');

export const RESTORE_DRILL_PROBES: readonly ProbeSpec[] = Object.freeze([
  /**
   * The structural probe. `pg_restore` exiting 0 does not mean every object
   * landed — a partially-applied restore reports errors and still exits 0 with
   * `--exit-on-error` off, which is the default.
   */
  {
    id: 'core_tables_present',
    required: true,
    sql: `SELECT count(*)::int AS present
            FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name IN (${tableList})`,
    grade(row) {
      if (row === null) return QUERY_FAILED;
      const present = num(row, 'present');
      const expected = CRITICAL_TABLES.length;
      return {
        ok: present === expected,
        detail: { expected, present, missing: present === null ? expected : expected - present },
      };
    },
  },

  /**
   * A structurally perfect but EMPTY database restores without a single error.
   * The tenant/agent seed is the cheapest proof that data — not just schema —
   * came back.
   */
  {
    id: 'tenant_seed_present',
    required: true,
    sql: `SELECT (SELECT count(*) FROM tenants)::int AS tenants,
                 (SELECT count(*) FROM agents)::int  AS agents`,
    grade(row) {
      if (row === null) return QUERY_FAILED;
      const tenants = num(row, 'tenants');
      const agents = num(row, 'agents');
      return {
        ok: (tenants ?? 0) > 0 && (agents ?? 0) > 0,
        detail: { tenants, agents },
      };
    },
  },

  /**
   * Invariant 1 survives the restore. A snapshot carrying unscoped rows — or
   * the legacy `default` sentinel that migration 084 deleted — would reopen the
   * cross-tenant hole the moment traffic resumed.
   */
  {
    id: 'tenant_scope_valid',
    required: true,
    sql: `SELECT (SELECT count(*) FROM mensagens
                   WHERE tenant_id IS NULL OR btrim(tenant_id) = '' OR tenant_id = 'default')::int
                 AS unscoped_mensagens,
                 (SELECT count(*) FROM conversas
                   WHERE tenant_id IS NULL OR btrim(tenant_id) = '' OR tenant_id = 'default')::int
                 AS unscoped_conversas`,
    grade(row) {
      if (row === null) return QUERY_FAILED;
      const mensagens = num(row, 'unscoped_mensagens');
      const conversas = num(row, 'unscoped_conversas');
      return {
        ok: mensagens === 0 && conversas === 0,
        detail: { unscoped_mensagens: mensagens, unscoped_conversas: conversas },
      };
    },
  },

  /**
   * Referential integrity across the relation a restore is most likely to
   * tear: `pg_dump -Fc` is consistent by construction, but a partially-applied
   * `pg_restore` is not, and orphaned messages are invisible until a turn
   * tries to load its conversation.
   */
  {
    id: 'conversation_integrity',
    required: true,
    sql: `SELECT count(*)::int AS orphan_mensagens
            FROM mensagens m
            LEFT JOIN conversas c ON c.id = m.conversa_id
           WHERE m.conversa_id IS NOT NULL AND c.id IS NULL`,
    grade(row) {
      if (row === null) return QUERY_FAILED;
      const orphans = num(row, 'orphan_mensagens');
      return { ok: orphans === 0, detail: { orphan_mensagens: orphans } };
    },
  },

  /**
   * The anti-resurrection ledger has to survive the restore, or post-restore
   * reconciliation has nothing to replay and `planReconciliation` blocks the
   * release. Kept REQUIRED for exactly that reason.
   */
  {
    id: 'tombstone_ledger_restored',
    required: true,
    sql: `SELECT count(*)::int AS tombstones FROM data_tombstones`,
    grade(row) {
      if (row === null) return QUERY_FAILED;
      const tombstones = num(row, 'tombstones');
      return { ok: tombstones !== null, detail: { tombstones } };
    },
  },

  /**
   * The baseline's only probe, kept — now as one of many. Zero transactions is
   * legitimate on a fresh installation, so the bar is "the table is readable",
   * not "the table is populated".
   */
  {
    id: 'financial_rows_readable',
    required: true,
    sql: `SELECT count(*)::int AS transacoes FROM transacoes`,
    grade(row) {
      if (row === null) return QUERY_FAILED;
      const transacoes = num(row, 'transacoes');
      return { ok: transacoes !== null, detail: { transacoes } };
    },
  },

  {
    id: 'audit_trail_readable',
    required: true,
    sql: `SELECT count(*)::int AS audit_logs FROM audit_logs`,
    grade(row) {
      if (row === null) return QUERY_FAILED;
      const audit_logs = num(row, 'audit_logs');
      return { ok: audit_logs !== null, detail: { audit_logs } };
    },
  },

  /**
   * INFORMATIONAL, and load-bearing anyway. Restoring a snapshot whose outbox
   * still holds dispatchable rows re-sends side effects that already happened
   * (runbook §3.7). The drill cannot decide that for the operator — the count
   * is what they need before releasing traffic, so it is measured and recorded
   * rather than turned into a pass/fail nobody could act on.
   */
  {
    id: 'outbox_dispatchable',
    required: false,
    sql: `SELECT count(*)::int AS pending
            FROM idempotency_effect_outbox
           WHERE status = 'pending'`,
    grade(row) {
      if (row === null) return QUERY_FAILED;
      const pending = num(row, 'pending');
      return { ok: pending === 0, detail: { pending } };
    },
  },

  /**
   * INFORMATIONAL. A snapshot older than the current migration head is normal
   * and restorable — the operator runs `npm run db:migrate` afterwards
   * (runbook §3.5). What matters is that the DIVERGENCE is measured and
   * recorded, because a silent one is how a restore lands on a schema the
   * application cannot read.
   */
  {
    id: 'migration_head_matches',
    required: false,
    sql: `SELECT max(id) AS head, count(*)::int AS applied FROM schema_migrations`,
    grade(row, ctx) {
      if (row === null) return QUERY_FAILED;
      const head = typeof row.head === 'string' ? row.head : null;
      const applied = num(row, 'applied');
      const expected = ctx.manifest_migration_head;
      // No claim in the manifest ⇒ nothing to contradict. Reported, not graded.
      const matches = expected === null ? true : head === expected;
      return {
        ok: matches,
        detail: { snapshot_head: head, manifest_head: expected, applied, matches },
      };
    },
  },
]);

export interface ProbeSuiteResult {
  /** True only when every REQUIRED probe passed. */
  passed: boolean;
  /** Ids of required probes that failed — the drill's failure evidence. */
  failed_required: string[];
  /** Ids of informational probes that reported a non-clean result. */
  warned: string[];
  /** Persisted verbatim into `restore_drills.probes`. */
  probes: Record<string, ProbeVerdict>;
}

/**
 * Grade a full suite from the rows the executor collected.
 *
 * A probe MISSING from `rows` is treated exactly like a probe whose query
 * failed. That is deliberate: an executor that silently skipped a probe must
 * not produce a passing drill, and "absent" is the shape a skip takes.
 */
export function gradeProbeSuite(
  rows: Readonly<Record<string, ProbeRow | null>>,
  ctx: ProbeContext,
  specs: readonly ProbeSpec[] = RESTORE_DRILL_PROBES,
): ProbeSuiteResult {
  const probes: Record<string, ProbeVerdict> = {};
  const failed_required: string[] = [];
  const warned: string[] = [];

  for (const spec of specs) {
    const row = Object.hasOwn(rows, spec.id) ? rows[spec.id] : null;
    const verdict = spec.grade(row ?? null, ctx);
    probes[spec.id] = verdict;
    if (verdict.ok) continue;
    if (spec.required) failed_required.push(spec.id);
    else warned.push(spec.id);
  }

  return {
    passed: failed_required.length === 0,
    failed_required: failed_required.sort(),
    warned: warned.sort(),
    probes,
  };
}
