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
  USER_CORRECTION: 'user_correction', // existente (reflection.ts)
} as const;
export type CognitiveEventType = typeof CognitiveEventType[keyof typeof CognitiveEventType];

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
} as const;
export type FeatureFlagName = typeof FeatureFlagName[keyof typeof FeatureFlagName];
