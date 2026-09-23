import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
const d =
  process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL
    ? describe
    : describe.skip;
d('Hermes manifest migration — real PostgreSQL isolated schema', () => {
  it('up creates scoped immutable storage; empty down removes it', async () => {
    const client = new pg.Client({ connectionString: process.env.TEST_DB_URL });
    const schema = `manifest_test_${randomUUID().replaceAll('-', '')}`;
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema},public`);
      // Minimal parent key for a DDL test only, not a runtime acceptance fixture.
      await client.query(
        'CREATE TABLE engine_runs(tenant_id text,agent_id text,id uuid,PRIMARY KEY(tenant_id,agent_id,id))',
      );
      await client.query(readFileSync('migrations/149_hermes_runtime_manifests.sql', 'utf8'));
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name='hermes_runtime_manifests'`,
            [schema],
          )
        ).rows[0].n,
      ).toBe(1);
      await client.query(readFileSync('migrations/149_hermes_runtime_manifests_down.sql', 'utf8'));
      expect(
        (
          await client.query(
            `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name='hermes_runtime_manifests'`,
            [schema],
          )
        ).rows[0].n,
      ).toBe(0);
      await client.query(readFileSync('migrations/149_hermes_runtime_manifests.sql', 'utf8'));
      const run = randomUUID();
      await client.query(`INSERT INTO engine_runs VALUES('synthetic','synthetic',$1)`, [run]);
      await client.query(
        `INSERT INTO hermes_runtime_manifests(tenant_id,agent_id,run_id,digest,evidence_class,manifest_json) VALUES('synthetic','synthetic',$1,$2,'synthetic',$3)`,
        [
          run,
          'a'.repeat(64),
          JSON.stringify({ schema: 'maia-hermes-runtime-manifest/v1', run_id: run }),
        ],
      );
      await expect(
        client.query(readFileSync('migrations/149_hermes_runtime_manifests_down.sql', 'utf8')),
      ).rejects.toThrow('refusing to discard');
      await client.query('ROLLBACK');
      expect(
        (await client.query('SELECT count(*)::int AS n FROM hermes_runtime_manifests')).rows[0].n,
      ).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA ${schema} CASCADE`);
      await client.end();
    }
  });
});
