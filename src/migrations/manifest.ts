/**
 * Schema compatibility manifest (issue #516 §6).
 *
 * The manifest is the RELEASE's statement about the schema: which migrations
 * it carries, what each one hashes to, and the range of applied heads it is
 * willing to serve on. It is what `maia doctor` (#517) reads to answer "is
 * this binary allowed to talk to this database?" without a Postgres round-trip.
 *
 * DERIVED FROM THE PACKAGED ARTIFACT, NOT FROM A CHECKED-IN JSON FILE. The
 * Dockerfile already copies `migrations/` into the runtime image, so the files
 * themselves ARE the artifact — computing the manifest from them cannot drift
 * from what the runner will apply, whereas a generated JSON can (and the first
 * time it does, it does so silently, which is the failure mode this whole
 * issue exists to remove). `maia migrate manifest` emits the JSON for anyone
 * who needs it out of band (CI, a doctor running against a remote build).
 *
 * PURE apart from what the caller passes in.
 */
import { expectedHead } from './discover.js';
import { SCHEMA_MANIFEST_VERSION, type DiscoveredMigration } from './types.js';
import { MIGRATION_RUNNER_VERSION } from './types.js';

export interface ManifestEntry {
  readonly id: string;
  readonly checksum_sha256: string;
  readonly no_transaction: boolean;
  readonly idempotent: boolean;
  readonly down: string | null;
}

export interface SchemaManifest {
  readonly schema_manifest_version: number;
  readonly runner_version: string;
  readonly expected_head: string | null;
  readonly min_supported_migration: string | null;
  readonly max_supported_migration: string | null;
  readonly migration_count: number;
  readonly migrations: readonly ManifestEntry[];
}

export interface ManifestRange {
  readonly minSupported?: string | null;
  readonly maxSupported?: string | null;
}

/**
 * Build the manifest for a set of discovered migrations.
 *
 * `min_supported_migration` defaults to the expected head — i.e. "this build
 * needs its own newest migration applied". That is the fail-closed default;
 * an expand/contract rollout deliberately widens it via
 * `MIGRATION_MIN_SUPPORTED`.
 *
 * `max_supported_migration` defaults to `null` (unbounded), which keeps a code
 * rollback (database ahead of the binary) inside readiness. A release that
 * ships a destructive migration narrows it so the OLD version is blocked
 * instead of failing at its first query.
 */
export function buildSchemaManifest(
  migrations: readonly DiscoveredMigration[],
  range: ManifestRange = {},
): SchemaManifest {
  const head = expectedHead(migrations);
  return {
    schema_manifest_version: SCHEMA_MANIFEST_VERSION,
    runner_version: MIGRATION_RUNNER_VERSION,
    expected_head: head,
    min_supported_migration: range.minSupported ?? head,
    max_supported_migration: range.maxSupported ?? null,
    migration_count: migrations.length,
    migrations: migrations.map((m) => ({
      id: m.id,
      checksum_sha256: m.checksum,
      no_transaction: m.noTransaction,
      idempotent: m.idempotent,
      down: m.downId,
    })),
  };
}
