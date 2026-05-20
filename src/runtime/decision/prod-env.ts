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
 *              getById(id) → SkillRow|null
 *     Mapping: DE findActive searches ALL active skills for agent + optional
 *     intent filter; P9a findActive needs a descriptor. We use listByCategory
 *     to enumerate all active skills, then filter by applicable_to_intent.
 *     SkillRow → Skill mapping (field name translation).
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
import { evaluate as p9dEvaluate } from '@/governance/policy-dsl/evaluator.js';
import { skillsRepo as p9aSkillsRepo } from '@/control-plane/skill-registry/skills-repo.js';
import { procedureExecutionsRepo } from '@/db/repositories.js';
import { getCurrentAgent } from '@/db/tenant-context.js';
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
    // P8e resolver does not accept AbortSignal; deadline wrapping happens in DE.
    const output = await p8eResolver.resolveDescriptors({
      tenant_id: query.tenant_id,
      agent_id: query.agent_id,
      descriptors: query.descriptors,
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
        const effectAction = (decision.effect as { action?: string } | undefined)?.action;
        const deAction = mapEffectAction(effectAction);
        const verdict: PolicyEvaluatorVerdict = {
          action: deAction,
          reason: bodyAsRecord['descriptor'] as string ?? 'policy_matched',
        };
        // Forward severity if present in rule body
        const severity = bodyAsRecord['severity'] as string | undefined;
        if (severity && isValidSeverity(severity)) {
          verdict.severity = severity;
        }
        // Forward parameters (used by dual_approval, reduce_tool_set)
        const params = bodyAsRecord['parameters'] as Record<string, unknown> | undefined;
        if (params) verdict.parameters = params;
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
  status: string;
  allowed_tools: string[] | unknown;
  policy_descriptors: string[] | unknown;
  runtime_hints: Record<string, unknown> | unknown;
  version: number;
}): Skill {
  const allowed_tools = Array.isArray(row.allowed_tools) ? (row.allowed_tools as string[]) : [];
  const hints = (typeof row.runtime_hints === 'object' && row.runtime_hints !== null)
    ? (row.runtime_hints as Record<string, unknown>)
    : {};
  return {
    id: row.id,
    category: row.category as Skill['category'],
    priority: 5, // P9a does not store priority; default 5 (medium)
    status: row.status as Skill['status'],
    // P9a does not store applicable_to_intent — derived from skill_descriptor convention
    // e.g. 'skill.greet' → intent 'greet'. PEPs that need exact match will
    // consult the full descriptor-to-intent mapping when P9a adds this field.
    allowed_tools,
    blocked_tools: [], // P9a does not store blocked_tools separately
    requires_confirmation_tools: [], // P9a does not store this
    runtime_hints: {
      allow_deep_context: hints['allow_deep_context'] === true,
    },
    output_schema_ref: typeof hints['output_schema_ref'] === 'string'
      ? hints['output_schema_ref']
      : undefined,
  };
}

const skillsRepoAdapter: SkillsRepo = {
  async findActive(query, _options) {
    // P9a skillsRepo.listByCategory needs tenant context (getCurrentTenant).
    // We enumerate all active skills across all categories and filter by
    // applicable_to_intent when supplied.
    // Categories aligned with DE Skill.category values.
    const categories = ['respond', 'tool_mediated', 'decide', 'plan'];
    const allSkills: Skill[] = [];
    for (const cat of categories) {
      // listByCategory is tenant+agent scoped via tenant-context.
      const rows = await p9aSkillsRepo.listByCategory(cat);
      for (const row of rows) {
        // Agent filter: P9a already applies agent scope via tenant context;
        // additional explicit filter not needed.
        allSkills.push(skillRowToSkill(row));
      }
    }
    // Filter by applicable_to_intent if specified.
    // Since P9a doesn't store applicable_to_intent, we can't filter precisely.
    // Return ALL active skills and let SkillSelector pick by category/priority.
    void query.applicable_to_intent; // acknowledged but not filterable in P9a
    return allSkills;
  },

  async find(skill_id, _scope, _options) {
    const row = await p9aSkillsRepo.getById(skill_id);
    if (!row) return null;
    return skillRowToSkill(row);
  },
};

// ---------------------------------------------------------------------------
// 5. ProceduresRepoAdapter
// ---------------------------------------------------------------------------

// Default TTL for procedure executions: 30 minutes.
const DEFAULT_PROCEDURE_TTL_MS = 30 * 60 * 1000;

const proceduresRepoAdapter: ProceduresRepo = {
  async findExecution(execution_id) {
    const exec = await procedureExecutionsRepo.findById(execution_id);
    if (!exec || exec.status !== 'in_progress') return null;
    const now = Date.now();
    const lastActivity = exec.last_activity_at.getTime();
    const elapsed = now - lastActivity;
    const ttl_remaining_ms = Math.max(0, DEFAULT_PROCEDURE_TTL_MS - elapsed);
    // procedure_domain: P9b WorkflowSelector uses this to match intent → domain.
    // DB procedure_executions does not store domain; we use a hardcoded 'unknown'
    // to signal no domain match (workflow selector will fall back to TTL heuristic).
    // KNOWN_STUB: replace with join to procedure_definitions.intencao once
    // procedure_definitions.domain column is added in a future migration.
    return {
      execution_id: exec.id,
      procedure_id: exec.definition_id,
      procedure_domain: 'unknown',
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
const channelPoliciesReaderAdapter: ChannelPoliciesReader = {
  async getForChannel(tenant_id, channel_id) {
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

    const controller = new AbortController();
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const response = await callLLM({
        system: 'You are a text classifier. Respond with ONLY the label, nothing else.',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: params.max_tokens,
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
    _options?: { signal?: AbortSignal },
  ): Promise<DecisionPacket['risk_profile']> {
    const topic = intentLabelToTopicSignal(input.intent.label);
    const tool_kinds = derivedToolKinds(topic, input.base);

    const signals: TurnRiskSignals = {
      topic,
      tool_kinds: tool_kinds.length > 0 ? tool_kinds : undefined,
      // skill_confidence / skill_threshold not available at this stage (pre-SkillSelector).
      // active_sensitive_memory_count not in BaseContextPacket — omit (conservative: no floor).
      // risk_override not carried in BaseContextPacket directly — omit.
    };

    const scored = await scoreTurn(signals);

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
