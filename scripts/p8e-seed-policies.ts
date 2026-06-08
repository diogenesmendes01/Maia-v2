/**
 * P8e — programmatic seed script (dev/test alternative to SQL migration 037).
 *
 * Idempotent: each policy is created only when no active row with the same
 * descriptor exists. Calls repo.propose() + repo.activate() with a
 * STRUCTURED dual_approval_evidence (2 distinct synthetic approvers).
 *
 * Codex review #93 closed the previous loophole — the old shape
 * `{ script_bootstrap: true }` is REJECTED by repo.activate now
 * (invalid_dual_approval_evidence). Dev seeding uses synthetic principals
 * `seed_owner_bootstrap` + `seed_compliance_bootstrap`, with the executor
 * (`approved_by`) distinct (`p8e_seed_executor`). In prod the Admin UI
 * (P8.5) populates real principals from authenticated sessions.
 *
 * Usage:
 *   tsx scripts/p8e-seed-policies.ts
 *
 * In CI / prod, prefer the SQL migration (037). This script exists so
 * engineers can re-seed a dev DB without re-running migrations.
 */
import { runWithTenantContext, PRIMARY_CONTEXT } from '@/db/tenant-context.js';
import { policyRulesRepo } from '@/control-plane/policy/index.js';
import type {
  PolicyRuleBody,
  PolicyRuleKind,
  PolicyRuleScope,
  PolicySourceOfTruth,
} from '@/control-plane/policy/index.js';
import { logger } from '@/lib/logger.js';
import { shutdownDb } from '@/db/client.js';

interface SeedPolicy {
  rule_kind: PolicyRuleKind;
  rule_descriptor: string;
  rule_body: PolicyRuleBody;
  scope?: PolicyRuleScope;
  source_of_truth: PolicySourceOfTruth;
  proposed_reason: string;
}

const SEED_POLICIES: SeedPolicy[] = [
  {
    rule_kind: 'hard_limit',
    rule_descriptor: 'no_refund_without_validation',
    source_of_truth: 'founder_explicit',
    rule_body: {
      predicate: {
        all: [
          { field: 'intent.label', op: 'eq', value: 'refund' },
          { field: 'context.validation_status', op: 'neq', value: 'validated' },
        ],
      },
      effect: {
        action: 'block',
        severity: 'high',
        message_template:
          'Reembolso requer validação prévia. Solicite confirmação do supervisor.',
      },
      applies_to_peps: ['mid', 'late'],
    },
    proposed_reason: 'Founder rule: nunca processar refund sem validação humana',
  },
  {
    rule_kind: 'hard_limit',
    rule_descriptor: 'lgpd_strict_no_pii_in_logs',
    source_of_truth: 'legal_compliance',
    rule_body: {
      predicate: {
        any: [
          { field: 'output.contains_pii', op: 'eq', value: true },
          { field: 'tool_call.audit_level', op: 'eq', value: 'full_payload' },
        ],
      },
      effect: {
        action: 'block',
        severity: 'critical',
        message_template:
          'LGPD: dados pessoais não podem aparecer em logs/audit completo. Redacted obrigatório.',
      },
      applies_to_peps: ['late'],
    },
    proposed_reason: 'LGPD Art. 7º + 11 — base legal de tratamento exige minimização',
  },
  {
    rule_kind: 'hard_limit',
    rule_descriptor: 'no_action_outside_business_hours_high_risk',
    source_of_truth: 'founder_explicit',
    scope: { channel: 'whatsapp' },
    rule_body: {
      predicate: {
        all: [
          { field: 'risk_profile.level', op: 'in', value: ['high', 'critical'] },
          { field: 'context.is_business_hours', op: 'eq', value: false },
        ],
      },
      effect: {
        action: 'escalate',
        severity: 'high',
        message_template:
          'Ação de risco alto fora do horário comercial — escalar humano antes de executar.',
      },
      applies_to_peps: ['early', 'mid'],
    },
    proposed_reason:
      'Founder rule: zero ação irreversível fora de horário, em alto risco',
  },
  {
    rule_kind: 'lockdown_trigger',
    rule_descriptor: 'tenant_lockdown_blocks_all_writes',
    source_of_truth: 'founder_explicit',
    rule_body: {
      predicate: {
        all: [
          { field: 'tenant.lockdown_active', op: 'eq', value: true },
          {
            field: 'tool_call.side_effect_level',
            op: 'in',
            value: ['medium', 'high'],
          },
        ],
      },
      effect: {
        action: 'block',
        severity: 'critical',
        message_template:
          'Tenant em lockdown — escritas bloqueadas. Contate suporte.',
      },
      applies_to_peps: ['early'],
    },
    proposed_reason: 'Kill switch global por tenant — invariante de segurança',
  },
  {
    rule_kind: 'hard_limit',
    rule_descriptor: 'no_financial_advice_without_compliance_disclaimer',
    source_of_truth: 'legal_compliance',
    rule_body: {
      predicate: {
        all: [
          {
            field: 'intent.label',
            op: 'in',
            value: ['investment_advice', 'tax_advice'],
          },
          { field: 'output.contains_disclaimer', op: 'eq', value: false },
        ],
      },
      effect: {
        action: 'warn_in_trace',
        severity: 'medium',
        message_template:
          'Conselho financeiro requer disclaimer compliance. Anexar template antes de enviar.',
      },
      applies_to_peps: ['late'],
    },
    proposed_reason:
      'Compliance — orientação financeira sem disclaimer fere CVM/BACEN regs',
  },
];

async function seedDefaultPolicies(): Promise<{
  created: number;
  skipped: number;
}> {
  let created = 0;
  let skipped = 0;
  for (const policy of SEED_POLICIES) {
    const existing = await policyRulesRepo.findActiveByDescriptor({
      descriptor: policy.rule_descriptor,
      agent_id: null,
    });
    if (existing) {
      logger.info(
        { descriptor: policy.rule_descriptor, version: existing.version },
        'p8e_seed.already_active',
      );
      skipped++;
      continue;
    }
    const proposed = await policyRulesRepo.propose({
      agent_id: null,
      rule_kind: policy.rule_kind,
      rule_descriptor: policy.rule_descriptor,
      rule_body: policy.rule_body,
      scope: policy.scope,
      source_of_truth: policy.source_of_truth,
      proposed_by: 'p8e_seed_script',
      proposed_reason: policy.proposed_reason,
    });
    const now = new Date().toISOString();
    const result = await policyRulesRepo.activate({
      id: proposed.id,
      approved_by: 'p8e_seed_executor',
      dual_approval_evidence: {
        approvers: ['seed_owner_bootstrap', 'seed_compliance_bootstrap'],
        approved_at: [now, now],
        context: {
          source: 'p8e_seed_script',
          rationale:
            'Dev seed: 2 synthetic principals satisfy structured guard. Prod policies originate from Admin UI (P8.5).',
        },
      },
    });
    if (!result.ok) {
      logger.warn(
        { descriptor: policy.rule_descriptor, reason: result.reason },
        'p8e_seed.activate_failed',
      );
      continue;
    }
    created++;
    logger.info(
      {
        descriptor: policy.rule_descriptor,
        version: result.updated.version,
        id: result.updated.id,
      },
      'p8e_seed.activated',
    );
  }
  return { created, skipped };
}

async function main(): Promise<void> {
  await runWithTenantContext(
    PRIMARY_CONTEXT,
    async () => {
      const { created, skipped } = await seedDefaultPolicies();
      logger.info(
        { created, skipped, total: SEED_POLICIES.length },
        'p8e_seed.done',
      );
    },
  );
  await shutdownDb();
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, 'p8e_seed.failed');
  process.exit(1);
});
