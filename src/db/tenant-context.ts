import { AsyncLocalStorage } from 'async_hooks';

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

type TenantContext = {
  tenant_id: string;
  agent_id: string;
};

const storage = new AsyncLocalStorage<TenantContext>();

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
// PR #269 review (Codex reval) — close the gap before merge.
function assertTruthyContext(ctx: TenantContext): void {
  if (!ctx.tenant_id || typeof ctx.tenant_id !== 'string') {
    throw new MissingTenantContextError('tenant_id is empty/non-string');
  }
  if (!ctx.agent_id || typeof ctx.agent_id !== 'string') {
    throw new MissingTenantContextError('agent_id is empty/non-string');
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
  // Malformed context (empty/nullish fields) must NOT silently leak through
  // `tryGetCurrentContext`. Callers that opt into the "try" variant expect
  // either a *valid* context or null — never a half-populated object.
  // Returning null forces them down the same code path as missing-ALS,
  // which today either skips the operation or escalates per their policy.
  if (!ctx.tenant_id || !ctx.agent_id || typeof ctx.tenant_id !== 'string' || typeof ctx.agent_id !== 'string') {
    return null;
  }
  return ctx;
}
