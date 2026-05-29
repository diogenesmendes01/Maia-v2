import { AsyncLocalStorage } from 'async_hooks';
import { incCounter } from '@/lib/metrics.js';

export class MissingTenantContextError extends Error {
  // Error code estável (não-traduzível) pra UI/dashboards que precisem
  // distinguir esse erro programaticamente sem fazer string match.
  readonly code = 'MISSING_TENANT_CONTEXT';

  constructor(reason?: string) {
    // Mensagem técnica em PT (target: devs/operadores). Não exposta a end-user.
    // UI deve usar `.code === 'MISSING_TENANT_CONTEXT'` pra traduzir/i18n
    // (PR #75 review, Superpowers finding #11).
    const base = 'Tenant context não está disponível — toda query precisa rodar dentro de runWithTenantContext';
    super(reason ? `${base} (${reason})` : base);
    this.name = 'MissingTenantContextError';
  }
}

/**
 * Distinct error for `'default'` literal rejection (issue #282).
 *
 * Surfaces a separate code so dashboards/alerts can distinguish "no ALS at
 * all" (`MISSING_TENANT_CONTEXT`) from "ALS carries the legacy sentinel"
 * (`TENANT_ID_DEFAULT_LITERAL_REJECTED`). The latter signals a path that
 * SHOULD have been migrated to a real tenant/agent pair (per the inviolable
 * isolation invariant) but wasn't.
 *
 * Throw behaviour is opt-in via `MAIA_REJECT_DEFAULT_LITERAL=true` so we can
 * land the warning+metric observability first, watch the counter in
 * production, and flip the throw on once every legacy path is migrated.
 */
export class DefaultLiteralRejectedError extends Error {
  readonly code = 'TENANT_ID_DEFAULT_LITERAL_REJECTED';

  constructor(field: 'tenant_id' | 'agent_id') {
    super(
      `Tenant context carries literal 'default' for ${field} — this sentinel was reachable from legacy paths and violates the inviolable multi-tenant isolation invariant. ` +
        `Migrate the caller to a real ${field} or remove the synthetic context.`,
    );
    this.name = 'DefaultLiteralRejectedError';
  }
}

type TenantContext = {
  tenant_id: string;
  agent_id: string;
};

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Read the opt-in flag at access time (NOT module-load time) so tests can
 * flip it per-case without re-importing.
 */
function shouldThrowOnDefaultLiteral(): boolean {
  return process.env.MAIA_REJECT_DEFAULT_LITERAL === 'true';
}

export async function runWithTenantContext<T>(
  ctx: TenantContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

// Fail-closed guard: ALS may carry a malformed context object
// (`{ tenant_id: '', agent_id: null as any }`) when an upstream caller wraps
// `runWithTenantContext` with garbage. Without this check, callers would get
// the empty/nullish value back and any downstream `WHERE tenant_id = $1`
// would either crash on type mismatch (best case) or return rows scoped to
// the wrong-and-likely-empty tenant (worst case, cross-tenant leak).
// Para cache keys (holidays-cache, etc.): falsy agent_id geraria key
// malformada `holidays:v2:tenantA::entidade:2026:standard` que colide
// silenciosamente com outros contextos malformados — exatamente o leak que
// PR #263 fechou para o caso de `agent_id` ausente da key.
//
// **Whitespace-only IDs (#272 reval — convergente com issue #283):** strings
// como `'   '` ou `'\t'` passariam o check `!str` (truthy), mas geram
// namespace anômalo (`holidays:v3:acme:%20%20%20:...`) que ainda é
// determinístico — colide com qualquer outro contexto que carregue o mesmo
// padrão de whitespace. Rejeitar `.trim().length === 0` fecha a porta.
//
// **Overlap com PR #293:** PR #293 (`fix(tenant-context): reject whitespace-only
// tenant_id/agent_id`) implementa o mesmo guard centralmente. Se #293 mergear
// primeiro, este diff vira no-op (mesma validação, msg ligeiramente diferente).
// Se este mergear primeiro, #293 resolve trivialmente. Sem conflito semântico.
//
// **Literal `'default'` rejection (issue #282):** the legacy sentinel
// `{tenant_id:'default', agent_id:'default'}` was reachable from several
// paths (channel-resolver fallback, base-context-builder DI default,
// worker scaffolding) and creates a synthetic shared context that
// violates tenant isolation. Until every legacy path is migrated
// (#268/#277, #240/#251, #262/#269, etc.), this guard emits a warning
// + metric so operators can watch the counter. Once the counter is
// flat at zero, owners can flip `MAIA_REJECT_DEFAULT_LITERAL=true` to
// promote to a hard throw.
//
// PRs #269 + #272 review (Codex reval) — close the gap before merge.
function assertTruthyContext(ctx: TenantContext): void {
  if (!ctx.tenant_id || typeof ctx.tenant_id !== 'string') {
    throw new MissingTenantContextError('tenant_id is empty/non-string');
  }
  if (ctx.tenant_id.trim().length === 0) {
    throw new MissingTenantContextError('tenant_id is whitespace-only');
  }
  if (!ctx.agent_id || typeof ctx.agent_id !== 'string') {
    throw new MissingTenantContextError('agent_id is empty/non-string');
  }
  if (ctx.agent_id.trim().length === 0) {
    throw new MissingTenantContextError('agent_id is whitespace-only');
  }
  // Issue #282: reject (or warn-meter) the legacy `'default'` literal so any
  // production path reaching it surfaces in metrics/alerts.
  if (ctx.tenant_id === 'default') {
    incCounter('maia_tenant_id_default_literal_total', { field: 'tenant_id' });
    if (shouldThrowOnDefaultLiteral()) {
      throw new DefaultLiteralRejectedError('tenant_id');
    }
  }
  if (ctx.agent_id === 'default') {
    incCounter('maia_tenant_id_default_literal_total', { field: 'agent_id' });
    if (shouldThrowOnDefaultLiteral()) {
      throw new DefaultLiteralRejectedError('agent_id');
    }
  }
}

export function getCurrentTenant(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingTenantContextError();
  assertTruthyContext(ctx);
  return ctx.tenant_id;
}

export function getCurrentAgent(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingTenantContextError();
  assertTruthyContext(ctx);
  return ctx.agent_id;
}

export function tryGetCurrentContext(): TenantContext | null {
  const ctx = storage.getStore();
  if (!ctx) return null;
  // Malformed context (empty/whitespace-only/nullish fields) must NOT silently
  // leak through `tryGetCurrentContext`. Callers that opt into the "try"
  // variant expect either a *valid* context or null — never a half-populated
  // object. Returning null forces them down the same code path as missing-ALS,
  // which today either skips the operation or escalates per their policy.
  if (
    !ctx.tenant_id ||
    !ctx.agent_id ||
    typeof ctx.tenant_id !== 'string' ||
    typeof ctx.agent_id !== 'string' ||
    ctx.tenant_id.trim().length === 0 ||
    ctx.agent_id.trim().length === 0
  ) {
    return null;
  }
  // Mirror the literal-default observability of the strict getters: meter
  // when callers receive a `default/default` context via the try variant so
  // the counter captures every path, not just the strict ones.
  if (ctx.tenant_id === 'default') {
    incCounter('maia_tenant_id_default_literal_total', {
      field: 'tenant_id',
      via: 'tryGetCurrentContext',
    });
  }
  if (ctx.agent_id === 'default') {
    incCounter('maia_tenant_id_default_literal_total', {
      field: 'agent_id',
      via: 'tryGetCurrentContext',
    });
  }
  return ctx;
}
