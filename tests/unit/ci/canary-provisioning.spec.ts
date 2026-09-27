import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  run?: string;
  shell?: string;
  if?: string;
  'continue-on-error'?: boolean;
}
const workflow = parse(
  readFileSync(resolve(__dirname, '../../../.github/workflows/ci.yml'), 'utf8'),
) as { jobs: Record<string, { steps: Step[] }> };
const name = "Reserve this ephemeral runner's canary Redis pair";

function reservationStep(): Step {
  const step = workflow.jobs.integration!.steps.find((candidate) => candidate.name === name);
  expect(step, 'missing mandatory canary reservation').toBeDefined();
  return step!;
}

describe('[declaration + shell boundary doubles] CI canary provisioning', () => {
  it('reserves after dependencies and before integration, without an optional bypass', () => {
    const step = reservationStep();
    const steps = workflow.jobs.integration!.steps;
    expect(steps.indexOf(step)).toBeGreaterThan(steps.findIndex((s) => s.run === 'npm ci'));
    expect(steps.indexOf(step)).toBeLessThan(
      steps.findIndex((s) => s.run === 'npm run test:integration'),
    );
    expect(step.shell).toBe('bash');
    expect(step.if).toBeUndefined();
    expect(step['continue-on-error']).toBeUndefined();
    for (const [job, value] of Object.entries(workflow.jobs)) {
      if (job !== 'integration') expect(value.steps.some((s) => s.name === name)).toBe(false);
    }
  });

  it.each([
    { setupExit: 0, readExit: 0, expectedExit: 0, published: true },
    { setupExit: 23, readExit: 0, expectedExit: 23, published: false },
    { setupExit: 0, readExit: 24, expectedExit: 24, published: false },
  ])('publishes only after successful privileged setup AND consumer readback: %j', (test) => {
    const step = reservationStep();
    const dir = mkdtempSync(join(tmpdir(), 'ci-canary-shell-'));
    try {
      // Exercise the committed shell, never sudo or create a real /run reservation here.
      writeFileSync(
        join(dir, 'sudo'),
        '#!/bin/bash\nprintf "%s\\n" "$@" > "$TRACE_SETUP"\nexit "$SETUP_EXIT"\n',
        { mode: 0o700 },
      );
      writeFileSync(
        join(dir, 'node'),
        '#!/bin/bash\nprintf "%s\\n" "$@" > "$TRACE_READ"\nexit "$READ_EXIT"\n',
        { mode: 0o700 },
      );
      const output = join(dir, 'github-env');
      writeFileSync(output, '');
      const context = {
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        RUNNER_ENVIRONMENT: 'github-hosted',
        GITHUB_REPOSITORY: 'diogenesmendes01/Maia-v2',
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_JOB: 'integration',
        GITHUB_WORKSPACE: '/home/runner/work/Maia-v2/Maia-v2',
      };
      const result = spawnSync('/bin/bash', ['-c', step.run!], {
        env: {
          ...context,
          PATH: `${dir}:/usr/bin:/bin`,
          GITHUB_ENV: output,
          SETUP_EXIT: String(test.setupExit),
          READ_EXIT: String(test.readExit),
          TRACE_SETUP: join(dir, 'setup'),
          TRACE_READ: join(dir, 'read'),
        },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(test.expectedExit);
      const setup = readFileSync(join(dir, 'setup'), 'utf8').trim().split('\n');
      expect(setup[0]).toBe('env');
      for (const [key, value] of Object.entries(context))
        expect(setup).toContain(`${key}=${value}`);
      expect(setup.slice(-3)).toEqual([
        join(dir, 'node'),
        'node_modules/tsx/dist/cli.mjs',
        'scripts/setup-ci-canary.ts',
      ]);
      if (test.setupExit === 0) {
        expect(readFileSync(join(dir, 'read'), 'utf8')).toContain('readCanaryRedisAllocation()');
      }
      expect(readFileSync(output, 'utf8')).toBe(
        test.published ? 'TEST_CANARY_REDIS_ALLOCATION=/run/maia-ci-canary/allocation.json\n' : '',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
