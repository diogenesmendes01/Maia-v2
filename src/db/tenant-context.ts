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

/**
 * Fail-closed guard: ALS may carry a malformed context object
 * (`{ tenant_id: '', agent_id: null as any }`) when an upstream caller wraps
 * `runWithTenantContext` with garbage. Without this check, callers would get
 * the empty/nullish value back and any downstream `WHERE tenant_id = $1`
 * would either crash on type mismatch (best case) or return rows scoped to
 * the wrong-and-likely-empty tenant (worst case, cross-tenant leak).
 *
 * Para cache keys (holidays-cache, etc.): falsy agent_id geraria key
 * malformada `holidays:v2:tenantA::entidade:2026:standard` que colide
 * silenciosamente com outros contextos malformados — exatamente o leak que
 * PR #263 fechou para o caso de `agent_id` ausente da key.
 *
 * Validation rules (estritas — reject, não normaliza):
 *  1. Deve ser string (rejeita `null`, `undefined`, number, etc.)
 *  2. `.trim().length > 0` (rejeita `''`, `'   '`, `'\t'`, `'\n'`)
 *  3. Strings com whitespace ao redor (`' acme '`) também rejeitam.
 *
 * **Whitespace-only IDs (#272 reval — convergente com issue #283):** strings
 * como `'   '` ou `'\t'` passariam o check `!str` (truthy), mas geram
 * namespace anômalo (`holidays:v3:acme:%20%20%20:...`) que ainda é
 * determinístico — colide com qualquer outro contexto que carregue o mesmo
 * padrão de whitespace.
 *
 * **Contrato `' valid '` → REJECTED (PR #293).** Decidimos rejeitar (mais
 * strict) ao invés de trim-implícito por dois motivos:
 *  - Cache keys (Redis, embedding cache, idempotency cache) usam o ID direto
 *    como segmento de namespace. `' acme '` vs `'acme'` vs `'acme '` colidem
 *    silenciosamente em algumas keys e divergem em outras → bugs sutis.
 *  - O contrato "operador normaliza upstream" empurra a responsabilidade pra
 *    fronteira (ingress / DI wiring), onde a fonte do ID é conhecida. Trim
 *    implícito mascara o bug upstream.
 *
 * Mensagem de erro mantém os tokens `is empty` e `whitespace-only` para
 * preservar contratos de teste (#269/#272 reval — regex `/tenant_id is empty/`
 * e `/whitespace-only/`).
 *
 * **Literal `'default'` rejection (issue #282 / PR #296):** o sentinel legado
 * `{tenant_id:'default', agent_id:'default'}` era alcançável por vários paths
 * (channel-resolver fallback, base-context-builder DI default, worker
 * scaffolding) e cria um contexto compartilhado sintético que viola o
 * isolamento de tenant. Esse guard é aplicado APÓS as checagens de
 * truthy/whitespace, pelos getters (`getCurrentTenant`/`getCurrentAgent`)
 * abaixo, emitindo warning + métrica até todos os paths legados migrarem;
 * com `MAIA_REJECT_DEFAULT_LITERAL=true` vira throw duro.
 *
 * PRs #269 + #272 + #293 + #296 review (Codex reval) — fail-closed em truthy +
 * whitespace + surrounding whitespace, e rejeição do literal `'default'`.
 */
function assertTruthyContext(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MissingTenantContextError(`${name} is empty or non-string`);
  }
  if (value.trim().length === 0) {
    throw new MissingTenantContextError(`${name} is whitespace-only`);
  }
  if (value !== value.trim()) {
    throw new MissingTenantContextError(`${name} has surrounding whitespace (strict: trim upstream)`);
  }
}

/**
 * Literal `'default'` rejection (issue #282 / PR #296), applied per field after
 * the truthy/whitespace guard above. Meters every hit on
 * `maia_tenant_id_default_literal_total` so operators can watch the counter,
 * and — once `MAIA_REJECT_DEFAULT_LITERAL=true` — promotes to a hard throw.
 * Kept as a distinct helper (instead of inline in `assertTruthyContext`) so the
 * per-field strict-string assertion stays a pure shape check while preserving
 * #296's observability + opt-in throw semantics.
 */
function assertNotDefaultLiteral(value: string, field: 'tenant_id' | 'agent_id'): void {
  if (value === 'default') {
    incCounter('maia_tenant_id_default_literal_total', { field });
    if (shouldThrowOnDefaultLiteral()) {
      throw new DefaultLiteralRejectedError(field);
    }
  }
}

export function getCurrentTenant(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingTenantContextError();
  assertTruthyContext(ctx.tenant_id, 'tenant_id');
  assertNotDefaultLiteral(ctx.tenant_id, 'tenant_id');
  return ctx.tenant_id;
}

export function getCurrentAgent(): string {
  const ctx = storage.getStore();
  if (!ctx) throw new MissingTenantContextError();
  assertTruthyContext(ctx.agent_id, 'agent_id');
  assertNotDefaultLiteral(ctx.agent_id, 'agent_id');
  return ctx.agent_id;
}

export function tryGetCurrentContext(): TenantContext | null {
  const ctx = storage.getStore();
  if (!ctx) return null;
  // Malformed context (empty/whitespace-only/surrounded fields) must NOT silently
  // leak through `tryGetCurrentContext`. Callers that opt into the "try" variant
  // expect either a *valid* context or null — never a half-populated object.
  // Returning null forces them down the same code path as missing-ALS, which
  // today either skips the operation or escalates per their policy.
  if (
    typeof ctx.tenant_id !== 'string' ||
    typeof ctx.agent_id !== 'string' ||
    ctx.tenant_id.length === 0 ||
    ctx.agent_id.length === 0 ||
    ctx.tenant_id.trim().length === 0 ||
    ctx.agent_id.trim().length === 0 ||
    ctx.tenant_id !== ctx.tenant_id.trim() ||
    ctx.agent_id !== ctx.agent_id.trim()
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
