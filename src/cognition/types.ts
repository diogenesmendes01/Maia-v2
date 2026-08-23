// P83-C5: Use value imports (not `import type`). The constants below
// are referenced in `typeof CognitiveEventType.X` / `typeof CandidateType.Y`
// type expressions; while TypeScript currently resolves those through the
// type binding, a future flip of `verbatimModuleSyntax` would erase the
// import and break compilation. Value imports work in both cases.
import { CognitiveEventType, CandidateType } from '@/types/enums.js';

/** Evento que dispara reflexão. Discriminated union por type. */
export type CognitiveEvent =
  | UserCorrectionEvent
  | SuccessExplicitEvent
  | ConversationClosedEvent
  | PatternDetectedEvent
  | InternalGapEvent;

export type UserCorrectionEvent = {
  type: typeof CognitiveEventType.USER_CORRECTION;
  conversa_id: string;
  inbound_mensagem_id: string;
  previous_assistant_mensagem_id: string;
  correction_text: string;
  previous_response_text: string;
};

export type SuccessExplicitEvent = {
  type: typeof CognitiveEventType.SUCCESS_EXPLICIT;
  conversa_id: string;
  inbound_mensagem_id: string;
  signal: string;
  context_summary: string;
};

export type ConversationClosedEvent = {
  type: typeof CognitiveEventType.CONVERSATION_CLOSED;
  conversa_id: string;
  transcript: string;
  summary: string;
  duration_minutes: number;
};

export type PatternDetectedEvent = {
  type: typeof CognitiveEventType.PATTERN_DETECTED;
  pattern_descriptor: string;
  evidence_count: number;
  evidence_ids: string[];
};

export type InternalGapEvent = {
  type: typeof CognitiveEventType.INTERNAL_GAP;
  conversa_id: string;
  inbound_mensagem_id: string;
  gap_description: string;
  attempted_response: string;
};

/** Candidato classificado. Discriminated union por type. */
export type ClassifiedCandidate =
  | FatoCandidate
  | RegraCandidate
  | ProcedimentoCandidate
  | LacunaCandidate
  | ToolRequestCandidate
  | DescarteCandidate;

export type FatoCandidate = {
  type: typeof CandidateType.FATO;
  content: string;
  scope: 'agent' | 'role' | 'conversation';
  subject_id?: string;
};

export type RegraCandidate = {
  type: typeof CandidateType.REGRA;
  contexto: string;
  acao: string;
  tipo: 'classificacao' | 'identificacao_entidade' | 'tom_resposta' | 'recorrencia';
  /**
   * METADATA-ONLY. The persister IGNORES this and computes confidence
   * deterministically (see `confidence.ts`). North-star invariant:
   * confidence is NEVER sourced from the LLM. Kept on the type to preserve
   * round-trip with the classifier schema; should never be read as
   * canonical confidence.
   */
  confianca_sugerida_llm?: number;
};

export type ProcedimentoCandidate = {
  type: typeof CandidateType.PROCEDIMENTO;
  nome: string;
  intencao: string;
  passos_draft: string[];
};

export type LacunaCandidate = {
  type: typeof CandidateType.LACUNA;
  capability_description: string;
  tipo: 'tool' | 'knowledge' | 'procedure';
  contexto: string;
};

export type ToolRequestCandidate = {
  type: typeof CandidateType.TOOL_REQUEST;
  tool_name_sketch: string;
  description: string;
  inputs_sketch: string;
  outputs_sketch: string;
};

export type DescarteCandidate = {
  type: typeof CandidateType.DESCARTE;
  reason: string;
};

/** Opções de runCognitiveModule. */
export type RunModuleOptions<TOut> = {
  name: string;
  version?: string;
  triggered_by: 'sync_required' | 'sync_conditional' | 'async_event';
  timeoutMs?: number;
  fallback?: TOut | (() => TOut);
  conversa_id?: string;
  turno_id?: string;
  audit?: boolean;
  /**
   * Issue #507 — CANCELAMENTO do caller (hoje: perda da lease do turno, via
   * `TurnExecutionContext.signal`).
   *
   * Opcional de propósito. `runCognitiveModule` tem ~30 call sites, e a maioria
   * roda FORA de um turno reivindicado (workers de batch, drift, KSM). Exigir o
   * sinal de todos seria uma migração grande sem defeito correspondente. Quem
   * passa o sinal opta pelo vocabulário novo (`status: 'cancelled'`); quem não
   * passa mantém exatamente o comportamento anterior.
   *
   * ATENÇÃO ao contrato: passar `signal` NÃO basta para cancelar de verdade. O
   * runner repassa o sinal composto ao `fn`, e é o `fn` que precisa entregá-lo
   * à operação subjacente — o parâmetro `signal` do gateway de LLM, por
   * exemplo. Sem isso o `Promise.race` devolve ao caller enquanto o trabalho
   * continua: o defeito que a #507 existe para fechar.
   */
  signal?: AbortSignal;
};

export type RunModuleResult<TOut> = {
  output: TOut | null;
  /**
   * Issue #507 — `cancelled` é ESTADO PRÓPRIO, não um sabor de `error`.
   *
   * Antes, um abort caía no `catch` genérico e virava `status='error'` com
   * `fallback_triggered=true`. No ReAct isso fazia um cancelamento DELIBERADO
   * (a lease do turno foi perdida) aparecer no log e na métrica como falha de
   * raciocínio — e o `cognitive_module_log` afirmava, para um turno que já não
   * era nosso, ou `success` (quando o LLM voltava antes de alguém olhar o
   * sinal) ou `error` (quando abortava). As duas linhas mentem sobre coisas
   * diferentes; nenhuma delas é "esta tentativa foi cancelada".
   *
   * `fallback_triggered` fica FALSE neste caminho: não houve degradação de
   * qualidade a explicar, houve interrupção. Marcar fallback aqui contaminaria
   * a taxa de fallback — a métrica que existe para dizer quanto o produto
   * degradou — com cancelamentos administrativos.
   */
  status: 'success' | 'timeout' | 'error' | 'skipped' | 'cancelled';
  fallback_triggered: boolean;
  latency_ms: number;
};

// P3a: Procedure types

export type ProcedureStep = {
  id: string;
  intencao: string;
  como: string;
  sucesso_criteria_ref?: string;
  armadilhas?: string[];
  tools_used?: string[];
  depends_on?: string[];
};

export type ProcedureSuccessCriterion =
  | { id: string; type: 'machine_check'; expression: string }
  | { id: string; type: 'tool_result'; tool: string; expected: string }
  | { id: string; type: 'user_signal'; signals: string[] }
  | { id: string; type: 'llm_judge'; prompt: string; threshold: number }
  | { id: string; type: 'human_confirmed'; requires_role: string };

export type ProcedureWhenApply = {
  conditions?: string[];
  tags?: string[];
  context_match?: Record<string, unknown>;
};

// P3c Task 4: forma tipada do critério llm_judge (já presente em
// ProcedureSuccessCriterion como union variant; aqui é o alias usado
// pelo step-evaluator-llm-judge para clareza nos call sites).
export type LLMJudgeCriterion = {
  id: string;
  type: 'llm_judge';
  prompt: string;
  threshold?: number;
  rubric?: string;
};
