import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { hermesSupervisorConfigV1Schema } from '@/integrations/hermes/supervisor.js';

// Exercise the actual integration constructors without opening DB/Redis or a worker.
// TypeScript's `!` does not turn a missing runner variable into a string.
const fixtures = [
  'hermes-core-admission-real-db.spec.ts',
  'hermes-core-recovery-real-db.spec.ts',
  'hermes-launch-context-real-db.spec.ts',
];

describe.each(fixtures)('%s supervisor configuration', (fixture) => {
  it.each([undefined, '/runner/temp'])('accepts runner TMPDIR=%s', (temp) => {
    const source = readFileSync(resolve('tests/integration', fixture), 'utf8');
    const expression = source.match(/const supervisorConfig = (\{[\s\S]*?\n {6}\});/);
    expect(expression).not.toBeNull();
    const compiled = ts.transpile(`const config = ${expression![1]};`, {
      target: ts.ScriptTarget.ES2022,
    });
    const env = {
      HERMES_PIN_PYTHON: '/pin/.venv/bin/python',
      HERMES_PIN_UPSTREAM: '/pin/upstream',
      HERMES_PIN_SHA: '5d59366010640c1d6b8f170d8a4ee109db2bbdef',
      PATH: '/usr/bin:/bin',
      ...(temp === undefined ? {} : { TMPDIR: temp }),
    };
    const config = new Function(
      'process',
      'resolve',
      'home',
      'tmpdir',
      `${compiled}\nreturn config;`,
    )({ env }, resolve, '/runner/synthetic-home', () => temp ?? tmpdir());
    const parsed = hermesSupervisorConfigV1Schema.safeParse(config);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    expect(config.platform_env).toEqual({ PATH: env.PATH, TMPDIR: temp ?? tmpdir() });
    // Keep the production contract strict; the fixture, not the schema, supplies a string.
    expect(
      hermesSupervisorConfigV1Schema.safeParse({
        ...config,
        platform_env: { ...config.platform_env, TMPDIR: undefined },
      }).success,
    ).toBe(false);
  });
});
