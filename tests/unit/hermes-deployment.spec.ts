import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateCrossFieldRules } from '@/config/rules.js';
import { ENV_CONTRACT } from '@/config/contract.js';
let runtime: typeof import('@/runtime/engines/hermes-runtime.js');
beforeAll(async () => {
  runtime = await import('@/runtime/engines/hermes-runtime.js');
});
describe('Hermes deployment disabled-safe', () => {
  it('refuses env-enabled boot until an attested deployment loader exists', () => {
    const findings = evaluateCrossFieldRules({
      values: { MAIA_HERMES_ENABLED: true },
      raw: {},
      profile: 'development',
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        scope: 'boot',
        severity: 'error',
        rule: 'hermes/deployment-unavailable',
      }),
    );
    expect(
      evaluateCrossFieldRules({
        values: { MAIA_HERMES_ENABLED: false },
        raw: {},
        profile: 'development',
      }).some((f) => f.rule === 'hermes/deployment-unavailable'),
    ).toBe(false);
  });
  it('defaults off and does not read deployment when disabled', async () => {
    const entry = ENV_CONTRACT.MAIA_HERMES_ENABLED;
    expect(entry).toBeDefined();
    expect(entry.schema.parse(undefined)).toBe(false);
    expect(entry.schema.safeParse('yes').success).toBe(false);
    expect(
      await runtime.createConfiguredHermesRuntime({
        enabled: false,
        get deployment() {
          throw new Error('must not read');
        },
      }),
    ).toBeNull();
  });
  it('refuses enabled without deployment before creating a supervisor', async () => {
    await expect(runtime.createConfiguredHermesRuntime({ enabled: true })).rejects.toThrow(
      'deployment_required',
    );
  });
});
