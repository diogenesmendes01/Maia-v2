/**
 * P6 Task 6 — Role selector shared types.
 *
 * Define input/output contracts compartilhados pelos suggesters (LLM + determinístico)
 * e pelo decider de policy (Task 7). LLM e determinístico SUGEREM via `suggested_by`;
 * a decisão final cabe à policy via `decided_by` (CHECK constraint no DB garante que
 * `decided_by != 'llm_classifier'`).
 *
 * `RoleCandidate.confidence` é sempre normalizado para [0,1]; `strength` é derivado
 * de `confidence` (mapping documentado em llm-suggester.ts: <0.5=weak, <0.8=medium,
 * >=0.8=strong). O decider usa strength para travas anti-oscilação em by_context.
 */
import type { Role, ChannelPolicy } from '@/db/schema.js';
import type { SuggestedBy, RoleSelectorStrength } from '@/types/enums.js';

export type RoleSelectorInput = {
  inbound_text: string;
  current_role: Role;
  available_roles: Role[];
  policy: ChannelPolicy;
  conversa_id?: string;
  channel_id?: string;   // propagado para audit (role_selector_decisions.channel_id)
  turno_id?: string;     // opcional, propagado para audit
  /**
   * Issue #507 (achado 2 da revisão do dono) — cancelamento da tentativa de
   * turno, vindo do node do grafo já composto com o timeout de 3 s do node.
   *
   * Dois destinos, e os dois importam: o `callLLM` do `llmSuggester` (para a
   * chamada em voo parar) e o guard imediatamente antes da gravação em
   * `role_selector_decisions` (para a decisão de um turno perdido não virar
   * row).
   */
  signal?: AbortSignal;
};

export type RoleCandidate = {
  role_id: string;
  role_key: string;
  confidence: number;
  strength: RoleSelectorStrength;
  suggested_by: SuggestedBy;
  reason: string;
};

export interface RoleSuggester {
  suggest(input: RoleSelectorInput): Promise<RoleCandidate | null>;
}
