/**
 * Single source of truth para enums do Maia v2.
 * Valores literais em snake_case (convention §10.10 do spec).
 * Importar daqui, nunca duplicar strings espalhadas.
 */

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
 */
export const DriftType = {
  TOM: 'tom',
  VALORES: 'valores',
  CONFIANCA: 'confianca',
  VIES: 'vies',
  ESCOPO: 'escopo',
  LINGUAGEM: 'linguagem',
  PROCEDIMENTO: 'procedimento',
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
  REJECTED: 'rejected',
  DELIVERED: 'delivered',
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
 * Nomes de feature flags conhecidas. Cresce conforme fases ativam.
 */
export const FeatureFlagName = {
  // P0 — flag de smoke test (validador do framework)
  P0_TENANT_GUARD_ENFORCED: 'P0_TENANT_GUARD_ENFORCED',
  // P4 — identidade operacional v2 (perfil versionado + drift)
  OPERATIONAL_PROFILE_V2: 'OPERATIONAL_PROFILE_V2',
  // P5 — aquisição dialógica de capacidades (lacunas -> propostas)
  DIALOGICAL_ACQUISITION: 'DIALOGICAL_ACQUISITION',
} as const;
export type FeatureFlagName = typeof FeatureFlagName[keyof typeof FeatureFlagName];
