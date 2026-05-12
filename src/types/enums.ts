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
 * Nomes de feature flags conhecidas. Cresce conforme fases ativam.
 */
export const FeatureFlagName = {
  // P0 — flag de smoke test (validador do framework)
  P0_TENANT_GUARD_ENFORCED: 'P0_TENANT_GUARD_ENFORCED',
} as const;
export type FeatureFlagName = typeof FeatureFlagName[keyof typeof FeatureFlagName];
