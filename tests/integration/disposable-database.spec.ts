import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { DisposableDatabase } from '../helpers/disposable-database.js';

const d = process.env.TEST_DB_URL ? describe : describe.skip;

d('disposable database isolation (real PostgreSQL)', () => {
  it('isolates concurrent owners, refuses collision, preserves foreign data and cleans only owned DBs', async () => {
    const context = `${import.meta.url}:${process.pid}:${randomUUID()}`;
    const first = new DisposableDatabase(process.env.TEST_DB_URL!, context);
    const other = new DisposableDatabase(process.env.TEST_DB_URL!, `${context}:other`);
    const collision = new DisposableDatabase(process.env.TEST_DB_URL!, context);
    const client = new pg.Client({ connectionString: first.url });
    const catalog = new pg.Client({ connectionString: process.env.TEST_DB_URL });
    await catalog.connect();
    try {
      const before = await catalog.query('SELECT oid FROM pg_database WHERE datname = $1', [
        'maia_rollback_090_test',
      ]);
      await Promise.all([first.create(), other.create()]);
      expect(first.name).not.toBe(other.name);
      await client.connect();
      await client.query('CREATE TABLE sentinel (value text)');
      await client.query("INSERT INTO sentinel VALUES ('foreign-to-collision-fixture')");
      await expect(collision.create()).rejects.toMatchObject({ code: '42P04' });
      await collision.cleanup();
      expect((await client.query('SELECT value FROM sentinel')).rows).toEqual([
        { value: 'foreign-to-collision-fixture' },
      ]);
      await other.cleanup();
      expect(
        (
          await catalog.query('SELECT datname FROM pg_database WHERE datname = ANY($1)', [
            [first.name, other.name],
          ])
        ).rows,
      ).toEqual([{ datname: first.name }]);
      expect(
        (
          await catalog.query('SELECT oid FROM pg_database WHERE datname = $1', [
            'maia_rollback_090_test',
          ])
        ).rows,
      ).toEqual(before.rows);
    } finally {
      await client.end();
      await collision.cleanup();
      await first.cleanup();
      await other.cleanup();
      const remaining = await catalog.query(
        'SELECT datname FROM pg_database WHERE datname = ANY($1)',
        [[first.name, other.name]],
      );
      await catalog.end();
      expect(remaining.rows).toEqual([]);
    }
  });
});
