/**
 * Issue #409 — DB-free proof of the SkillUsagePolicy CONTRACT + the pure
 * admission PREDICATE. This is the canonical unit test for the governance logic
 * the two enforcement points (SkillSelector candidate filter, SkillRunner gate
 * 4.6) both call. No DB / no Redis — runs on every CI lane.
 *
 * Covers the issue's acceptance criteria at the predicate level:
 *   - daily_business_summary allowed for owner/manager, blocked for customer;
 *   - a customer skill limited to own_customer_data_only;
 *   - unknown / unauthorized-channel / insufficient-auth / risk-ceiling blocks;
 *   - the no-policy conservative default + the audience→data-scope table.
 */
import { describe, it, expect } from 'vitest';
import {
  SkillUsagePolicySchema,
  evaluateUsagePolicy,
  parseUsagePolicy,
  safeParseUsagePolicy,
  resolveEffectiveUsagePolicy,
  allowedDataScopesForAudience,
  CONSERVATIVE_DEFAULT_USAGE_POLICY,
  type SkillUsagePolicy,
  type UsagePolicyEvalContext,
} from '@/skills/usage-policy.js';

// The two canonical policies from the issue body.
const DAILY_BUSINESS_SUMMARY: SkillUsagePolicy = {
  allowed_audience: ['owner', 'manager'],
  blocked_audience: ['customer', 'lead', 'vendor'],
  data_scope: ['financial_summary', 'operations_summary'],
  exposure_policy: 'internal_only',
  requires_auth_level: 'trusted_internal',
  requires_confirmation: false,
};

const CUSTOMER_SKILL: SkillUsagePolicy = {
  allowed_audience: ['customer'],
  data_scope: ['own_customer_data_only'],
  exposure_policy: 'subject_only',
  requires_auth_level: 'known_external',
  requires_confirmation: false,
};

function ctx(over: Partial<UsagePolicyEvalContext>): UsagePolicyEvalContext {
  return {
    audience_type: 'owner',
    trust_level: 'trusted_internal',
    channel_type: 'whatsapp',
    ...over,
  };
}

describe('SkillUsagePolicySchema (Zod contract)', () => {
  it('accepts a well-formed policy', () => {
    expect(() => SkillUsagePolicySchema.parse(DAILY_BUSINESS_SUMMARY)).not.toThrow();
  });

  it('rejects an empty allowed_audience (≥1 required)', () => {
    expect(
      SkillUsagePolicySchema.safeParse({ ...DAILY_BUSINESS_SUMMARY, allowed_audience: [] }).success,
    ).toBe(false);
  });

  it('rejects an unknown audience literal (drift guard)', () => {
    expect(
      SkillUsagePolicySchema.safeParse({
        ...DAILY_BUSINESS_SUMMARY,
        allowed_audience: ['supervisor'],
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown data_scope literal', () => {
    expect(
      SkillUsagePolicySchema.safeParse({ ...CUSTOMER_SKILL, data_scope: ['secret_sauce'] }).success,
    ).toBe(false);
  });

  it('is .strict() — rejects an unknown key (malformed not silently waved through)', () => {
    expect(
      SkillUsagePolicySchema.safeParse({ ...CUSTOMER_SKILL, surprise: true }).success,
    ).toBe(false);
  });

  it('parseUsagePolicy returns null for NULL and {} (treated as absent)', () => {
    expect(parseUsagePolicy(null)).toBeNull();
    expect(parseUsagePolicy(undefined)).toBeNull();
    expect(parseUsagePolicy({})).toBeNull();
  });

  it('safeParseUsagePolicy reports a malformed policy as { ok: false }', () => {
    const r = safeParseUsagePolicy({ allowed_audience: [] });
    expect(r.ok).toBe(false);
  });
});

describe('evaluateUsagePolicy — daily_business_summary (issue acceptance criteria)', () => {
  it('ALLOWS owner', () => {
    const d = evaluateUsagePolicy(
      DAILY_BUSINESS_SUMMARY,
      ctx({
        audience_type: 'owner',
        trust_level: 'trusted_internal',
        allowed_data_scope: allowedDataScopesForAudience('owner', 'trusted_internal'),
      }),
    );
    expect(d.allowed).toBe(true);
  });

  it('ALLOWS manager', () => {
    const d = evaluateUsagePolicy(
      DAILY_BUSINESS_SUMMARY,
      ctx({
        audience_type: 'manager',
        trust_level: 'trusted_internal',
        allowed_data_scope: allowedDataScopesForAudience('manager', 'trusted_internal'),
      }),
    );
    expect(d.allowed).toBe(true);
  });

  it('BLOCKS customer with audience_blocked (explicit block-list)', () => {
    const d = evaluateUsagePolicy(
      DAILY_BUSINESS_SUMMARY,
      ctx({ audience_type: 'customer', trust_level: 'known_external' }),
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('audience_blocked');
  });

  it('BLOCKS lead and vendor', () => {
    for (const a of ['lead', 'vendor'] as const) {
      const d = evaluateUsagePolicy(
        DAILY_BUSINESS_SUMMARY,
        ctx({ audience_type: a, trust_level: 'known_external' }),
      );
      expect(d.allowed).toBe(false);
    }
  });

  it('BLOCKS an audience NOT in allowed_audience even when not explicitly blocked (employee)', () => {
    const d = evaluateUsagePolicy(
      DAILY_BUSINESS_SUMMARY,
      ctx({ audience_type: 'employee', trust_level: 'trusted_internal' }),
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('audience_blocked');
  });
});

describe('evaluateUsagePolicy — customer skill limited to own_customer_data_only', () => {
  it('ALLOWS a customer acting on their own data', () => {
    const d = evaluateUsagePolicy(
      CUSTOMER_SKILL,
      ctx({
        audience_type: 'customer',
        trust_level: 'known_external',
        allowed_data_scope: allowedDataScopesForAudience('customer', 'known_external'),
      }),
    );
    expect(d.allowed).toBe(true);
  });

  it('BLOCKS the customer skill if it tried to expose financial_summary (data_scope_blocked)', () => {
    const leaky: SkillUsagePolicy = { ...CUSTOMER_SKILL, data_scope: ['financial_summary'] };
    const d = evaluateUsagePolicy(
      leaky,
      ctx({
        audience_type: 'customer',
        trust_level: 'known_external',
        allowed_data_scope: allowedDataScopesForAudience('customer', 'known_external'),
      }),
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('data_scope_blocked');
  });
});

describe('evaluateUsagePolicy — channel, auth, risk', () => {
  const channelScoped: SkillUsagePolicy = {
    allowed_audience: ['owner'],
    allowed_channels: ['whatsapp'],
    data_scope: ['internal_business_summary'],
    exposure_policy: 'internal_only',
    requires_auth_level: 'trusted_internal',
    requires_confirmation: false,
  };

  it('BLOCKS an unauthorized channel (channel_blocked)', () => {
    const d = evaluateUsagePolicy(channelScoped, ctx({ channel_type: 'web' }));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('channel_blocked');
  });

  it('ALLOWS the authorized channel', () => {
    const d = evaluateUsagePolicy(channelScoped, ctx({ channel_type: 'whatsapp' }));
    expect(d.allowed).toBe(true);
  });

  it('BLOCKS a blocked_channels entry even if in allowed_channels would pass', () => {
    const p: SkillUsagePolicy = { ...channelScoped, blocked_channels: ['whatsapp'] };
    const d = evaluateUsagePolicy(p, ctx({ channel_type: 'whatsapp' }));
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('channel_blocked');
  });

  it('BLOCKS when trust is below requires_auth_level (auth_level_insufficient)', () => {
    const p: SkillUsagePolicy = {
      allowed_audience: ['owner', 'customer'],
      data_scope: ['public_info'],
      exposure_policy: 'internal_only',
      requires_auth_level: 'trusted_internal',
      requires_confirmation: false,
    };
    // A customer with known_external trust cannot satisfy trusted_internal.
    const d = evaluateUsagePolicy(
      p,
      ctx({ audience_type: 'customer', trust_level: 'known_external' }),
    );
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.reason).toBe('auth_level_insufficient');
  });

  it('a known_external contact satisfies a verified_subject requirement', () => {
    const d = evaluateUsagePolicy(
      CUSTOMER_SKILL, // requires known_external; customer is known_external
      ctx({
        audience_type: 'customer',
        trust_level: 'known_external',
        allowed_data_scope: ['own_customer_data_only', 'public_info'],
      }),
    );
    expect(d.allowed).toBe(true);
  });

  it('BLOCKS when turn risk is at or above the ceiling (risk_blocked)', () => {
    const p: SkillUsagePolicy = {
      allowed_audience: ['owner'],
      data_scope: ['internal_business_summary'],
      exposure_policy: 'internal_only',
      requires_auth_level: 'trusted_internal',
      requires_confirmation: false,
      blocked_when_risk_at_or_above: 'high',
    };
    const blocked = evaluateUsagePolicy(p, ctx({ risk_level: 'high' }));
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.reason).toBe('risk_blocked');

    const critical = evaluateUsagePolicy(p, ctx({ risk_level: 'critical' }));
    expect(critical.allowed).toBe(false);

    const allowedLow = evaluateUsagePolicy(p, ctx({ risk_level: 'medium' }));
    expect(allowedLow.allowed).toBe(true);
  });
});

describe('no-policy conservative default + audience→data-scope table', () => {
  it('CONSERVATIVE_DEFAULT admits internal/trusted, blocks customer', () => {
    const ownerD = evaluateUsagePolicy(
      CONSERVATIVE_DEFAULT_USAGE_POLICY,
      ctx({
        audience_type: 'owner',
        trust_level: 'trusted_internal',
        allowed_data_scope: allowedDataScopesForAudience('owner', 'trusted_internal'),
      }),
    );
    expect(ownerD.allowed).toBe(true);

    const customerD = evaluateUsagePolicy(
      CONSERVATIVE_DEFAULT_USAGE_POLICY,
      ctx({
        audience_type: 'customer',
        trust_level: 'known_external',
        allowed_data_scope: allowedDataScopesForAudience('customer', 'known_external'),
      }),
    );
    expect(customerD.allowed).toBe(false);
  });

  it('resolveEffectiveUsagePolicy falls back to the conservative default for NULL/{}', () => {
    const a = resolveEffectiveUsagePolicy(null);
    expect(a.ok && a.source).toBe('conservative_default');
    const b = resolveEffectiveUsagePolicy({});
    expect(b.ok && b.source).toBe('conservative_default');
  });

  it('resolveEffectiveUsagePolicy returns the DECLARED policy when valid', () => {
    const r = resolveEffectiveUsagePolicy(CUSTOMER_SKILL);
    expect(r.ok && r.source).toBe('declared');
  });

  it('resolveEffectiveUsagePolicy fails (not defaults) for a MALFORMED policy', () => {
    const r = resolveEffectiveUsagePolicy({ allowed_audience: [] });
    expect(r.ok).toBe(false);
  });

  it('allowedDataScopesForAudience: owner sees all, customer sees only own+public, unknown sees public', () => {
    expect(allowedDataScopesForAudience('owner', 'trusted_internal')).toContain('financial_summary');
    expect(allowedDataScopesForAudience('customer', 'known_external')).toEqual([
      'own_customer_data_only',
      'public_info',
    ]);
    expect(allowedDataScopesForAudience('unknown', 'unknown')).toEqual(['public_info']);
  });
});
