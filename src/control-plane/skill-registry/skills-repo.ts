/**
 * P9a — skillsRepo (Source of Truth para Skill Contracts).
 *
 * Convenções:
 *  - Toda skill nasce em status='proposed' (DEFAULT na DB).
 *  - propose() incrementa version automaticamente (v1, v2, ...).
 *  - activate() é transacional: deprecate previous active + activate this one.
 *  - rollback() é transacional: marca como rolled_back + reativa version-1
 *    (que estava deprecated).
 *  - Lookups respeitam tenant_id do contexto (applyTenantGuard quando insert;
 *    SELECT inclui tenant_id no WHERE).
 *
 * Master spec v3.1.1 §2.4. Plan P9a Tasks 4.
 */
import { eq, and, desc, sql } from 'drizzle-orm';
import { db, withTx } from '@/db/client.js';
import { skills } from '@/db/schema.js';
import type { SkillRow, SkillContract } from '@/db/schema.js';
import { getCurrentTenant } from '@/db/tenant-context.js';

export type ProposeInput = SkillContract & {
  proposed_by: string;
  proposed_reason?: string;
  agent_id?: string | null;
  tenant_id?: string;
};

export interface SkillsRepo {
  /** Lookup hot path por descriptor + status='active'. Tenant-scoped. */
  findActive(descriptor: string, agent_id?: string | null): Promise<SkillRow | null>;

  /** Lista todas active dentro de uma category (para slice builder / Admin UI). */
  listByCategory(category: string): Promise<SkillRow[]>;

  /** Cria uma nova versão em status='proposed' (jamais 'active'). */
  propose(input: ProposeInput): Promise<SkillRow>;

  /**
   * Transacional: desativa previous active (deprecated) + marca a target como
   * active. Lança se a target não estiver em 'proposed'.
   */
  activate(id: string, approver: string, reason?: string): Promise<SkillRow>;

  /** Marca como deprecated sem reativar nada. */
  deprecate(id: string, deprecator: string, reason: string): Promise<SkillRow>;

  /**
   * Transacional: marca a target como rolled_back + reativa version-1 (se
   * existir e estiver deprecated). Versão anterior NÃO precisa ser a mesma
   * agent_id; usa-se (tenant, agent_or_tenant_wide, descriptor, version-1).
   */
  rollback(id: string, reason: string, rolledBackBy: string): Promise<SkillRow>;

  /** Lookup por id (tenant-scoped). */
  getById(id: string): Promise<SkillRow | null>;

  /** Lookup por descriptor + version (tenant-scoped). Sem version, retorna a mais recente. */
  getByDescriptor(descriptor: string, version?: number): Promise<SkillRow | null>;

  /** Lista todas as versões de um descriptor, mais recente primeiro. */
  listVersions(descriptor: string): Promise<SkillRow[]>;
}

export const skillsRepo: SkillsRepo = {
  async findActive(descriptor, agent_id): Promise<SkillRow | null> {
    const tenant_id = getCurrentTenant();
    const rows = await db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.tenant_id, tenant_id),
          eq(skills.skill_descriptor, descriptor),
          eq(skills.status, 'active'),
          // null agent_id means tenant-wide; explicit agent_id only matches that one.
          agent_id === undefined
            ? sql`true`
            : agent_id === null
            ? sql`agent_id IS NULL`
            : eq(skills.agent_id, agent_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async listByCategory(category): Promise<SkillRow[]> {
    const tenant_id = getCurrentTenant();
    return db
      .select()
      .from(skills)
      .where(
        and(
          eq(skills.tenant_id, tenant_id),
          eq(skills.category, category),
          eq(skills.status, 'active'),
        ),
      );
  },

  async propose(input): Promise<SkillRow> {
    const ctxTenant = getCurrentTenant();
    const tenant_id = input.tenant_id ?? ctxTenant;
    if (input.tenant_id && input.tenant_id !== ctxTenant) {
      throw new Error(`tenant mismatch: input ${input.tenant_id} vs context ${ctxTenant}`);
    }
    const agent_id = input.agent_id ?? null;

    // Determinar próxima version monotônica para (tenant, agent_or_tenant_wide, descriptor)
    const latestRows = await db
      .select({ version: skills.version })
      .from(skills)
      .where(
        and(
          eq(skills.tenant_id, tenant_id),
          eq(skills.skill_descriptor, input.skill_descriptor),
          agent_id === null ? sql`agent_id IS NULL` : eq(skills.agent_id, agent_id),
        ),
      )
      .orderBy(desc(skills.version))
      .limit(1);
    const nextVersion = (latestRows[0]?.version ?? 0) + 1;

    const [row] = await db
      .insert(skills)
      .values({
        tenant_id,
        agent_id,
        skill_descriptor: input.skill_descriptor,
        category: input.category,
        execution_mode: input.execution_mode,
        goal: input.goal,
        when_to_use: input.when_to_use,
        procedure: input.procedure,
        constraints: input.constraints ?? [],
        input_schema: input.input_schema,
        output_schema: input.output_schema,
        allowed_tools: input.allowed_tools ?? [],
        policy_descriptors: input.policy_descriptors ?? [],
        success_criteria: input.success_criteria ?? [],
        failure_modes: input.failure_modes ?? [],
        runtime_hints: input.runtime_hints ?? {},
        status: 'proposed',
        version: nextVersion,
        proposed_by: input.proposed_by,
        proposed_reason: input.proposed_reason ?? null,
      })
      .returning();
    return row!;
  },

  async activate(id, approver, reason): Promise<SkillRow> {
    const tenant_id = getCurrentTenant();
    return withTx(async (tx) => {
      const targetRows = await tx
        .select()
        .from(skills)
        .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
        .limit(1);
      const target = targetRows[0];
      if (!target) throw new Error('skill_not_found');
      if (target.status !== 'proposed') {
        throw new Error(`cannot_activate_from_${target.status}`);
      }

      // Deprecate previous active for the same (tenant, agent_or_tenant_wide, descriptor)
      await tx
        .update(skills)
        .set({ status: 'deprecated', deprecated_at: new Date() })
        .where(
          and(
            eq(skills.tenant_id, tenant_id),
            eq(skills.skill_descriptor, target.skill_descriptor),
            target.agent_id === null
              ? sql`agent_id IS NULL`
              : eq(skills.agent_id, target.agent_id),
            eq(skills.status, 'active'),
          ),
        );

      const now = new Date();
      const [updated] = await tx
        .update(skills)
        .set({
          status: 'active',
          activated_at: now,
          approved_by: approver,
          approved_at: now,
          // Append reason as a hint into proposed_reason chain when supplied;
          // dedicated approval_reason column is not in v3.1.1 schema.
          proposed_reason: reason
            ? `${target.proposed_reason ?? ''}${target.proposed_reason ? ' | ' : ''}approved: ${reason}`
            : target.proposed_reason,
        })
        .where(eq(skills.id, id))
        .returning();
      return updated!;
    });
  },

  async deprecate(id, _deprecator, _reason): Promise<SkillRow> {
    const tenant_id = getCurrentTenant();
    const [updated] = await db
      .update(skills)
      .set({ status: 'deprecated', deprecated_at: new Date() })
      .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
      .returning();
    if (!updated) throw new Error('skill_not_found');
    return updated;
  },

  async rollback(id, reason, _rolledBackBy): Promise<SkillRow> {
    const tenant_id = getCurrentTenant();
    return withTx(async (tx) => {
      const targetRows = await tx
        .select()
        .from(skills)
        .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
        .limit(1);
      const target = targetRows[0];
      if (!target) throw new Error('skill_not_found');

      const now = new Date();
      const [updated] = await tx
        .update(skills)
        .set({
          status: 'rolled_back',
          rolled_back_at: now,
          rollback_reason: reason,
        })
        .where(eq(skills.id, id))
        .returning();

      // Try to reactivate v-1 (deprecated). Best-effort: respects tenant +
      // agent_or_tenant_wide + descriptor + version-1.
      const previousRows = await tx
        .select()
        .from(skills)
        .where(
          and(
            eq(skills.tenant_id, tenant_id),
            eq(skills.skill_descriptor, target.skill_descriptor),
            target.agent_id === null
              ? sql`agent_id IS NULL`
              : eq(skills.agent_id, target.agent_id),
            eq(skills.version, target.version - 1),
          ),
        )
        .limit(1);
      const previous = previousRows[0];
      if (previous && previous.status === 'deprecated') {
        await tx
          .update(skills)
          .set({ status: 'active', activated_at: now })
          .where(eq(skills.id, previous.id));
      }

      return updated!;
    });
  },

  async getById(id): Promise<SkillRow | null> {
    const tenant_id = getCurrentTenant();
    const rows = await db
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, tenant_id), eq(skills.id, id)))
      .limit(1);
    return rows[0] ?? null;
  },

  async getByDescriptor(descriptor, version): Promise<SkillRow | null> {
    const tenant_id = getCurrentTenant();
    const filters = [
      eq(skills.tenant_id, tenant_id),
      eq(skills.skill_descriptor, descriptor),
    ];
    if (typeof version === 'number') {
      filters.push(eq(skills.version, version));
    }
    const rows = await db
      .select()
      .from(skills)
      .where(and(...filters))
      .orderBy(desc(skills.version))
      .limit(1);
    return rows[0] ?? null;
  },

  async listVersions(descriptor): Promise<SkillRow[]> {
    const tenant_id = getCurrentTenant();
    return db
      .select()
      .from(skills)
      .where(and(eq(skills.tenant_id, tenant_id), eq(skills.skill_descriptor, descriptor)))
      .orderBy(desc(skills.version));
  },
};
