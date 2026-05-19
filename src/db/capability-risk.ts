/**
 * P8.5 — Capability proposal risk + architecture-lock derivation.
 *
 * Lives in src/db/ (not src/admin-ui/) because `proposalsUnifiedRepo` in
 * src/db/repositories.ts needs it AND the main TS build excludes src/admin-ui.
 * The admin-ui re-exports this from src/admin-ui/lib/capability-risk.ts.
 *
 * Post-Codex-review #101: see review note in src/admin-ui/lib/capability-risk.ts
 * for the full design rationale. TL;DR: hardcoded risk='medium' downgraded
 * destructive capabilities to owner-only approval. This module derives both
 * fields from the spec and FAILS CLOSED to 'critical' when unsure.
 */
import type { RiskLevelId } from './schema.js';

const TYPE_RISK_FLOOR: Record<string, RiskLevelId> = {
  knowledge: 'low',
  procedure: 'medium',
  tool: 'critical',
  integration: 'critical',
  other: 'critical',
};

const DESTRUCTIVE_SPEC_MARKERS = [
  'destructive',
  'irreversible',
  'sends_money',
  'sends_message_external',
  'deletes_data',
  'mass_writes',
  'side_effect_critical',
] as const;

const SIDE_EFFECT_SPEC_MARKERS = [
  'has_side_effects',
  'mutates_state',
  'writes_data',
  'external_post',
  'side_effect',
] as const;

const READ_ONLY_SPEC_MARKERS = ['read_only', 'idempotent', 'safe_read'] as const;

const COSTLY_READ_MARKERS = ['paid_api', 'high_cost', 'large_scan'] as const;

function getBool(spec: Record<string, unknown> | null | undefined, key: string): boolean {
  if (!spec) return false;
  const v = spec[key];
  return v === true || v === 'true' || v === 1 || v === '1';
}

function hasAny(spec: Record<string, unknown> | null | undefined, keys: readonly string[]): boolean {
  return keys.some((k) => getBool(spec, k));
}

function asObject(spec: unknown): Record<string, unknown> | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  return spec as Record<string, unknown>;
}

const RISK_ORDER: Record<RiskLevelId, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function maxRisk(a: RiskLevelId, b: RiskLevelId): RiskLevelId {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

export function deriveCapabilityRisk(
  capabilityType: string | null | undefined,
  proposedSpec: unknown,
): RiskLevelId {
  const spec = asObject(proposedSpec);
  const t = capabilityType ?? '';
  const typeFloor: RiskLevelId = TYPE_RISK_FLOOR[t] ?? 'critical';

  // --- Step 1: Compute marker-derived risk (security-authoritative). ---
  // Destructive markers dominate everything.
  let markerRisk: RiskLevelId;
  if (hasAny(spec, DESTRUCTIVE_SPEC_MARKERS)) {
    markerRisk = 'critical';
  } else if (hasAny(spec, SIDE_EFFECT_SPEC_MARKERS)) {
    markerRisk = 'high';
  } else if (hasAny(spec, READ_ONLY_SPEC_MARKERS)) {
    // read_only is a downward hint. Clamp to 'medium' at most
    // (never below 'low'); but the type floor will still dominate in step 2.
    markerRisk = 'low';
  } else if (hasAny(spec, COSTLY_READ_MARKERS)) {
    markerRisk = 'medium';
  } else {
    // No markers — marker contribution is neutral (floor wins).
    markerRisk = 'low';
  }

  // --- Step 2: Apply type floor (floor is a MINIMUM, cannot be bypassed). ---
  const derivedRisk: RiskLevelId = maxRisk(markerRisk, typeFloor);

  // --- Step 3: Self-declared risk is an ESCALATION HINT ONLY. ---
  // proposal_spec.risk can raise the computed severity (escalate) but NEVER
  // lower it. This prevents a malicious or buggy proposal body from
  // self-downgrading its approval class past what markers + type floor require.
  if (spec && typeof spec.risk === 'string') {
    const selfDeclared = spec.risk as string;
    if (
      selfDeclared === 'low' ||
      selfDeclared === 'medium' ||
      selfDeclared === 'high' ||
      selfDeclared === 'critical'
    ) {
      return maxRisk(derivedRisk, selfDeclared as RiskLevelId);
    }
  }

  return derivedRisk;
}

export function deriveCapabilityLocks(
  capabilityType: string | null | undefined,
  proposedSpec: unknown,
): string[] {
  const spec = asObject(proposedSpec);
  const locks: string[] = [];

  if (hasAny(spec, DESTRUCTIVE_SPEC_MARKERS)) {
    locks.push('tool_blast_radius');
  }
  if (getBool(spec, 'sends_message_external') || getBool(spec, 'external_post')) {
    locks.push('external_egress');
  }
  if (getBool(spec, 'sends_money')) {
    locks.push('financial_movement');
  }
  if (spec && Array.isArray(spec.architecture_locks)) {
    for (const l of spec.architecture_locks as unknown[]) {
      if (typeof l === 'string' && !locks.includes(l)) locks.push(l);
    }
  }
  if (
    capabilityType === 'integration' &&
    !hasAny(spec, READ_ONLY_SPEC_MARKERS) &&
    !locks.includes('external_egress')
  ) {
    locks.push('external_egress');
  }
  return locks;
}
