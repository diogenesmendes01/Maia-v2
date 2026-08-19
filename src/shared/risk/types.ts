/**
 * P9c — tipos compartilhados do risk-assessor.
 *
 * Os dois consumidores (TurnRiskScorer em `src/runtime/decision/` e
 * KnowledgeRiskScorer em `src/control-plane/knowledge-state-machine/`)
 * usam a MESMA heurística determinística (`scoreHeuristic`) e o MESMO
 * gate Haiku (`maybeRefineWithLLM`). Esses dois symbols vivem em
 * `src/shared/risk/` para evitar drift entre consumidores.
 *
 * Convention: tudo aqui é puro (sem I/O, sem repos, sem clock) — o
 * runtime do gate LLM injeta o callable. Assim o property test pode
 * gerar inputs e o adversarial test pode mockar o LLM sem tocar Anthropic.
 */
import type { RiskLevel } from '@/types/enums.js';

/**
 * Sinais determinísticos disponíveis para o turn (fluxo de decisão de
 * mensagem do agente). Agregados pelo caller a partir do estado do turno
 * — o scorer não consulta repos.
 */
export type TurnRiskSignals = {
  /** Classificação tópica determinística feita upstream (nullable). */
  topic?: TopicSignal;
  /** Tools que o turn provavelmente chamará. */
  tool_kinds?: ToolKind[];
  /** Confidence do self-model na skill ativa, [0,1]. */
  skill_confidence?: number;
  /** Threshold mínimo configurado para a skill. */
  skill_threshold?: number;
  /** Memórias sensíveis ativas (apenas presença, não conteúdo). */
  active_sensitive_memory_count?: number;
  /** Procedure ativa tem um passo `critical_step` no caminho atual. */
  active_procedure_has_critical_step?: boolean;
  /** Owner declarou risk override (trava ou eleva). */
  risk_override?: RiskLevel;
};

/**
 * Sinais determinísticos para o ciclo de vida de um pedaço de
 * conhecimento (regra/procedimento/fato sendo proposto/ativado/etc.).
 * Reaproveita os mesmos sub-tipos de tool/topic.
 */
export type KnowledgeRiskSignals = {
  /** Tipo do candidato. */
  knowledge_type: 'fato' | 'regra' | 'procedimento' | 'lacuna' | 'tool_request';
  /** Tópico inferido (sensível?). */
  topic?: TopicSignal;
  /** Confidence agregada determinística (NÃO o número que o LLM mandou). */
  derived_confidence?: number;
  /** Quantas evidências independentes suportam. */
  evidence_count?: number;
  /** Conhecimento toca em ação irreversível ou tool sensível. */
  touches_irreversible?: boolean;
  /** Tool kinds referenciados pelo conhecimento (proc passos, tool_request). */
  tool_kinds?: ToolKind[];
  /** Owner declarou risk override. */
  risk_override?: RiskLevel;
};

export type TopicSignal =
  | 'casual'
  | 'operational_simple'
  | 'financial'
  | 'legal'
  | 'health'
  | 'critical_decision'
  | 'unknown';

export type ToolKind =
  | 'read_local'
  | 'read_external'
  | 'write_local'
  | 'write_external'
  | 'transfer'
  | 'irreversible'
  | 'communication';

/**
 * Saída do estágio determinístico (sempre roda, sem LLM).
 *
 * `triggers` é a lista bruta dos motivos que somaram para chegar ao
 * `level`. Vai para `cognitive_module_log.metadata.triggers` e habilita
 * post-mortems sem reprocessar a entrada.
 */
export type HeuristicResult = {
  level: RiskLevel;
  /** Confidence determinística [0,1] derivada da quantidade de sinais. */
  confidence: number;
  /** True se Stage 2 (LLM) deve ser considerado pelo gate. */
  ambiguous: boolean;
  /** Traço auditável dos sinais que somaram. */
  triggers: ReadonlyArray<RiskTrigger>;
};

export type RiskTrigger = {
  signal: string;
  contributes_to: RiskLevel;
  weight: number;
};

/**
 * Saída do scorer completo (heurística + gate LLM opcional). Carrega a
 * decisão final + um diff do que o LLM moveu (se moveu), para que callers
 * publiquem em audit sem reconstruir.
 */
export type ScoredRisk = {
  level: RiskLevel;
  confidence: number;
  /** True se o LLM rodou (independentemente de ter mudado o nível). */
  llm_consulted: boolean;
  /**
   * True se o LLM tentou rebaixar (level menor que o heurístico). Quando
   * true, o resultado final IGNORA o LLM e mantém o nível heurístico —
   * registrado para detectarmos ataques/regressões na 3ª camada de defesa.
   */
  llm_attempted_downgrade: boolean;
  /** Triggers determinísticos (sempre presentes). */
  triggers: ReadonlyArray<RiskTrigger>;
  /** Razão dada pelo LLM (se consultado), opaca para o caller. */
  llm_reason?: string;
  /** Estágio final que produziu o nível: 'heuristic' ou 'llm_upgrade'. */
  decided_by: 'heuristic' | 'llm_upgrade';
};

/**
 * Interface do gate LLM (Haiku). Injeção de dependência para isolar do
 * SDK Anthropic em testes. Implementação real em
 * `src/shared/risk/llm-gate.ts`.
 *
 * Contrato:
 *  - Input: nível atual (heurístico) + texto contextual livre
 *    (preparado pelo caller, sem PII estruturada).
 *  - Output: nível sugerido pelo LLM + razão. Pode retornar null
 *    em timeout/erro/JSON malformado (runner já registrou).
 *  - O contrato NÃO força no-downgrade no LLM — esse invariante é
 *    enforced runtime na camada do scorer (defesa em profundidade).
 */
export type LLMGate = (input: {
  current_level: RiskLevel;
  context_text: string;
  /**
   * Issue #507 (achado 2 da revisão do dono) — cancelamento do caller.
   *
   * Este gate é a ÚNICA chamada de LLM do caminho do Decision Engine que ainda
   * não recebia sinal: `engine.run` já compõe o seu e o repassa a
   * `riskScorer.score(..., { signal })`, mas a cadeia parava aqui e o Haiku
   * seguia pago depois de a lease do turno cair.
   *
   * Opcional porque o outro consumidor (`scoreKnowledgeRisk`, no control-plane)
   * não roda dentro de um turno reivindicado.
   */
  signal?: AbortSignal;
}) => Promise<{ suggested_level: RiskLevel; reason: string } | null>;
