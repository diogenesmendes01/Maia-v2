/**
 * Issue #516 §2/§4/§6 — the decision core: artifact + ledger ⇒ status, and
 * status + manifest ⇒ readiness.
 *
 * Everything in this file is PURE. No `pg`, no filesystem, no clock beyond an
 * injected one. That is deliberate: these are the rules that decide whether
 * production traffic is allowed onto a schema, and they must be exercisable
 * exhaustively in unit tests rather than only against a live database.
 *
 * Fail-closed is the governing principle (AGENTS.md §4 rule 2). Every state
 * that is not "verified applied with a matching checksum" blocks. In
 * particular an UNKNOWN checksum blocks just as hard as a MISMATCHED one —
 * "we never recorded what this migration was" is not evidence of health.
 */
import { compareMigrationIds } from './discover.js';
import { shortChecksum } from './checksum.js';
import type {
  LedgerEntry,
  MigrationArtifact,
  MigrationCompatibilityManifest,
  MigrationEntryState,
  MigrationEntryStatus,
  MigrationStatusCounts,
  MigrationStatusReport,
  SchemaBlocker,
  SchemaReadiness,
} from './types.js';

export interface ComputeStatusOptions {
  /** `false` when `schema_migrations` does not exist / could not be read. */
  readonly ledgerPresent?: boolean;
  readonly ledgerVersion?: 1 | 2 | null;
  /**
   * `true` only when the caller holds the exclusive migration advisory lock.
   * It changes exactly one verdict: a `running` row becomes `orphaned_running`,
   * because under the lock no other migrator can exist, so the row is debris.
   * Read-only callers (status, doctor, readiness) MUST leave this false.
   */
  readonly lockHeld?: boolean;
}

/** States that make an entry block `up` and keep the schema out of readiness. */
const BLOCKING_STATES: ReadonlySet<MigrationEntryState> = new Set<MigrationEntryState>([
  'dirty',
  'running',
  'orphaned_running',
  'checksum_mismatch',
  'checksum_unknown',
  'missing_file',
]);

/**
 * States that mean "this migration is not in the database yet, and applying it
 * is safe to attempt". `failed` belongs here: a transactional migration that
 * rolled back left no partial change, so the correct response is to retry it,
 * not to demand a manual repair.
 */
const RETRYABLE_STATES: ReadonlySet<MigrationEntryState> = new Set<MigrationEntryState>([
  'pending',
  'failed',
]);

function classify(
  ledger: LedgerEntry | undefined,
  artifactChecksum: string | null,
  lockHeld: boolean,
): MigrationEntryState {
  if (artifactChecksum === null) return 'missing_file';
  if (!ledger) return 'pending';
  switch (ledger.status) {
    case 'running':
      return lockHeld ? 'orphaned_running' : 'running';
    case 'dirty':
      return 'dirty';
    case 'failed':
      return 'failed';
    case 'applied':
      if (ledger.checksum_sha256 === null) return 'checksum_unknown';
      return ledger.checksum_sha256 === artifactChecksum ? 'applied' : 'checksum_mismatch';
  }
}

/**
 * Merge the packaged artifact with the ledger rows into a full status report.
 *
 * Ids present only in the ledger are kept (as `missing_file`) — dropping them
 * would hide the single most dangerous shape there is: a database that ran a
 * migration this build has never heard of.
 */
export function computeMigrationStatus(
  artifact: MigrationArtifact,
  ledgerRows: readonly LedgerEntry[],
  options: ComputeStatusOptions = {},
): MigrationStatusReport {
  const ledgerPresent = options.ledgerPresent ?? true;
  const lockHeld = options.lockHeld ?? false;
  const byLedgerId = new Map(ledgerRows.map((r) => [r.id, r]));

  const ids = [...new Set([...artifact.migrations.map((m) => m.id), ...byLedgerId.keys()])].sort(
    compareMigrationIds,
  );

  const entries: MigrationEntryStatus[] = [];
  const pending: string[] = [];
  let appliedHead: string | null = null;

  for (const id of ids) {
    const file = artifact.byId.get(id);
    const row = byLedgerId.get(id);
    const state = classify(row, file?.checksum ?? null, lockHeld);
    entries.push({
      id,
      state,
      blocking: BLOCKING_STATES.has(state),
      checksum: file?.checksum ?? null,
      ledger_checksum: row?.checksum_sha256 ?? null,
      checksum_source: row?.checksum_source ?? null,
      no_transaction: file?.noTransaction ?? null,
      applied_at: row?.applied_at ?? null,
      execution_ms: row?.execution_ms ?? null,
      error_class: row?.error_class ?? null,
    });
    if (RETRYABLE_STATES.has(state)) pending.push(id);
    // The DB's notion of "already ran" is the ledger's own status, independent
    // of whether THIS build can still verify the file (checksum mismatch and
    // missing_file rows were applied too — that is precisely why they block).
    if (row?.status === 'applied' && (appliedHead === null || compareMigrationIds(id, appliedHead) > 0)) {
      appliedHead = id;
    }
  }

  const outOfOrder =
    appliedHead === null
      ? []
      : pending.filter((id) => compareMigrationIds(id, appliedHead!) < 0);

  const counts: MigrationStatusCounts = {
    total: entries.length,
    applied: entries.filter((e) => e.state === 'applied').length,
    pending: entries.filter((e) => e.state === 'pending').length,
    dirty: entries.filter((e) => e.state === 'dirty').length,
    failed: entries.filter((e) => e.state === 'failed').length,
    running: entries.filter((e) => e.state === 'running').length,
    orphaned_running: entries.filter((e) => e.state === 'orphaned_running').length,
    checksum_mismatch: entries.filter((e) => e.state === 'checksum_mismatch').length,
    checksum_unknown: entries.filter((e) => e.state === 'checksum_unknown').length,
    missing_file: entries.filter((e) => e.state === 'missing_file').length,
  };

  return {
    ledger_present: ledgerPresent,
    ledger_version: options.ledgerVersion ?? (ledgerPresent ? 2 : null),
    expected_head: artifact.head,
    applied_head: appliedHead,
    entries,
    pending,
    out_of_order: outOfOrder,
    counts,
    problems: artifact.problems,
  };
}

/**
 * The manifest a build declares by default: it requires its OWN head and
 * tolerates nothing below it, and does not cap how far ahead the database may
 * be. A release doing an expand/contract rollout overrides
 * `min_supported_migration` with the earlier id it tolerates; a release that
 * must refuse to run against a newer schema sets `max_supported_migration`.
 */
export function defaultCompatibilityManifest(
  artifact: MigrationArtifact,
): MigrationCompatibilityManifest {
  return {
    schema_manifest_version: 1,
    expected_head: artifact.head,
    min_supported_migration: artifact.head,
    max_supported_migration: null,
  };
}

function describeBlocker(entry: MigrationEntryStatus): SchemaBlocker | null {
  switch (entry.state) {
    case 'dirty':
      return {
        kind: 'dirty_migration',
        id: entry.id,
        detail: `migration "${entry.id}" is DIRTY: a no-transaction run failed midway, so the schema may be partially applied. It requires inspection and an explicit repair — it is never treated as success.`,
      };
    case 'running':
      return {
        kind: 'running_migration',
        id: entry.id,
        detail: `migration "${entry.id}" is marked RUNNING: either a migrator is applying it right now or one crashed. Unknowable from a read-only probe, so it blocks.`,
      };
    case 'orphaned_running':
      return {
        kind: 'orphaned_running',
        id: entry.id,
        detail: `migration "${entry.id}" is marked RUNNING while no migrator holds the lock — the debris of a crashed run. Treated as dirty.`,
      };
    case 'checksum_mismatch':
      return {
        kind: 'checksum_mismatch',
        id: entry.id,
        detail: `migration "${entry.id}" was applied with checksum ${shortChecksum(entry.ledger_checksum)} but the packaged file hashes to ${shortChecksum(entry.checksum)}. An applied migration was edited, or this build ships a different file.`,
      };
    case 'checksum_unknown':
      return {
        kind: 'checksum_unknown',
        id: entry.id,
        detail: `migration "${entry.id}" is applied with NO recorded checksum. Run \`migrate up\` (or \`migrate backfill\`) to adopt the packaged checksum; until then its content is unverifiable.`,
      };
    case 'missing_file':
      return {
        kind: 'missing_file',
        id: entry.id,
        detail: `the database applied "${entry.id}", which this build does not ship. The database is running a schema this release cannot verify.`,
      };
    default:
      return null;
  }
}

export interface ReadinessOptions {
  readonly now?: () => Date;
}

/**
 * Turn a status report plus a compatibility manifest into the readiness verdict
 * consumed by `/readyz` and by `maia doctor` (#517).
 *
 * Blocking rules, in evaluation order:
 *
 *   1. the ledger itself is absent or unreadable ⇒ `unknown` (never `ready`);
 *   2. any entry in a blocking state (dirty, running, orphaned, checksum
 *      mismatch/unknown, missing file);
 *   3. the schema is BELOW the minimum this build supports — i.e. some
 *      migration at or before `min_supported_migration` is not applied;
 *   4. the schema is ABOVE `max_supported_migration`, when the build declares
 *      a ceiling.
 *
 * Artifact integrity problems (a forward migration without its `_down`
 * sibling, a malformed prefix) are reported in `status.problems` and block
 * `migrate up`, but deliberately do NOT block readiness: they describe the
 * repository, not the compatibility of the schema already in the database.
 */
export function evaluateSchemaReadiness(
  status: MigrationStatusReport,
  manifest: MigrationCompatibilityManifest,
  options: ReadinessOptions = {},
): SchemaReadiness {
  const checkedAt = (options.now?.() ?? new Date()).toISOString();
  const base = {
    manifest,
    expected_head: status.expected_head,
    applied_head: status.applied_head,
    pending_count: status.counts.pending,
    dirty_count: status.counts.dirty + status.counts.orphaned_running,
    checked_at: checkedAt,
  };

  if (!status.ledger_present) {
    const blocker: SchemaBlocker = {
      kind: 'ledger_missing',
      detail:
        'schema_migrations is absent or unreadable — the applied schema is unknown. Failing closed: an empty or unmigrated database is indistinguishable from a healthy one from here.',
    };
    return {
      ready: false,
      state: 'unknown',
      reason: blocker.detail,
      blockers: [blocker],
      status,
      ...base,
    };
  }

  const blockers: SchemaBlocker[] = [];
  for (const entry of status.entries) {
    if (!entry.blocking) continue;
    const blocker = describeBlocker(entry);
    if (blocker) blockers.push(blocker);
  }

  const min = manifest.min_supported_migration;
  if (min !== null) {
    const required = status.entries.filter(
      (e) => compareMigrationIds(e.id, min) <= 0 && e.state !== 'missing_file',
    );
    const notApplied = required.filter((e) => RETRYABLE_STATES.has(e.state)).map((e) => e.id);
    if (notApplied.length > 0) {
      blockers.push({
        kind: 'schema_below_minimum',
        detail: `schema is below the minimum this build supports (${min}): ${notApplied.length} required migration(s) not applied, starting at "${notApplied[0]}". Run the migrator before serving traffic.`,
      });
    }
  }

  const max = manifest.max_supported_migration;
  if (max !== null) {
    const ahead = status.entries
      .filter((e) => compareMigrationIds(e.id, max) > 0)
      .filter((e) => e.state === 'applied' || e.state === 'missing_file' || e.state === 'checksum_mismatch')
      .map((e) => e.id);
    if (ahead.length > 0) {
      blockers.push({
        kind: 'schema_above_maximum',
        detail: `schema is ahead of the maximum this build supports (${max}): "${ahead[0]}" is already applied. A newer release has migrated this database; do not serve traffic from this build.`,
      });
    }
  }

  if (blockers.length > 0) {
    return {
      ready: false,
      state: 'blocked',
      reason: blockers[0]!.detail,
      blockers,
      status,
      ...base,
    };
  }

  return { ready: true, state: 'ready', reason: null, blockers: [], status, ...base };
}

/** Readiness verdict for the case where nothing at all could be read. */
export function unknownReadiness(
  manifest: MigrationCompatibilityManifest,
  detail: string,
  options: ReadinessOptions = {},
): SchemaReadiness {
  return {
    ready: false,
    state: 'unknown',
    reason: detail,
    blockers: [{ kind: 'ledger_unavailable', detail }],
    manifest,
    expected_head: manifest.expected_head,
    applied_head: null,
    pending_count: 0,
    dirty_count: 0,
    checked_at: (options.now?.() ?? new Date()).toISOString(),
    status: null,
  };
}
