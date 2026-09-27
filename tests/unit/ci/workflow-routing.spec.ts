/** Declaration tests: parse the real workflows; do not claim to execute Actions. */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const directory = resolve(__dirname, '../../../.github/workflows');
interface Workflow {
  on: Record<
    string,
    {
      branches?: string[];
      types?: string[];
      paths?: string[];
      'branches-ignore'?: string[];
      'paths-ignore'?: string[];
    }
  >;
  jobs: Record<string, { name: string; if?: string; 'continue-on-error'?: boolean }>;
}
const workflow = (file: string): Workflow =>
  parse(readFileSync(resolve(directory, file), 'utf8')) as Workflow;

describe('[declaration] CI routing for the integration base', () => {
  it('routes the reservation guard to both bases without broadening its path filter', () => {
    const guard = workflow('migration-prefix-guard.yml');
    expect(guard.on).toEqual({
      pull_request: {
        branches: ['main', 'claude/hermes-core-wiring'],
        paths: [
          'migrations/**',
          'scripts/check-migration-reservations.ts',
          'scripts/migrate-reserve.ts',
          '.github/workflows/migration-prefix-guard.yml',
        ],
      },
    });
    expect(Object.keys(guard.jobs)).toEqual(['reservations']);
    expect(guard.jobs.reservations?.name).toBe('reservation ledger guard');
    expect(guard.jobs.reservations?.if).toBeUndefined();
    expect(guard.jobs.reservations?.['continue-on-error']).toBeUndefined();
  });

  it('audits every workflow, not an empty or partial file list', () => {
    expect(
      readdirSync(directory)
        .filter((file) => /\.ya?ml$/.test(file))
        .sort(),
    ).toEqual(['ci.yml', 'migration-prefix-guard.yml']);
  });

  it('runs the complete CI for PRs to main and the exact integration base, on every path', () => {
    const events = workflow('ci.yml').on;
    expect(Object.keys(events).sort()).toEqual(['pull_request', 'push']);
    expect(events.pull_request).toEqual({
      branches: ['main', 'claude/hermes-core-wiring'],
      types: ['opened', 'synchronize', 'reopened', 'edited'],
    });
    // Push scope stays main-only: no duplicated runs on feature-branch pushes.
    expect(events.push).toEqual({ branches: ['main'] });
  });

  it('keeps every CI job name and does not condition or soften any job', () => {
    const jobs = workflow('ci.yml').jobs;
    expect(Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, job.name]))).toEqual({
      validate: 'typecheck + test + lint + build (node ${{ matrix.node }})',
      'secret-scan': 'gitleaks (secret scan)',
      'dependency-audit': 'npm audit (prod deps, both lockfiles)',
      integration: 'integration (node ${{ matrix.node }})',
      reliability: 'fault injection (#510)',
      'smoke-migrate-image': 'smoke do job migrate na imagem real',
      'alert-rules': 'regras de alerta (promtool)',
      'drizzle-kit-roundtrip': 'round-trip do drizzle-kit (generate + up + down)',
      'admin-ui': 'build + e2e do console (admin-ui)',
    });
    for (const job of Object.values(jobs)) {
      expect(job.if).toBeUndefined();
      expect(job['continue-on-error']).toBeUndefined();
    }
  });
});
