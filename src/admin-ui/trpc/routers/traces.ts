/**
 * P8.5 — Tela 5 (Audit & Trace Explorer) router.
 *
 * Procedures:
 *   - listTraces             — paginated list of recent runtime traces
 *   - getTrace               — get redacted body + PEP decisions inline
 *   - requestFullSnapshot    — create a TTL-bounded debug_snapshot_grant
 *
 * Issue #514 §7: `listTraces`/`getTrace` were stubs returning `[]`/`null`
 * because P10b's tables did not exist when this router was written. They do
 * now, so both are wired to `runtimeTraceRepo`
 * (`src/db/repositories/runtime-trace-repos.ts`).
 *
 * Boundaries preserved:
 *   - `resolveTenantId()` + the existing RBAC are untouched; the repo ALSO
 *     scopes every query by tenant, so isolation does not depend on this layer
 *     alone.
 *   - The body returned here is the REDACTED one the body writer persisted.
 *     Un-redacted access stays behind the existing `debug_snapshot_grant`
 *     flow — this issue does not widen that permission.
 *   - Pagination is cursor/keyset based; there is no OFFSET and no COUNT.
 *
 * Post-Codex-review #101: tenantId derived from authenticated session.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';

const ListTracesSchema = z.object({
  tenantId: z.string().optional(),
  agentId: z.string().optional(),
  conversaId: z.string().uuid().optional(),
  fromDate: z.date().optional(),
  toDate: z.date().optional(),
  /** Envelope outcome filter. Enumerated — mirrors the P10b `Decision` type. */
  decision: z.enum(['allow', 'deny', 'soft_block', 'escalate', 'observe']).optional(),
  /** Only traces whose side effect actually touched the world. */
  sideEffectOnly: z.boolean().optional(),
  /** Surfaces bodies still pending or gone orphaned. */
  bodyStatus: z.enum(['pending', 'persisted', 'orphaned']).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
});

const GetTraceSchema = z.object({
  tenantId: z.string().optional(),
  traceId: z.string().uuid(),
});

const RequestSnapshotSchema = z.object({
  tenantId: z.string().optional(),
  traceId: z.string().uuid(),
  reason: z.string().min(20).max(2000),
  category: z.enum(['debugging', 'incident_response', 'audit_review', 'support']),
  ttlHours: z.number().int().min(1).max(72).default(24),
});

export const tracesRouter = router({
  listTraces: protectedProcedure
    .input(ListTracesSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      const page = await ctx.repos.runtimeTraceRepo.list({
        tenantId,
        agentId: input.agentId,
        conversaId: input.conversaId,
        fromDate: input.fromDate,
        toDate: input.toDate,
        decision: input.decision,
        sideEffectOnly: input.sideEffectOnly,
        bodyStatus: input.bodyStatus,
        limit: input.limit,
        cursor: input.cursor,
      });

      return {
        items: page.items.map((t) => ({
          // `id` kept as the display key for the existing pages; `trace_id` is
          // the canonical name and both point at the same UUID.
          id: t.trace_id,
          trace_id: t.trace_id,
          tenant_id: t.tenant_id,
          agent_id: t.agent_id,
          conversa_id: t.conversa_id,
          turno_id: t.turno_id,
          // Review round 2 [P1]: attempt grouping, so a retry is legible as a
          // retry instead of an unrelated trace.
          root_trace_id: t.root_trace_id,
          attempt: t.attempt,
          is_retry: t.attempt > 1,
          started_at: t.created_at,
          decision: t.decision,
          side_effect_level: t.side_effect_level,
          body_status: t.body_status,
          body_persisted_at: t.body_persisted_at,
          /**
           * The envelope records the DECISION, not a span duration — P10b has
           * no end timestamp, so a "duration" column here would be invented.
           * Kept as an explicit null rather than dropped so the existing table
           * column renders "—" instead of breaking. Real per-stage durations
           * arrive with the operational/OTLP spans (issue #514, still open).
           */
          duration_ms: null as number | null,
          outcome: t.decision,
        })),
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      };
    }),

  getTrace: protectedProcedure
    .input(GetTraceSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);

      const trace = await ctx.repos.runtimeTraceRepo.get({
        tenantId,
        traceId: input.traceId,
      });
      if (!trace) {
        // NOT_FOUND, never FORBIDDEN: a "forbidden" answer for another
        // tenant's trace would confirm the id exists — an existence oracle is
        // itself a cross-tenant leak.
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Trace não encontrado' });
      }

      // Un-redacted access remains behind the governed grant flow.
      const grant = await ctx.repos.debugSnapshotGrantsRepo.findActive({
        tenantId,
        userId: ctx.userId,
        traceId: input.traceId,
      });

      // Review round 2 [P1]: every attempt of this turn, so the detail page can
      // show "attempt 2 of 3" and link to the siblings. Falls back to just this
      // trace for rows written before migration 107 backfilled the root.
      const attempts = trace.root_trace_id
        ? await ctx.repos.runtimeTraceRepo.listAttempts({
            tenantId,
            rootTraceId: trace.root_trace_id,
          })
        : [];

      const packet = (trace.redacted_packet ?? null) as Record<string, unknown> | null;
      const hooks = Array.isArray(packet?.policy_hooks)
        ? (packet.policy_hooks as Array<Record<string, unknown>>)
        : [];

      return {
        trace_id: trace.trace_id,
        tenant_id: trace.tenant_id,
        agent_id: trace.agent_id,
        conversa_id: trace.conversa_id,
        turno_id: trace.turno_id,
        root_trace_id: trace.root_trace_id,
        attempt: trace.attempt,
        // The sibling attempts of the same turn, oldest first.
        attempts: attempts.map((a) => ({
          trace_id: a.trace_id,
          attempt: a.attempt,
          decision: a.decision,
          side_effect_level: a.side_effect_level,
          body_status: a.body_status,
          started_at: a.created_at,
          is_current: a.trace_id === trace.trace_id,
        })),
        attempt_count: attempts.length,
        started_at: trace.created_at,
        decision: trace.decision,
        side_effect_level: trace.side_effect_level,
        redaction_class: trace.redaction_class,
        redaction_applied: trace.redaction_applied,
        // Integrity surface. Review round 1 [P2]: this used to be
        // `envelope_hmac.length > 0`, which reported a TAMPERED envelope as
        // "signed" — worse than showing nothing, because an operator acts on
        // it during an incident. The repo now RECOMPUTES the HMAC over the
        // row's own fields and returns verified | invalid | unknown
        // (`unknown` = the key version's secret is not configured here, which
        // is a config gap, never evidence of tampering).
        hmac_key_version: trace.hmac_key_version,
        envelope_integrity: trace.integrity,
        envelope_signed: trace.integrity === 'verified',
        // Round 2 [P2]: the BODY carries its own `packet_hmac`, which was
        // persisted and never read back — the same omission the envelope check
        // just fixed. `absent` means "not persisted yet", not "failed to
        // verify" and not "invalid".
        body_integrity: trace.body_integrity,
        // Body lifecycle — makes "pending" and "orphaned" visible instead of
        // looking like an empty trace.
        body_status: trace.body_status,
        body_persisted_at: trace.body_persisted_at,
        body_available: trace.body_available,
        body_encrypted: trace.encrypted,
        redacted_packet: trace.redacted_packet,
        // PEP decisions come from the redacted body's `policy_hooks`, which the
        // redaction allowlist restricts to hook/outcome/error_code/duration —
        // never the operator's free-text reason.
        pep_decisions: hooks.map((h, i) => ({
          id: `${trace.trace_id}:${i}`,
          // `hook_name` is the PEP kind (early/mid/late) — surfacing it lets an
          // operator see WHERE in the chain the verdict came from.
          pep: String(h.hook_name ?? 'unknown'),
          decision: String(h.outcome ?? h.effect ?? 'unknown'),
          reason: String(h.error_code ?? ''),
          at: trace.created_at,
        })),
        // Every policy that participated, not just the blocking one.
        policy_refs: [
          ...new Set(
            [
              trace.policy_id,
              ...hooks.map((h) => (typeof h.hook_id === 'string' ? h.hook_id : null)),
            ].filter((p): p is string => typeof p === 'string' && p.length > 0),
          ),
        ],
        full_snapshot_available: grant !== null,
      };
    }),

  requestFullSnapshot: protectedProcedure
    .input(RequestSnapshotSchema)
    .mutation(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      ctx.assertRole('owner', 'compliance_officer', 'analyst', 'founder');

      const expiresAt = new Date(Date.now() + input.ttlHours * 60 * 60 * 1000);
      const grant = await ctx.repos.debugSnapshotGrantsRepo.create({
        tenant_id: tenantId,
        granted_to_user_id: ctx.userId,
        granted_by_user_id: ctx.userId, // self-grant; founder may grant to others (v1.1)
        trace_id: input.traceId,
        reason: input.reason,
        category: input.category,
        expires_at: expiresAt,
      });

      // Audit
      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: tenantId,
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
