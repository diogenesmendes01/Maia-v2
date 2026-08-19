/**
 * P9b (Camada 2) — Production wiring for DecisionEngine dependencies.
 *
 * Bridges the real production implementations (P8e, P9a, P9d, P9c) to the
 * Decision Engine's port interfaces, which were defined in P9b before those
 * implementations existed.  Every adapter here is a thin translation layer —
 * no business logic lives in this file.
 *
 * Adapters needed (recursive cebola — all interfaces diverged during phased
 * development):
 *
 *  1. PolicyDescriptorResolverAdapter  (P8e → DE port)
 *     DE port: resolveDescriptors(query, {signal?}) → ResolvedPolicy[]
 *     P8e impl: resolveDescriptors({tenant_id,agent_id,descriptors,scope?})
 *              → {resolved, unresolved, failures}
 *     Mapping: pass-through query fields; strip unresolved/failures; map
 *              P8e ResolvedPolicy to DE ResolvedPolicy (both carry policy_id
 *              + descriptor; DE adds optional applies_to_peps from rule_kind).
 *     NOTE: P8e resolver doesn't accept AbortSignal — not exposed in its
 *     interface. The DE deadline wraps the Promise externally, so omitting
 *     signal here is safe.
 *
 *  2. PolicyRulesRepoAdapter  (P8e PolicyRulesRepo → DE PolicyRulesRepo)
 *     DE port: getBody(id, {signal?}) / getBodySync(id)
 *     P8e impl: getById(id)
 *     Mapping: getBody → getById (async); getBodySync always null (no sync
 *     path in P8e repo). The sync path is a fast-path cache hint for PEPs;
 *     returning null is safe (PEPs fall back to async getBody).
 *
 *  3. PolicyDSLEvaluatorAdapter  (P9d pure fn → DE PolicyEvaluator interface)
 *     DE port: PolicyEvaluator.evaluate(body, context, {signal?})
 *              → PolicyEvaluatorVerdict
 *     P9d impl: evaluate(rule_body, context) → PolicyDecision
 *     Mapping: wrap the pure fn; translate PolicyDecision.outcome →
 *              PolicyEvaluatorVerdict.action (matched→block/warn/etc via
 *              effect.action; not_matched→allow; not_applicable→allow;
 *              evaluation_error→block fail-closed).
 *
 *  4. SkillsRepoAdapter  (P9a SkillsRepo → DE SkillsRepo)
 *     DE port: findActive({tenant_id, agent_id, applicable_to_intent?, ...})
 *              → Skill[]; find(id, {tenant_id,agent_id}, {signal?}) → Skill|null
 *     P9a impl: findActive(descriptor, agent_id?) → SkillRow|null;
 *              listByCategory(category) → SkillRow[]; getById(id) → SkillRow|null
 *     Mapping: DE findActive searches ALL active skills for the ROUTED agent +
 *     optional intent filter; P9a findActive needs a descriptor, so we use
 *     listByCategory to enumerate active skills across EVERY DE/DB category,
 *     then SkillSelector ranks/matches. SkillRow → Skill mapping (field name
 *     translation).
 *     TENANT ISOLATION (Codex PR #215 review, BLOCKER 2): P9a's listByCategory /
 *     getById derive their scope from the ambient tenant-context
 *     (getCurrentTenant + getCurrentAgent). The DE query carries the *routed*
 *     agent (channel policy may route to an agent ≠ the context agent that
 *     built the BaseContextPacket). We therefore run the P9a lookups inside a
 *     nested runWithTenantContext pinned to {query.tenant_id, query.agent_id}
 *     so selection scopes to the routed agent (the repo keeps its tenant-wide
 *     `agent_id IS NULL` fallback) and NEVER leaks another agent's skills.
 *
 *  5. ProceduresRepoAdapter  (procedureExecutionsRepo → DE ProceduresRepo)
 *     DE port: findExecution(id) → ProcedureExecution|null
 *     DB: procedureExecutionsRepo.findById(id) returns ProcedureExecution row
 *     Mapping: execution_id=id; procedure_id=definition_id;
 *     procedure_domain=scope(from definition join, but we approximate with
 *     intencao from the linked definition or default to 'unknown');
 *     ttl_remaining_ms derived from last_activity_at + 30min default TTL.
 *
 *  6. LockdownReaderProdAdapter  — wraps governance/lockdown.ts entity/permissao
 *     signals. Dual-layer design: channel lockdown is checked via
 *     BaseContextPacket.channel.is_locked_down (Layer 1, Early PEP). This
 *     adapter implements Layer 2: entity/permissao lockdown via
 *     entity_states.flags['lockdown_snapshot'] (isTenantInGlobalLockdown) and
 *     permissoes.status='suspensa' (tenantHasSensitiveContext). isChannelLockedDown
 *     always returns false — handled at Layer 1.
 *
 *  7. ChannelPoliciesReaderAdapter  — direct drizzle query on channel_policies.
 *     DE port: getForChannel(tenant_id, channel_id) → {channel_id,
 *              tenant_id, default_agent_id}
 *     DB schema: channel_policies has agent_id directly (no JOIN required).
 *     The adapter queries channel_policies WHERE tenant_id=$1 AND channel_id=$2
 *     and returns channel_policies.agent_id as default_agent_id. Tenant
 *     isolation is guaranteed by the WHERE predicate.  If no row exists
 *     (channel not yet configured), falls back to getCurrentAgent() so the
 *     engine keeps the current context agent — identical to the old stub
 *     behaviour for unconfigured channels.
 *
 *  8. ContentResolverAdapter  — wraps mensagensRepo.findById for content_ref
 *     resolution.  Falls back to empty string if not found.
 *
 *  9. HaikuClientAdapter  — wraps lib/claude.ts callClaude for classification.
 *
 *  10. MetricsClientAdapter  — wraps lib/metrics.ts incCounter/observeHistogram.
 *
 * Architecture Lock: this file imports from control-plane/policy and
 * control-plane/skill-registry.  It MUST NOT be imported by src/agent/
 * or src/cognition/. Only runtime/decision/integration.ts (and tests) may
 * import it.
 */

import {
  policyDescriptorResolver as p8eResolver,
} from '@/control-plane/policy/policy-descriptor-resolver.js';
import {
  policyRulesRepo as p8ePolicyRulesRepo,
} from '@/control-plane/policy/policy-rules-repo.js';
import { RUNTIME_ENFORCED_WRITE_RISK_DESCRIPTORS } from '@/control-plane/policy/boleto-write-policies.js';
import { evaluate as p9dEvaluate } from '@/governance/policy-dsl/evaluator.js';
import { skillsRepo as p9aSkillsRepo } from '@/control-plane/skill-registry/skills-repo.js';
import { procedureExecutionsRepo, procedureDefinitionsRepo } from '@/db/repositories.js';
import { logger } from '@/lib/logger.js';
import { getCurrentAgent, runWithTenantContext } from '@/db/tenant-context.js';
import { db } from '@/db/client.js';
import { channel_policies, entity_states, permissoes } from '@/db/schema.js';
import { and, eq } from 'drizzle-orm';
import { incCounter, observeHistogram } from '@/lib/metrics.js';
import { callLLM } from '@/lib/claude.js';
import { scoreTurn } from './turn-risk-scorer.js';
import { RiskLevel } from '@/types/enums.js';
import type { TurnRiskSignals, TopicSignal, ToolKind } from '@/shared/risk/types.js';
import type {
  ChannelPoliciesReader,
  ContentResolver,
  HaikuClient,
  LockdownReader,
  MetricsClient,
  PolicyDescriptorResolver,
  PolicyEvaluator,
  PolicyEvaluatorVerdict,
  PolicyRulesRepo,
  ProceduresRepo,
  ResolvedPolicy,
  RiskScorer,
  Skill,
  SkillsRepo,
} from './types.js';
import type { BaseContextPacket, DecisionPacket } from '../context-packet/types.js';
import type { CreateDecisionEngineEnv } from './index.js';

// ---------------------------------------------------------------------------
// 1. PolicyDescriptorResolverAdapter
// ---------------------------------------------------------------------------

const policyDescriptorResolverAdapter: PolicyDescriptorResolver = {
  async resolveDescriptors(query, _options) {
    // Issue #437 — wildcard expansion. The Decision Engine asks for "all
    // applicable policies" via the sentinel descriptor `'*'`, but the P8e
    // resolver matches `rule_descriptor` literally (no wildcard) and the P9d
    // evaluator can only evaluate DSL-shaped (`PolicyRuleBody`) bodies. Expand
    // `'*'` to the curated set of ACTIVE, DSL-evaluable descriptors
    // (`confirm_before_write_policy`, `human_confirmation_policy`) so the boleto
    // write/risk policies actually reach the Early/Mid PEPs. Resolving every
    // active policy indiscriminately would feed the legacy non-DSL hard-limit
    // rows (migration 037) to the evaluator → `evaluation_error` → BLOCK every
    // turn; the curated list avoids that landmine until 037 is migrated. Any
    // non-wildcard descriptor set is passed through unchanged.
    const descriptors = query.descriptors.includes('*')
      ? [...RUNTIME_ENFORCED_WRITE_RISK_DESCRIPTORS]
      : query.descriptors;
    // P8e resolver does not accept AbortSignal; deadline wrapping happens in DE.
    const output = await p8eResolver.resolveDescriptors({
      tenant_id: query.tenant_id,
      agent_id: query.agent_id,
      descriptors,
      scope: query.scope?.channel
        ? { channel: query.scope.channel }
        : query.scope?.domain
        ? { domain: query.scope.domain }
        : undefined,
    });
    // Map P8e ResolvedPolicy to DE ResolvedPolicy.
    // DE type: { policy_id, descriptor, applies_to_peps? }
    // P8e type: { descriptor, policy_id, version, rule_kind }
    // applies_to_peps not stored in P8e resolved output; PEPs derive it from
    // the rule_body (getBody). We omit it here — PEPs that need it read it from
    // the repo body directly.
    const resolved: ResolvedPolicy[] = output.resolved.map((r) => ({
      policy_id: r.policy_id,
      descriptor: r.descriptor,
    }));
    return resolved;
  },
};

// ---------------------------------------------------------------------------
// 2. PolicyRulesRepoAdapter
// ---------------------------------------------------------------------------

const policyRulesRepoAdapter: PolicyRulesRepo = {
  async getBody(policy_id, _options) {
    const rule = await p8ePolicyRulesRepo.getById(policy_id);
    if (!rule) return null;
    // DE PolicyRuleBody = Record<string, unknown> with policy_id/descriptor/applies_to_peps
    return {
      policy_id: rule.id,
      descriptor: rule.rule_descriptor,
      rule_kind: rule.rule_kind,
      // applies_to_peps not stored in policy_rules table — defaulted to ['mid','late']
      // per DE types.ts comment: "Default if unspecified is ['mid', 'late']"
      ...((rule.rule_body as Record<string, unknown>) ?? {}),
    };
  },
  getBodySync(_policy_id) {
    // P8e repo has no sync cache path exposed. Returning null makes PEPs fall
    // back to the async getBody() path, which is correct.
    return null;
  },
};

// ---------------------------------------------------------------------------
// 3. PolicyDSLEvaluatorAdapter (P9d pure fn → DE PolicyEvaluator interface)
// ---------------------------------------------------------------------------

const policyDSLEvaluatorAdapter: PolicyEvaluator = {
  async evaluate(body, context, _options) {
    // P9d evaluate is a pure synchronous function; we wrap in Promise for DE interface.
    // DE PolicyRuleBody = Record<string,unknown>; P9d PolicyRuleBody has typed fields.
    // Cast through unknown to satisfy both type constraints safely.
    const bodyForP9d = body as unknown as Parameters<typeof p9dEvaluate>[0];
    const decision = p9dEvaluate(bodyForP9d, context);

    // Also treat the body as an open record for reading custom fields.
    const bodyAsRecord = body as unknown as Record<string, unknown>;

    // Map PolicyDecision.outcome to PolicyEvaluatorVerdict.action.
    // Architecture Lock: fail-closed on evaluation_error (must block).
    switch (decision.outcome) {
      case 'matched': {
        // Use the effect action if it's a valid DE verdict action.
        const effect = decision.effect as
          | { action?: string; message?: string; metadata?: Record<string, unknown> }
          | undefined;
        const deAction = mapEffectAction(effect?.action);
        const verdict: PolicyEvaluatorVerdict = {
          action: deAction,
          reason:
            (bodyAsRecord['descriptor'] as string | undefined) ??
            (bodyAsRecord['rule_id'] as string | undefined) ??
            'policy_matched',
        };
        if (typeof effect?.message === 'string') {
          verdict.message = effect.message;
        }
        // Issue #437 — the DSL convention (migration 078) carries severity +
        // intent + approval params in `effect.metadata`, NOT at the rule-body top
        // level. Read from there first (legacy top-level as a fallback) so the
        // Mid PEP can disambiguate `confirm_before_write` from
        // `escalate_to_human` and forward a severity. Forwarding the whole
        // metadata bag as `parameters` lets PEPs read `intent` / `approval_class`
        // / any future signal without another mapping layer.
        const meta =
          effect?.metadata && typeof effect.metadata === 'object'
            ? effect.metadata
            : {};
        const severity =
          (meta['severity'] as string | undefined) ??
          (bodyAsRecord['severity'] as string | undefined);
        if (severity && isValidSeverity(severity)) {
          verdict.severity = severity;
        }
        const topLevelParams = bodyAsRecord['parameters'] as
          | Record<string, unknown>
          | undefined;
        const params: Record<string, unknown> = { ...meta, ...(topLevelParams ?? {}) };
        if (Object.keys(params).length > 0) {
          verdict.parameters = params;
        }
        return verdict;
      }
      case 'not_matched':
        return { action: 'allow', reason: 'predicate_not_matched' };
      case 'not_applicable':
        // Missing context field — treat as not matching (allow). Per P9d spec,
        // not_applicable means the field wasn't present; the rule doesn't apply.
        return { action: 'allow', reason: 'predicate_not_applicable' };
      case 'evaluation_error':
        // Fail-closed: any evaluation error must block, per RESOLVER_FAILURE_DEFAULT
        // and P9d Architecture Lock §4 "PEPs MUST treat this as BLOCK".
        return {
          action: 'block',
          reason: `evaluation_error: ${decision.errors.map((e) => e.code).join(', ')}`,
          severity: 'high',
        };
    }
  },
};

function mapEffectAction(action: string | undefined): PolicyEvaluatorVerdict['action'] {
  switch (action) {
    case 'block': return 'block';
    case 'escalate': return 'escalate';
    case 'warn': return 'warn_in_trace';
    case 'warn_in_trace': return 'warn_in_trace';
    case 'require_dual_approval': return 'require_dual_approval';
    case 'reduce_tool_set': return 'reduce_tool_set';
    case 'allow': return 'allow';
    default:
      // Unknown effect action → block fail-closed
      return 'block';
  }
}

function isValidSeverity(s: string): s is 'critical' | 'high' | 'medium' | 'low' {
  return s === 'critical' || s === 'high' || s === 'medium' || s === 'low';
}

// ---------------------------------------------------------------------------
// 4. SkillsRepoAdapter (P9a SkillsRepo → DE SkillsRepo)
// ---------------------------------------------------------------------------

/**
 * Map a P9a SkillRow to the DE Skill type.
 *
 * P9a SkillRow uses skill_descriptor as id, category/execution_mode,
 * allowed_tools, etc. DE Skill uses id, category, priority, status,
 * applicable_to_intent, allowed_tools, etc.
 *
 * NOTE: P9a does not store applicable_to_intent, priority, or
 * requires_confirmation_tools — these are DE-specific. We derive them from
 * the skill_descriptor name and runtime_hints.
 */
function skillRowToSkill(row: {
  id: string;
  skill_descriptor: string;
  category: string;
  execution_mode: string;
  status: string;
  goal?: string | unknown;
  when_to_use?: string | unknown;
  allowed_tools: string[] | unknown;
  policy_descriptors: string[] | unknown;
  applicable_to_role?: string[] | unknown;
  runtime_hints: Record<string, unknown> | unknown;
  usage_policy?: Record<string, unknown> | null | unknown;
  version: number;
}): Skill {
  const allowed_tools = Array.isArray(row.allowed_tools) ? (row.allowed_tools as string[]) : [];
  // Issue #415 — carry the role → skill scope through so the SkillSelector can
  // apply `applicable_to_role` against the turn's active role (taxonomy §2 step
  // 5). EMPTY/absent ⇒ universal (applies regardless of role).
  const applicable_to_role = Array.isArray(row.applicable_to_role)
    ? (row.applicable_to_role as string[])
    : [];
  const hints = (typeof row.runtime_hints === 'object' && row.runtime_hints !== null)
    ? (row.runtime_hints as Record<string, unknown>)
    : {};
  const when_to_use = typeof row.when_to_use === 'string' ? row.when_to_use : '';
  // Issue #409 — carry the native usage_policy JSONB through so the
  // SkillSelector candidate filter can admit/remove by audience before any tool
  // reaches the LLM. Validation/parse happens in the filter (usage-policy.ts);
  // here we only forward the raw object (or null).
  const usage_policy =
    typeof row.usage_policy === 'object' && row.usage_policy !== null
      ? (row.usage_policy as Record<string, unknown>)
      : null;
  return {
    id: row.id,
    // F1 Phase 1 (immutable identity): carry the stable descriptor + version
    // + execution_mode forward so ActionDecider can gate execute_skill on the
    // mode and pin the descriptor/version onto the packet for the call site's
    // identity assert. Previously these were discarded (Codex P2).
    skill_descriptor: row.skill_descriptor,
    version: row.version,
    execution_mode: row.execution_mode as Skill['execution_mode'],
    category: row.category as Skill['category'],
    priority: 5, // P9a does not store priority; default 5 (medium)
    status: row.status as Skill['status'],
    // F1 Phase 0: P9a doesn't store a structured applicable_to_intent list,
    // but the `skill_descriptor` follows a convention (e.g. 'skill.greet',
    // 'transfer_intent') whose terminal token names the intent. We surface the
    // descriptor token(s) as applicable_to_intent so SkillSelector's exact-match
    // path works for descriptor-named skills; the free-text `when_to_use` below
    // carries the rest of the matching signal.
    applicable_to_intent: deriveIntentLabels(row.skill_descriptor),
    // F1 Phase 0: free-text matching guidance from the Skill Contract. The
    // anti-hijack matcher tokenises this against the classified intent so a
    // skill is only selected when the turn clearly relates to it.
    when_to_use,
    // Issue #415 — role → skill scope, forwarded for the SkillSelector's
    // `applicable_to_role` filter (taxonomy §2 step 5).
    applicable_to_role,
    allowed_tools,
    blocked_tools: [], // P9a does not store blocked_tools separately
    requires_confirmation_tools: [], // P9a does not store this
    runtime_hints: {
      allow_deep_context: hints['allow_deep_context'] === true,
    },
    output_schema_ref: typeof hints['output_schema_ref'] === 'string'
      ? hints['output_schema_ref']
      : undefined,
    // Issue #409 — native SkillUsagePolicy (raw JSONB; null = conservative
    // default at filter time).
    usage_policy,
  };
}

/**
 * Derive candidate intent labels from a skill descriptor (F1 Phase 0).
 *
 * Descriptors follow loose conventions: dotted ('skill.greet', 'billing.cancel')
 * or snake/flat ('transfer_intent'). We surface the FULL descriptor and its
 * terminal segment as exact-match candidates so a descriptor that literally
 * equals (or ends with) the classified intent label selects deterministically.
 * The free-text `when_to_use` provides the fuzzier token-overlap signal.
 */
function deriveIntentLabels(descriptor: string): string[] {
  if (!descriptor) return [];
  const labels = new Set<string>();
  const full = descriptor.trim().toLowerCase();
  if (full) labels.add(full);
  const lastDotSegment = full.split('.').pop();
  if (lastDotSegment) labels.add(lastDotSegment);
  return Array.from(labels);
}

/**
 * Every category the `skills.category` CHECK constraint allows
 * (db/schema.ts: 'classify','extract','compose','decide','tool_mediated',
 * 'diagnose','plan','evaluator'). Codex PR #215 review (CORRECTNESS 4): the
 * adapter previously enumerated only respond/tool_mediated/decide/plan, so
 * active skills in classify/extract/compose/diagnose/evaluator NEVER became
 * candidates. We enumerate the full DB set here so all active skills are
 * eligible; SkillSelector then ranks/matches them.
 *
 * NOTE: 'respond' is a DE-RUNTIME `Skill.category` value, not a DB category, so
 * it is intentionally absent — `listByCategory('respond')` would always return
 * zero rows. The DE-side ranking still treats `respond` specially when a Skill
 * carries that category from another source.
 */
const SKILL_DB_CATEGORIES = [
  'classify',
  'extract',
  'compose',
  'decide',
  'tool_mediated',
  'diagnose',
  'plan',
  'evaluator',
] as const;

/**
 * The DE's SkillsRepoAdapter. Its COMPLETE P9a surface is exactly two calls:
 *   - findActive → p9aSkillsRepo.listByCategory (once per DB category)
 *   - find       → p9aSkillsRepo.getById
 * BOTH run inside a nested runWithTenantContext pinned to the ROUTED
 * {tenant_id, agent_id} (Codex #215 BLOCKER 2). Any P9a query added here in the
 * future MUST be wrapped the same way — otherwise it would silently scope to
 * the AMBIENT context agent (getCurrentAgent) and leak another agent's skills.
 *
 * Tenant-wide skills (agent_id IS NULL) are SHARED across every agent in the
 * tenant BY DESIGN — that is P9a's semantic for an ownerless/shared skill, NOT
 * a leak (Codex #217 review item 3). The nested context only changes which
 * agent P9a's `agent_id = <ctx> OR agent_id IS NULL` clause resolves <ctx> to;
 * it can never surface a row OWNED by a different agent. So the inter-agent
 * isolation guarantee is precisely: an agent-OWNED skill never resolves under
 * a different agent, while ownerless/tenant-wide skills remain shared. This is
 * proven with seeded rows (not just context observation) by the `items 3+4`,
 * `item 5`, and `item 6` tests in tests/unit/decision-prod-env-skills.spec.ts.
 */
const skillsRepoAdapter: SkillsRepo = {
  async findActive(query, _options) {
    // TENANT ISOLATION (Codex PR #215 review, BLOCKER 2): P9a's listByCategory
    // scopes to the AMBIENT tenant-context agent (getCurrentAgent). The DE query
    // carries the *routed* agent, which channel policy may resolve to a
    // different agent than the one that built the BaseContextPacket. Pin the
    // P9a lookups to {query.tenant_id, query.agent_id} via a nested
    // runWithTenantContext so candidates belong to the ROUTED agent (P9a still
    // unions its tenant-wide `agent_id IS NULL` skills) and we never leak the
    // context agent's skills.
    return runWithTenantContext(
      { tenant_id: query.tenant_id, agent_id: query.agent_id },
      async () => {
        const allSkills: Skill[] = [];
        for (const cat of SKILL_DB_CATEGORIES) {
          const rows = await p9aSkillsRepo.listByCategory(cat);
          for (const row of rows) {
            allSkills.push(skillRowToSkill(row));
          }
        }
        // P9a doesn't store a structured applicable_to_intent, so we can't
        // pre-filter precisely here. Return ALL active scoped skills and let
        // SkillSelector match by applicable_to_intent (derived from the
        // descriptor) + when_to_use + category/priority.
        void query.applicable_to_intent; // acknowledged; matched downstream
        // Issue #415 — the role → skill scope (`applicable_to_role`) IS a stored
        // column, but we do NOT pre-filter it in SQL here: the SkillSelector
        // applies it uniformly (against the turn's active role) right after
        // ranking, so the role-scope decision lives in one place. Acknowledged;
        // filtered downstream by `filterByApplicableRole`.
        void query.applicable_to_role; // acknowledged; filtered downstream
        return allSkills;
      },
    );
  },

  async find(skill_id, scope, _options) {
    // Scope the lookup to the supplied {tenant_id, agent_id} (the routed agent)
    // rather than the ambient context (Codex PR #215 review, BLOCKER 2 /
    // round-2 finding 3). getById is tenant+agent scoped via tenant-context and
    // returns null for a skill owned by a different agent in the same tenant.
    const row = await runWithTenantContext(
      { tenant_id: scope.tenant_id, agent_id: scope.agent_id },
      () => p9aSkillsRepo.getById(skill_id),
    );
    if (!row) return null;
    return skillRowToSkill(row);
  },
};

// ---------------------------------------------------------------------------
// 5. ProceduresRepoAdapter
// ---------------------------------------------------------------------------

// Default TTL for procedure executions: 30 minutes.
const DEFAULT_PROCEDURE_TTL_MS = 30 * 60 * 1000;

/**
 * Reads the active procedure execution and joins procedure_definitions to
 * obtain the domain field (migration 060_p3a_procedure_definitions_domain.sql).
 *
 * Returns null if:
 *   - execution not found or status !== 'in_progress'
 *
 * Returns procedure_domain = 'unknown' (with a warn log) if:
 *   - procedure_definitions.domain IS NULL (backfill pending)
 */
const proceduresRepoAdapter: ProceduresRepo = {
  async findExecution(execution_id) {
    const exec = await procedureExecutionsRepo.findById(execution_id);
    if (!exec || exec.status !== 'in_progress') return null;

    const now = Date.now();
    const lastActivity = exec.last_activity_at.getTime();
    const elapsed = now - lastActivity;
    const ttl_remaining_ms = Math.max(0, DEFAULT_PROCEDURE_TTL_MS - elapsed);

    // Fetch the definition to read the domain field.
    // Tenant isolation is enforced by procedureDefinitionsRepo.findById
    // via getCurrentTenant() + WHERE tenant_id/agent_id.
    const definition = await procedureDefinitionsRepo.findById(exec.definition_id);
    const rawDomain = (definition as { domain?: string | null } | null)?.domain ?? null;

    if (rawDomain === null) {
      logger.warn(
        { definition_id: exec.definition_id, execution_id, tenant_id: exec.tenant_id },
        'procedure_definitions.domain is NULL — WorkflowSelector will use unknown fallback',
      );
    }

    return {
      execution_id: exec.id,
      procedure_id: exec.definition_id,
      procedure_domain: rawDomain ?? 'unknown',
      ttl_remaining_ms,
    };
  },
};

// ---------------------------------------------------------------------------
// 6. LockdownReaderProdAdapter  (entity/permissao layer)
// ---------------------------------------------------------------------------

/**
 * DESIGN NOTE: dual-layer lockdown
 *
 * Layer 1 — Channel lockdown:
 *   Checked via `BaseContextPacket.channel.is_locked_down` at the Early PEP
 *   entry point (hardcoded short-circuit, line 38 of early-pep.ts). This flag
 *   is set upstream by the channel resolver and is independent of this adapter.
 *
 * Layer 2 — Entity/permissao lockdown (this adapter):
 *   The legacy `governance/lockdown.ts` operates at entity/permissao scope.
 *   When `activateLockdown()` runs it:
 *     a) suspends all non-owner permissoes (status → 'suspensa')
 *     b) stores a `lockdown_snapshot` array in `entity_states.flags` per entity
 *
 *   This adapter reads those signals:
 *   - `isTenantInGlobalLockdown(tenant_id)`:
 *       Queries `entity_states` for the tenant; returns true if any row has a
 *       non-empty `flags.lockdown_snapshot` (= lockdown currently active).
 *   - `isChannelLockedDown(channel_id, tenant_id)`:
 *       Always returns false at this layer — channel-level lockdown is handled
 *       by BaseContextPacket.channel.is_locked_down (Layer 1). No DB query.
 *   - `tenantHasSensitiveContext(tenant_id)`:
 *       Returns true if any permissao for the tenant has status='suspensa'.
 *       A suspended permissao signals that a lockdown event occurred (or is
 *       ongoing), indicating sensitive context where the budget-fallback must
 *       escalate rather than ask_clarification (spec §6.2).
 *
 * Out-of-scope contexts (channel-only turns with no entity) are handled
 * exclusively at Layer 1. This adapter never blocks such turns.
 */

const LOCKDOWN_SNAPSHOT_KEY = 'lockdown_snapshot';

export class LockdownReaderProdAdapter implements LockdownReader {
  /**
   * Channel-level lockdown is always false at this layer.
   * It is handled upstream via BaseContextPacket.channel.is_locked_down
   * (Layer 1, Early PEP hardcoded short-circuit).
   */
  async isChannelLockedDown(
    _channel_id: string,
    _tenant_id: string,
    _options?: { signal?: AbortSignal },
  ): Promise<boolean> {
    return false;
  }

  /**
   * Returns true if any entity in the tenant has an active lockdown snapshot.
   * The snapshot is written by governance/lockdown.ts#activateLockdown() into
   * entity_states.flags['lockdown_snapshot'] and cleared by liftLockdown().
   */
  async isTenantInGlobalLockdown(
    tenant_id: string,
    _options?: { signal?: AbortSignal },
  ): Promise<boolean> {
    const rows = await db
      .select()
      .from(entity_states)
      .where(eq(entity_states.tenant_id, tenant_id));

    for (const row of rows) {
      const flags = (row.flags as Record<string, unknown>) ?? {};
      const snapshot = flags[LOCKDOWN_SNAPSHOT_KEY];
      if (Array.isArray(snapshot) && snapshot.length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if any permissao for the tenant is in 'suspensa' status.
   * Suspended permissoes signal that a lockdown event has occurred (or is
   * active), triggering budget-fallback escalation instead of ask_clarification.
   */
  async tenantHasSensitiveContext(
    tenant_id: string,
    _options?: { signal?: AbortSignal },
  ): Promise<boolean> {
    const rows = await db
      .select()
      .from(permissoes)
      .where(
        and(
          eq(permissoes.tenant_id, tenant_id),
          eq(permissoes.status, 'suspensa'),
        ),
      );
    return rows.length > 0;
  }
}

const lockdownReaderAdapter = new LockdownReaderProdAdapter();

// ---------------------------------------------------------------------------
// 7. ChannelPoliciesReaderAdapter  — direct DB lookup on channel_policies
// ---------------------------------------------------------------------------

/**
 * Queries channel_policies with explicit tenant_id + channel_id predicates so
 * there is no dependency on the request-scoped tenant context. Tenant isolation
 * is enforced by the WHERE clause. If no row is found (channel not yet
 * configured in DB), falls back to getCurrentAgent() — same behaviour as the
 * former stub — so existing unconfigured channels are unaffected.
 *
 * channel_policies.agent_id is the owning/default agent for the channel.  No
 * JOIN to roles or agents is needed because agent_id is a direct column.
 */
// `channel_policies.channel_id` is a `uuid` column. When the channel resolver
// did not surface a channel_id (e.g. an inbound with no telefone metadata), the
// hot path feeds the sentinel string 'default' as the channel id (see
// build-base-context.ts: `channel_id ?? 'default'`), which is not a uuid.
// Querying the uuid column with it makes Postgres throw
// `invalid input syntax for type uuid: "default"`, which propagates up and
// fail-closes the entire Decision Engine turn. A non-uuid channel id can never
// match a stored policy row anyway, so short-circuit to the context agent —
// the same outcome as the zero-row fallback below for an unconfigured (but
// uuid-shaped) channel.
const CHANNEL_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const channelPoliciesReaderAdapter: ChannelPoliciesReader = {
  async getForChannel(tenant_id, channel_id) {
    if (!CHANNEL_ID_UUID_RE.test(channel_id)) {
      return { tenant_id, channel_id, default_agent_id: getCurrentAgent() };
    }

    const rows = await db
      .select({ agent_id: channel_policies.agent_id })
      .from(channel_policies)
      .where(
        and(
          eq(channel_policies.tenant_id, tenant_id),
          eq(channel_policies.channel_id, channel_id),
        ),
      )
      .limit(1);

    const stored_agent_id = rows[0]?.agent_id ?? null;
    // Fall back to context agent for channels not yet configured in DB.
    const default_agent_id = stored_agent_id ?? getCurrentAgent();

    return { tenant_id, channel_id, default_agent_id };
  },
};

// ---------------------------------------------------------------------------
// 8. ContentResolverAdapter
// ---------------------------------------------------------------------------

const contentResolverAdapter: ContentResolver = {
  async text(content_ref, _options) {
    // content_ref is a mensagem id (msg_<uuid>) or raw text.
    // Try mensagensRepo.findById; if not found, treat content_ref as literal text.
    try {
      const { mensagensRepo } = await import('@/db/repositories.js');
      const msg = await mensagensRepo.findById(content_ref);
      // DB column is `conteudo` (Portuguese), not `content`.
      if (msg) return msg.conteudo ?? '';
    } catch {
      // Repo error: fall through to literal interpretation.
    }
    // Treat content_ref as literal text (test / synthetic turns).
    return content_ref;
  },
};

// ---------------------------------------------------------------------------
// 9. HaikuClientAdapter
// ---------------------------------------------------------------------------

const haikuClientAdapter: HaikuClient = {
  async classify(params, options) {
    // Use callClaude with claude-haiku model for intent classification.
    const prompt = [
      `Classify the following text into one of these labels: ${params.allowed_labels.join(', ')}.`,
      `Return ONLY the label, nothing else.`,
      `Text: ${params.text}`,
    ].join('\n');

    try {
      const response = await callLLM({
        // Issue #508: o adapter se chama "Haiku" mas roda no tier MAIN desde
        // sempre. O workload preserva esse comportamento (a política em
        // src/lib/llm/workloads.ts o declara como main) — retierizar um
        // classificador é mudança de critério funcional e está fora do
        // escopo desta issue.
        workload: 'intent_classifier',
        system: 'You are a text classifier. Respond with ONLY the label, nothing else.',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: params.max_tokens,
        // O AbortController local que existia aqui era criado, encadeado ao
        // sinal do caller e nunca passado adiante: cancelar a classificação
        // não cancelava a requisição HTTP. Agora o sinal do caller vai
        // direto ao gateway, que o propaga até o SDK.
        signal: options?.signal,
      });
      const label = (response.content ?? '').trim().toLowerCase();
      const matched = params.allowed_labels.find(
        (l) => l.toLowerCase() === label,
      ) ?? 'unknown';
      return { label: matched, confidence: 0.85 };
    } catch {
      return { label: 'unknown', confidence: 0 };
    }
  },
};

// ---------------------------------------------------------------------------
// 10. MetricsClientAdapter
// ---------------------------------------------------------------------------

const metricsClientAdapter: MetricsClient = {
  increment(name, tags) {
    incCounter(name, tags);
  },
  recordHistogram(name, value, tags) {
    observeHistogram(name, value, tags);
  },
};

// ---------------------------------------------------------------------------
// 11. RiskScorerProdAdapter  (P9c scoreTurn → DE RiskScorer interface)
// ---------------------------------------------------------------------------

/**
 * Maps a DE intent label to a P9c TopicSignal.
 *
 * Groupings are intentionally coarse — the heuristic layer handles fine-grained
 * risk; this mapping only needs to correctly partition into the buckets that
 * affect the heuristic's piso (floor):
 *   financial → RiskLevel.MEDIUM piso
 *   legal / health / critical_decision → RiskLevel.HIGH piso
 *   casual / operational_simple → no floor
 *   unknown → ambiguous (gate will be consulted)
 */
function intentLabelToTopicSignal(label: string): TopicSignal {
  const normalized = label.toLowerCase();
  // Financial domain — transfers, billing, collections.
  if (
    normalized.includes('transfer') ||
    normalized.includes('financ') ||
    normalized.includes('pagamento') ||
    normalized.includes('cobranca') ||
    normalized.includes('cobrança') ||
    normalized.includes('cancel') ||
    normalized.includes('boleto') ||
    normalized.includes('pix')
  ) {
    return 'financial';
  }
  // Casual / social — greetings, chitchat.
  if (
    normalized.includes('chat') ||
    normalized.includes('saudacao') ||
    normalized.includes('saudação') ||
    normalized.includes('greet') ||
    normalized.includes('ola') ||
    normalized.includes('olá') ||
    normalized.includes('oi') ||
    normalized.includes('help') ||
    normalized.includes('ajuda')
  ) {
    return 'casual';
  }
  // Admin / setup — operational, low-risk.
  if (
    normalized.includes('admin') ||
    normalized.includes('setup') ||
    normalized.includes('config') ||
    normalized.includes('cadastro')
  ) {
    return 'operational_simple';
  }
  // Any label that doesn't match a known bucket → unknown (ambiguous; gate consulted).
  return 'unknown';
}

/**
 * Derives a list of `ToolKind` hints from `BaseContextPacket` signals.
 *
 * In P9c, tool_kinds is derived from the Skill's allowed_tools list. At this
 * point in the call stack (risk scoring) the Skill has not yet been selected
 * (SkillSelector runs after RiskScorer in the engine). We approximate from
 * intent label:
 *  - 'financial'  → likely involves transfer / write_external
 *  - everything else → no tool signal injected (heuristic stays at topic floor)
 *
 * This is intentionally conservative: we only inject 'transfer' if the intent
 * is clearly financial AND the base packet doesn't carry an authenticated actor
 * override — we want the heuristic to have a realistic floor, not over-block.
 */
function derivedToolKinds(
  topic: TopicSignal,
  _base: BaseContextPacket,
): ToolKind[] {
  if (topic === 'financial') {
    return ['transfer'];
  }
  return [];
}

/**
 * RiskScorerProdAdapter — Camada 3, stub #1/4.
 *
 * Bridges the DE `RiskScorer` interface to P9c's `scoreTurn` function:
 *
 *  Input mapping:
 *    intent.label  → TopicSignal (via intentLabelToTopicSignal)
 *    base.*        → TurnRiskSignals (authenticated status, sensitive memory, etc.)
 *
 *  Output mapping:
 *    ScoredRisk.level CRITICAL → 'high' + requires_human_review=true + 'critical_capped' reason
 *    ScoredRisk.level HIGH    → 'high' + requires_human_review=true
 *    ScoredRisk.level MEDIUM  → 'medium' + requires_human_review=false
 *    ScoredRisk.level LOW     → 'low'   + requires_human_review=false
 *
 *  The DE RiskLevel type only has 3 values ('low'|'medium'|'high'). P9c's
 *  ScoredRisk.level uses 4 (adds 'critical'). CRITICAL is capped at the
 *  interface boundary so the engine never sees a value outside its type contract.
 */
export class RiskScorerProdAdapter implements RiskScorer {
  async score(
    input: {
      intent: DecisionPacket['intent'];
      base: BaseContextPacket;
    },
    options?: { signal?: AbortSignal },
  ): Promise<DecisionPacket['risk_profile']> {
    const topic = intentLabelToTopicSignal(input.intent.label);
    const tool_kinds = derivedToolKinds(topic, input.base);

    const signals: TurnRiskSignals = {
      topic,
      tool_kinds: tool_kinds.length > 0 ? tool_kinds : undefined,
      active_sensitive_memory_count: input.base.active_sensitive_memory_count,
      // skill_confidence / skill_threshold not available at this stage (pre-SkillSelector).
      // risk_override not carried in BaseContextPacket directly — omit.
    };

    // Issue #507 (achado 2) — o sinal do turno segue até o `callLLM` do gate
    // Haiku. Antes ele parava aqui: o parâmetro existia, chamava-se `_options`
    // e nunca era lido.
    const scored = await scoreTurn(signals, options?.signal ? { signal: options.signal } : {});

    // Map P9c 4-level ScoredRisk → DE 3-level risk_profile.
    // Build reasons from triggers (audit-visible).
    const reasons: string[] = scored.triggers.map((t) => t.signal);
    if (scored.llm_reason) reasons.push(`llm_reason:${scored.llm_reason}`);

    switch (scored.level) {
      case RiskLevel.CRITICAL:
        // Cap CRITICAL → HIGH at the interface boundary. Record the cap so
        // callers can audit the original signal.
        reasons.push('critical_capped');
        return {
          level: 'high',
          reasons,
          requires_human_review: true,
        };
      case RiskLevel.HIGH:
        return {
          level: 'high',
          reasons,
          requires_human_review: true,
        };
      case RiskLevel.MEDIUM:
        return {
          level: 'medium',
          reasons,
          requires_human_review: false,
        };
      case RiskLevel.LOW:
      default:
        return {
          level: 'low',
          reasons,
          requires_human_review: false,
        };
    }
  }
}

// Singleton instance (stateless — safe to reuse across requests).
const riskScorerProdAdapter = new RiskScorerProdAdapter();

// ---------------------------------------------------------------------------
// Production env factory
// ---------------------------------------------------------------------------

/**
 * Assembles the real `CreateDecisionEngineEnv` from production adapters.
 *
 * Called once by `getDecisionEngine()` in `integration.ts`. The returned
 * env object is stateless (all state is in the underlying singletons) and
 * safe to reuse across requests.
 */
export function createProductionDecisionEngineEnv(): CreateDecisionEngineEnv {
  return {
    resolver: policyDescriptorResolverAdapter,
    policyEvaluator: policyDSLEvaluatorAdapter,
    policyRepo: policyRulesRepoAdapter,
    skillsRepo: skillsRepoAdapter,
    channelPolicies: channelPoliciesReaderAdapter,
    lockdownReader: lockdownReaderAdapter,
    proceduresRepo: proceduresRepoAdapter,
    contentResolver: contentResolverAdapter,
    haiku: haikuClientAdapter,
    metrics: metricsClientAdapter,
    // Stub #1/4 replaced: RiskScorerProdAdapter bridges DE's RiskScorer interface
    // to P9c's scoreTurn, mapping {intent, base} → TurnRiskSignals and
    // ScoredRisk (4 levels) → risk_profile (3 levels + requires_human_review).
    riskScorer: riskScorerProdAdapter,
  };
}
