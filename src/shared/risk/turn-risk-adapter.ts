/**
 * Issue #433 — `classifyTurnRisk`: the domain-neutral adapter that turns a RAW
 * turn (free text + optional pre-aggregated structured signals) into a scored
 * risk classification, REUSING the shared two-stage scorer
 * (`src/shared/risk/scorer.ts`). It introduces NO second risk engine and NO
 * second risk enum — `RiskLevel` and `scoreTurnRisk` are the single source.
 *
 * WHY THIS LIVES IN `shared/risk/` (not in the tool): two callers compose it.
 *   - `risk_signal_classify` (this issue, #433) — the baseline.core tool wraps
 *     this 1:1; the handler is a thin shell.
 *   - `case_risk_classify` (sibling #431) — a domain tool that composes the SAME
 *     helper, so the extraction → scorer → mapping logic is written ONCE.
 * Keeping it domain-neutral (no `ctx`, no repos, no tool import) is the contract
 * that makes both wrappers possible.
 *
 * The pipeline, mirroring `RiskScorerProdAdapter` in
 * `src/runtime/decision/prod-env.ts` (the runtime turn path) but generalised and
 * EXPORTED:
 *   1. SIGNAL EXTRACTION — `extractTurnRiskSignals(input)` derives a
 *      `TurnRiskSignals` struct (topic + tool_kinds) from free text, honoring any
 *      structured signals the caller already has (they WIN over keyword
 *      inference). The scorer never sees raw text as a signal — text only flows
 *      to the Haiku gate via `opts.contextText` (the scorer's contract).
 *   2. SCORE — `scoreTurnRisk(signals, { gate, contextText })`. The default gate
 *      is the real Haiku gate (`haikuRiskGate`); tests inject a stub. The scorer
 *      enforces the no-downgrade invariant (LLM may only ELEVATE).
 *   3. OUTPUT MAPPING — `ScoredRisk` → the tool's contract:
 *        level       → risk           (RiskLevel, unchanged 4-level scale)
 *        triggers    → reasons         (the trigger `signal` strings, audit-visible)
 *                    + triggers        (the raw RiskTrigger[] for downstream detail)
 *        decided_by  → source          ('heuristic' | 'llm_upgrade'; the issue's
 *                                       'combined' is NOT a real scorer value)
 *        level       → recommended_action  (NET-NEW deterministic mapping; the
 *                                           scorer does not provide this)
 *
 * Invariants:
 *   - #3 (backend decides, LLM proposes): the level is the deterministic
 *     scorer's, never a number the LLM emitted; the gate may only elevate.
 *   - The mapping never invents a level below the heuristic floor — it just
 *     re-labels the scorer's own `level`.
 */
import { RiskLevel } from '@/types/enums.js';
import { scoreTurnRisk } from './scorer.js';
import { haikuRiskGate } from './llm-gate.js';
import type {
  LLMGate,
  RiskTrigger,
  ScoredRisk,
  ToolKind,
  TopicSignal,
  TurnRiskSignals,
} from './types.js';

/**
 * The recommended next action a CALLER should take given the scored level. This
 * is net-new mapping logic (the scorer does not produce it). It is a SUGGESTION
 * for the agent loop — the dispatcher + policy layer remain the real authority
 * (a tool still can't execute just because this says 'allow').
 *
 *   low      → 'allow'    — proceed normally.
 *   medium   → 'clarify'  — ask a clarifying question before acting.
 *   high     → 'confirm'  — require explicit confirmation (ask_pending_question).
 *   critical → 'handoff'  — escalate to a human owner (handoff_to_owner).
 * `'block'` is reserved for callers that want a hard stop; the level mapping
 * never emits it on its own (a critical turn escalates rather than silently
 * blocks), but it is part of the union so a composing caller (e.g. #431 with a
 * stricter policy) can return it.
 */
export type RecommendedAction = 'allow' | 'clarify' | 'confirm' | 'handoff' | 'block';

/**
 * Input to `classifyTurnRisk`. EVERYTHING is optional so the helper is usable
 * from a bare tool call ("classify the current turn") up to a fully
 * pre-aggregated signal set. Structured signals, when present, OVERRIDE the
 * keyword inference (the caller knows better than a keyword scan).
 */
export interface ClassifyTurnRiskInput {
  /**
   * Free text of the turn (the user message and/or relevant context). Used for
   * keyword-based topic/tool inference AND forwarded to the Haiku gate as
   * `contextText`. The caller is responsible for PII redaction before passing it.
   */
  text?: string;
  /** Pre-classified topic (wins over keyword inference when provided). */
  topic?: TopicSignal;
  /** Pre-known tool kinds the turn will likely use (merged with inference). */
  tool_kinds?: ToolKind[];
  /** Self-model confidence in the active skill, [0,1]. */
  skill_confidence?: number;
  /** Minimum configured threshold for the active skill. */
  skill_threshold?: number;
  /** Count of ACTIVE sensitive memories (presence only, not content). */
  active_sensitive_memory_count?: number;
  /** The active procedure has a `critical_step` on the current path. */
  active_procedure_has_critical_step?: boolean;
  /** Owner-declared risk override (may only ELEVATE, per the heuristic). */
  risk_override?: RiskLevel;
  /**
   * Override the LLM gate (default: the real `haikuRiskGate`). Tests inject a
   * deterministic stub; offline environments can disable the LLM with a gate
   * that returns null.
   */
  gate?: LLMGate;
}

/** The classification result — the shape both #433 and #431 surface. */
export interface ClassifyTurnRiskResult {
  /** Final risk level from the deterministic scorer (4-level scale). */
  risk: RiskLevel;
  /** Audit-visible reasons: the trigger `signal` strings that summed to `risk`. */
  reasons: string[];
  /** The raw deterministic triggers (signal + contributes_to + weight). */
  triggers: ReadonlyArray<RiskTrigger>;
  /** Which stage decided the level: 'heuristic' or 'llm_upgrade'. */
  source: ScoredRisk['decided_by'];
  /** Net-new: the recommended next action derived from `risk`. */
  recommended_action: RecommendedAction;
}

// ---------------------------------------------------------------------------
// Keyword tables for topic inference. Domain-neutral and intentionally coarse:
// the heuristic layer (src/shared/risk/heuristic.ts) does the fine-grained
// floor; this only needs to partition text into the buckets that move the
// piso. Mirrors `intentLabelToTopicSignal` in prod-env.ts but covers the
// HIGH-floor topics (legal/health/critical_decision) too, since this is the
// reusable, domain-neutral entry point rather than the intent-label bridge.
// ---------------------------------------------------------------------------

const CRITICAL_DECISION_KEYWORDS = [
  'irrevers', // irreversível / irreversible
  'demit', // demitir
  'rescis', // rescisão
  'encerrar empresa',
  'fechar a conta',
  'deletar tudo',
  'apagar tudo',
  'excluir conta',
];

const LEGAL_KEYWORDS = [
  'juríd', // jurídico
  'jurid',
  'advogad',
  'process', // processo / processar
  'contrato',
  'legal',
  'lawsuit',
  'litig',
  'court',
  'intim', // intimação
];

const HEALTH_KEYWORDS = [
  'saúde',
  'saude',
  'médic', // médico
  'medic',
  'hospital',
  'doenç', // doença
  'sintoma',
  'health',
  'doctor',
  'diagnós', // diagnóstico
];

const FINANCIAL_KEYWORDS = [
  'transfer',
  'financ',
  'pagamento',
  'pagar',
  'cobranç',
  'cobranc',
  'boleto',
  'pix',
  'saldo',
  'fatura',
  'reembolso',
  'refund',
  'invoice',
  'payment',
];

const CASUAL_KEYWORDS = [
  'olá',
  'ola',
  'oi ',
  'bom dia',
  'boa tarde',
  'boa noite',
  'tudo bem',
  'obrigad',
  'hello',
  'hi ',
  'thanks',
  'thank you',
];

const OPERATIONAL_KEYWORDS = [
  'cadastr',
  'configur',
  'config',
  'setup',
  'admin',
  'relatório simples',
  'status',
];

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * Infer a `TopicSignal` from free text. Order matters: the highest-risk buckets
 * are checked first so a message that mixes "demitir" + "pagamento" classifies
 * as the more conservative `critical_decision`, not `financial`. Unmatched text
 * → `'unknown'` (the heuristic treats this as ambiguous and consults the gate).
 */
export function inferTopicFromText(text: string): TopicSignal {
  const t = text.toLowerCase();
  if (includesAny(t, CRITICAL_DECISION_KEYWORDS)) return 'critical_decision';
  if (includesAny(t, LEGAL_KEYWORDS)) return 'legal';
  if (includesAny(t, HEALTH_KEYWORDS)) return 'health';
  if (includesAny(t, FINANCIAL_KEYWORDS)) return 'financial';
  if (includesAny(t, OPERATIONAL_KEYWORDS)) return 'operational_simple';
  if (includesAny(t, CASUAL_KEYWORDS)) return 'casual';
  return 'unknown';
}

/**
 * Infer likely `ToolKind`s from free text + the inferred topic. Conservative,
 * mirroring `derivedToolKinds`: a financial / critical_decision turn that
 * mentions a transfer/payment likely touches a `transfer` tool (HIGH floor); a
 * clearly destructive phrasing implies `irreversible`. Otherwise no tool signal
 * is injected (the heuristic stays at the topic floor). De-duplicated.
 */
export function inferToolKindsFromText(text: string, topic: TopicSignal): ToolKind[] {
  const t = text.toLowerCase();
  const kinds = new Set<ToolKind>();
  if (
    includesAny(t, ['irrevers', 'deletar', 'apagar', 'excluir', 'delete', 'remove'])
  ) {
    kinds.add('irreversible');
  }
  if (
    topic === 'financial' ||
    includesAny(t, ['transfer', 'pix', 'pagar', 'pagamento', 'payment', 'transferir'])
  ) {
    kinds.add('transfer');
  }
  return [...kinds];
}

/**
 * Build the `TurnRiskSignals` struct the scorer consumes from a raw input.
 * Exported so a composing caller (#431) can reuse the SAME extraction before
 * its own scoring, or assert against it. Structured signals on `input` WIN over
 * keyword inference; tool kinds are the UNION of explicit + inferred.
 */
export function extractTurnRiskSignals(input: ClassifyTurnRiskInput): TurnRiskSignals {
  const text = input.text ?? '';
  const topic = input.topic ?? (text ? inferTopicFromText(text) : undefined);
  const inferredToolKinds =
    topic !== undefined && text ? inferToolKindsFromText(text, topic) : [];
  const mergedToolKinds = [...new Set([...(input.tool_kinds ?? []), ...inferredToolKinds])];

  return {
    topic,
    tool_kinds: mergedToolKinds.length > 0 ? mergedToolKinds : undefined,
    skill_confidence: input.skill_confidence,
    skill_threshold: input.skill_threshold,
    active_sensitive_memory_count: input.active_sensitive_memory_count,
    active_procedure_has_critical_step: input.active_procedure_has_critical_step,
    risk_override: input.risk_override,
  };
}

/**
 * Map a scored `RiskLevel` to the recommended next action (net-new logic the
 * scorer does not supply). Deterministic and total over the 4-level enum.
 */
export function recommendedActionForLevel(level: RiskLevel): RecommendedAction {
  switch (level) {
    case RiskLevel.LOW:
      return 'allow';
    case RiskLevel.MEDIUM:
      return 'clarify';
    case RiskLevel.HIGH:
      return 'confirm';
    case RiskLevel.CRITICAL:
      return 'handoff';
    default:
      // Fail-closed: an unexpected level (schema drift) escalates rather than
      // silently allowing. Unreachable with the current enum.
      return 'handoff';
  }
}

/**
 * The composable entry point. Extracts signals → scores with the shared two-
 * stage scorer → maps to the tool contract. Domain-neutral: no `ctx`, no repos,
 * no tool import — so #431 can import and compose it directly.
 */
export async function classifyTurnRisk(
  input: ClassifyTurnRiskInput,
): Promise<ClassifyTurnRiskResult> {
  const signals = extractTurnRiskSignals(input);
  const scored = await scoreTurnRisk(signals, {
    gate: input.gate ?? haikuRiskGate,
    // Free text flows to the gate as contextText (the scorer's contract), never
    // as a structured signal. Empty string is a valid weak-signal context.
    contextText: input.text ?? '',
  });

  return {
    risk: scored.level,
    reasons: scored.triggers.map((tr) => tr.signal),
    triggers: scored.triggers,
    source: scored.decided_by,
    recommended_action: recommendedActionForLevel(scored.level),
  };
}
