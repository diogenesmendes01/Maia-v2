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

  // Topic
  if (sig.topic && sig.topic !== 'casual' && sig.topic !== 'operational_simple') {
    const lvl = TOPIC_RISK[sig.topic];
    if (lvl) pushTrigger(triggers, `topic:${sig.topic}`, lvl, 1);
  }

  // Tools
  for (const k of sig.tool_kinds ?? []) {
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
    sig.topic === 'critical_decision' &&
    (sig.tool_kinds ?? []).some(
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
  const topicMissing = !sig.topic || sig.topic === 'unknown';
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

export function scoreKnowledgeHeuristic(sig: KnowledgeRiskSignals): HeuristicResult {
  const triggers: RiskTrigger[] = [];

  // Topic
  if (sig.topic && sig.topic !== 'casual' && sig.topic !== 'operational_simple') {
    const lvl = TOPIC_RISK[sig.topic];
    if (lvl) pushTrigger(triggers, `topic:${sig.topic}`, lvl, 1);
  }

  // Tools envolvidas
  for (const k of sig.tool_kinds ?? []) {
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
    sig.knowledge_type === 'lacuna' &&
    (sig.topic === 'critical_decision' || sig.topic === 'legal' || sig.topic === 'health')
  ) {
    pushTrigger(triggers, 'knowledge:lacuna_in_sensitive_domain', RiskLevel.MEDIUM, 1);
  }

  let level = levelFromTriggers(RiskLevel.LOW, triggers);

  // Owner override
  level = applyOwnerOverride(level, sig.risk_override, triggers);

  // Ambiguous heuristics:
  //  - regra/procedimento com pouca evidência (<2) → revisar com LLM
  //  - lacuna sempre ambígua (precisa contexto humano para classificar)
  //  - knowledge_type sem topic explícito → ambíguo
  let ambiguous = false;
  if (
    (sig.knowledge_type === 'regra' || sig.knowledge_type === 'procedimento') &&
    (sig.evidence_count ?? 0) < 2
  ) {
    ambiguous = true;
  }
  if (sig.knowledge_type === 'lacuna') ambiguous = true;
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
