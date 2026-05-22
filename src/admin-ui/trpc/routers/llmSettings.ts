/**
 * Admin UI — LLM settings router.
 *
 * Replaces the GET/POST `/dashboard/llm-settings` handlers from the legacy
 * Fastify dashboard (`src/dashboard/index.ts`, removed by PR #176). Those
 * handlers were the ONLY UI control for `setCurrentMainModel` /
 * `setCurrentFastModel` — an incident-response surface (Anthropic outage,
 * model deprecation, mid-deploy regression) that operators relied on to
 * switch the runtime model live, no redeploy.
 *
 * Procedures:
 *   - get      — current main/fast model + env defaults + provider
 *                (founder-only; the model switch UI itself is founder-gated,
 *                and this query backs that UI, so we keep the gate consistent).
 *   - catalog  — OpenRouter tool-calling-capable model list (cached 1 h).
 *                Founder-only for the same reason as `get`.
 *   - update   — flips `llm.model.main` / `llm.model.fast` AND appends an
 *                `admin_audit_log` row, both inside a single `withTx` —
 *                same atomicity pattern as `tenants.updateStatusAtomic`
 *                (issue #165) and `proposals.decideAtomically` (PR #101):
 *                if the audit insert throws, BOTH model facts roll back.
 *
 * Tenant-scope reality:
 *   The legacy llm-settings module stores the picks in `agent_facts` with
 *   `escopo='global'`, but `agent_facts` rows are keyed by
 *   `(tenant_id, agent_id, escopo, chave)` — the storage is silently
 *   tenant-scoped. We preserve that semantic by writing under
 *   `(session.tenant_id, 'default')` to match the env-default fallback
 *   shape. Runtime `callLLM` (in `src/lib/claude.ts`) reads inside its own
 *   `(tenant_id, agent_id)` context, so a founder's change here affects
 *   the founder's own tenant agents — not necessarily other tenants. This
 *   is the same scoping the legacy `/dashboard/llm-settings` had; making
 *   it truly global requires a separate `global_settings` table (deferred).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, founderProcedure } from '../server.js';
import {
  getCurrentMainModel,
  getCurrentFastModel,
  envDefaults,
} from '../../../lib/llm-settings.js';
import { getToolCallingModels } from '../../../lib/openrouter-models.js';
import { runWithTenantContext } from '../../../db/tenant-context.js';
import { withTx } from '../../../db/client.js';
import { admin_audit_log, agent_facts } from '../../../db/schema.js';

// Default agent slot used for storing the "global" model selection (see
// tenant-scope note in the file header). Hardcoded to 'default' to match
// the schema column DEFAULTs and the legacy dashboard's expectation.
const STORAGE_AGENT_ID = 'default';

const KEY_MAIN = 'llm.model.main';
const KEY_FAST = 'llm.model.fast';

// Model slugs are vendor-provided (`anthropic/claude-sonnet-4.6`,
// `openai/gpt-5`, `x-ai/grok-4.1-fast`, etc.). Keep the validation
// permissive (any printable chars, capped at 200 — same cap the legacy
// dashboard enforced) so operators can paste a freshly-published slug
// not yet in the OpenRouter catalog.
const ModelSlugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9._\-/:]+$/,
    'must contain only letters, digits, dot, underscore, hyphen, slash, or colon',
  );

const UpdateInputSchema = z.object({
  // Both required: operators must always set both explicitly so an incident
  // switch can't accidentally leave one side on the broken provider. Pass
  // the same value back to "keep it unchanged" — the audit row will record
  // that as a no-op for that side (see logic below).
  main: ModelSlugSchema,
  fast: ModelSlugSchema,
  comment: z
    .string()
    .min(10, 'comment must be at least 10 characters')
    .max(1000, 'comment must be at most 1000 characters'),
});

export const llmSettingsRouter = router({
  /**
   * Read current main+fast model along with env defaults and provider.
   * Wrapped in `runWithTenantContext` because `getCurrentMainModel` reads
   * `factsRepo.getByKey` which calls `getCurrentTenant()` internally.
   */
  get: founderProcedure.query(async ({ ctx }) => {
    const [main, fast] = await runWithTenantContext(
      { tenant_id: ctx.tenantId, agent_id: STORAGE_AGENT_ID },
      async () =>
        Promise.all([getCurrentMainModel(), getCurrentFastModel()]),
    );
    const env = envDefaults();
    return { main, fast, env };
  }),

  /**
   * OpenRouter tool-calling-capable model catalog. Cached 1h in-memory in
   * `getToolCallingModels` (see `src/lib/openrouter-models.ts`); on
   * network failure or first-call timeout, returns a curated fallback
   * list so the UI stays usable mid-Anthropic-outage.
   */
  catalog: founderProcedure.query(async () => {
    const items = await getToolCallingModels();
    return { items };
  }),

  /**
   * Atomic update: writes both model facts AND the audit row inside one
   * `withTx`. If the audit insert throws, neither model fact persists —
   * the surrounding transaction rolls back. Same invariant as
   * `tenantsRepo.updateStatusAtomic` (issue #165).
   *
   * Steps inside the tx:
   *   1. Read current main/fast (FOR UPDATE locks not needed — concurrent
   *      founders running this at the same moment is acceptable; the last
   *      writer wins and both writes are audited).
   *   2. UPSERT `llm.model.main` (only if changed — no-op write would
   *      pollute the audit "before"/"after" with identical values).
   *   3. UPSERT `llm.model.fast` (idem).
   *   4. INSERT `admin_audit_log` with action=`llm_model_changed`,
   *      change_summary capturing before/after for both sides + comment.
   *
   * Returns `{ ok: true, applied_at, before, after }` so the UI can show
   * exactly what changed. If neither side changed, `applied_at` is null
   * and `before === after`; no DB writes happen and no audit row is
   * appended (BAD_REQUEST instead).
   */
  update: founderProcedure
    .input(UpdateInputSchema)
    .mutation(async ({ input, ctx }) => {
      const result = await runWithTenantContext(
        { tenant_id: ctx.tenantId, agent_id: STORAGE_AGENT_ID },
        async () => {
          // Read CURRENT values OUTSIDE the tx for the before-snapshot.
          // Reading them inside withTx would also work but the snapshot is
          // for the audit row, not for any race-sensitive invariant.
          const beforeMain = await getCurrentMainModel();
          const beforeFast = await getCurrentFastModel();

          // No-op detection: if nothing changes, refuse rather than write
          // a meaningless audit row. (Caller can pass the same values to
          // intentionally "renew" the fact — but the operator workflow is
          // "change a model in incident", not "ping the audit log".)
          if (beforeMain === input.main && beforeFast === input.fast) {
            return {
              ok: false as const,
              reason: 'no_changes' as const,
              before: { main: beforeMain, fast: beforeFast },
            };
          }

          return await withTx(async (tx) => {
            const now = new Date();

            // Same upsert shape as factsRepo.upsert — kept inline so the
            // UPSERT runs against the in-tx `tx` (factsRepo.upsert uses
            // the connection-pool `db` and can't enroll in the caller's
            // transaction).
            if (beforeMain !== input.main) {
              await tx
                .insert(agent_facts)
                .values({
                  tenant_id: ctx.tenantId,
                  agent_id: STORAGE_AGENT_ID,
                  escopo: 'global',
                  chave: KEY_MAIN,
                  valor: { model: input.main },
                  fonte: 'configurado',
                  confianca: '1.00',
                  updated_at: now,
                })
                .onConflictDoUpdate({
                  target: [
                    agent_facts.tenant_id,
                    agent_facts.agent_id,
                    agent_facts.escopo,
                    agent_facts.chave,
                  ],
                  set: {
                    valor: { model: input.main },
                    fonte: 'configurado',
                    updated_at: now,
                  },
                });
            }

            if (beforeFast !== input.fast) {
              await tx
                .insert(agent_facts)
                .values({
                  tenant_id: ctx.tenantId,
                  agent_id: STORAGE_AGENT_ID,
                  escopo: 'global',
                  chave: KEY_FAST,
                  valor: { model: input.fast },
                  fonte: 'configurado',
                  confianca: '1.00',
                  updated_at: now,
                })
                .onConflictDoUpdate({
                  target: [
                    agent_facts.tenant_id,
                    agent_facts.agent_id,
                    agent_facts.escopo,
                    agent_facts.chave,
                  ],
                  set: {
                    valor: { model: input.fast },
                    fonte: 'configurado',
                    updated_at: now,
                  },
                });
            }

            // Audit in the SAME tx. If this throws, both UPSERTs above
            // roll back together — no unaudited model change reaches the
            // runtime read path.
            await tx.insert(admin_audit_log).values({
              tenant_id: ctx.tenantId,
              actor_id: ctx.userId,
              actor_role: ctx.userRole,
              action: 'llm_model_changed',
              resource_type: 'llm_settings',
              resource_id: null,
              change_summary: {
                before: { main: beforeMain, fast: beforeFast },
                after: { main: input.main, fast: input.fast },
                comment: input.comment,
              },
            });

            return {
              ok: true as const,
              applied_at: now,
              before: { main: beforeMain, fast: beforeFast },
              after: { main: input.main, fast: input.fast },
            };
          });
        },
      );

      if (!result.ok) {
        // Exhaustive narrowing: only one failure reason today.
        if (result.reason === 'no_changes') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'No changes — both main and fast already match the requested models',
          });
        }
        const _exhaustive: never = result.reason;
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `llmSettings.update unknown failure: ${String(_exhaustive)}`,
        });
      }

      return result;
    }),
});

// Test seam: exported so the router-level test can re-use the validation
// schema for input-shape assertions without importing zod directly.
export const _internal = {
  UpdateInputSchema,
  ModelSlugSchema,
  KEY_MAIN,
  KEY_FAST,
  STORAGE_AGENT_ID,
};

// Re-export aliases that the router test imports from `@/db/schema.js`
// indirectly (agent_facts / admin_audit_log are not exported here — only
// the schema reference is needed if a downstream test wants to introspect
// the table at runtime). Kept for future extension.
