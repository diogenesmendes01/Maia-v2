/**
 * Registro de política por workload (issue #508).
 *
 * O BACKEND decide tier, número de tentativas e se fallback é permitido — o
 * caller só declara a INTENÇÃO (`workload`). Isso é o que impede um módulo de
 * "pedir Sonnet" ou de inventar sua própria camada de retry.
 *
 * ⚠️ As políticas abaixo foram derivadas do comportamento OBSERVADO em
 * `origin/main@d93624b`, não do comportamento ideal. A migração da issue #508
 * é deliberadamente iso-comportamental:
 *
 *  - Call sites que passavam por `callLLM()` já tinham `CLAUDE_MAX_RETRIES`
 *    tentativas no modelo main + 1 fallback no fast → `max_attempts: undefined`
 *    (= configurado) e `allow_fast_fallback: true`.
 *  - Call sites que instanciavam o SDK direto faziam UMA chamada, sem retry e
 *    sem fallback, quase sempre dentro de um `runCognitiveModule` com timeout
 *    curto (2.5s–15s) → `max_attempts: 1`, `allow_fast_fallback: false`.
 *    Retentar dentro deles seria inútil (o backoff estoura o timeout do
 *    runner) e violaria "existe somente uma camada de retry".
 *
 * Retierizar classificadores (ex.: `intent_classifier` roda hoje no modelo
 * MAIN apesar do adapter se chamar "Haiku") é mudança de critério funcional e
 * está FORA do escopo desta issue — ver "Fora de escopo" em #508. O tier
 * declarado aqui reproduz o modelo efetivo de hoje; a correção é follow-up.
 */
import type { LLMTier, LLMWorkload } from './types.js';

export type WorkloadPolicy = {
  /**
   * Tier usado quando o caller não passa `tier` explícito — que é o caso de
   * praticamente todos.
   *
   * ESTE é o lugar onde o tier é declarado. A issue #508 pede que "todos os
   * callers declarem workload e tier"; a declaração de tier acontece aqui, uma
   * vez por workload, em vez de repetida em cada call site. O raciocínio
   * completo está em `src/lib/llm/types.ts`, no campo `tier` de
   * `LLMGatewayRequest` — resumo: o call site é exatamente quem não tem
   * contexto para escolher classe de modelo, e foi assim que 13 módulos
   * acabaram com slug fixo no código.
   */
  default_tier: LLMTier;
  /**
   * `undefined` → usa `config.CLAUDE_MAX_RETRIES`. Número → teto fixo.
   * Contagem é de TENTATIVAS (attempts), não de "retries": 1 = uma chamada.
   */
  max_attempts?: number;
  /**
   * Fallback para o modelo fast quando o primário esgota. Proibido para
   * workloads cujo contrato exige main (nenhum hoje) e para os que já rodam
   * em fast (fallback seria no-op) — em ambos os casos o downgrade silencioso
   * de qualidade é pior que o erro.
   */
  allow_fast_fallback: boolean;
};

const DEFAULT_POLICY: WorkloadPolicy = {
  default_tier: 'main',
  allow_fast_fallback: true,
};

/** Política de quem já passava por `callLLM()` (retry + fallback). */
const VIA_CALL_LLM: WorkloadPolicy = DEFAULT_POLICY;

/** Política de quem chamava o SDK direto (uma tentativa, sem fallback). */
const SINGLE_SHOT_FAST: WorkloadPolicy = {
  default_tier: 'fast',
  max_attempts: 1,
  allow_fast_fallback: false,
};

const SINGLE_SHOT_MAIN: WorkloadPolicy = {
  default_tier: 'main',
  max_attempts: 1,
  allow_fast_fallback: false,
};

const POLICIES: Record<LLMWorkload, WorkloadPolicy> = {
  // --- migrados de callLLM(): retry configurado + fallback para fast --------
  reasoner: VIA_CALL_LLM,
  intent_classifier: VIA_CALL_LLM,
  pending_gate: VIA_CALL_LLM,
  memory_classifier: VIA_CALL_LLM,
  conversation_classifier: VIA_CALL_LLM,
  behavioral_hint: VIA_CALL_LLM,
  procedure_selector: VIA_CALL_LLM,
  procedure_builder: VIA_CALL_LLM,
  reflection: VIA_CALL_LLM,
  summarizer: VIA_CALL_LLM,
  skill: VIA_CALL_LLM,
  playground: VIA_CALL_LLM,
  probe: VIA_CALL_LLM,

  // --- migrados de SDK direto: uma tentativa, sem fallback -----------------
  risk_classifier: SINGLE_SHOT_FAST,
  role_selector: SINGLE_SHOT_FAST,
  step_evaluator: SINGLE_SHOT_FAST,
  calendar_detector: SINGLE_SHOT_FAST,
  capability_proposer: SINGLE_SHOT_MAIN,
  drift_detector: SINGLE_SHOT_MAIN,
  vision: { default_tier: 'vision', max_attempts: 1, allow_fast_fallback: false },
};

export function workloadPolicy(workload: LLMWorkload): WorkloadPolicy {
  return POLICIES[workload] ?? DEFAULT_POLICY;
}

/** Exportado só para o teste de cobertura do registro. */
export const _internal = { POLICIES };
