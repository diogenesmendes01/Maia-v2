/**
 * P8.5 — Tela 4 (Drift & Incidents) router.
 *
 * Procedures:
 *   - listDriftAlerts   — paginated list of agent_drift_alerts (P4)
 *   - listIncidents     — PEP blocks + budget alerts + regression alerts
 *
 * PEP blocks / regression alerts depend on P9 (capability_test_runner +
 * pep_decisions). For P8.5 v1 they return [] until P9 lands.
 *
 * Post-Codex-review #101: tenantId derived from authenticated session.
 */
import { z } from 'zod';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';

const ListDriftSchema = z.object({
  tenantId: z.string().optional(),
  driftTypes: z.array(z.string()).optional(),
  severities: z.array(z.enum(['low', 'medium', 'high', 'critical'])).optional(),
  decision: z.enum(['auto_fix', 'queue', 'freeze', 'rollback']).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const ListIncidentsSchema = z.object({
  tenantId: z.string().optional(),
  category: z.enum(['pep_block', 'budget_alert', 'regression_alert']).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const driftRouter = router({
  listDriftAlerts: protectedProcedure
    .input(ListDriftSchema)
    .query(async ({ input, ctx }) => {
      const _tenantId = resolveTenantId(ctx, input.tenantId);
      // P4 agent_drift_alerts repo wired here once exposed; for now return empty.
      return { items: [] as Array<{
        id: string;
        drift_type: string;
        severity: string;
        decision: string | null;
        detected_at: Date;
      }> };
    }),

  listIncidents: protectedProcedure
    .input(ListIncidentsSchema)
    .query(async ({ input, ctx }) => {
      const _tenantId = resolveTenantId(ctx, input.tenantId);
      // P9 dependency: pep_decisions + capability_test_results joins.
      return {
        pep_blocks: [] as Array<{ id: string; pep_id: string; reason: string; at: Date }>,
        budget_alerts: [] as Array<{ id: string; budget_kind: string; threshold: number; at: Date }>,
        regression_alerts: [] as Array<{ id: string; capability_id: string; failure_count: number; at: Date }>,
      };
    }),
});
