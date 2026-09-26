import { createHash } from 'node:crypto';
import pg from 'pg';

/** One fixture instance owns only the database it successfully created. */
export class DisposableDatabase {
  readonly name: string;
  readonly url: string;
  private readonly maintenanceUrl: string;
  private readonly template: string;
  private ownedOid: number | undefined;

  constructor(
    baseUrl: string,
    context: string,
    env = process.env,
    prefix = 'card_fixture',
    name?: string,
  ) {
    if (!/^card_[a-z][a-z0-9_]{0,20}$/.test(prefix)) throw new Error('Invalid fixture prefix');
    this.name =
      name ?? `${prefix}_${createHash('sha256').update(context).digest('hex').slice(0, 32)}`;
    if (!/^card_[a-z0-9_]{1,58}$/.test(this.name)) throw new Error('Invalid fixture name');
    const url = new URL(baseUrl);
    url.pathname = `/${this.name}`;
    this.url = url.toString();
    const maintenance = env.TEST_PG_MAINTENANCE_DB ?? 'postgres';
    this.template = env.TEST_PG_TEMPLATE ?? 'template1';
    for (const identifier of [maintenance, this.template]) {
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier)) throw new Error('Invalid fixture identifier');
    }
    url.pathname = `/${maintenance}`;
    this.maintenanceUrl = url.toString();
  }

  async create(): Promise<void> {
    if (this.ownedOid !== undefined) throw new Error('Fixture already owns a database');
    const admin = new pg.Client({ connectionString: this.maintenanceUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${this.name}" TEMPLATE "${this.template}"`);
      // Register only after CREATE succeeds; a collision never grants ownership.
      const result = await admin.query<{ oid: number }>(
        'SELECT oid FROM pg_database WHERE datname = $1',
        [this.name],
      );
      if (!result.rows[0]) throw new Error('Cannot register fixture ownership');
      this.ownedOid = result.rows[0].oid;
    } finally {
      await admin.end();
    }
  }

  async cleanup(): Promise<void> {
    if (this.ownedOid === undefined) return;
    const admin = new pg.Client({ connectionString: this.maintenanceUrl });
    await admin.connect();
    try {
      const result = await admin.query<{ oid: number }>(
        'SELECT oid FROM pg_database WHERE datname = $1',
        [this.name],
      );
      if (result.rows[0]?.oid !== this.ownedOid)
        throw new Error('Fixture ownership changed; refusing cleanup');
      await admin.query(`DROP DATABASE "${this.name}"`);
      this.ownedOid = undefined;
    } finally {
      await admin.end();
    }
  }
}
