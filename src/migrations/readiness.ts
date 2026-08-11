/**
 * Issue #516 §6 — the READ-ONLY schema status / readiness API.
 *
 * This is the surface `maia doctor` (#517), `/readyz` and `migrate plan` /
 * `migrate status` consume. It is a real, importable API on purpose: a consumer
 * must never re-derive schema health by parsing runner logs, counting rows or
 * hashing files itself. Ask this module; it answers with a typed verdict plus
 * the evidence behind it.
 *
 * Guarantees:
 *
 *   - **Read-only.** No DDL, no ledger writes, no advisory lock, no checksum
 *     backfill. Safe to call from a load-balancer probe and safe to call while
 *     a migrator is running (a `running` row is reported as such and blocks,
 *     rather than being mistaken for crash debris — only the runner, which
 *     holds the lock, can make that call).
 *   - **Never throws.** Every failure — DB down, permission denied, ledger
 *     absent — becomes `state: 'unknown', ready: false`. A readiness gate that
 *     can throw is a readiness gate that some caller will `catch` into a
 *     warning.
 *   - **Fail-closed.** `ready === true` only when the schema was positively
 *     verified against the manifest.
 *   - **Leak-safe.** Blocker text carries migration ids, states and short
 *     checksums. Never SQL, never driver messages, never `DATABASE_URL`
 *     (pg error messages embed the DSN with its password).
 *   - **Closes what it opens.** The pooled client is released in `finally`.
 */
import { discoverMigrations } from './discover.js';
import { describeLedger, readLedger, type LedgerClient } from './ledger.js';
import {
  computeMigrationStatus,
  defaultCompatibilityManifest,
  evaluateSchemaReadiness,
  unknownReadiness,
} from './status.js';
import type {
  MigrationCompatibilityManifest,
  MigrationStatusReport,
  SchemaReadiness,
} from './types.js';

export interface ReadOnlyPoolClient extends LedgerClient {
  release(): void;
}

export interface ReadOnlyPool {
  connect(): Promise<ReadOnlyPoolClient>;
}

export interface SchemaInspectionDeps {
  readonly pool: ReadOnlyPool;
  readonly migrationsDir: string;
  /**
   * Compatibility range this build declares. Defaults to
   * `defaultCompatibilityManifest(artifact)` — "I require my own head, and I do
   * not cap how far ahead the database may be". Override for expand/contract
   * rollouts (lower `min_supported_migration`) or to refuse a newer schema
   * (set `max_supported_migration`).
   */
  readonly manifest?: MigrationCompatibilityManifest;
  readonly now?: () => Date;
}

/**
 * Full artifact-vs-database report. Read-only. Throws only if the migrations
 * directory itself cannot be read (a packaging bug, not a runtime condition) —
 * `getSchemaReadiness()` wraps even that.
 */
export async function getMigrationStatus(
  deps: SchemaInspectionDeps,
): Promise<MigrationStatusReport> {
  const artifact = await discoverMigrations(deps.migrationsDir);
  const client = await deps.pool.connect();
  try {
    const shape = await describeLedger(client);
    const ledger = await readLedger(client, shape);
    return computeMigrationStatus(artifact, ledger, {
      ledgerPresent: shape.present,
      ledgerVersion: shape.version,
      // Read-only callers do NOT hold the migration lock, so a `running` row
      // stays ambiguous (in-flight or crashed) and blocks either way.
      lockHeld: false,
    });
  } finally {
    client.release();
  }
}

/**
 * The readiness verdict. THE entry point for #517 and for any probe that must
 * decide "may this build serve traffic against this database?".
 *
 * Never throws. Never writes. Returns `state: 'unknown'` (and `ready: false`)
 * when the answer could not be established.
 */
export async function getSchemaReadiness(
  deps: SchemaInspectionDeps,
): Promise<SchemaReadiness> {
  const now = deps.now;
  let manifest = deps.manifest;
  try {
    const artifact = await discoverMigrations(deps.migrationsDir);
    manifest = manifest ?? defaultCompatibilityManifest(artifact);
    const client = await deps.pool.connect();
    try {
      const shape = await describeLedger(client);
      const ledger = await readLedger(client, shape);
      const status = computeMigrationStatus(artifact, ledger, {
        ledgerPresent: shape.present,
        ledgerVersion: shape.version,
        lockHeld: false,
      });
      return evaluateSchemaReadiness(status, manifest, now ? { now } : {});
    } finally {
      client.release();
    }
  } catch (err) {
    // CLASS only. A pg error message can contain the connection string.
    const cls =
      typeof (err as { code?: unknown } | null)?.code === 'string'
        ? String((err as { code: string }).code)
        : err instanceof Error
          ? err.constructor.name
          : 'UnknownError';
    return unknownReadiness(
      manifest ?? {
        schema_manifest_version: 1,
        expected_head: null,
        min_supported_migration: null,
        max_supported_migration: null,
      },
      `schema state could not be determined (${cls}) — failing closed`,
      now ? { now } : {},
    );
  }
}
