/**
 * P9c — Stage 1 do risk-assessor: heurística determinística.
 *
 * NÃO faz I/O. NÃO consulta repos. NÃO chama LLM. Recebe sinais já
 * agregados pelo caller e devolve `{ level, confidence, ambiguous, triggers }`.
 *
 * Por que determinístico:
 *  - Latência previsível (~µs).
 *  - Reproduzível em property tests.
 *  - É a fonte de verdade do "piso" de risco — o gate LLM só pode
 *    ELEVAR (cf. invariante no-downgrade em `scorer.ts`).
 *
 * As tabelas de peso abaixo são intencionalmente baixas-cardinalidade:
 * a heurística é uma função monotônica + saturação por nível, não um
 * regressor. Quando um sinal forte entra (irreversível, critical_step,
 * critical_decision) ele sozinho determina o piso; sinais médios
 * compõem por contagem.
 */
import { RiskLevel } from '@/types/enums.js';
import { maxRiskLevel } from './level.js';
import { logger } from '@/lib/logger.js';
import type {
  HeuristicResult,
  KnowledgeRiskSignals,
  RiskTrigger,
  ToolKind,
  TopicSignal,
  TurnRiskSignals,
} from './types.js';

// ---------------------------------------------------------------------------
// Tabelas declarativas (single source). Mudar pesos aqui propaga para os
// dois consumidores (turn + knowledge), preservando o invariante "mesma
// heurística em ambos".
// ---------------------------------------------------------------------------

const TOPIC_RISK: Record<TopicSignal, RiskLevel | null> = {
  casual: null,
  operational_simple: null,
  unknown: null,             // unknown não soma piso, mas marca ambíguo
  financial: RiskLevel.MEDIUM,
  legal: RiskLevel.HIGH,
  health: RiskLevel.HIGH,
  critical_decision: RiskLevel.HIGH, // 'critical' final só com tool sensível
};

const TOOL_RISK: Record<ToolKind, RiskLevel | null> = {
  read_local: null,
  read_external: null,
  communication: null,
  write_local: RiskLevel.MEDIUM,
  write_external: RiskLevel.MEDIUM,
  transfer: RiskLevel.HIGH,
  irreversible: RiskLevel.HIGH,
};

// ---------------------------------------------------------------------------
// Runtime validators (fail-closed on invalid strings from schema drift /
// deserialized rows). TypeScript does not protect runtime boundaries where
// unknown strings arrive from classifiers or DB. These guards ensure invalid
// values are treated conservatively instead of silently returning undefined
// from index lookups (which would suppress triggers → emit LOW with no audit).
// ---------------------------------------------------------------------------

const VALID_TOPICS = new Set<string>(Object.keys(TOPIC_RISK));
const VALID_TOOL_KINDS = new Set<string>(Object.keys(TOOL_RISK));
const VALID_KNOWLEDGE_TYPES = new Set<string>([
  'fato', 'regra', 'procedimento', 'lacuna', 'tool_request',
]);

/**
 * Coerce an unknown runtime topic string to a valid TopicSignal.
 * Invalid strings map to 'unknown' so that the caller treats the signal
 * as ambiguous (LLM gate will be consulted) rather than a silent no-op.
 */
function coerceTopic(raw: string | undefined): TopicSignal | undefined {
  if (raw === undefined) return undefined;
  if (VALID_TOPICS.has(raw)) return raw as TopicSignal;
  logger.warn(
    { module: 'risk_heuristic', invalid_topic: raw },
    'heuristic.invalid_topic_coerced_to_unknown',
  );
  return 'unknown';
}

/**
 * Coerce an unknown runtime tool kind string to a valid ToolKind.
 * Invalid tool kinds are mapped to 'irreversible' (the most restrictive
 * bucket) so that a schema drift does not suppress risk — it is more
 * conservative to assume the worst than to silently drop the signal.
 */
function coerceToolKind(raw: string): ToolKind {
  if (VALID_TOOL_KINDS.has(raw)) return raw as ToolKind;
  logger.warn(
    { module: 'risk_heuristic', invalid_tool_kind: raw },
    'heuristic.invalid_tool_kind_coerced_to_irreversible',
  );
  return 'irreversible';
}

/**
 * Validate knowledge_type. Invalid values are treated as 'lacuna' (always
 * ambiguous) so that an unrecognized type does not silently skip checks.
 */
function coerceKnowledgeType(raw: string): KnowledgeRiskSignals['knowledge_type'] {
  if (VALID_KNOWLEDGE_TYPES.has(raw)) {
    return raw as KnowledgeRiskSignals['knowledge_type'];
  }
  logger.warn(
    { module: 'risk_heuristic', invalid_knowledge_type: raw },
    'heuristic.invalid_knowledge_type_coerced_to_lacuna',
  );
  return 'lacuna';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pushTrigger(
  triggers: RiskTrigger[],
  signal: string,
  contributes_to: RiskLevel,
  weight: number,
): void {
  triggers.push({ signal, contributes_to, weight });
}

function levelFromTriggers(
  baseline: RiskLevel,
  triggers: ReadonlyArray<RiskTrigger>,
): RiskLevel {
  let current = baseline;
  for (const t of triggers) {
    current = maxRiskLevel(current, t.contributes_to);
  }
  return current;
}

function confidenceFromTriggers(triggers: ReadonlyArray<RiskTrigger>): number {
  if (triggers.length === 0) return 0.5;
  // Saturação suave: 1 sinal => 0.6, 2 => 0.75, 3+ => 0.85+
  const n = triggers.length;
  const c = 0.5 + 0.15 * Math.log2(n + 1);
  return Math.min(1, Math.round(c * 100) / 100);
}

function applyOwnerOverride(
  current: RiskLevel,
  override: RiskLevel | undefined,
  triggers: RiskTrigger[],
): RiskLevel {
  if (!override) return current;
  // Política: owner pode ELEVAR, nunca rebaixar (mesmo critério aplicado
  // ao LLM no scorer). Se override < current, ignoramos silenciosamente
  // mas registramos o sinal para auditoria.
  pushTrigger(triggers, 'owner:override', override, 1);
  return maxRiskLevel(current, override);
}

// ---------------------------------------------------------------------------
// API: Turn scoring
// ---------------------------------------------------------------------------

export function scoreTurnHeuristic(sig: TurnRiskSignals): HeuristicResult {
  const triggers: RiskTrigger[] = [];

  // Validate and coerce topic at the runtime boundary (fail-closed).
  const topic = coerceTopic(sig.topic);

  // Topic
  if (topic && topic !== 'casual' && topic !== 'operational_simple') {
    const lvl = TOPIC_RISK[topic];
    if (lvl) pushTrigger(triggers, `topic:${topic}`, lvl, 1);
  }

  // Validate and coerce tool_kinds at the runtime boundary (fail-closed).
  const toolKinds = (sig.tool_kinds ?? []).map(coerceToolKind);

  // Tools
  for (const k of toolKinds) {
    const lvl = TOOL_RISK[k];
    if (lvl) pushTrigger(triggers, `tool:${k}`, lvl, 1);
  }

  // Self-model abaixo do threshold
  if (
    typeof sig.skill_confidence === 'number' &&
    typeof sig.skill_threshold === 'number' &&
    sig.skill_confidence < sig.skill_threshold
  ) {
    const gap = sig.skill_threshold - sig.skill_confidence;
    const lvl = gap >= 0.4 ? RiskLevel.HIGH : RiskLevel.MEDIUM;
    pushTrigger(triggers, 'self_model:below_threshold', lvl, 1);
  }

  // Memória sensível ativa
  if ((sig.active_sensitive_memory_count ?? 0) > 0) {
    pushTrigger(
      triggers,
      'memory:sensitive_active',
      RiskLevel.MEDIUM,
      sig.active_sensitive_memory_count ?? 1,
    );
  }

  // Procedure com critical_step
  if (sig.active_procedure_has_critical_step) {
    pushTrigger(triggers, 'procedure:critical_step', RiskLevel.HIGH, 1);
  }

  // Composite: critical_decision + ferramenta sensível → critical.
  // Anotação explícita `RiskLevel`: sem ela, TS infere o tipo literal
  // `"low"` da inicialização e rejeita o reassign para `"critical"`.
  let baseline: RiskLevel = RiskLevel.LOW;
  if (
    topic === 'critical_decision' &&
    toolKinds.some(
      (k) => k === 'irreversible' || k === 'transfer' || k === 'write_external',
    )
  ) {
    baseline = RiskLevel.CRITICAL;
    pushTrigger(triggers, 'composite:critical_decision+sensitive_tool', RiskLevel.CRITICAL, 1);
  }

  let level = levelFromTriggers(baseline, triggers);

  // Owner override
  level = applyOwnerOverride(level, sig.risk_override, triggers);

  // Ambiguous: LOW com topic=unknown ou sem topic, OU MEDIUM sem trigger forte
  // (heurística de "vale a pena consultar Haiku para refinar?").
  const topicMissing = !topic || topic === 'unknown';
  const hasStrongTrigger = triggers.some(
    (t) => t.contributes_to === RiskLevel.HIGH || t.contributes_to === RiskLevel.CRITICAL,
  );
  let ambiguous = false;
  if (level === RiskLevel.LOW && topicMissing) ambiguous = true;
  if (level === RiskLevel.MEDIUM && !hasStrongTrigger) ambiguous = true;

  return {
    level,
    confidence: confidenceFromTriggers(triggers),
    ambiguous,
    triggers,
  };
}

// ---------------------------------------------------------------------------
// API: Knowledge scoring
// ---------------------------------------------------------------------------

/**
 * Helper: um tool_kind é "sensitive" no sentido de poder consumar uma
 * ação irreversível/destrutiva (transferir dinheiro, escrever em sistema
 * externo, executar ação não-revertível). Usado nos composites CRITICAL.
 */
function isSensitiveTool(k: ToolKind): boolean {
  return k === 'irreversible' || k === 'transfer' || k === 'write_external';
}

export function scoreKnowledgeHeuristic(sig: KnowledgeRiskSignals): HeuristicResult {
  const triggers: RiskTrigger[] = [];

  // Validate and coerce at runtime boundaries (fail-closed on invalid strings).
  const topic = coerceTopic(sig.topic);
  const knowledgeType = coerceKnowledgeType(sig.knowledge_type);
  const toolKinds = (sig.tool_kinds ?? []).map(coerceToolKind);

  // Topic
  if (topic && topic !== 'casual' && topic !== 'operational_simple') {
    const lvl = TOPIC_RISK[topic];
    if (lvl) pushTrigger(triggers, `topic:${topic}`, lvl, 1);
  }

  // Tools envolvidas
  for (const k of toolKinds) {
    const lvl = TOOL_RISK[k];
    if (lvl) pushTrigger(triggers, `tool:${k}`, lvl, 1);
  }

  // touches_irreversible (procedimento ou regra que aciona ação irreversível)
  if (sig.touches_irreversible) {
    pushTrigger(triggers, 'knowledge:touches_irreversible', RiskLevel.HIGH, 1);
  }

  // Confidence agregada baixa
  if (typeof sig.derived_confidence === 'number' && sig.derived_confidence < 0.5) {
    const lvl = sig.derived_confidence < 0.3 ? RiskLevel.HIGH : RiskLevel.MEDIUM;
    pushTrigger(triggers, 'knowledge:low_derived_confidence', lvl, 1);
  }

  // Lacuna em domínio crítico = pelo menos medium e ambíguo
  if (
    knowledgeType === 'lacuna' &&
    (topic === 'critical_decision' || topic === 'legal' || topic === 'health')
  ) {
    pushTrigger(triggers, 'knowledge:lacuna_in_sensitive_domain', RiskLevel.MEDIUM, 1);
  }

  // --------------------------------------------------------------------
  // Codex review #97 — finding 1: KNOWLEDGE CRITICAL composite.
  //
  // Antes desta regra, `scoreKnowledgeHeuristic` saturava em HIGH para
  // um procedimento de critical_decision + tool irreversível. Como
  // `applyGate` SKIPa o LLM para >=HIGH, esse caso ficava preso em HIGH
  // e nunca virava CRITICAL — o que para procedimentos PERSISTIDOS de
  // ação irreversível é under-classificação.
  //
  // O turn-path tem composite simétrico em scoreTurnHeuristic; aqui
  // ele estava faltando. Replicamos o mesmo formato + também tratamos
  // `touches_irreversible` (sinal específico do knowledge path).
  //
  // Tipos elegíveis: REGRA e PROCEDIMENTO (não fato/lacuna/tool_request)
  // — o conhecimento precisa ser ACIONÁVEL para virar critical via composite.
  // tool_request também elegível porque é literalmente um pedido para
  // criar uma capability que aciona ação sensível.
  // --------------------------------------------------------------------
  let baseline: RiskLevel = RiskLevel.LOW;
  const isActionable =
    knowledgeType === 'regra' ||
    knowledgeType === 'procedimento' ||
    knowledgeType === 'tool_request';
  const hasSensitiveTool = toolKinds.some(isSensitiveTool);
  const hasIrreversibleAction = hasSensitiveTool || sig.touches_irreversible === true;
  if (
    isActionable &&
    topic === 'critical_decision' &&
    hasIrreversibleAction
  ) {
    baseline = RiskLevel.CRITICAL;
    pushTrigger(
      triggers,
      'composite:knowledge_critical_decision+sensitive_action',
      RiskLevel.CRITICAL,
      1,
    );
  }

  let level = levelFromTriggers(baseline, triggers);

  // Owner override
  level = applyOwnerOverride(level, sig.risk_override, triggers);

  // Ambiguous heuristics:
  //  - regra/procedimento com pouca evidência (<2) → revisar com LLM
  //  - lacuna sempre ambígua (precisa contexto humano para classificar)
  //  - knowledge_type sem topic explícito → ambíguo
  let ambiguous = false;
  if (
    (knowledgeType === 'regra' || knowledgeType === 'procedimento') &&
    (sig.evidence_count ?? 0) < 2
  ) {
    ambiguous = true;
  }
  if (knowledgeType === 'lacuna') ambiguous = true;
  if (level === RiskLevel.MEDIUM) {
    const hasStrong = triggers.some(
      (t) => t.contributes_to === RiskLevel.HIGH || t.contributes_to === RiskLevel.CRITICAL,
    );
    if (!hasStrong) ambiguous = true;
  }

  return {
    level,
    confidence: confidenceFromTriggers(triggers),
    ambiguous,
    triggers,
  };
}
