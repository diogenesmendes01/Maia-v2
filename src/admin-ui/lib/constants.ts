/**
 * P8.5 — UI constants used across screens.
 */

export const DRIFT_TYPES = [
  'tom',
  'valores',
  'linguagem',
  'operacao',
  'tomada_decisao',
  'emocional',
  'interacao',
  'limites',
  'dominio',
] as const;

export type DriftType = (typeof DRIFT_TYPES)[number];

export const SEVERITY_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

export const DECISION_MODES = ['auto_fix', 'queue', 'freeze', 'rollback'] as const;
export type DecisionMode = (typeof DECISION_MODES)[number];

export const SOT_KINDS = [
  'agent_operational_profile_versions',
  'policy_rules',
  'soul_biases',
  'skills',
] as const;
export type SotKind = (typeof SOT_KINDS)[number];

export const TRACE_OUTCOMES = ['ok', 'error', 'blocked'] as const;
export type TraceOutcome = (typeof TRACE_OUTCOMES)[number];

export const SNAPSHOT_GRANT_CATEGORIES = [
  'debugging',
  'incident_response',
  'audit_review',
  'support',
] as const;
export type SnapshotGrantCategory = (typeof SNAPSHOT_GRANT_CATEGORIES)[number];

/**
 * Architecture lock identifiers tracked by approval matrix.
 * Touching any of these requires founder role.
 */
export const ARCHITECTURE_LOCKS = [
  'precedence_pyramid',
  'soul_immutable_core',
  'identity_immutable_core',
  'tool_blast_radius',
] as const;
export type ArchitectureLock = (typeof ARCHITECTURE_LOCKS)[number];
