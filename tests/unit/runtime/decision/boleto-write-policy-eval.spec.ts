/**
 * Issue #437 — runtime evaluation of the boleto write/risk policies.
 *
 * Proves the END-TO-END decision path for the DSL bodies seeded by migration
 * 078 (`confirm_before_write_policy`, `human_confirmation_policy`) through the
 * production `PolicyEvaluator` adapter (P9d `evaluate` + the DE verdict mapping):
 *
 *   - the three sensitive writes (boleto_cancel / company_campaign_remove /
 *     refund_create) → `require_dual_approval` with `intent=confirm_before_write`;
 *   - a medium/high/critical risk turn → `require_dual_approval` with
 *     `intent=escalate_to_human`;
 *   - a non-write skill / low-risk turn → `allow` (the rule did not fire);
 *   - a MISSING context field → `allow` (not_applicable, fail-SAFE — a confirm
 *     policy keyed on an absent field never silently blocks, and never silently
 *     allows a write either: the write is still gated by C-009 + the dispatcher).
 *
 * The `policyEvaluator` is a pure function (wraps P9d `evaluate`), so only the DB
 * client import needs mocking to keep this a fast unit test.
 */
import { describe, it, expect } from 'vitest';

// prod-env.ts imports the db client at module load; stub it so the import is
// side-effect free (the policy evaluator itself touches no DB).
import { vi } from 'vitest';
vi.mock('@/db/client.js', async () => ({
  withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  db: {},
  pool: {},
  isDbConnected: () => true,
  probeDb: async () => true,
  shutdownDb: async () => {},
}));

import { createProductionDecisionEngineEnv } from '@/runtime/decision/prod-env.js';
import {
  RUNTIME_ENFORCED_WRITE_RISK_DESCRIPTORS,
  CONFIRM_BEFORE_WRITE_POLICY,
  HUMAN_CONFIRMATION_POLICY,
} from '@/control-plane/policy/boleto-write-policies.js';

// The exact DSL bodies migration 078 seeds (trimmed to the load-bearing fields:
// predicate + effect.action + effect.metadata.intent/severity). `getBody` in
// prod-env spreads the rule_body onto the returned object, so the evaluator sees
// `descriptor` + `predicate` + `effect` at the top level.
const confirmBeforeWriteBody = {
  descriptor: CONFIRM_BEFORE_WRITE_POLICY,
  rule_id: CONFIRM_BEFORE_WRITE_POLICY,
  predicate: {
    kind: 'or',
    predicates: [
      { kind: 'leaf', field: 'skill.selected.allowed_tools', op: 'contains', value: 'boleto_cancel' },
      { kind: 'leaf', field: 'skill.selected.allowed_tools', op: 'contains', value: 'company_campaign_remove' },
      { kind: 'leaf', field: 'skill.selected.allowed_tools', op: 'contains', value: 'refund_create' },
    ],
  },
  effect: {
    action: 'require_dual_approval',
    message: 'Operação sensível: requer confirmação explícita antes de executar.',
    metadata: { severity: 'high', intent: 'confirm_before_write' },
  },
};

const humanConfirmationBody = {
  descriptor: HUMAN_CONFIRMATION_POLICY,
  rule_id: HUMAN_CONFIRMATION_POLICY,
  predicate: { kind: 'leaf', field: 'risk.level', op: 'in', value: ['medium', 'high', 'critical'] },
  effect: {
    action: 'require_dual_approval',
    message: 'Caso requer confirmação/handoff humano antes de prosseguir.',
    metadata: { severity: 'high', intent: 'escalate_to_human' },
  },
};

describe('Issue #437 — boleto write/risk policy evaluation (prod evaluator adapter)', () => {
  const env = createProductionDecisionEngineEnv();
  const evaluator = env.policyEvaluator;

  it('curated descriptor set is exactly the two ACTIVE DSL descriptors', () => {
    expect([...RUNTIME_ENFORCED_WRITE_RISK_DESCRIPTORS]).toEqual([
      CONFIRM_BEFORE_WRITE_POLICY,
      HUMAN_CONFIRMATION_POLICY,
    ]);
    // small_risk_write_policy (proposed/inactive) must NOT be in the runtime set.
    expect(RUNTIME_ENFORCED_WRITE_RISK_DESCRIPTORS as readonly string[]).not.toContain(
      'small_risk_write_policy',
    );
  });

  it.each(['boleto_cancel', 'company_campaign_remove', 'refund_create'])(
    'confirm_before_write_policy → require_dual_approval (intent=confirm_before_write) when the skill exposes %s',
    async (writeTool) => {
      const verdict = await evaluator.evaluate(confirmBeforeWriteBody, {
        skill: { selected: { allowed_tools: [writeTool, 'company_search'] } },
        risk: { level: 'low' },
      });
      expect(verdict.action).toBe('require_dual_approval');
      expect(verdict.parameters?.['intent']).toBe('confirm_before_write');
      expect(verdict.severity).toBe('high');
    },
  );

  it('confirm_before_write_policy → allow when the skill exposes only read tools', async () => {
    const verdict = await evaluator.evaluate(confirmBeforeWriteBody, {
      skill: { selected: { allowed_tools: ['company_search', 'boleto_search'] } },
      risk: { level: 'low' },
    });
    expect(verdict.action).toBe('allow');
  });

  it('confirm_before_write_policy → allow (not_applicable, fail-safe) when skill context is MISSING', async () => {
    const verdict = await evaluator.evaluate(confirmBeforeWriteBody, {
      // no `skill` key at all — the `contains` op short-circuits to not_applicable
      risk: { level: 'low' },
    });
    expect(verdict.action).toBe('allow');
  });

  it.each(['medium', 'high', 'critical'])(
    'human_confirmation_policy → require_dual_approval (intent=escalate_to_human) at risk.level=%s',
    async (level) => {
      const verdict = await evaluator.evaluate(humanConfirmationBody, {
        skill: { selected: { allowed_tools: [] } },
        risk: { level },
      });
      expect(verdict.action).toBe('require_dual_approval');
      expect(verdict.parameters?.['intent']).toBe('escalate_to_human');
    },
  );

  it('human_confirmation_policy → allow at risk.level=low', async () => {
    const verdict = await evaluator.evaluate(humanConfirmationBody, {
      skill: { selected: { allowed_tools: [] } },
      risk: { level: 'low' },
    });
    expect(verdict.action).toBe('allow');
  });

  it('fail-closed: a malformed (non-DSL) body → block, never allow', async () => {
    // migration 037 legacy shape ({all:[...]} with no `kind`) — must NOT slip
    // through as allow. The evaluator returns evaluation_error → adapter blocks.
    const legacyBody = {
      descriptor: 'legacy_no_refund',
      predicate: { all: [{ field: 'intent.label', op: 'eq', value: 'refund' }] },
      effect: { action: 'block' },
    };
    const verdict = await evaluator.evaluate(legacyBody, { intent: { label: 'refund' } });
    expect(verdict.action).toBe('block');
  });
});
