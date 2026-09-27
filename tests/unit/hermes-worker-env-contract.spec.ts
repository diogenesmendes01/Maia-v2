import { expect, it } from 'vitest';
import { buildWorkerEnv } from '../../src/integrations/hermes/supervisor.js';

it('sets a supervisor-controlled NODE_ENV, never inherited from the host', () => {
  const env = buildWorkerEnv({
    platform_env: { NODE_ENV: 'development', DATABASE_URL: 'must-not-leak' },
    python_path: [],
    home: '/fixture/worker',
    hermes_sha: 'a'.repeat(40),
    inference_key: 'fixture-key',
  });
  expect(env.NODE_ENV).toBe('production');
  expect(env.DATABASE_URL).toBeUndefined();
});
