/**
 * P8e — policyRulesRepo: drizzle wrapper around `policy_rules`.
 *
 * Master spec v3.1.1 §2.1, §4 (this design's §4). Pattern matches the P4
 * agent_operational_profile_versions repo:
 *   - applyTenantGuard / getCurrentTenant on every read & write
 *   - Typed-result for expected failures (no throws on business-rule violations)
 *   - Lifecycle events emitted via Redis pub/sub on `policy_rule_lifecycle`
 *
 * READ-side methods feed PolicyDescriptorResolver. WRITE-side methods are
 * called by P8.5 Admin UI (future) and the seed script.
 *
 * Hard-limit extra guard: activate() refuses to flip `rule_kind='hard_limit'`
 * without `dual_approval_evidence`. Real "two distinct approvers from Admin
 * UI" validation lives in P8.5; here we only block direct programmatic
 * auto-activation.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { policy_rules } from '@/db/schema.js';
import type { PolicyRuleRow } from '@/db/schema.js';
import { applyTenantGuard } from '@/db/tenant-guard.js';
import { getCurrentTenant } from '@/db/tenant-context.js';
import { TypedError } from '@/lib/utils.js';
import { redis } from '@/lib/redis.js';
import { logger } from '@/lib/logger.js';
import type {
  PolicyRule,
  PolicyRuleBody,
  PolicyRuleKind,
  PolicyRuleScope,
  PolicyRuleStatus,
  PolicySourceOfTruth,
  PolicyLifecycleEvent,
  PolicyLifecycleEventName,
} from './types.js';

/**
 * Cache invalidation channel: shared with policy-cache.ts. Writers publish;
 * caches subscribe. JSON-encoded {event, tenant_id, agent_id, descriptor}.
 */
export const POLICY_LIFECYCLE_CHANNEL = 'policy_rule_lifecycle';

/**
 * Row -> domain mapper. Drizzle returns JSONB as `unknown`; we narrow here
 * and cast `string` columns to their CHECK-constrained literal types. The
 * DB CHECKs make this safe; tests verify round-trip.
 */
function rowToDomain(row: PolicyRuleRow): PolicyRule {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    rule_kind: row.rule_kind as PolicyRuleKind,
    rule_descriptor: row.rule_descriptor,
    rule_body: (row.rule_body ?? {}) as PolicyRuleBody,
    scope: (row.scope ?? {}) as PolicyRuleScope,
    source_of_truth: row.source_of_truth as PolicySourceOfTruth,
    status: row.status as PolicyRuleStatus,
    version: row.version,
    proposed_by: row.proposed_by,
    proposed_reason: row.proposed_reason ?? null,
    approved_by: row.approved_by ?? null,
    approved_at: row.approved_at ?? null,
    activated_at: row.activated_at ?? null,
    deprecated_at: row.deprecated_at ?? null,
    rolled_back_at: row.rolled_back_at ?? null,
    rollback_reason: row.rollback_reason ?? null,
    created_at: row.created_at,
  };
}

/**
 * Publish a lifecycle event. Failure is logged but never thrown — cache
 * invalidation is best-effort; TTL handles eventual consistency.
 */
async function publishLifecycle(evt: PolicyLifecycleEvent): Promise<void> {
  try {
    await redis.publish(POLICY_LIFECYCLE_CHANNEL, JSON.stringify(evt));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, evt },
      'policy_rules_repo.publish_failed',
    );
  }
}

/**
 * Codex review #93 finding: a hard_limit activation MUST present structured
 * evidence of two distinct approvers (owner + compliance). Previously any
 * truthy object passed. The seed script also bypassed the guard with
 * `{ script_bootstrap: true }` — that backdoor is closed by routing the
 * seed through `propose()` only and approving via Admin UI (P8.5).
 *
 * Validation rules:
 *  - `approvers`: array of >= 2 distinct non-empty principal ids
 *  - `approved_at`: ISO-8601 timestamp string (1 per approver, parallel arr)
 *  - `dual_approval_evidence` must NOT be undefined for hard_limit /
 *    lockdown_trigger (lockdown is the kill-switch — same guard applies).
 *
 * The Admin UI (P8.5) populates this from session-authenticated approvers;
 * the repo just enforces shape. Strict cryptographic proof (signatures)
 * is out of scope here; P8.5 may add a `signature` field later.
 */
export interface DualApprovalEvidence {
  approvers: string[]; // >= 2 distinct
  approved_at: string[]; // parallel array of ISO-8601 timestamps
  // Optional free-form context (audit trail, ticket id, etc.).
  context?: Record<string, unknown>;
}

export function isValidDualApprovalEvidence(
  ev: unknown,
): ev is DualApprovalEvidence {
  if (!ev || typeof ev !== 'object') return false;
  const e = ev as Record<string, unknown>;
  if (!Array.isArray(e.approvers) || !Array.isArray(e.approved_at)) return false;
  if (e.approvers.length < 2) return false;
  if (e.approvers.length !== e.approved_at.length) return false;
  // All approvers non-empty strings, all distinct, all timestamps parse.
  const seen = new Set<string>();
  for (const a of e.approvers) {
    if (typeof a !== 'string' || a.trim() === '') return false;
    if (seen.has(a)) return false;
    seen.add(a);
  }
  for (const t of e.approved_at) {
    if (typeof t !== 'string') return false;
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return false;
  }
  return true;
}

/**
 * The two rule kinds that REQUIRE dual_approval_evidence to activate.
 * `lockdown_trigger` is the tenant-wide kill-switch — Codex #93 flagged
 * that it had NO guard at all; same dual-approval guard now applies.
 */
const ACTIVATION_REQUIRES_DUAL_APPROVAL: ReadonlySet<PolicyRuleKind> = new Set([
  'hard_limit',
  'lockdown_trigger',
]);

export interface PolicyRulesRepo {
  // READ-side
  findActiveByDescriptor(args: {
    descriptor: string;
    agent_id?: string | null;
  }): Promise<PolicyRule | null>;

  listActiveForTenant(): Promise<PolicyRule[]>;

  listVersions(args: {
    descriptor: string;
    agent_id?: string | null;
  }): Promise<PolicyRule[]>;

  getById(id: string): Promise<PolicyRule | null>;

  // WRITE-side
  propose(input: {
    agent_id?: string | null;
    rule_kind: PolicyRuleKind;
    rule_descriptor: string;
    rule_body: PolicyRuleBody;
    scope?: PolicyRuleScope;
    source_of_truth: PolicySourceOfTruth;
    proposed_by: string;
    proposed_reason?: string;
  }): Promise<PolicyRule>;

  activate(args: {
    id: string;
    approved_by: string;
    dual_approval_evidence?: DualApprovalEvidence;
  }): Promise<
    | { ok: true; updated: PolicyRule }
    | {
        ok: false;
        reason:
          | 'not_found'
          | 'invalid_transition'
          | 'already_has_active'
          | 'hard_limit_requires_dual_approval'
          | 'invalid_dual_approval_evidence';
      }
  >;

  deprecate(args: {
    id: string;
    deprecated_by: string;
  }): Promise<
    | { ok: true; updated: PolicyRule }
    | { ok: false; reason: 'not_found' | 'invalid_transition' }
  >;

  rollback(args: {
    id: string;
    rolled_back_by: string;
    rollback_reason: string;
  }): Promise<
    | { ok: true; updated: PolicyRule }
    | { ok: false; reason: 'not_found' | 'terminal' }
  >;

  nextVersion(args: {
    descriptor: string;
    agent_id?: string | null;
  }): Promise<number>;
}

export const policyRulesRepo: PolicyRulesRepo = {
  /**
   * Hot path of the resolver. Precedence: agent-specific (eq agent_id) ->
   * tenant-wide (agent_id IS NULL). Returns first active match or null.
   */
  async findActiveByDescriptor(args) {
    const tenant_id = getCurrentTenant();
    // 1) agent-specific lookup if agent_id provided
    if (args.agent_id) {
      const [agentRow] = await db
        .select()
        .from(policy_rules)
        .where(
          and(
            eq(policy_rules.tenant_id, tenant_id),
            eq(policy_rules.agent_id, args.agent_id),
            eq(policy_rules.rule_descriptor, args.descriptor),
            eq(policy_rules.status, 'active'),
          ),
        )
        .limit(1);
      if (agentRow) return rowToDomain(agentRow);
    }
    // 2) tenant-wide fallback (agent_id IS NULL)
    const [tenantRow] = await db
      .select()
      .from(policy_rules)
      .where(
        and(
          eq(policy_rules.tenant_id, tenant_id),
          sql`${policy_rules.agent_id} IS NULL`,
          eq(policy_rules.rule_descriptor, args.descriptor),
          eq(policy_rules.status, 'active'),
        ),
      )
      .limit(1);
    return tenantRow ? rowToDomain(tenantRow) : null;
  },

  async listActiveForTenant() {
    const tenant_id = getCurrentTenant();
    const rows = await db
      .select()
      .from(policy_rules)
      .where(
        and(
          eq(policy_rules.tenant_id, tenant_id),
          eq(policy_rules.status, 'active'),
        ),
      )
      .orderBy(asc(policy_rules.rule_descriptor));
    return rows.map(rowToDomain);
  },

  async listVersions(args) {
    const tenant_id = getCurrentTenant();
    const whereParts = [
      eq(policy_rules.tenant_id, tenant_id),
      eq(policy_rules.rule_descriptor, args.descriptor),
    ];
    if (args.agent_id === null || args.agent_id === undefined) {
      whereParts.push(sql`${policy_rules.agent_id} IS NULL`);
    } else {
      whereParts.push(eq(policy_rules.agent_id, args.agent_id));
    }
    const rows = await db
      .select()
      .from(policy_rules)
      .where(and(...whereParts))
      .orderBy(desc(policy_rules.version));
    return rows.map(rowToDomain);
  },

  async getById(id) {
    const tenant_id = getCurrentTenant();
    const [row] = await db
      .select()
      .from(policy_rules)
      .where(
        and(eq(policy_rules.id, id), eq(policy_rules.tenant_id, tenant_id)),
      )
      .limit(1);
    return row ? rowToDomain(row) : null;
  },

  /**
   * Forces status='proposed' (invariant #5). Auto-resolves next version
   * via nextVersion(). Never accepts external status arg.
   */
  async propose(input) {
    const tenant_id = getCurrentTenant();
    // applyTenantGuard for write-side audit. We override agent_id below
    // because tenant_wide rows must persist NULL — guard expects a string.
    applyTenantGuard({ tenant_id });

    const agent_id = input.agent_id ?? null;
    const version = await this.nextVersion({
      descriptor: input.rule_descriptor,
      agent_id,
    });

    const [row] = await db
      .insert(policy_rules)
      .values({
        tenant_id,
        agent_id,
        rule_kind: input.rule_kind,
        rule_descriptor: input.rule_descriptor,
        rule_body: input.rule_body,
        scope: input.scope ?? {},
        source_of_truth: input.source_of_truth,
        status: 'proposed',
        version,
        proposed_by: input.proposed_by,
        proposed_reason: input.proposed_reason ?? null,
      })
      .returning();

    if (!row) {
      throw new TypedError('policy_propose_failed', 'insert returned no row');
    }
    return rowToDomain(row);
  },

  /**
   * proposed → active. Hard-limit + lockdown_trigger guard: refuses
   * without VALID dual_approval_evidence (2+ distinct approvers, ISO
   * timestamps). Codex review #93 closed the loophole where any truthy
   * object passed and noted lockdown_trigger had no guard at all.
   *
   * Concurrency: state-transition is enforced with a CONDITIONAL UPDATE
   * (`WHERE status='proposed'`). A concurrent rollback that flipped the
   * row to rolled_back between our SELECT and UPDATE is rejected by the
   * 0-rowcount → invalid_transition path. The partial unique index
   * `idx_policy_rules_one_active_uq` separately guarantees no two
   * actives co-exist for the same (tenant, agent_or_wide, descriptor);
   * a concurrent activate that won surfaces as 23505 →
   * already_has_active.
   */
  async activate(args) {
    const tenant_id = getCurrentTenant();
    const [row] = await db
      .select()
      .from(policy_rules)
      .where(
        and(eq(policy_rules.id, args.id), eq(policy_rules.tenant_id, tenant_id)),
      )
      .limit(1);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status !== 'proposed') {
      return { ok: false, reason: 'invalid_transition' };
    }
    const kind = row.rule_kind as PolicyRuleKind;
    if (ACTIVATION_REQUIRES_DUAL_APPROVAL.has(kind)) {
      if (!args.dual_approval_evidence) {
        return { ok: false, reason: 'hard_limit_requires_dual_approval' };
      }
      if (!isValidDualApprovalEvidence(args.dual_approval_evidence)) {
        return { ok: false, reason: 'invalid_dual_approval_evidence' };
      }
      // approved_by must not be one of the approvers (the requester
      // cannot self-approve their own activation, even with co-signer).
      const ev = args.dual_approval_evidence;
      if (ev.approvers.includes(args.approved_by)) {
        // approved_by is the EXECUTOR. To satisfy 2-of-N separation of
        // duties, the executor MUST be distinct from the approvers.
        return { ok: false, reason: 'invalid_dual_approval_evidence' };
      }
    }

    const now = new Date();
    try {
      // Codex review #93: conditional UPDATE on expected status guards
      // against the stale-read race where a concurrent rollback flipped
      // the row between our SELECT and UPDATE.
      const updated = await db
        .update(policy_rules)
        .set({
          status: 'active',
          approved_by: args.approved_by,
          approved_at: now,
          activated_at: now,
        })
        .where(
          and(
            eq(policy_rules.id, args.id),
            eq(policy_rules.tenant_id, tenant_id),
            eq(policy_rules.status, 'proposed'),
          ),
        )
        .returning();
      const updatedRow = updated[0];
      if (!updatedRow) {
        // 0 rows updated: either the row vanished or someone won the
        // transition first. Re-read to decide which.
        const [check] = await db
          .select()
          .from(policy_rules)
          .where(
            and(
              eq(policy_rules.id, args.id),
              eq(policy_rules.tenant_id, tenant_id),
            ),
          )
          .limit(1);
        if (!check) return { ok: false, reason: 'not_found' };
        return { ok: false, reason: 'invalid_transition' };
      }
      const domain = rowToDomain(updatedRow);
      await publishLifecycle({
        event: 'policy_rule_activated',
        tenant_id: domain.tenant_id,
        agent_id: domain.agent_id,
        descriptor: domain.rule_descriptor,
      });
      return { ok: true, updated: domain };
    } catch (err) {
      const e = err as Error & { code?: string };
      // 23505 = unique_violation. Our partial unique 'one active' triggers
      // when a concurrent activate for the same descriptor already won.
      if (e.code === '23505') {
        return { ok: false, reason: 'already_has_active' };
      }
      throw err;
    }
  },

  /**
   * active → deprecated. Frees the descriptor slot for a new active version.
   * Codex review #93: conditional UPDATE on expected status guards
   * against the stale-read race; tenant_id in WHERE guarantees no
   * cross-tenant write even if AsyncLocalStorage leaked.
   */
  async deprecate(args) {
    const tenant_id = getCurrentTenant();
    const now = new Date();
    const updated = await db
      .update(policy_rules)
      .set({
        status: 'deprecated',
        deprecated_at: now,
      })
      .where(
        and(
          eq(policy_rules.id, args.id),
          eq(policy_rules.tenant_id, tenant_id),
          eq(policy_rules.status, 'active'),
        ),
      )
      .returning();
    const updatedRow = updated[0];
    if (!updatedRow) {
      const [check] = await db
        .select()
        .from(policy_rules)
        .where(
          and(
            eq(policy_rules.id, args.id),
            eq(policy_rules.tenant_id, tenant_id),
          ),
        )
        .limit(1);
      if (!check) return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'invalid_transition' };
    }
    const domain = rowToDomain(updatedRow);
    await publishLifecycle({
      event: 'policy_rule_deprecated',
      tenant_id: domain.tenant_id,
      agent_id: domain.agent_id,
      descriptor: domain.rule_descriptor,
    });
    // hint that `deprecated_by` belongs in audit log; current schema lacks
    // a column for it. P8.5 may add a column or rely on audit_log directly.
    void args.deprecated_by;
    return { ok: true, updated: domain };
  },

  /**
   * any non-terminal → rolled_back. Terminal = rolled_back already.
   * Codex review #93: conditional UPDATE excludes 'rolled_back' atomically;
   * a concurrent rollback that won between our (avoided) SELECT and UPDATE
   * lands as 0-rowcount → re-read → `terminal`.
   */
  async rollback(args) {
    const tenant_id = getCurrentTenant();
    const now = new Date();
    const updated = await db
      .update(policy_rules)
      .set({
        status: 'rolled_back',
        rolled_back_at: now,
        rollback_reason: args.rollback_reason,
      })
      .where(
        and(
          eq(policy_rules.id, args.id),
          eq(policy_rules.tenant_id, tenant_id),
          // not yet terminal
          sql`${policy_rules.status} <> 'rolled_back'`,
        ),
      )
      .returning();
    const updatedRow = updated[0];
    if (!updatedRow) {
      const [check] = await db
        .select()
        .from(policy_rules)
        .where(
          and(
            eq(policy_rules.id, args.id),
            eq(policy_rules.tenant_id, tenant_id),
          ),
        )
        .limit(1);
      if (!check) return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'terminal' };
    }
    const domain = rowToDomain(updatedRow);
    await publishLifecycle({
      event: 'policy_rule_rolled_back',
      tenant_id: domain.tenant_id,
      agent_id: domain.agent_id,
      descriptor: domain.rule_descriptor,
    });
    void args.rolled_back_by;
    return { ok: true, updated: domain };
  },

  /**
   * Next sequential version for (tenant, agent_or_wide, descriptor). 1 if
   * no row exists. The unique index `idx_policy_rules_version_uq` enforces
   * no duplicate (tenant, agent_or_wide, descriptor, version).
   */
  async nextVersion(args) {
    const tenant_id = getCurrentTenant();
    const whereParts = [
      eq(policy_rules.tenant_id, tenant_id),
      eq(policy_rules.rule_descriptor, args.descriptor),
    ];
    if (args.agent_id === null || args.agent_id === undefined) {
      whereParts.push(sql`${policy_rules.agent_id} IS NULL`);
    } else {
      whereParts.push(eq(policy_rules.agent_id, args.agent_id));
    }
    const [row] = await db
      .select({ max: sql<number>`COALESCE(MAX(${policy_rules.version}), 0)` })
      .from(policy_rules)
      .where(and(...whereParts));
    const max = row?.max ?? 0;
    // drizzle/pg can return numeric as string; coerce defensively
    return Number(max) + 1;
  },
};

// Re-emit lifecycle constants for downstream consumers (cache module subscribes).
export type { PolicyLifecycleEvent, PolicyLifecycleEventName };
