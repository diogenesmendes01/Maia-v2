/**
 * P8.5 — public types shared between tRPC routers and React components.
 *
 * Source of truth for governance enums lives in `src/db/schema.ts`
 * (ProposalTypeId, RiskLevelId, ApprovalClassId, AdminUserRole). This file
 * re-exports those + adds UI-facing row shapes.
 */
import { z } from 'zod';
import type {
  AdminUserRole,
  ApprovalClassId,
  ProposalTypeId,
  RiskLevelId,
  ProposalUnifiedStatus,
} from '../../db/schema.js';

export type {
  AdminUserRole,
  ApprovalClassId,
  ProposalTypeId,
  RiskLevelId,
  ProposalUnifiedStatus,
};

// Zod schemas — kept in admin-ui (not at db layer) to keep db layer
// dependency-free. Values mirror the literal-union types above.
export const ProposalTypeSchema = z.enum([
  'policy_rule',
  'soul_bias',
  'skill',
  'capability_proposal',
  'knowledge_proposal',
]) satisfies z.ZodType<ProposalTypeId>;

export const RiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']) satisfies z.ZodType<RiskLevelId>;

export const ApprovalClassSchema = z.enum([
  'policy_rule_soft_guidance',
  'policy_rule_hard_limit',
  'soul_bias_core_value',
  'soul_bias_peripheral',
  'skill_new_domain',
  'skill_refinement',
  'capability_safe_tool',
  'capability_dangerous_tool',
  'capability_side_effect',
  'knowledge_rule',
  'knowledge_guidance',
  'knowledge_deprecated',
  'identity_drift_correction',
  'procedure_update',
]) satisfies z.ZodType<ApprovalClassId>;

export const AdminUserRoleSchema = z.enum([
  'founder',
  'compliance_officer',
  'owner',
  'analyst',
  'viewer',
]) satisfies z.ZodType<AdminUserRole>;

export const ProposalUnifiedStatusSchema = z.enum([
  'proposed',
  'pending_review',
  'rejected',
  'activated',
]) satisfies z.ZodType<ProposalUnifiedStatus>;

// =====================================================================
// Row shapes for React components / TanStack Table
// =====================================================================

export interface ProposalRow {
  id: string;
  type: ProposalTypeId;
  descriptor: string;
  risk: RiskLevelId;
  source: string;
  status: ProposalUnifiedStatus;
  proposed_at: Date;
  proposed_by: string;
}

export interface ProposalDetail extends ProposalRow {
  body: unknown;
  /** Architecture lock identifiers touched by this proposal. */
  locks: string[];
}

export interface VersionRow {
  id: string;
  sot_kind: 'policy_rules' | 'soul_biases' | 'skills' | 'agent_operational_profile_versions';
  sot_id: string;
  version: number;
  status: 'proposed' | 'active' | 'frozen' | 'rolled_back';
  created_at: Date;
  inUseBy?: string[];
}

export interface DriftAlertRow {
  id: string;
  drift_type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  decision: 'auto_fix' | 'queue' | 'freeze' | 'rollback' | null;
  detected_at: Date;
}

export interface TraceRow {
  id: string;
  conversa_id: string | null;
  agent_id: string;
  tenant_id: string;
  started_at: Date;
  duration_ms: number | null;
  outcome: 'ok' | 'error' | 'blocked' | null;
}

export interface AuditRow {
  id: number;
  actor_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  created_at: Date;
  change_summary: Record<string, unknown> | null;
}
