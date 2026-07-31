/**
 * Shared vocabulary of the migration runner (issue #516).
 *
 * PURE module: types plus a handful of frozen constant tables. It imports
 * nothing, so `maia doctor` (#517), the Admin UI and the test suite can reason
 * about migration state without pulling in `pg`, the config loader or the
 * filesystem.
 */

/** Ledger row lifecycle. `dirty` is NEVER interpreted as success. */
export type LedgerStatus = 'running' | 'applied' | 'dirty' | 'failed';

/**
 * Where a stored checksum came from.
 *   - `runner`     — computed by this runner at the moment it applied the file.
 *   - `backfilled` — adopted from the packaged artifact for a row that predates
 *                    the v2 ledger. Trusted ONCE, at backfill time; every later
 *                    divergence is a blocker.
 *   - `repair`     — written by an explicit, audited `maia migrate repair`.
 */
export type ChecksumSource = 'runner' | 'backfilled' | 'repair';

/** One forward migration file, as shipped in the build artifact. */
export interface DiscoveredMigration {
  /** Ledger key: the exact forward filename. NEVER a number. */
  readonly id: string;
  /** Leading `^[0-9]+[a-z]?$` token, or `null` when the name is malformed. */
  readonly prefix: string | null;
  /** Absolute path on disk. Never logged (it is an internal path). */
  readonly path: string;
  /** `-- maia:no-transaction` opt-out of the BEGIN/COMMIT envelope. */
  readonly noTransaction: boolean;
  /** `-- maia:idempotent` — re-running after a crash is declared safe. */
  readonly idempotent: boolean;
  /** `-- maia:statement-timeout=<n>(ms|s|min)` override, in milliseconds. */
  readonly statementTimeoutMs: number | null;
  /** sha256 (hex) of the CANONICALISED bytes — see `discover.ts`. */
  readonly checksum: string;
  /** `<id>_down.sql` filename when the sibling exists, else `null`. */
  readonly downId: string | null;
}

/** A `schema_migrations` row, v2 shape (v1 columns are the first two). */
export interface LedgerRow {
  readonly id: string;
  readonly applied_at: Date | null;
  readonly checksum_sha256: string | null;
  readonly checksum_source: ChecksumSource | null;
  readonly status: LedgerStatus;
  readonly started_at: Date | null;
  readonly execution_ms: number | null;
  readonly app_version: string | null;
  readonly runner_version: string | null;
  readonly error_class: string | null;
}

/**
 * Machine-readable reasons a schema is not in the state the running code was
 * built for. These strings are a CONTRACT: `maia doctor` (#517), `/readyz` and
 * the runbook all switch on them, so they are additive-only.
 */
export type DriftCode =
  /** An applied migration's file no longer hashes to the recorded checksum. */
  | 'checksum_mismatch'
  /** An applied migration has no file in this build (renamed or deleted). */
  | 'missing_file'
  /** A forward file ships without its `_down.sql` sibling (AGENTS.md §4.6). */
  | 'missing_down_sibling'
  /** A pending file sorts BEFORE the applied head — concurrent branches. */
  | 'out_of_order'
  /** A no-transaction migration left partial, unverified state. */
  | 'dirty'
  /** A transactional migration failed; the domain change was rolled back. */
  | 'failed'
  /** A `running` row older than the staleness budget: crashed mid-flight. */
  | 'running_stale'
  /** Migrations exist on disk that the database has not applied. */
  | 'pending'
  /** Applied head is older than the oldest schema this build supports. */
  | 'below_min'
  /** Applied head is newer than the newest schema this build supports. */
  | 'above_max'
  /** Filename does not carry a conforming `^[0-9]+[a-z]?$` prefix. */
  | 'malformed_id';

export type DriftSeverity = 'error' | 'warn';

/**
 * One drift finding. `detail` is OUR literal text — never a driver message,
 * never a DSN, never an internal path (`/readyz` returns it verbatim).
 */
export interface Drift {
  readonly code: DriftCode;
  readonly severity: DriftSeverity;
  /** Migration id the finding is about, when it is about one. */
  readonly id: string | null;
  readonly detail: string;
}

/**
 * Drift codes that keep an instance OUT of the load-balancer rotation.
 *
 * `missing_down_sibling` is deliberately absent: it is a build-layout defect
 * caught by `maia migrate plan --strict` in CI, and draining a healthy fleet
 * over a missing rollback script would trade a review problem for an outage.
 */
export const BLOCKS_READINESS: ReadonlySet<DriftCode> = new Set<DriftCode>([
  'checksum_mismatch',
  'missing_file',
  'dirty',
  'failed',
  'running_stale',
  'pending',
  'below_min',
  'above_max',
]);

/**
 * Drift codes that stop `maia migrate up` BEFORE it runs any DDL.
 *
 * `pending` and `below_min` are absent because resolving them is precisely
 * what `up` exists to do. `out_of_order` is absent because two branches that
 * merged in a different order than they were authored is a normal, benign
 * outcome — it is reported, loudly, and then applied.
 */
export const BLOCKS_UP: ReadonlySet<DriftCode> = new Set<DriftCode>([
  'checksum_mismatch',
  'missing_file',
  'missing_down_sibling',
  'dirty',
  'failed',
  'running_stale',
  'malformed_id',
  'above_max',
]);

/** Aggregate counters — the numbers `maia doctor` and `/metrics` report. */
export interface SchemaCounters {
  readonly total_files: number;
  readonly applied_count: number;
  readonly pending_count: number;
  readonly dirty_count: number;
  readonly failed_count: number;
  readonly running_count: number;
  readonly mismatch_count: number;
  readonly backfilled_count: number;
}

/**
 * THE contract consumed by `/readyz`, `maia migrate status` and `maia doctor`
 * (#517). Everything in it is safe to return on a public probe.
 */
export interface SchemaCompatibility {
  /** `true` ⇔ no readiness-blocking drift. */
  readonly compatible: boolean;
  /** Newest forward file in the build artifact. */
  readonly expected_head: string | null;
  /** Newest successfully applied migration id. */
  readonly applied_head: string | null;
  /** Oldest / newest applied head this build tolerates (`null` = unbounded). */
  readonly min_supported: string | null;
  readonly max_supported: string | null;
  /** Forward files with no `applied` ledger row, in apply order. */
  readonly pending: readonly string[];
  readonly problems: readonly Drift[];
  readonly counters: SchemaCounters;
}

/** Outcome of one migration inside a run. */
export interface AppliedMigration {
  readonly id: string;
  /** First 12 hex chars — enough to correlate, short enough to read. */
  readonly checksum_short: string;
  readonly no_transaction: boolean;
  readonly duration_ms: number;
  readonly result: 'applied' | 'failed' | 'dirty';
  /** Error CLASS only (SQLSTATE or error name). Never a message. */
  readonly error_class?: string;
}

/** Typed outcome of `maia migrate up`. Never `process.exit` from the core. */
export type MigrateUpResult =
  | {
      readonly outcome: 'applied';
      readonly lock_wait_ms: number;
      readonly applied: readonly AppliedMigration[];
      readonly head: string | null;
    }
  | {
      readonly outcome: 'noop';
      readonly lock_wait_ms: number;
      readonly applied: readonly AppliedMigration[];
      readonly head: string | null;
    }
  | {
      /** Refused BEFORE any DDL — drift the operator has to resolve. */
      readonly outcome: 'blocked';
      readonly lock_wait_ms: number;
      readonly problems: readonly Drift[];
      readonly head: string | null;
    }
  | {
      /** A migration failed. Everything after it is deliberately not run. */
      readonly outcome: 'failed';
      readonly lock_wait_ms: number;
      readonly applied: readonly AppliedMigration[];
      readonly failed_id: string;
      readonly error_class: string;
      readonly dirty: boolean;
      readonly head: string | null;
    }
  | {
      /** Another migrator holds the lock and did not release it in time. */
      readonly outcome: 'lock_timeout';
      readonly lock_wait_ms: number;
    };

/** Runner identity written into every ledger row it touches. */
export const MIGRATION_RUNNER_VERSION = '2.0.0';

/** Version of the compatibility manifest shape (`manifest.ts`). */
export const SCHEMA_MANIFEST_VERSION = 1;
