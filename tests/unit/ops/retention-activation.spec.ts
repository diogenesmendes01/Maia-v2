/**
 * Issue #536 — the activation gate.
 *
 * `resolveActivation` is the executable form of the #520 rollout: "dry-run →
 * comparar contagens → desligar dry-run por classe". Its contract is that
 * `enforce` requires FIVE independent conditions, so each case below satisfies
 * four and breaks one.
 */
import { describe, it, expect } from 'vitest';
import {
  ACTIVATION_WAVES,
  MIN_DRY_RUN_CYCLES,
  activationOrder,
  activationWaveOf,
  effectiveDryRun,
  resolveActivation,
} from '../../../src/ops/retention/activation.js';
import {
  DATA_CLASSES,
  UNAPPROVED_POLICY,
  parseRetentionPolicy,
} from '../../../src/ops/retention/data-classes.js';
import { PROPOSED_RETENTION_POLICY_JSON } from '../../../src/ops/retention/proposed-policy.js';

function policy(
  classes: Record<string, { days: number; armed?: boolean }>,
  approver = 'dpo@example',
) {
  return parseRetentionPolicy(
    JSON.stringify({
      version: 'v-test',
      approved_by: approver,
      approved_at: '2026-07-01T00:00:00.000Z',
      classes: Object.fromEntries(
        Object.entries(classes).map(([k, v]) => [
          k,
          { retention_days: v.days, dry_run: v.armed !== true },
        ]),
      ),
    }),
  );
}

/** Wave-1 class, armed, with the observation done. The only enforcing shape. */
function armed(classId = 'postgres.traces') {
  return {
    classId,
    policy: policy({ [classId]: { days: 30, armed: true } }),
    dryRunConfigured: false,
    cyclesByClass: { [classId]: MIN_DRY_RUN_CYCLES },
  };
}

describe('the wave order is the owner’s, and it is complete', () => {
  it('activates traces, export and artifacts first', () => {
    expect(ACTIVATION_WAVES[0]!.classes).toEqual([
      'postgres.traces',
      'privacy.export',
      'backup.artifact',
    ]);
  });

  it('puts conversation content, identity and audit LAST', () => {
    for (const id of ['postgres.messages', 'postgres.people', 'postgres.audit']) {
      expect(activationWaveOf(id)).toBe(3);
    }
  });

  it('lists no class twice', () => {
    const flat = activationOrder().map((e) => e.data_class);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('covers every PURGEABLE class — an omission would be a silent never-activate', () => {
    const ordered = new Set(activationOrder().map((e) => e.data_class));
    for (const c of DATA_CLASSES) {
      if (c.purge_mechanism === 'not_purgeable') continue;
      // `queue.redis` is deliberately out: ops owns its TTLs, no personal data.
      if (c.id === 'queue.redis') continue;
      expect(ordered, c.id).toContain(c.id);
    }
  });

  it('never places a non-purgeable class in the order', () => {
    const ordered = new Set(activationOrder().map((e) => e.data_class));
    for (const c of DATA_CLASSES.filter((k) => k.purge_mechanism === 'not_purgeable')) {
      expect(ordered, c.id).not.toContain(c.id);
    }
  });
});

describe('enforce requires ALL five conditions', () => {
  it('enforces when every condition holds', () => {
    const v = resolveActivation(armed());
    expect(v.mode).toBe('enforce');
    expect(v.reason).toBe('ok');
    expect(v.retention_days).toBe(30);
  });

  it('1. refuses while the global lever is on', () => {
    const v = resolveActivation({ ...armed(), dryRunConfigured: true });
    expect(v.mode).toBe('dry_run');
    expect(v.reason).toBe('dry_run_configured');
  });

  it('2. refuses a policy that is only PROPOSED', () => {
    const input = armed();
    const v = resolveActivation({
      ...input,
      policy: policy({ 'postgres.traces': { days: 30, armed: true } }, 'pending_dpo_homologation'),
    });
    expect(v.mode).toBe('dry_run');
    expect(v.reason).toBe('policy_not_homologated');
  });

  it('3. refuses a class the policy names but does not arm', () => {
    const v = resolveActivation({
      ...armed(),
      policy: policy({ 'postgres.traces': { days: 30 } }),
    });
    expect(v.reason).toBe('class_not_armed');
  });

  it('4. refuses a later wave while an earlier one is still unobserved', () => {
    const v = resolveActivation({
      classId: 'media.blobs',
      policy: policy({
        'postgres.traces': { days: 30, armed: true },
        'media.blobs': { days: 7, armed: true },
      }),
      dryRunConfigured: false,
      cyclesByClass: { 'media.blobs': 9 },
    });
    expect(v.reason).toBe('earlier_wave_not_observed');
    expect(v.blocking_class).toBe('postgres.traces');
  });

  it('4b. ignores an earlier-wave class the policy does not mention at all', () => {
    // The order constrains classes actually being rolled out, not every class
    // that could theoretically be.
    const v = resolveActivation({
      classId: 'media.blobs',
      policy: policy({ 'media.blobs': { days: 7, armed: true } }),
      dryRunConfigured: false,
      cyclesByClass: { 'media.blobs': MIN_DRY_RUN_CYCLES },
    });
    expect(v.mode).toBe('enforce');
  });

  it('5. refuses with fewer than two observed cycles', () => {
    for (const observed of [0, 1]) {
      const v = resolveActivation({
        ...armed(),
        cyclesByClass: { 'postgres.traces': observed },
      });
      expect(v.reason, `observed=${observed}`).toBe('insufficient_dry_run_cycles');
      expect(v.observed_cycles).toBe(observed);
      expect(v.required_cycles).toBe(2);
    }
  });
});

describe('structural refusals come first, so the operator is never told to do the useless', () => {
  it('reports class_not_purgeable ahead of anything else', () => {
    const v = resolveActivation({
      classId: 'privacy.tombstone',
      policy: policy({ 'postgres.traces': { days: 30, armed: true } }),
      dryRunConfigured: false,
      cyclesByClass: { 'privacy.tombstone': 99 },
    });
    expect(v.reason).toBe('class_not_purgeable');
  });

  it('reports policy_not_approved before asking for cycles', () => {
    const v = resolveActivation({
      classId: 'postgres.traces',
      policy: UNAPPROVED_POLICY,
      dryRunConfigured: false,
      cyclesByClass: { 'postgres.traces': 99 },
    });
    expect(v.reason).toBe('policy_not_approved');
  });

  it('reports class_not_in_policy for a class the DPO has not ruled on', () => {
    const v = resolveActivation({
      classId: 'postgres.traces',
      policy: policy({ 'media.blobs': { days: 7, armed: true } }),
      dryRunConfigured: false,
      cyclesByClass: { 'postgres.traces': 99 },
    });
    expect(v.reason).toBe('class_not_in_policy');
  });

  it('refuses a class that is not in the activation order at all', () => {
    const v = resolveActivation({
      classId: 'queue.redis',
      policy: policy({ 'queue.redis': { days: 1, armed: true } }),
      dryRunConfigured: false,
      cyclesByClass: { 'queue.redis': 99 },
    });
    expect(v.reason).toBe('class_not_in_activation_order');
  });

  it('throws on an unknown class instead of defaulting', () => {
    expect(() =>
      resolveActivation({
        classId: 'postgres.nope',
        policy: UNAPPROVED_POLICY,
        dryRunConfigured: true,
        cyclesByClass: {},
      }),
    ).toThrowError(/not in the inventory/);
  });
});

describe('fail-closed against garbage cycle counts', () => {
  it.each([-5, 0, Number.NaN, Number.POSITIVE_INFINITY])('treats %s as zero', (n) => {
    const v = resolveActivation({
      ...armed(),
      cyclesByClass: { 'postgres.traces': n as number },
    });
    expect(v.mode).toBe('dry_run');
    expect(v.observed_cycles).toBe(0);
  });

  it('treats a missing class as zero', () => {
    expect(resolveActivation({ ...armed(), cyclesByClass: {} }).reason).toBe(
      'insufficient_dry_run_cycles',
    );
  });
});

describe('the derivation clamp reaches the arming decision', () => {
  it('arms a derived class at the SOURCE period, never at the longer declared one', () => {
    const v = resolveActivation({
      classId: 'postgres.memory',
      policy: policy({
        'postgres.traces': { days: 30, armed: true },
        'postgres.messages': { days: 180, armed: true },
        'postgres.memory': { days: 3650, armed: true },
      }),
      dryRunConfigured: false,
      cyclesByClass: {
        'postgres.traces': MIN_DRY_RUN_CYCLES,
        'postgres.messages': MIN_DRY_RUN_CYCLES,
        'postgres.memory': MIN_DRY_RUN_CYCLES,
      },
    });
    expect(v.mode).toBe('enforce');
    // Not 3650: the clamp is on the path that decides, not a separate report.
    expect(v.retention_days).toBe(180);
  });
});

describe('effectiveDryRun defaults to true', () => {
  it('returns true for every class under the unapproved policy', () => {
    for (const c of DATA_CLASSES) {
      expect(
        effectiveDryRun({
          classId: c.id,
          policy: UNAPPROVED_POLICY,
          dryRunConfigured: false,
          cyclesByClass: {},
        }),
        c.id,
      ).toBe(true);
    }
  });

  it('returns true for every class under the SHIPPED proposal, even with cycles', () => {
    // The thing this whole issue promises: materialising the proposal arms
    // nothing. Every knob turned the wrong way and it still only counts.
    const proposal = parseRetentionPolicy(PROPOSED_RETENTION_POLICY_JSON);
    const cycles = Object.fromEntries(DATA_CLASSES.map((c) => [c.id, 99]));
    for (const c of DATA_CLASSES) {
      expect(
        effectiveDryRun({
          classId: c.id,
          policy: proposal,
          dryRunConfigured: false,
          cyclesByClass: cycles,
        }),
        c.id,
      ).toBe(true);
    }
  });
});
