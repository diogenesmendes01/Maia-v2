/**
 * Single source of truth para enums do Maia v2.
 * Valores literais em snake_case (convention §10.10 do spec).
 * Importar daqui, nunca duplicar strings espalhadas.
 *
 * O padrão `const X = {} as const` + `type X = typeof X[keyof typeof X]`
 * faz o nome viver em dois namespaces (valor + tipo). É legítimo em TS,
 * mas `no-redeclare` (mesmo a variante TS-aware) sinaliza como conflito.
 */
/* eslint-disable @typescript-eslint/no-redeclare */

export const TenantStatus = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  ARCHIVED: 'archived',
} as const;
export type TenantStatus = typeof TenantStatus[keyof typeof TenantStatus];

export const AgentStatus = {
  ACTIVE: 'active',
  PAUSED: 'paused',
  ARCHIVED: 'archived',
} as const;
export type AgentStatus = typeof AgentStatus[keyof typeof AgentStatus];

/**
 * Eventos cognitivos consumidos por workers de reflexão (item 1 do spec).
 * Esse enum cresce em P1; em P0 ele nasce com o mínimo pra cognitive_module_log
 * já registrar eventos do Reflector existente.
 */
export const CognitiveEventType = {
  USER_CORRECTION: 'user_correction',         // existente (P0)
  SUCCESS_EXPLICIT: 'success_explicit',       // P1 NEW
  CONVERSATION_CLOSED: 'conversation_closed', // P1 NEW
  PATTERN_DETECTED: 'pattern_detected',       // P1 NEW
  INTERNAL_GAP: 'internal_gap',               // P1 NEW
} as const;
export type CognitiveEventType = typeof CognitiveEventType[keyof typeof CognitiveEventType];

/**
 * Tipos de candidatos a conhecimento que peuvent ser capturados e armazenados.
 * Define 6 destinos de aprendizado do sistema.
 */
export const CandidateType = {
  FATO: 'fato',
  REGRA: 'regra',
  PROCEDIMENTO: 'procedimento',
  LACUNA: 'lacuna',
  TOOL_REQUEST: 'tool_request',
  DESCARTE: 'descarte',
} as const;
export type CandidateType = typeof CandidateType[keyof typeof CandidateType];

/**
 * P4 — Tipos de drift de identidade operacional detectados pelo sistema.
 * Mapeiam dimensões do comportamento que podem desviar do perfil ativo.
 *
 * P8d adiciona PAPEL_DRIFT (9º). P8b adiciona SOUL_DRIFT (8º) — registrado
 * em outra branch; quando aquela merge, este enum cresce naturalmente.
 */
export const DriftType = {
  TOM: 'tom',
  VALORES: 'valores',
  CONFIANCA: 'confianca',
  VIES: 'vies',
  ESCOPO: 'escopo',
  LINGUAGEM: 'linguagem',
  PROCEDIMENTO: 'procedimento',
  PAPEL_DRIFT: 'papel_drift',
} as const;
export type DriftType = typeof DriftType[keyof typeof DriftType];

/**
 * P4 — Severidade de drift detectado, define limiar de ação.
 */
export const DriftSeverity = {
  BAIXO: 'baixo',
  MEDIO: 'medio',
  ALTO: 'alto',
  CRITICO: 'critico',
} as const;
export type DriftSeverity = typeof DriftSeverity[keyof typeof DriftSeverity];

/**
 * P4 — Ciclo de vida do perfil operacional versionado.
 */
export const ProfileStatus = {
  PROPOSED: 'proposed',
  ACTIVE: 'active',
  FROZEN: 'frozen',
  ROLLED_BACK: 'rolled_back',
} as const;
export type ProfileStatus = typeof ProfileStatus[keyof typeof ProfileStatus];

/**
 * P4 — Decisão tomada pelo classificador de drift sobre o que fazer.
 */
export const DriftDecision = {
  AUTO_APPROVED: 'auto_approved',
  QUEUED_HUMAN: 'queued_human',
  FROZEN: 'frozen',
  ROLLBACK: 'rollback',
} as const;
export type DriftDecision = typeof DriftDecision[keyof typeof DriftDecision];

/**
 * P5 — Nível de escalada para lacunas detectadas (aquisição dialógica de
 * capacidades). 4 níveis determinísticos: silencioso (apenas log) ->
 * dashboard (visível para owner) -> mencionável (Maia pode pedir contexto)
 * -> proposto (spec formal aguardando decisão do owner).
 */
export const GapLevel = {
  SILENT: 'silent',
  DASHBOARD: 'dashboard',
  MENTIONABLE: 'mentionable',
  PROPOSED: 'proposed',
} as const;
export type GapLevel = typeof GapLevel[keyof typeof GapLevel];

/**
 * P5 — Ciclo de vida de uma proposta de capacidade (spec técnica gerada
 * pela Maia para fechar uma lacuna). Owner decide aprovação/rejeição;
 * delivered indica que a capacidade foi entregue.
 */
export const ProposalStatus = {
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  // P87-C3 — closed-loop test gate: post-approval, runs the proposal's
  // declared test_scenarios. Outcome decides delivered vs reverted.
  TESTING: 'testing',
  REJECTED: 'rejected',
  DELIVERED: 'delivered',
  // P87-C3 — terminal: a delivered capability later flagged failing in
  // the loop is reverted (and a technical_gap_id may be raised).
  REVERTED: 'reverted',
} as const;
export type ProposalStatus = typeof ProposalStatus[keyof typeof ProposalStatus];

/**
 * P5 — Resultado de teste pós-aquisição (loop fechado: a capacidade
 * adquirida realmente fecha a lacuna?).
 */
export const CapabilityTestOutcome = {
  PASS: 'pass',
  FAIL: 'fail',
  ERROR: 'error',
} as const;
export type CapabilityTestOutcome = typeof CapabilityTestOutcome[keyof typeof CapabilityTestOutcome];

/**
 * P6 — Comportamento de switching entre roles dentro de um canal/agente.
 * locked: role fixa (sem troca). prefer_handoff: prefere transferir
 * para outro agente em vez de trocar role. free_with_trigger: troca
 * livre mediante trigger explícito. by_context: troca automática por
 * contexto (com travas anti-oscilação).
 */
export const SwitchBehavior = {
  LOCKED: 'locked',
  PREFER_HANDOFF: 'prefer_handoff',
  FREE_WITH_TRIGGER: 'free_with_trigger',
  BY_CONTEXT: 'by_context',
} as const;
export type SwitchBehavior = typeof SwitchBehavior[keyof typeof SwitchBehavior];

/**
 * P6 — Origem da sugestão de role pelo seletor. LLM apenas sugere
 * (suggested_by); decisão final fica com a policy (decided_by).
 */
export const SuggestedBy = {
  LLM_CLASSIFIER: 'llm_classifier',
  DETERMINISTIC_CLASSIFIER: 'deterministic_classifier',
  NONE: 'none',
} as const;
export type SuggestedBy = typeof SuggestedBy[keyof typeof SuggestedBy];

/**
 * P6 — Origem da decisão final de role. Note que llm_classifier NÃO
 * aparece aqui: LLM nunca decide, apenas sugere. Policy/owner/fallback
 * são as únicas autoridades de decisão.
 */
export const DecidedBy = {
  POLICY_DEFAULT: 'policy_default',
  POLICY_RULE: 'policy_rule',
  OWNER_OVERRIDE: 'owner_override',
  FALLBACK_RULE: 'fallback_rule',
} as const;
export type DecidedBy = typeof DecidedBy[keyof typeof DecidedBy];

/**
 * P6 — Política de anúncio de troca de role ao usuário. affects_user
 * é o default: anuncia somente quando a troca muda a experiência
 * percebida pelo usuário.
 */
export const AnnounceMode = {
  ALWAYS: 'always',
  NEVER: 'never',
  AFFECTS_USER: 'affects_user',
} as const;
export type AnnounceMode = typeof AnnounceMode[keyof typeof AnnounceMode];

/**
 * P6 — Força do sinal do seletor de role (intensidade da evidência).
 * Combina com policy para decidir se troca ou mantém.
 */
export const RoleSelectorStrength = {
  WEAK: 'weak',
  MEDIUM: 'medium',
  STRONG: 'strong',
} as const;
export type RoleSelectorStrength = typeof RoleSelectorStrength[keyof typeof RoleSelectorStrength];

/**
 * P6 — Ação tomada pela decisão de role: manter atual, trocar,
 * transferir para outro agente, ou cair em regra de fallback.
 */
export const RoleDecisionAction = {
  KEEP_CURRENT: 'keep_current',
  SWITCH: 'switch',
  HANDOFF: 'handoff',
  FALLBACK: 'fallback',
} as const;
export type RoleDecisionAction = typeof RoleDecisionAction[keyof typeof RoleDecisionAction];

/**
 * P7 — Grafo cognitivo formal. Camada de execução de um módulo cognitivo
 * dentro do orquestrador declarativo. Os valores literais batem com o tipo
 * `triggered_by` de `RunModuleOptions` (src/cognition/types.ts), permitindo
 * passar `CognitiveLayer.X` direto sem cast.
 */
export const CognitiveLayer = {
  /** Caminho crítico — não pode falhar nem ser pulado. */
  SYNC_REQUIRED: 'sync_required',
  /** Rodado por turn se `runWhen` satisfeito; falha não derruba turn. */
  SYNC_CONDITIONAL: 'sync_conditional',
  /** Fire-and-forget pós-turn ou worker; nunca bloqueia user-facing reply. */
  ASYNC: 'async_event',
} as const;
export type CognitiveLayer = (typeof CognitiveLayer)[keyof typeof CognitiveLayer];

/**
 * Nomes de feature flags conhecidas. Cresce conforme fases ativam.
 */
export const FeatureFlagName = {
  // P0 — flag de smoke test (validador do framework de feature flags).
  // TODO(P1+): `P0_TENANT_GUARD_ENFORCED` é só um smoke flag — ela existe
  // pra validar que o framework funciona ponta-a-ponta (env → singleton →
  // isEnabled). NÃO é consultada em runtime; o `applyTenantGuard` é sempre
  // aplicado. Quando a primeira flag real entrar (ex.: P1 reflection toggle),
  // remover este comentário. Se este flag continuar sem caller até P2,
  // considerar removê-lo e reescrever os testes de feature-flags.spec.ts
  // contra a nova flag real.
  P0_TENANT_GUARD_ENFORCED: 'P0_TENANT_GUARD_ENFORCED',
  // P4 — identidade operacional v2 (perfil versionado + drift)
  OPERATIONAL_PROFILE_V2: 'OPERATIONAL_PROFILE_V2',
  // P5 — aquisição dialógica de capacidades (lacunas -> propostas)
  DIALOGICAL_ACQUISITION: 'DIALOGICAL_ACQUISITION',
  // P6 — separação Agent/Channel/Role + Role Policy (multi-canal)
  MULTI_CHANNEL: 'MULTI_CHANNEL',
  // P7 — grafo cognitivo formal (orquestração declarativa de módulos)
  COGNITIVE_GRAPH: 'cognitive_graph',
} as const;
export type FeatureFlagName = typeof FeatureFlagName[keyof typeof FeatureFlagName];
