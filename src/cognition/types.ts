import type { CognitiveEventType, CandidateType } from '@/types/enums.js';

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
};

export type RunModuleResult<TOut> = {
  output: TOut | null;
  status: 'success' | 'timeout' | 'error' | 'skipped';
  fallback_triggered: boolean;
  latency_ms: number;
};
