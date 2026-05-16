/**
 * P8.5 — Tela 5 (Audit & Trace Explorer) router.
 *
 * Procedures:
 *   - listTraces             — paginated list of recent runtime traces
 *   - getTrace               — get redacted body + PEP decisions inline
 *   - requestFullSnapshot    — create a TTL-bounded debug_snapshot_grant
 *
 * runtime_trace_bodies depends on P10b. For now, traces return [].
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../server.js';

const ListTracesSchema = z.object({
  tenantId: z.string(),
  agentId: z.string().optional(),
  conversaId: z.string().optional(),
  fromDate: z.date().optional(),
  toDate: z.date().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const GetTraceSchema = z.object({
  tenantId: z.string(),
  traceId: z.string().uuid(),
});

const RequestSnapshotSchema = z.object({
  tenantId: z.string(),
  traceId: z.string().uuid(),
  reason: z.string().min(20).max(2000),
  category: z.enum(['debugging', 'incident_response', 'audit_review', 'support']),
  ttlHours: z.number().int().min(1).max(72).default(24),
});

export const tracesRouter = router({
  listTraces: protectedProcedure
    .input(ListTracesSchema)
    .query(async ({ input, ctx }) => {
      ctx.assertTenant(input.tenantId);
      // P10b runtime_trace + runtime_trace_bodies repo wired here once available.
      return { items: [] as Array<{
        id: string;
        conversa_id: string | null;
        agent_id: string;
        tenant_id: string;
        started_at: Date;
        duration_ms: number | null;
        outcome: string | null;
      }> };
    }),

  getTrace: protectedProcedure
    .input(GetTraceSchema)
    .query(async ({ input, ctx }) => {
      ctx.assertTenant(input.tenantId);
      // Redaction policy from P10 applied here; for now return null body.
      // If user has an active debug_snapshot_grant, return un-redacted body.
      const grant = await ctx.repos.debugSnapshotGrantsRepo.findActive({
        tenantId: input.tenantId,
        userId: ctx.userId,
        traceId: input.traceId,
      });
      return {
        trace_id: input.traceId,
        redacted_packet: null as unknown,
        pep_decisions: [] as Array<{ id: string; decision: string; reason: string; at: Date }>,
        policy_refs: [] as string[],
        full_snapshot_available: grant !== null,
      };
    }),

  requestFullSnapshot: protectedProcedure
    .input(RequestSnapshotSchema)
    .mutation(async ({ input, ctx }) => {
      ctx.assertTenant(input.tenantId);
      ctx.assertRole('owner', 'compliance_officer', 'analyst', 'founder');

      const expiresAt = new Date(Date.now() + input.ttlHours * 60 * 60 * 1000);
      const grant = await ctx.repos.debugSnapshotGrantsRepo.create({
        tenant_id: input.tenantId,
        granted_to_user_id: ctx.userId,
        granted_by_user_id: ctx.userId, // self-grant; founder may grant to others (v1.1)
        trace_id: input.traceId,
        reason: input.reason,
        category: input.category,
        expires_at: expiresAt,
      });

      // Audit
      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: input.tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'debug_snapshot_grant',
        resource_type: 'runtime_trace',
        resource_id: input.traceId,
        change_summary: { reason: input.reason, category: input.category, ttl_hours: input.ttlHours },
      });

      return {
        grant_id: grant.id,
        expires_at: grant.expires_at,
      };
    }),
});
