import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  queries: [] as string[],
  existing: false,
  oid: 42,
  urls: [] as string[],
}));
vi.mock('pg', () => ({
  default: {
    Client: class {
      constructor(options: { connectionString: string }) {
        boundary.urls.push(options.connectionString);
      }
      async connect() {}
      async end() {}
      async query(sql: string) {
        boundary.queries.push(sql);
        if (sql.startsWith('DROP')) boundary.existing = false;
        if (sql.startsWith('CREATE')) {
          if (boundary.existing)
            throw Object.assign(new Error('database already exists'), { code: '42P04' });
          boundary.existing = true;
        }
        return { rows: boundary.existing ? [{ oid: boundary.oid }] : [] };
      }
    },
  },
}));
import { DisposableDatabase } from '../../helpers/disposable-database.js';

beforeEach(() => {
  boundary.queries = [];
  boundary.urls = [];
  boundary.existing = false;
  boundary.oid = 42;
});
const base = 'postgres://fixture:fixture@127.0.0.1:5435/card_parent';

describe('disposable database ownership (SQL boundary double)', () => {
  it('does not drop a replacement database with the same name', async () => {
    const fixture = new DisposableDatabase(base, 'replaced');
    await fixture.create();
    boundary.oid = 99;
    await expect(fixture.cleanup()).rejects.toThrow('ownership');
    expect(boundary.existing).toBe(true);
    expect(boundary.queries.some((q) => q.startsWith('DROP'))).toBe(false);
  });

  it('uses bounded card names, dedicated maintenance/template and compatible defaults', async () => {
    const fixture = new DisposableDatabase(base, 'unique-context', {
      TEST_PG_MAINTENANCE_DB: 'maia_maintenance',
      TEST_PG_TEMPLATE: 'maia_template',
    });
    expect(fixture.name).toMatch(/^card_[a-z0-9_]{1,48}$/);
    expect(new DisposableDatabase(base, 'other-context').name).not.toBe(fixture.name);
    await fixture.create();
    await fixture.cleanup();
    await fixture.cleanup();
    expect(boundary.urls.every((u) => new URL(u).pathname === '/maia_maintenance')).toBe(true);
    expect(boundary.queries.filter((q) => q.startsWith('DROP'))).toHaveLength(1);
    expect(boundary.queries.join(';')).not.toContain('FORCE');
    expect(boundary.queries.join(';')).toContain('TEMPLATE "maia_template"');
    const legacy = new DisposableDatabase(base, 'legacy', {});
    await legacy.create();
    expect(new URL(boundary.urls.at(-1)!).pathname).toBe('/postgres');
    expect(boundary.queries.join(';')).toContain('TEMPLATE "template1"');
    await legacy.cleanup();
  });

  it('rejects unsafe template and maintenance identifiers before connecting', () => {
    expect(
      () =>
        new DisposableDatabase(base, 'unsafe', { TEST_PG_TEMPLATE: 'x"; DROP DATABASE other;--' }),
    ).toThrow('identifier');
    expect(
      () => new DisposableDatabase(base, 'unsafe', { TEST_PG_MAINTENANCE_DB: '../other' }),
    ).toThrow('identifier');
    expect(boundary.urls).toHaveLength(0);
  });

  it('refuses a preexisting foreign database without DROP or cleanup adoption', async () => {
    boundary.existing = true;
    const fixture = new DisposableDatabase(base, 'collision');
    await expect(fixture.create()).rejects.toMatchObject({ code: '42P04' });
    await fixture.cleanup();
    expect(boundary.existing).toBe(true);
    expect(boundary.queries.some((q) => q.startsWith('DROP'))).toBe(false);
  });
});
