/**
 * Issue #536 §1 — the restore drill's PERSISTENCE layer against real Postgres.
 *
 * `tests/unit/ops/restore-drill.spec.ts` proves the lifecycle with fakes. What
 * only a database can prove is the part that decides WHICH artifact a drill
 * exercises, and whether the drill's own evidence survives the round trip:
 *
 *  1. an artifact with NO signed manifest is never a candidate (the inner
 *     join) — restoring an unidentifiable file would prove nothing;
 *  2. an off-site candidate must be `remote_verified`, which since manifest v2
 *     means a provider-computed checksum matched or the object was
 *     re-downloaded — never the uploader's own metadata stamp;
 *  3. a locally-verified-only run is a LOCAL candidate and never an off-site
 *     one, so a profile that requires off-site cannot be certified by the copy
 *     sitting on the host it is protecting against losing;
 *  4. selection is by RECENCY of the run, never by file mtime;
 *  5. a run already reaped by retention (`deleted`) is not a candidate;
 *  6. the drill row round-trips with its probe JSON, duration and
 *     `tombstones_pending`, which is what feeds the measured RTO;
 *  7. an EMPTY tombstone ledger reads back as `available: true` with zero rows
 *     — distinguishable from an unreadable one, which blocks a restore;
 *  8. the teardown verdict (`cleanup_status`, migration 112) survives the round
 *     trip on its OWN column, starts as `unknown` rather than `clean`, and is
 *     constrained by the database — so "which drills left a copy of production
 *     data on a host?" is one indexed predicate an operator can trust.
 *
 * Skipped without TEST_DB_URL (the unit-only lane passes without Postgres).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  readTombstoneLedger,
  restoreDrillStore,
  selectDrillCandidate,
} from '@/db/repositories/ops-repos.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

let pool: pg.Pool;

/** Namespaced so a parallel suite's rows can never be mistaken for ours. */
const CORR = 'ops536-drill';

async function insertRun(over: Record<string, unknown>): Promise<string> {
  const row: Record<string, unknown> = {
    correlation_id: CORR,
    state: 'completed',
    profile: 'production',
    outcome: 'completed',
    outcome_reason: 'verified',
    finished_at: new Date(),
    artifact_ref: `maia-${randomUUID().slice(0, 8)}.dump`,
    ...over,
  };
  const cols = Object.keys(row);
  const res = await pool.query<{ id: string }>(
    `INSERT INTO backup_runs (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     RETURNING id`,
    cols.map((c) => row[c]),
  );
  return res.rows[0]!.id;
}

async function insertManifest(runId: string): Promise<void> {
  await pool.query(
    `INSERT INTO backup_manifests
       (backup_run_id, manifest_version, manifest, manifest_sha256, signature, signature_key_version)
     VALUES ($1, 2, $2::jsonb, $3, $4, 1)`,
    [runId, JSON.stringify({ backup_id: runId, manifest_version: 2 }), 'a'.repeat(64), 'b'.repeat(64)],
  );
}

d('restore drill candidate selection (issue #536)', () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM restore_drills WHERE correlation_id = $1`, [CORR]);
    await pool.query(
      `DELETE FROM backup_manifests WHERE backup_run_id IN
         (SELECT id FROM backup_runs WHERE correlation_id = $1)`,
      [CORR],
    );
    await pool.query(`DELETE FROM backup_runs WHERE correlation_id = $1`, [CORR]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM restore_drills WHERE correlation_id = $1`, [CORR]);
    await pool.query(
      `DELETE FROM backup_manifests WHERE backup_run_id IN
         (SELECT id FROM backup_runs WHERE correlation_id = $1)`,
      [CORR],
    );
    await pool.query(`DELETE FROM backup_runs WHERE correlation_id = $1`, [CORR]);
  });

  it('returns null when nothing is verified', async () => {
    await insertRun({ local_verified: false, remote_verified: false });
    expect(await selectDrillCandidate('offsite')).toBeNull();
    expect(await selectDrillCandidate('local')).toBeNull();
  });

  it('never selects an artifact that has no signed manifest', async () => {
    // Verified bytes, but nothing identifies them. Same reasoning as the
    // retention planner refusing to delete an unidentifiable artifact.
    await insertRun({
      local_verified: true,
      remote_verified: true,
      destination_kind: 's3',
      remote_verified_at: new Date(),
    });
    expect(await selectDrillCandidate('offsite')).toBeNull();
    expect(await selectDrillCandidate('local')).toBeNull();
  });

  it('selects the newest REMOTELY-verified run for an off-site drill', async () => {
    const older = await insertRun({
      local_verified: true,
      remote_verified: true,
      destination_kind: 's3',
      finished_at: new Date(Date.now() - 86_400_000),
    });
    await insertManifest(older);
    const newer = await insertRun({
      local_verified: true,
      remote_verified: true,
      destination_kind: 's3',
      finished_at: new Date(),
    });
    await insertManifest(newer);

    const candidate = await selectDrillCandidate('offsite');
    expect(candidate?.backup_id).toBe(newer);
    expect(candidate?.source).toBe('offsite');
    // The envelope is reassembled for `verifyManifest`; the repository never
    // asserts a manifest is valid, it only hands over what was stored.
    expect(candidate?.signed_manifest).toMatchObject({ signature_alg: 'HMAC-SHA256' });
  });

  it('does NOT offer a locally-verified-only run as an off-site candidate', async () => {
    const localOnly = await insertRun({
      local_verified: true,
      remote_verified: false,
      destination_kind: 'local',
    });
    await insertManifest(localOnly);

    expect(await selectDrillCandidate('offsite')).toBeNull();
    expect((await selectDrillCandidate('local'))?.backup_id).toBe(localOnly);
  });

  it('does not offer a run whose artifact retention already reaped', async () => {
    const gone = await insertRun({
      state: 'deleted',
      local_verified: true,
      remote_verified: true,
      destination_kind: 's3',
    });
    await insertManifest(gone);
    expect(await selectDrillCandidate('offsite')).toBeNull();
  });

  it('accepts a DEGRADED run as a local candidate — degraded still has bytes', async () => {
    const degraded = await insertRun({
      state: 'completed_degraded',
      outcome: 'completed_degraded',
      outcome_reason: 'offsite_unverified',
      local_verified: true,
    });
    await insertManifest(degraded);
    expect((await selectDrillCandidate('local'))?.backup_id).toBe(degraded);
  });
});

d('restore drill evidence round-trip (issue #536)', () => {
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM restore_drills WHERE correlation_id = $1`, [CORR]);
    await pool.query(
      `DELETE FROM backup_manifests WHERE backup_run_id IN
         (SELECT id FROM backup_runs WHERE correlation_id = $1)`,
      [CORR],
    );
    await pool.query(`DELETE FROM backup_runs WHERE correlation_id = $1`, [CORR]);
    await pool.end();
  });

  it('persists probes, duration and tombstones_pending, and lands under `system`', async () => {
    const runId = await insertRun({ local_verified: true });
    await insertManifest(runId);
    const drillId = randomUUID();

    await restoreDrillStore.createDrill({
      id: drillId,
      correlation_id: CORR,
      backup_run_id: runId,
      source: 'offsite',
    });
    await restoreDrillStore.finishDrill(drillId, {
      status: 'passed',
      finished_at: new Date(),
      duration_ms: 12_345,
      probes: { core_tables_present: { ok: true, detail: { present: 11 } } },
      tombstones_pending: 3,
      failure_code: null,
    });

    const res = await pool.query<{
      tenant_id: string;
      agent_id: string;
      status: string;
      source: string;
      duration_ms: number;
      tombstones_pending: number;
      probes: Record<string, unknown>;
    }>('SELECT * FROM restore_drills WHERE id = $1', [drillId]);

    expect(res.rows[0]).toMatchObject({
      // Migration 101 CHECK: backup evidence is DB-wide, under the reserved
      // `system` sentinel — never the legacy `default` literal.
      tenant_id: 'system',
      agent_id: 'system',
      status: 'passed',
      source: 'offsite',
      duration_ms: 12_345,
      tombstones_pending: 3,
    });
    expect(res.rows[0]?.probes).toMatchObject({
      core_tables_present: { ok: true, detail: { present: 11 } },
    });
  });

  it('records a FAILED drill that never selected an artifact', async () => {
    const drillId = randomUUID();
    await restoreDrillStore.createDrill({
      id: drillId,
      correlation_id: CORR,
      backup_run_id: null,
      source: 'local',
    });
    await restoreDrillStore.finishDrill(drillId, {
      status: 'failed',
      finished_at: new Date(),
      duration_ms: 4,
      probes: {},
      tombstones_pending: null,
      failure_code: 'no_drill_candidate',
    });

    const res = await pool.query<{ backup_run_id: string | null; failure_code: string }>(
      'SELECT backup_run_id, failure_code FROM restore_drills WHERE id = $1',
      [drillId],
    );
    expect(res.rows[0]).toEqual({ backup_run_id: null, failure_code: 'no_drill_candidate' });
  });

  it('the database refuses an invented drill status', async () => {
    await expect(
      pool.query(
        `INSERT INTO restore_drills (correlation_id, status) VALUES ($1, 'green')`,
        [CORR],
      ),
    ).rejects.toThrow();
  });

  /**
   * Issue #536, review of PR #541. The teardown verdict is a SECOND axis, and
   * these three properties are what make it trustworthy in an incident.
   */
  it('starts at `unknown` — a drill that died mid-flight never reads as clean', async () => {
    const drillId = randomUUID();
    await restoreDrillStore.createDrill({
      id: drillId,
      correlation_id: CORR,
      backup_run_id: null,
      source: 'local',
    });

    const res = await pool.query<{ status: string; cleanup_status: string }>(
      'SELECT status, cleanup_status FROM restore_drills WHERE id = $1',
      [drillId],
    );
    // `unknown` is the honest state of a row nobody finished: residue possible,
    // nobody checked. Defaulting to `clean` would manufacture the very
    // certification this column exists to withhold.
    expect(res.rows[0]).toEqual({ status: 'running', cleanup_status: 'unknown' });
  });

  it('records a residue WITHOUT losing the restore-phase diagnosis', async () => {
    const drillId = randomUUID();
    await restoreDrillStore.createDrill({
      id: drillId,
      correlation_id: CORR,
      backup_run_id: null,
      source: 'offsite',
    });
    // A drill that failed its probes AND could not drop its database. One row
    // has to carry both, because the two ask for different remediations.
    await restoreDrillStore.finishDrill(drillId, {
      status: 'failed',
      finished_at: new Date(),
      duration_ms: 999,
      probes: {
        tenant_seed_present: { ok: false },
        cleanup: {
          ok: false,
          status: 'unsafe',
          residue: [{ kind: 'drill_database', reason: 'still_present' }],
        },
      },
      tombstones_pending: null,
      failure_code: 'probe_failed',
      cleanup_status: 'unsafe',
    });

    const res = await pool.query<{
      status: string;
      failure_code: string;
      cleanup_status: string;
      probes: Record<string, unknown>;
    }>('SELECT status, failure_code, cleanup_status, probes FROM restore_drills WHERE id = $1', [
      drillId,
    ]);
    expect(res.rows[0]).toMatchObject({
      status: 'failed',
      failure_code: 'probe_failed',
      cleanup_status: 'unsafe',
    });
    expect(res.rows[0]?.probes).toMatchObject({
      cleanup: { ok: false, residue: [{ kind: 'drill_database', reason: 'still_present' }] },
    });

    // The incident query: "which drills left a copy of production behind?" —
    // answered by the column, regardless of what `failure_code` says.
    const unsafe = await pool.query<{ id: string }>(
      `SELECT id FROM restore_drills WHERE cleanup_status = 'unsafe' AND correlation_id = $1`,
      [CORR],
    );
    expect(unsafe.rows.map((r) => r.id)).toContain(drillId);
  });

  it('the database refuses an invented cleanup_status', async () => {
    await expect(
      pool.query(
        `INSERT INTO restore_drills (correlation_id, cleanup_status) VALUES ($1, 'probably_fine')`,
        [CORR],
      ),
    ).rejects.toThrow();
  });
});

d('tombstone ledger read (issue #536)', () => {
  it('reports an EMPTY ledger as available — unreadable is a different thing', async () => {
    const ledger = await readTombstoneLedger();
    // The round-1 finding of #520, preserved: `available:false` blocks a
    // restore, an empty ledger does not.
    expect(ledger.available).toBe(true);
    expect(Array.isArray(ledger.tombstones)).toBe(true);
  });
});
