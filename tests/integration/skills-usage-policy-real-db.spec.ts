/**
 * Issue #409 — `skills.usage_policy` column (migration 077) + baseline backfill
 * on REAL Postgres.
 *
 * DoD: migration 077 adds the nullable `usage_policy` JSONB and backfills the 8
 * #410 baseline skills with the permissive-but-safe policy (usable by ANY
 * audience). Proves:
 *   1. the column exists and is nullable;
 *   2. each baseline skill has a usage_policy that admits every audience type,
 *      data_scope=['public_info'], exposure=public_safe, auth=known_external;
 *   3. the backfill is IDEMPOTENT (re-running 077 does not change a row);
 *   4. the parsed policy ADMITS a customer (proving the #410 baseline keeps
 *      working for external audiences — they are NOT hidden by the conservative
 *      NULL default because they carry an explicit policy).
 *
 * ---------------------------------------------------------------------------
 * RUNTIME REQUIREMENT — DOCKER DAEMON. Mirrors
 * `tests/integration/baseline-skills-seed-real-db.spec.ts`: gated behind a
 * Docker probe; SKIP_DOCKER_TESTS=1 forces skip; run via
 *   npm run test:integration:real-db
 * This suite did NOT run in the implementing environment (no Docker / Postgres);
 * it runs in CI's Docker-enabled lane.
 * ---------------------------------------------------------------------------
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  startPostgresContainer,
  stopPostgresContainer,
  isDockerAvailable,
  type StartedPostgres,
} from './_fixtures/postgres-testcontainer.js';
import {
  evaluateUsagePolicy,
  parseUsagePolicy,
  allowedDataScopesForAudience,
} from '@/skills/usage-policy.js';
import { AUDIENCE_TYPES } from '@/shared/audience.js';

type DbClientModule = typeof import('@/db/client.js');
let dbClientMod: DbClientModule;

let pg: StartedPostgres;
let previousDatabaseUrl: string | undefined;

const SHOULD_RUN = await isDockerAvailable();
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 'default';
const BASELINE_DESCRIPTORS = [
  'safe_conversation',
  'ask_clarification',
  'request_confirmation',
  'handoff_to_owner',
  'remember_safe_fact',
  'retrieve_context',
  'explain_limitation',
  'audit_decision',
] as const;

d('skills.usage_policy (migration 077) — real DB', () => {
  beforeAll(async () => {
    pg = await startPostgresContainer();
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = pg.uri;
    dbClientMod = await import('@/db/client.js');
  }, 120_000);

  afterAll(async () => {
    if (dbClientMod) await dbClientMod.shutdownDb().catch(() => undefined);
    if (pg) await stopPostgresContainer(pg);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('adds a nullable usage_policy JSONB column to skills', async () => {
    const { rows } = await pg.pool.query<{
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'skills' AND column_name = 'usage_policy'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe('jsonb');
    expect(rows[0]!.is_nullable).toBe('YES');
  });

  it('backfills every baseline skill with a permissive-but-safe usage_policy', async () => {
    const { rows } = await pg.pool.query<{
      skill_descriptor: string;
      usage_policy: Record<string, unknown> | null;
    }>(
      // Scope to the known baseline descriptors: issue #415 also seeds role
      // skills tenant-wide with proposed_by='system' (without a backfilled
      // usage_policy), so a bare proposed_by filter would now over-match.
      `SELECT skill_descriptor, usage_policy
         FROM skills
        WHERE tenant_id = $1 AND proposed_by = 'system'
          AND skill_descriptor = ANY($2)
        ORDER BY skill_descriptor`,
      [TENANT, [...BASELINE_DESCRIPTORS]],
    );
    expect(rows.map((r) => r.skill_descriptor).sort()).toEqual(
      [...BASELINE_DESCRIPTORS].sort(),
    );
    for (const r of rows) {
      const policy = parseUsagePolicy(r.usage_policy);
      expect(policy, `${r.skill_descriptor} must carry a usage_policy`).not.toBeNull();
      // Admits every audience type (except the non-policy `unknown` sentinel).
      const realAudiences = AUDIENCE_TYPES.filter((a) => a !== 'unknown');
      for (const a of realAudiences) {
        expect(
          policy!.allowed_audience.includes(a),
          `${r.skill_descriptor} should allow ${a}`,
        ).toBe(true);
      }
      expect(policy!.data_scope).toEqual(['public_info']);
      expect(policy!.exposure_policy).toBe('public_safe');
      expect(policy!.requires_auth_level).toBe('known_external');
      expect(policy!.requires_confirmation).toBe(false);
    }
  });

  it('a baseline skill policy ADMITS a customer (not hidden by the NULL default)', async () => {
    const { rows } = await pg.pool.query<{ usage_policy: Record<string, unknown> | null }>(
      `SELECT usage_policy FROM skills
        WHERE tenant_id = $1 AND skill_descriptor = 'safe_conversation'
        LIMIT 1`,
      [TENANT],
    );
    const policy = parseUsagePolicy(rows[0]!.usage_policy);
    expect(policy).not.toBeNull();
    const decision = evaluateUsagePolicy(policy!, {
      audience_type: 'customer',
      trust_level: 'known_external',
      channel_type: 'whatsapp',
      allowed_data_scope: allowedDataScopesForAudience('customer', 'known_external'),
    });
    expect(decision.allowed).toBe(true);
  });

  it('re-running migration 077 is IDEMPOTENT (does not change a backfilled row)', async () => {
    const before = await pg.pool.query<{ usage_policy: Record<string, unknown> | null }>(
      `SELECT usage_policy FROM skills
        WHERE tenant_id = $1 AND skill_descriptor = 'audit_decision' LIMIT 1`,
      [TENANT],
    );
    const sql = await readFile(
      new URL('../../migrations/077_skills_usage_policy.sql', import.meta.url),
      'utf8',
    );
    await pg.pool.query(sql);
    const after = await pg.pool.query<{ usage_policy: Record<string, unknown> | null }>(
      `SELECT usage_policy FROM skills
        WHERE tenant_id = $1 AND skill_descriptor = 'audit_decision' LIMIT 1`,
      [TENANT],
    );
    expect(after.rows[0]!.usage_policy).toEqual(before.rows[0]!.usage_policy);
  });
});
