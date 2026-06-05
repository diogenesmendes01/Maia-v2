/**
 * Issue #433 — `risk_signal_classify` (baseline.core).
 *
 * A universal capability: let the agent ask "how risky is this turn?" and get
 * back a deterministic risk level + reasons + a recommended next action — so it
 * can decide whether to proceed, clarify, confirm, or escalate BEFORE acting.
 *
 * REUSES the shared risk system end-to-end (NO second risk engine / enum):
 *   - The handler is a thin wrapper over `classifyTurnRisk`
 *     (`src/shared/risk/turn-risk-adapter.ts`), which extracts `TurnRiskSignals`
 *     from the raw text/structured input and delegates to `scoreTurnRisk`
 *     (heuristic + Haiku gate, no-downgrade enforced). The adapter is exported
 *     and domain-neutral so the sibling #431 `case_risk_classify` composes the
 *     SAME helper.
 *
 * Conservative by construction:
 *   - side_effect: 'none', operation_type: 'parse_only' — pure classification,
 *     no business mutation, no external call (other than the optional Haiku gate,
 *     which is read-only inference).
 *   - required_actions: [] → universal baseline capability.
 *
 * Invariant #3 (backend decides, LLM proposes): the level is the deterministic
 * scorer's; the Haiku gate may only ELEVATE it, never downgrade. The agent
 * cannot inject a risk level — it only supplies the text/signals to score.
 */
import { z } from 'zod';
import type { Tool } from './_registry.js';
import { RiskLevel } from '@/types/enums.js';
import { classifyTurnRisk } from '@/shared/risk/turn-risk-adapter.js';
import type { ToolKind, TopicSignal } from '@/shared/risk/types.js';

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
  // keyword topic/tool inference AND forwarded to the Haiku gate as contextText.
  text: z.string().max(8000).optional(),
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
    'Classifica o risco do turno atual (low/medium/high/critical) e recomenda a próxima ação (allow/clarify/confirm/handoff). Determinístico — o nível vem do scorer compartilhado; sem efeito colateral.',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: [],
  side_effect: 'none',
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
    });
    return {
      risk: result.risk,
      reasons: result.reasons,
      recommended_action: result.recommended_action,
      source: result.source,
    };
  },
};
