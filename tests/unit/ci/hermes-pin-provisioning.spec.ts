import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  if?: string;
  'continue-on-error'?: boolean;
}
const root = resolve(__dirname, '../../..');
const workflow = parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, { steps: Step[] }>;
};

describe('[declaration] real Hermes pin in integration CI', () => {
  it('provisions Python and the pinned dependencies before the real integration suite', () => {
    const steps = workflow.jobs.integration!.steps;
    const bootstrap = steps.findIndex((step) => step.id === 'hermes-pin');
    const run = steps.findIndex((step) => step.run === 'npm run test:integration');
    expect(bootstrap, 'missing real pin bootstrap').toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeLessThan(run);
    expect(
      steps
        .slice(0, bootstrap)
        .some(
          (step) =>
            step.uses?.startsWith('actions/setup-python@') &&
            step.with?.['python-version'] === '3.12',
        ),
    ).toBe(true);
    expect(steps[bootstrap]?.run).toBe(
      'python scripts/ci/setup-hermes-pin.py "$RUNNER_TEMP/maia-hermes-pin"',
    );
    expect(steps[bootstrap]?.if).toBeUndefined();
    expect(steps[bootstrap]?.['continue-on-error']).toBeUndefined();
    expect(steps[run]?.env).toMatchObject({
      HERMES_PIN_PYTHON: '${{ steps.hermes-pin.outputs.python }}',
      HERMES_PIN_UPSTREAM: '${{ steps.hermes-pin.outputs.upstream }}',
      HERMES_PIN_SHA: '${{ steps.hermes-pin.outputs.sha }}',
    });
    expect(steps[run]?.env?.MAIA_HERMES_UPSTREAM).toBeUndefined();
    expect(steps[run]?.env?.MAIA_HERMES_WORKER_PYTHON).toBeUndefined();
    expect(
      steps.find((step) =>
        step.run?.includes('check-vitest-summary.ts .ci-test-summary/integration.txt'),
      )?.run,
    ).toContain('--min 1 --max-pulados 0');
  });

  it('keeps the documented engine pin and confines provisioning to the lane that needs it', () => {
    const pin = JSON.parse(
      readFileSync(resolve(root, 'scripts/ci/hermes-pin.json'), 'utf8'),
    ) as Record<string, string>;
    expect(pin).toEqual({
      repository: 'https://github.com/NousResearch/hermes-agent.git',
      sha: '5d59366010640c1d6b8f170d8a4ee109db2bbdef',
      python: '3.12',
      uv: '0.12.13',
    });
    expect(readFileSync(resolve(root, 'docs/dev-environment.md'), 'utf8')).toContain(pin.sha);
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (name !== 'integration') {
        expect(job.steps.some((step) => step.id === 'hermes-pin')).toBe(false);
      }
    }
  });
});
