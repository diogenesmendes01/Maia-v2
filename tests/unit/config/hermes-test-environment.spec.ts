import { describe, expect, it } from 'vitest';
import { buildFixture } from '@/config/generate.js';
import { loadServiceConfig } from '@/config/load.js';

const pins = {
  MAIA_HERMES_UPSTREAM: '/opt/test/hermes-upstream',
  MAIA_HERMES_WORKER_PYTHON: '/opt/test/hermes-upstream/.venv/bin/python',
};

// These are local spike inputs, not permission to enable a production engine.
describe('Hermes spike environment composes with strict runtime boot', () => {
  it('accepts the two explicit pin paths without disabling strict validation', () => {
    expect(() =>
      loadServiceConfig('runtime', {
        env: { ...buildFixture('development'), ...pins },
      }),
    ).not.toThrow();
  });

  it.each(['MAIA_HERMES_UPSTREAM', 'MAIA_HERMES_WORKER_PYTHON'])('rejects a blank %s', (key) => {
    expect(() =>
      loadServiceConfig('runtime', {
        env: { ...buildFixture('development'), ...pins, [key]: '   ' },
      }),
    ).toThrow(new RegExp(key));
  });

  it('keeps both paths optional', () => {
    expect(() =>
      loadServiceConfig('runtime', {
        env: {
          ...buildFixture('development'),
          MAIA_HERMES_UPSTREAM: undefined,
          MAIA_HERMES_WORKER_PYTHON: undefined,
        },
      }),
    ).not.toThrow();
  });

  it.each(['MAIA_HERMES_UPSTREM', 'MAIA_HERMES_WORKER_PYTHON_EXTRA'])(
    'still rejects unknown key %s',
    (key) => {
      expect(() =>
        loadServiceConfig('runtime', {
          env: { ...buildFixture('development'), ...pins, [key]: '/untrusted' },
        }),
      ).toThrow(/contract\/unknown/);
    },
  );

  it('does not authorize enabling the runtime engine', () => {
    expect(() =>
      loadServiceConfig('runtime', {
        env: { ...buildFixture('development'), ...pins, MAIA_HERMES_ENABLED: 'true' },
      }),
    ).toThrow(/MAIA_HERMES_ENABLED/);
  });
});
