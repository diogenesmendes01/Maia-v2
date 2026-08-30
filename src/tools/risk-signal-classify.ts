/**
 * Issue #433 — `risk_signal_classify` (baseline.core).
 *
 * A universal capability: let the agent ask "how risky is this turn?" and get
 * back a deterministic, HEURISTIC-ONLY risk level + reasons + a recommended next
 * action — so it can decide whether to proceed, clarify, confirm, or escalate
 * BEFORE acting.
 *
 * REUSES the shared risk system end-to-end (NO second risk engine / enum):
 *   - The handler is a thin wrapper over `classifyTurnRisk`
 *     (`src/shared/risk/turn-risk-adapter.ts`), which extracts `TurnRiskSignals`
 *     from the raw text/structured input and delegates to `scoreTurnRisk`. The
 *     adapter is exported and domain-neutral so the sibling #431
 *     `case_risk_classify` composes the SAME helper.
 *
 * NO EXTERNAL LLM CALL (review fix, ALTO): as a baseline tool with
 * `required_actions: []` and a large free-text field, an ungated Anthropic call
 * would be an unbounded cost/privacy surface. So this tool passes an EXPLICIT
 * no-op gate (`async () => null`) into the shared scorer. The two-stage scorer
 * then runs heuristic-only: on an ambiguous turn it consults the (no-op) gate,
 * gets `null`, and keeps the deterministic heuristic level (escalating an
 * ambiguous LOW to MEDIUM via its fail-closed path) — it NEVER reaches
 * `haikuRiskGate`/Anthropic. `source` is therefore always `'heuristic'`. The
 * shared scorer's behaviour for its OTHER callers (the runtime turn path) is
 * unchanged — only THIS tool opts out of the gate.
 *
 * Conservative by construction:
 *   - side_effect: 'none', operation_type: 'parse_only' — pure classification,
 *     no business mutation, and (per the above) no external call at all.
 *   - required_actions: [] → universal baseline capability.
 *
 * Invariant #3 (backend decides, LLM proposes): the level is the deterministic
 * scorer's. The agent cannot inject a risk level — it only supplies the
 * text/signals to score, and the heuristic floor is never lowered.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { RiskLevel } from '@/types/enums.js';
import { classifyTurnRisk } from '@/shared/risk/turn-risk-adapter.js';
import type { LLMGate, ToolKind, TopicSignal } from '@/shared/risk/types.js';

/**
 * Explicit no-op LLM gate: returns `null` for any input. Wiring this into the
 * scorer forces the heuristic-only path — the scorer treats `null` as "the gate
 * couldn't decide", keeps the deterministic level, and makes NO Anthropic call.
 * Declared once at module scope so the tool never accidentally falls back to the
 * real `haikuRiskGate`.
 */
const NO_LLM_GATE: LLMGate = async () => null;

const TOPIC_VALUES = [
  'casual',
  'operational_simple',
  'financial',
  'legal',
  'health',
  'critical_decision',
  'unknown',
] as const satisfies readonly TopicSignal[];

const TOOL_KIND_VALUES = [
  'read_local',
  'read_external',
  'write_local',
  'write_external',
  'transfer',
  'irreversible',
  'communication',
] as const satisfies readonly ToolKind[];

const RISK_LEVEL_VALUES = [
  RiskLevel.LOW,
  RiskLevel.MEDIUM,
  RiskLevel.HIGH,
  RiskLevel.CRITICAL,
] as const;

const inputSchema = z.object({
  // The raw text of the turn to classify (user message and/or context). Used for
  // keyword topic/tool inference ONLY — the LLM gate is disabled for this
  // baseline tool, so the text never leaves the process. Capped to a sane bound
  // (review fix) since it is a large, ungated free-text field.
  text: z.string().max(4000).optional(),
  // Optional pre-classified topic (wins over keyword inference).
  topic: z.enum(TOPIC_VALUES).optional(),
  // Optional pre-known tool kinds the turn will likely use.
  tool_kinds: z.array(z.enum(TOOL_KIND_VALUES)).max(20).optional(),
  // Optional self-model signals.
  skill_confidence: z.number().min(0).max(1).optional(),
  skill_threshold: z.number().min(0).max(1).optional(),
  active_sensitive_memory_count: z.number().int().min(0).max(1000).optional(),
  active_procedure_has_critical_step: z.boolean().optional(),
});

const outputSchema = z.object({
  risk: z.enum(RISK_LEVEL_VALUES),
  reasons: z.array(z.string()),
  recommended_action: z.enum(['allow', 'clarify', 'confirm', 'handoff', 'block']),
  source: z.enum(['heuristic', 'llm_upgrade']),
});

export const riskSignalClassifyTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'risk_signal_classify',
  description:
    'Classificação determinística e heurística do risco do turno atual (low/medium/high/critical) sobre o scorer compartilhado, SEM nenhuma chamada externa de LLM. Retorna o nível, a próxima ação recomendada (allow/clarify/confirm/handoff) e a origem (source=heuristic). Sem efeito colateral.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
  effect_class: 'abort_safe',
  redis_required: false,
  operation_type: 'parse_only',
  audit_action: 'risk_signal_classified',
  handler: async (args) => {
    const result = await classifyTurnRisk({
      text: args.text,
      topic: args.topic,
      tool_kinds: args.tool_kinds,
      skill_confidence: args.skill_confidence,
      skill_threshold: args.skill_threshold,
      active_sensitive_memory_count: args.active_sensitive_memory_count,
      active_procedure_has_critical_step: args.active_procedure_has_critical_step,
      // Disable the LLM gate: this baseline tool is heuristic-only and must make
      // NO external Anthropic call (see file header). `source` is thus always
      // 'heuristic'.
      gate: NO_LLM_GATE,
    });
    return {
      risk: result.risk,
      reasons: result.reasons,
      recommended_action: result.recommended_action,
      source: result.source,
    };
  },
};
