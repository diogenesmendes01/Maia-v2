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

/**
 * Reserved sentinel for genuinely-GLOBAL maintenance work that has no single
 * owning tenant (issue #323 phase 1).
 *
 * Why a distinct sentinel (and not `'default'`):
 *   - `'default'` is the LEGACY single-tenant Maia bucket. Real per-tenant
 *     work was historically collapsed onto it (issue #240 et al.), so it is
 *     on the path to being REJECTED fail-closed (`assertNotDefaultLiteral` +
 *     `MAIA_REJECT_DEFAULT_LITERAL`). Anything still running under `'default'`
 *     is presumed-misrouted until proven otherwise.
 *   - `'system'` is RESERVED and ALLOWED: it is the explicit home for work that
 *     legitimately has no tenant attribution (DB-wide backup, DLQ depth probe,
 *     health checks, idempotency-key GC, setup/pairing audit). The `tenants`/
 *     `agents` rows are seeded by migration `014_p0_seed_system_tenant.sql`, so
 *     FK-bearing writes (e.g. `audit_log`) under this context are valid.
 *
 * `audit()` already falls back to this context when no ALS context is active
 * (`src/governance/audit.ts`). Exporting it as a single canonical constant lets
 * global workers adopt the SAME bucket instead of each re-typing a literal — and
 * keeps the "global → system / per-tenant → real tenant" split auditable in one
 * place as the worker fleet is migrated off `'default'`.
 *
 * IMPORTANT: `'system'` is NOT a catch-all. It is ONLY for work that is global
 * by NATURE (no per-tenant row to attribute to). Per-tenant work that merely
 * lacks a tenant loop today must be migrated to iterate real tenants, never
 * parked here — parking it here would re-create the cross-tenant collapse that
 * the `'default'` rejection exists to kill.
 */
export const SYSTEM_TENANT_ID = 'system' as const;
export const SYSTEM_AGENT_ID = 'system' as const;

/**
 * Canonical global-maintenance context. Frozen so callers can't mutate the
 * shared object. Pass to `runWithTenantContext` (or use `runWithSystemContext`).
 */
export const SYSTEM_CONTEXT: TenantContext = Object.freeze({
  tenant_id: SYSTEM_TENANT_ID,
  agent_id: SYSTEM_AGENT_ID,
});

/**
 * Reserved tenant/agent for the SINGLE-TENANT runtime home (issue #323).
 *
 * Unlike `system` (sanctioned for genuinely-global, no-owner maintenance and
 * exempt from the `'default'` rejection), `primary` is an ORDINARY tenant: it
 * passes `assertTruthyContext`/`assertNotDefaultLiteral` with no special-casing
 * (the reject-set stays `{'default'}`, the permit-exception stays `{'system'}`).
 *
 * It replaces the legacy `'default'` bucket as the home of the single-tenant
 * deployment, so `'default'` can be rejected fail-closed everywhere once
 * `MAIA_REJECT_DEFAULT_LITERAL` defaults ON. When a real second tenant is
 * onboarded, `primary` is simply one tenant among many — the single-tenant
 * catch-all (`channelsRepo.findPrimaryCatchAllChannel`) auto-disables the moment
 * a channel of any other tenant exists.
 */
export const PRIMARY_TENANT_ID = 'primary' as const;
export const PRIMARY_AGENT_ID = 'primary' as const;

/**
 * Canonical single-tenant runtime context. Frozen like `SYSTEM_CONTEXT` so
 * callers can't mutate the shared object.
 */
export const PRIMARY_CONTEXT: TenantContext = Object.freeze({
  tenant_id: PRIMARY_TENANT_ID,
  agent_id: PRIMARY_AGENT_ID,
});

/**
 * True when both ids equal the reserved `primary` sentinel. Lets callers/tests
 * distinguish the single-tenant home from a real onboarded tenant without
 * string-matching the literal at multiple sites (mirrors `isSystemContext`).
 */
export function isPrimaryContext(ctx: { tenant_id: string; agent_id: string }): boolean {
  return ctx.tenant_id === PRIMARY_TENANT_ID && ctx.agent_id === PRIMARY_AGENT_ID;
}

const storage = new AsyncLocalStorage<TenantContext>();

/**
 * Reject the `'default'` literal by DEFAULT (issue #323, Phase 6): opt-OUT, not
 * opt-in. Read at access time from `process.env` (NOT the boot-cached config) so:
 *   - default-ON needs no env var set (`undefined !== 'false'` → true), and
 *   - an emergency rollback is env-only with no redeploy
 *     (`MAIA_REJECT_DEFAULT_LITERAL=false`).
 * Tests can still flip it per-case without re-importing.
 */
function shouldThrowOnDefaultLiteral(): boolean {
  return process.env.MAIA_REJECT_DEFAULT_LITERAL !== 'false';
}

/**
 * Notified whenever a tenant scope is ENTERED, from inside the new scope.
 *
 * Exists for ONE reason (issue #535, owner review of PR #541): the observability
 * layer needs to know the tuple a turn resolved to, and it cannot read it. The
 * root `turn` span opens before the resolution and closes after the scope has
 * unwound, so an ALS read at either end returns `system` and the exported root
 * carries no usable attribution.
 *
 * Dependency is INVERTED — this module stays the fail-closed security boundary
 * with zero observability imports; `src/observability/tracer.ts` registers
 * itself. The observer is advisory and fail-SOFT: it cannot change the context,
 * cannot reject a scope, and a throw from it is swallowed, so a bug in
 * instrumentation can never be the reason a tenant scope fails to open.
 */
type TenantScopeObserver = (ctx: TenantContext) => void;

let tenantScopeObserver: TenantScopeObserver | null = null;

export function setTenantScopeObserver(observer: TenantScopeObserver | null): void {
  tenantScopeObserver = observer;
}

function notifyTenantScope(ctx: TenantContext): void {
  const observer = tenantScopeObserver;
  if (observer === null) return;
  try {
    observer(ctx);
  } catch {
    // Observability is never a control-flow participant.
  }
}

export async function runWithTenantContext<T>(
  ctx: TenantContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, () => {
    // Inside the new scope, so the observer sees exactly what `fn` will see.
    notifyTenantScope(ctx);
    return fn();
  });
}

/**
 * Run `fn` under the reserved global-maintenance context (`system`/`system`).
 *
 * Thin convenience wrapper over `runWithTenantContext(SYSTEM_CONTEXT, fn)` for
 * genuinely-global workers (backup, DLQ monitor, health monitor, idempotency
 * GC, …) so they declare their intent explicitly instead of hand-typing a
 * `{ tenant_id: 'default', agent_id: 'default' }` literal that is on the path
 * to being rejected. Additive (issue #323 phase 1): this introduces the
 * vocabulary; migrating each worker to call it is a separate, reviewed step.
 *
 * Do NOT use for per-tenant work — see `SYSTEM_CONTEXT` docs. Per-tenant
 * workers must enumerate real tenants and open `runWithTenantContext` per tuple
 * (cf. `src/workers/reflection-batch.ts`).
 */
export async function runWithSystemContext<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run(SYSTEM_CONTEXT, fn);
}

/**
 * True when both ids equal the reserved `system` sentinel. Lets callers/tests
 * distinguish the sanctioned global-maintenance bucket from a real tenant
 * without string-matching the literal at multiple sites.
 */
export function isSystemContext(ctx: { tenant_id: string; agent_id: string }): boolean {
  return ctx.tenant_id === SYSTEM_TENANT_ID && ctx.agent_id === SYSTEM_AGENT_ID;
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
 *
 * Exported (issue #315) so the upstream `BaseContextBuilder` can apply the
 * exact same gating + metering + throw semantics at packet-build time. Sharing
 * this single helper guarantees the builder guard and the ALS read-time guard
 * cannot silently diverge (same flag, same counter, same `DefaultLiteralRejectedError`).
 *
 * Scope of rejection (issue #323): this guard rejects ONLY the literal
 * `'default'`. The reserved `'system'` sentinel (`SYSTEM_TENANT_ID` /
 * `SYSTEM_CONTEXT`) is intentionally NOT rejected — it is the sanctioned home
 * for genuinely-global maintenance with no owning tenant (backup, DLQ monitor,
 * idempotency GC, setup/pairing audit). Keeping `'system'` permitted is what
 * makes flipping `MAIA_REJECT_DEFAULT_LITERAL` to default-ON safe: global
 * workers move to `'system'`, per-tenant workers iterate real tenants, and
 * `'default'` becomes a hard-fail signal of a still-misrouted path. Do NOT add
 * `'system'` to the rejection set without first re-homing every global worker.
 */
export function assertNotDefaultLiteral(value: string, field: 'tenant_id' | 'agent_id'): void {
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

/**
 * Non-throwing variant. Contract: returns a *fully valid* `TenantContext` or
 * `null` — never a half-populated / cross-tenant-readable scope.
 *
 * **Routed through the SAME helpers as the strict getters** (`assertTruthyContext`
 * + `assertNotDefaultLiteral`) so the validation surface cannot silently diverge
 * (PR #293 review, blocker 1). The helpers are invoked inside a `try/catch`
 * because this variant signals "no usable context" with `null` rather than by
 * throwing.
 *
 * Fail-closed `null` is returned when EITHER field is:
 *  - non-string / empty / whitespace-only / surrounded by whitespace
 *    (`assertTruthyContext` throws — always, regardless of the flag), OR
 *  - the literal `'default'` sentinel while `MAIA_REJECT_DEFAULT_LITERAL=true`
 *    (`assertNotDefaultLiteral` throws `DefaultLiteralRejectedError`).
 *
 * Closing the cross-tenant-isolation hole (PR #293 review, blocker 2): the old
 * implementation metered the `'default'` literal and then STILL returned
 * `{tenant_id:'default', agent_id:'default'}`, handing the caller a synthetic
 * shared scope. Now a `'default'` literal with the flag ON yields `null`, so
 * every caller takes its existing missing-context branch (all callers of this
 * function fail closed on `null` — they skip the write / abort the operation,
 * never fall back to a default scope).
 *
 * Flag OFF: `assertNotDefaultLiteral` only meters (no throw), so a `'default'`
 * literal still returns the context — preserving the warning+counter
 * observability rollout while the shape checks above remain enforced.
 */
export function tryGetCurrentContext(): TenantContext | null {
  const ctx = storage.getStore();
  if (!ctx) return null;
  try {
    // Same shape + literal-default guards as getCurrentTenant/getCurrentAgent.
    // assertTruthyContext narrows each field to a non-empty, fully-trimmed
    // string; assertNotDefaultLiteral meters the 'default' sentinel and throws
    // when MAIA_REJECT_DEFAULT_LITERAL=true. Any throw → fail-closed null.
    assertTruthyContext(ctx.tenant_id, 'tenant_id');
    assertNotDefaultLiteral(ctx.tenant_id, 'tenant_id');
    assertTruthyContext(ctx.agent_id, 'agent_id');
    assertNotDefaultLiteral(ctx.agent_id, 'agent_id');
  } catch {
    return null;
  }
  return ctx;
}
