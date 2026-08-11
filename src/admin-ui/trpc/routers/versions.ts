/**
 * P8.5 — Tela 3 (Version History & Rollback) router.
 *
 * Procedures:
 *   - listVersions      — list versions per source-of-truth (sotKind)
 *   - getInUseBy        — show which agents/conversations use a given version
 *   - rollback          — switch active version to an earlier one
 *
 * Post-Codex-review #101:
 *   - rollback NO LONGER returns status='rolled_back' for unwired SoTs. It now
 *     throws NOT_IMPLEMENTED so the operator gets an explicit recovery-failed
 *     signal during an incident instead of a false-positive.
 *   - The audit row is still appended on every attempt (success OR failure)
 *     so forensics can see who attempted what, when.
 *   - tenantId derived from session.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../server.js';
import { resolveTenantId } from '../tenant-resolver.js';
import { validateRollbackTarget } from '../../lib/rollback-targets.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';

const SotKindSchema = z.enum([
  'agent_operational_profile_versions',
  'policy_rules',
  'soul_biases',
  'skills',
]);

const ListInputSchema = z.object({
  tenantId: z.string().optional(),
  sotKind: SotKindSchema.optional(),
  agentId: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

const GetInUseBySchema = z.object({
  tenantId: z.string().optional(),
  agentId: z.string(),
  sotKind: SotKindSchema,
  sotId: z.string(),
});

const RollbackInputSchema = z.object({
  tenantId: z.string().optional(),
  sotKind: SotKindSchema,
  sotId: z.string(),
  fromVersion: z.number().int().min(1),
  toVersion: z.number().int().min(1),
  reason: z.string().min(10).max(2000),
});

/**
 * Wired source-of-truth kinds that have a rollback implementation. Until one
 * lands the per-SoT entry must throw NOT_IMPLEMENTED to avoid false-positive
 * incident recovery signals.
 *
 * Issue #481 item 5 — avaliado e mantido FORA DE ESCOPO daquela rodada de
 * dívidas: as três SoTs restantes não compartilham o desenho de
 * `agent_operational_profile_versions` (uma linha ATIVA por agente, alvos
 * `frozen`, lock no agente pai), então cada uma exige seu próprio desenho de
 * "ponteiro ativo" antes de qualquer código:
 *
 *   - `policy_rules`  (migração 036) — versionadas por `idx_policy_rules_version_uq`,
 *     mas o resolver casa regra por escopo/prioridade: reverter uma versão
 *     sem reavaliar o conjunto pode deixar duas regras conflitantes ativas;
 *   - `soul_biases`   (migração 038) — append-only encadeada por
 *     `previous_version_id`; "rollback" aqui é ANEXAR a reversão, não
 *     reativar uma linha antiga (o histórico é imutável por contrato);
 *   - `skills`        (migração 043) — o ciclo de vida (propose→approve→
 *     deprecate) já tem transições próprias; rollback precisa combinar com
 *     elas em vez de mexer no status por fora.
 *
 * Enquanto isso o contrato é: falhar ALTO (nunca devolver 'rolled_back' sem
 * mutar a fonte) e auditar a TENTATIVA. Coberto por
 * `tests/admin-ui/unit/versions-router.spec.ts`. Flipar um `false` aqui sem
 * escrever o branch correspondente cai no INTERNAL_SERVER_ERROR de
 * exaustividade no fim de `rollback` — de propósito.
 */
const ROLLBACK_IMPLEMENTED: Record<string, boolean> = {
  // Issue #468 — wired via operationalProfileVersionsRepo.adminRollbackAtomic
  // (demote active → rolled_back + re-activate frozen target + completion
  // audit, all in one tx under the parent-agent lock).
  agent_operational_profile_versions: true,
  policy_rules: false,
  soul_biases: false,
  skills: false,
};

export const versionsRouter = router({
  listVersions: protectedProcedure
    .input(ListInputSchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);

      // agent_operational_profile_versions is the only SoT with a wired list
      // path on main. It REQUIRES (tenant, agent) context (uses applyTenantGuard
      // + listByStatus). Other SoTs return [] until they get a repo helper.
      const wantKinds = input.sotKind
        ? [input.sotKind]
        : ['agent_operational_profile_versions' as const];

      const items: Array<{
        id: string;
        sot_kind: string;
        sot_id: string;
        version: number;
        status: string;
        created_at: Date;
      }> = [];

      const partiallyImplemented: string[] = [];

      for (const kind of wantKinds) {
        if (kind === 'agent_operational_profile_versions') {
          // Fan out: if agentId is supplied, use just that one; otherwise list
          // every agent in this tenant.
          const agentIds = input.agentId
            ? [input.agentId]
            : (await ctx.repos.agentsRepo.listByTenant(tenantId)).map((a) => a.id);

          for (const agentId of agentIds) {
            for (const status of ['proposed', 'active', 'frozen', 'rolled_back'] as const) {
              const rows = await runWithTenantContext(
                { tenant_id: tenantId, agent_id: agentId },
                async () =>
                  ctx.repos.operationalProfileVersionsRepo.listByStatus(status),
              );
              for (const r of rows) {
                items.push({
                  id: r.id,
                  sot_kind: 'agent_operational_profile_versions',
                  sot_id: r.agent_id,
                  version: r.version,
                  status: r.status,
                  created_at: r.created_at,
                });
              }
            }
          }
        } else {
          // policy_rules / soul_biases / skills don't have an admin-ui-shaped
          // list helper yet — track partial wiring so the UI can surface it.
          partiallyImplemented.push(kind);
        }
      }

      // Stable sort: newest first.
      items.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      const limited = items.slice(0, input.limit);

      return {
        items: limited,
        partially_implemented: partiallyImplemented,
      };
    }),

  getInUseBy: protectedProcedure
    .input(GetInUseBySchema)
    .query(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);

      if (input.sotKind === 'agent_operational_profile_versions') {
        // For an operational profile version, "in use by" = is it the active
        // version of its agent? If yes, surface the agent_id. Otherwise empty.
        const active = await runWithTenantContext(
          { tenant_id: tenantId, agent_id: input.agentId },
          async () => ctx.repos.operationalProfileVersionsRepo.getActive(),
        );
        const in_use_by: string[] = active && active.id === input.sotId ? [input.agentId] : [];
        return { in_use_by, partially_implemented: false as const };
      }

      // Other SoTs: in-use lookup not implemented yet — surface honestly
      // instead of silently saying "nothing uses it".
      return { in_use_by: [] as string[], partially_implemented: true as const };
    }),

  rollback: protectedProcedure
    .input(RollbackInputSchema)
    .mutation(async ({ input, ctx }) => {
      const tenantId = resolveTenantId(ctx, input.tenantId);
      ctx.assertRole('owner', 'compliance_officer', 'founder');

      if (!validateRollbackTarget(input.sotKind, input.fromVersion, input.toVersion)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid rollback target (must be earlier than current version)',
        });
      }

      // Always audit the ATTEMPT — operators can see who tried what, even if
      // the SoT isn't wired yet.
      await ctx.repos.adminAuditLogRepo.append({
        tenant_id: tenantId,
        actor_id: ctx.userId,
        actor_role: ctx.userRole,
        action: 'version_rollback_attempt',
        resource_type: input.sotKind,
        resource_id: input.sotId,
        change_summary: {
          from_version: input.fromVersion,
          to_version: input.toVersion,
          reason: input.reason,
          implemented: ROLLBACK_IMPLEMENTED[input.sotKind] ?? false,
        },
      });

      // Post-Codex-review #101: NEVER return 'rolled_back' without actually
      // mutating the source. Throw NOT_IMPLEMENTED so the operator's incident
      // playbook fails loudly instead of silently miring on stale state.
      if (!ROLLBACK_IMPLEMENTED[input.sotKind]) {
        throw new TRPCError({
          code: 'NOT_IMPLEMENTED',
          message:
            `Rollback for ${input.sotKind} is not implemented in admin-ui v1. ` +
            `Use the per-SoT repo directly or contact the platform team. ` +
            `Attempt has been logged to admin_audit_log.`,
        });
      }

      // Future per-SoT branches go here. Each MUST:
      //   1. Mutate the active-pointer in a transaction.
      //   2. Verify the active version actually changed (SELECT after UPDATE).
      //   3. Re-audit with action='version_rollback_completed' inside the same tx.
      if (input.sotKind === 'agent_operational_profile_versions') {
        // sotId carries the agent_id for this SoT (mirrors listVersions,
        // where sot_id := agent_id). The repo method validates existence,
        // current-active match, and target status under the parent-agent
        // lock — all checks here are translations, not decisions.
        const result = await ctx.repos.operationalProfileVersionsRepo.adminRollbackAtomic({
          tenant_id: tenantId,
          agent_id: input.sotId,
          from_version: input.fromVersion,
          to_version: input.toVersion,
          actor_id: ctx.userId,
          actor_role: ctx.userRole,
          reason: input.reason,
        });

        if (!result.ok) {
          if (result.reason === 'agent_missing') {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent not found' });
          }
          if (result.reason === 'active_mismatch') {
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                `Active version changed since you loaded this screen ` +
                `(expected v${input.fromVersion}, current ` +
                `${result.actual_active_version === null ? 'none' : `v${result.actual_active_version}`}). ` +
                `Refresh and retry.`,
            });
          }
          if (result.reason === 'target_not_found') {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: `Version v${input.toVersion} not found for this agent`,
            });
          }
          if (result.reason === 'target_invalid_status') {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message:
                `Version v${input.toVersion} is '${result.actual_status}' — only ` +
                `'frozen' versions can be re-activated (proposed was never ` +
                `approved; rolled_back is terminal).`,
            });
          }
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Rollback transition failed: ${result.reason}`,
          });
        }

        return {
          status: 'rolled_back' as const,
          activated: result.activated,
          rolled_back: result.rolled_back,
        };
      }

      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `BUG: ROLLBACK_IMPLEMENTED says ${input.sotKind} is wired but no branch handles it`,
      });
    }),
});
