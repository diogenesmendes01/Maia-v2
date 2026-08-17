/**
 * Issue #516 — the one-shot `migrate` job in Compose, asserted against the
 * REAL files in the repository root.
 *
 * The rest of #516 made the schema *knowable*: checksums, dirty state, an
 * advisory lock and a read-only readiness verdict that `/readyz` consumes.
 * None of that puts a database at the head — it only refuses traffic while the
 * database is behind. The job is the piece that ADVANCES the schema, and the
 * `depends_on` edges are what make "app never runs against an old schema" a
 * property of the deployment instead of a step in an operator's memory.
 *
 * SCOPE OF THIS SPEC, stated honestly: it reads `docker-compose.yml` and
 * `compose.prod.yml` from disk and asserts the invariants that survive a
 * careless edit. It does NOT run Docker, so it proves the files SAY the right
 * thing — the runtime semantics of `service_completed_successfully` are
 * Docker's, exercised by hand (see the PR notes), not here.
 *
 * The one thing it must never become is a mirror: nothing below builds its own
 * YAML. Every assertion is about the bytes committed in the repo root.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { asMap, asString, interpolate, parseComposeFile, type ComposeNode } from './_compose-yaml.js';
import { loadServiceConfig } from '@/config/load.js';
import { CONTRACT_ENTRIES, entriesForService } from '@/config/contract.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const DEV = resolve(REPO_ROOT, 'docker-compose.yml');
const PROD = resolve(REPO_ROOT, 'compose.prod.yml');

const FILES: readonly { label: string; path: string }[] = [
  { label: 'docker-compose.yml', path: DEV },
  { label: 'compose.prod.yml', path: PROD },
];

/** The job's name is part of the contract: the runbooks and `depends_on` cite it. */
const JOB = 'migrate';
/** Services that must not start before the job has finished successfully. */
const GATED = ['app', 'admin-ui'] as const;

function servicesOf(path: string): Record<string, ComposeNode> {
  return asMap(parseComposeFile(path).services, `${path}: services`);
}

function service(path: string, name: string): Record<string, ComposeNode> {
  return asMap(servicesOf(path)[name], `${path}: services.${name}`);
}

describe.each(FILES)('$label — one-shot migrate job (#516)', ({ label, path }) => {
  it('declares a `migrate` service', () => {
    expect(Object.keys(servicesOf(path)), `${label} must declare a "${JOB}" service`).toContain(JOB);
  });

  it('the job runs the migration CLI — one shot, not a server', () => {
    const job = service(path, JOB);
    const command = job.command;
    expect(Array.isArray(command), `${label}: services.${JOB}.command must be an exec-form list`).toBe(true);
    // `db:migrate` is `tsx scripts/migrate.ts` with the default subcommand
    // `up` (package.json). Asserting the script name rather than the argv
    // keeps this from breaking when the CLI grows a flag.
    expect((command as string[]).join(' ')).toContain('db:migrate');
    // A job serves no traffic: publishing a port would mean it is expected to
    // stay up, which contradicts `service_completed_successfully`.
    expect(Object.keys(job), `${label}: the ${JOB} job must not publish ports`).not.toContain('ports');
  });

  it('the job has a restart policy that lets it COMPLETE', () => {
    const restart = asString(service(path, JOB).restart, `${label}: services.${JOB}.restart`);
    // The whole file otherwise uses `unless-stopped`; inheriting that here is
    // the easy mistake. A restarting container is restarted after exit 0, so
    // it never reaches "completed" and every gated service waits forever.
    expect(
      ['always', 'unless-stopped', 'on-failure'],
      `${label}: services.${JOB}.restart is "${restart}" — a one-shot job must not be restarted, or it never completes`,
    ).not.toContain(restart);
    expect(restart).toBe('no');
  });

  it('the job waits for Postgres to be healthy', () => {
    const dependsOn = asMap(service(path, JOB).depends_on, `${label}: services.${JOB}.depends_on`);
    expect(asString(asMap(dependsOn.postgres, 'depends_on.postgres').condition, 'condition')).toBe(
      'service_healthy',
    );
  });

  it.each(GATED)('%s does not start until the job completes successfully', (name) => {
    const dependsOn = asMap(service(path, name).depends_on, `${label}: services.${name}.depends_on`);
    expect(
      Object.keys(dependsOn),
      `${label}: services.${name} must depend on the "${JOB}" job`,
    ).toContain(JOB);
    const condition = asString(
      asMap(dependsOn[JOB], `${label}: services.${name}.depends_on.${JOB}`).condition,
      'condition',
    );
    expect(
      condition,
      `${label}: services.${name}.depends_on.${JOB}.condition must be ` +
        '"service_completed_successfully" — "service_started" would let it boot ' +
        'while the migration is still running, and even after it FAILED',
    ).toBe('service_completed_successfully');
  });

  it('the job is built from the same image contract as the app', () => {
    const job = asMap(service(path, JOB).build, `${label}: services.${JOB}.build`);
    const app = asMap(service(path, 'app').build, `${label}: services.app.build`);
    // Same context + Dockerfile ⇒ the migrator applies exactly the migrations
    // this build packages, which is the premise behind checksum drift and
    // `missing_file` in `src/migrations/status.ts`.
    expect(job).toEqual(app);
  });

  it('the job reaches the database through the same URL the app uses', () => {
    const jobEnv = asMap(service(path, JOB).environment, `${label}: services.${JOB}.environment`);
    const appEnv = asMap(service(path, 'app').environment, `${label}: services.app.environment`);
    const jobUrl = asString(jobEnv.DATABASE_URL, `${label}: services.${JOB}.environment.DATABASE_URL`);
    expect(
      jobUrl,
      `${label}: the ${JOB} job and the app must resolve the SAME DATABASE_URL — ` +
        'a job that migrates a different database gates nothing',
    ).toBe(asString(appEnv.DATABASE_URL, 'app DATABASE_URL'));
    expect(jobUrl).toContain('@postgres:5432/');
  });
});

describe('docker-compose.yml (dev) — the local flow keeps working', () => {
  it('postgres and redis do not depend on the job', () => {
    // `npm run test:integration:setup` is `docker compose up -d redis postgres`.
    // Naming services explicitly starts only them and their dependencies, so
    // the integration-test flow must never be able to drag the job in.
    for (const name of ['postgres', 'redis']) {
      const svc = service(DEV, name);
      expect(Object.keys(svc), `services.${name} must have no depends_on`).not.toContain('depends_on');
    }
  });

  it('the job does not pin NODE_ENV/MAIA_ENV apart — they are one decision', () => {
    const env = asMap(service(DEV, JOB).environment, 'dev: services.migrate.environment');
    const pinned = ['NODE_ENV', 'MAIA_ENV'].filter((k) => k in env);
    // `loadMigrationConfig()` resolves the profile from MAIA_ENV/NODE_ENV and
    // REJECTS a contradiction (`profile/node-env-conflict`,
    // src/config/profiles.ts). The dev compose injects the whole `.env`, whose
    // template sets MAIA_ENV=development — pinning only NODE_ENV=production
    // here (what the `app` service does) makes the job refuse to boot on every
    // .env derived from .env.example.
    expect(
      pinned.length === 0 || pinned.length === 2,
      `services.migrate pins ${pinned.join(' + ')} alone; set both or neither`,
    ).toBe(true);
  });
});

describe('compose.prod.yml — the job gets the migrator subset and nothing else (#515)', () => {
  /**
   * What `docker compose --env-file .env.infra` supplies for interpolation.
   * `MAIA_ENV` is in here because the compose file now REQUIRES it (`:?`) —
   * see the `MAIA_ENV` block below and `docs/runbooks/deploy-prod.md` §1.
   */
  const INFRA = {
    POSTGRES_USER: 'maia_prod',
    POSTGRES_PASSWORD: 'f4kepassw0rdf4ke',
    POSTGRES_DB: 'maia',
    REDIS_PASSWORD: 'f4keredispass',
    MAIA_ENV: 'production',
  } as const;

  function resolvedJobEnv(): Record<string, string> {
    const raw = asMap(service(PROD, JOB).environment, 'prod: services.migrate.environment');
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      out[key] = interpolate(asString(value, `environment.${key}`), INFRA);
    }
    return out;
  }

  it('carries no env_file — .env.app must never reach the migrator', () => {
    const job = service(PROD, JOB);
    expect(
      Object.keys(job),
      'the migrator must not receive .env.app: LLM keys, the WhatsApp session and the S3 ' +
        'credentials are exactly what a migration container has no business holding (#515)',
    ).not.toContain('env_file');
  });

  it('every contract variable it does receive is one the migrator may read', () => {
    const allowed = new Set(entriesForService('migrator').map((s) => s.name));
    const contractNames = new Set(CONTRACT_ENTRIES.map((s) => s.name));
    const leaked = Object.keys(resolvedJobEnv()).filter((k) => contractNames.has(k) && !allowed.has(k));
    expect(leaked, `variables outside the migrator subset: ${leaked.join(', ')}`).toEqual([]);
  });

  it('the injected environment actually satisfies the migrator contract', () => {
    // The executable half of the claim. `scripts/migrate.ts` starts with
    // `loadMigrationConfig()`, so a missing MAIA_ENV or POSTGRES_DB is not a
    // subtle degradation — the job exits non-zero at line one and, through
    // `service_completed_successfully`, holds the whole stack down.
    expect(() => loadServiceConfig('migrator', { env: resolvedJobEnv() })).not.toThrow();
  });

  it('MAIA_ENV is required, not defaulted — a staging that forgets it must abort', () => {
    // The whole point of the owner decision behind this assertion: `${MAIA_ENV:-production}`
    // does not fail when the variable is missing, it SUCCEEDS with the wrong
    // answer. A staging deploy whose `.env.infra` lacks the line silently gets
    // the production profile, and nothing in the logs says so. `${MAIA_ENV:?…}`
    // turns that into an abort before any container is created.
    const raw = asMap(service(PROD, JOB).environment, 'prod: services.migrate.environment');
    const declared = asString(raw.MAIA_ENV, 'MAIA_ENV');
    expect(
      declared,
      'services.migrate.environment.MAIA_ENV must use the required form `${MAIA_ENV:?…}` — ' +
        'a `:-` default makes a missing variable indistinguishable from an explicit choice',
    ).toMatch(/^\$\{MAIA_ENV:\?/);
    expect(() => interpolate(declared, {})).toThrow(/MAIA_ENV is required/);
    // And it still resolves to the operator's value when the value IS supplied —
    // a required variable that ignored `.env.infra` would be no better.
    expect(interpolate(declared, { MAIA_ENV: 'staging' })).toBe('staging');
  });

  it('an .env.infra without MAIA_ENV aborts the whole job env, not just that line', () => {
    // Reads the REAL file and drops exactly one key from the infra fixture.
    // The assertion is on the whole `environment:` block because that is what
    // `docker compose` interpolates as a unit: the run never starts.
    const { MAIA_ENV: _dropped, ...withoutMaiaEnv } = INFRA;
    const raw = asMap(service(PROD, JOB).environment, 'prod: services.migrate.environment');
    expect(() => {
      for (const [key, value] of Object.entries(raw)) {
        interpolate(asString(value, `environment.${key}`), withoutMaiaEnv);
      }
    }).toThrow(/MAIA_ENV is required/);
  });

  it('the required production credentials have no fallback', () => {
    const raw = asMap(service(PROD, JOB).environment, 'prod: services.migrate.environment');
    const url = asString(raw.DATABASE_URL, 'DATABASE_URL');
    // `${VAR:?}` aborts the compose run when the variable is absent; `${VAR:-maia}`
    // would silently migrate a database nobody meant to touch.
    expect(() => interpolate(url, {})).toThrow(/required/);
  });

  it('keeps the hardened posture of every other production service', () => {
    const job = service(PROD, JOB);
    expect(asString(job.user, 'user')).toBe('1001:1001');
    expect(asString(job.read_only, 'read_only')).toBe('true');
    expect(job.cap_drop).toEqual(['ALL']);
    expect(job.security_opt).toEqual(['no-new-privileges:true']);
    // Only the internal datastore network: the job has no reason to be
    // reachable from the reverse proxy.
    expect(job.networks, 'the migrate job must not join the `web` network').toEqual(['data']);
  });
});

/**
 * The smoke gate (`scripts/smoke-migrate-image.sh`) is the executable half of
 * everything above: it builds the REAL image and runs the REAL command in it,
 * as uid 1001, with a read-only rootfs, against an ephemeral database. A gate
 * that drifts from the file it claims to exercise gates nothing — so the
 * parameters it pins are asserted here against `compose.prod.yml` itself.
 * Both sides are read from disk; neither is reconstructed here.
 */
describe('scripts/smoke-migrate-image.sh — the gate exercises what compose.prod.yml declares', () => {
  const script = readFileSync(resolve(REPO_ROOT, 'scripts/smoke-migrate-image.sh'), 'utf8');
  const job = service(PROD, JOB);

  it('runs the same command the job runs', () => {
    const declared = (job.command as string[]).join(' ');
    const pinned = /^MIGRATE_COMMAND=\((.+)\)$/m.exec(script)?.[1];
    expect(pinned, 'the smoke script must declare MIGRATE_COMMAND=(...)').toBeDefined();
    expect(pinned, `the smoke runs "${pinned}" but compose.prod.yml runs "${declared}"`).toBe(declared);
  });

  it('runs under the same uid and the same read-only rootfs', () => {
    expect(script).toContain(`--user ${asString(job.user, 'user')}`);
    // `read_only: true` in the file ⇒ `--read-only` in the run. Dropping that
    // flag is exactly the edit that turns the smoke into decoration.
    expect(asString(job.read_only, 'read_only')).toBe('true');
    expect(script).toMatch(/^\s*--read-only$/m);
    // The job's only writable scratch is a tmpfs on /tmp — and `tsx` genuinely
    // needs it: it creates `/tmp/tsx-<uid>` before loading the first module.
    expect(job.tmpfs).toEqual(['/tmp']);
    expect(script).toMatch(/^\s*--tmpfs \/tmp$/m);
  });

  it('injects exactly the variables the job receives — no more, no fewer', () => {
    const declared = Object.keys(asMap(job.environment, 'prod: services.migrate.environment')).sort();
    // Scoped to the `migrator_env_flags()` body on purpose: the script also
    // passes `-e POSTGRES_*` to the EPHEMERAL Postgres container, and a regex
    // over the whole file happily counts those too — which is how the first
    // version of this assertion reported duplicates instead of drift.
    const body = /^migrator_env_flags\(\) \{$([\s\S]*?)^\}$/m.exec(script)?.[1];
    expect(body, 'the smoke script must declare a migrator_env_flags() function').toBeDefined();
    const injected = [...(body as string).matchAll(/^\s*-e "([A-Za-z_][A-Za-z0-9_]*)=/gm)]
      .map((m) => m[1] as string)
      .sort();
    expect(
      injected,
      'a variable added to the compose job but not to the smoke would never be exercised in the ' +
        'real image; one added only to the smoke would be exercising a fiction',
    ).toEqual(declared);
  });

  it('migrates against the same Postgres image production runs', () => {
    const image = asString(service(PROD, 'postgres').image, 'prod: services.postgres.image');
    expect(script).toContain(`POSTGRES_IMAGE="${image}"`);
  });
});
