/**
 * Tool idempotency key + result cache (issue #261).
 *
 * TENANT/AGENT-ISOLATION INVARIANT (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * The `idempotency_keys` table has `tenant_id` + `agent_id` columns (both
 * NOT NULL with a legacy `'default'` default — see migrations 009/012).
 * Before issue #261's fix the hash inputs to `computeIdempotencyKey` did
 * NOT include tenant_id/agent_id, and the lookup/store predicates filtered
 * ONLY by `key`. Net effect: two tenants invoking the same tool with the
 * same (pessoa_id, entity_id, tool_name, operation_type, payload, bucket)
 * tuple computed an IDENTICAL key and shared a single cache row — a direct
 * cross-tenant leak of tool output AND a cache-poisoning vector.
 *
 * AFTER this fix:
 *   1. `computeIdempotencyKey` resolves `tenant_id` / `agent_id` from
 *      `getCurrentTenant()` / `getCurrentAgent()` and folds BOTH into the
 *      hash input (file-based AND payload-based code paths). No active
 *      tenant context → `MissingTenantContextError`. We refuse to fall
 *      through to the legacy `'default'` bucket — same fail-closed pattern
 *      used by #232 (rulesRepo) / #237 (vector memory) / #241.
 *   2. `idempotencyRepo.lookup` (src/db/repositories.ts) injects
 *      `tenant_id = <ctx> AND agent_id = <ctx>` into the WHERE clause as
 *      defense-in-depth: even if a future caller bypasses
 *      `computeIdempotencyKey` and supplies a raw key, the lookup still
 *      cannot surface a foreign-tenant cache row.
 *   3. `idempotencyRepo.store` writes through `applyTenantGuard`, which
 *      stamps the routed tenant_id/agent_id and rejects any explicit
 *      mismatch.
 *   4. Migration 063 promotes the table's PRIMARY KEY from `(key)` to
 *      `(tenant_id, agent_id, key)` so the storage layer reflects the new
 *      identity tuple. Cross-tenant insert of the same key — should not
 *      happen since the hash already includes tenant/agent — now succeeds
 *      as two distinct rows rather than a single PK collision.
 *
 * Proven by `tests/unit/governance/idempotency-cross-tenant.spec.ts`.
 */
import { sha256, bucketMinutes, canonicalize, stripDiacritics } from '@/lib/utils.js';
import { config } from '@/config/env.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

export function normalizePayload(p: unknown): string {
  const c = canonicalize(p) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...c };
  if ('valor' in out && (typeof out.valor === 'number' || typeof out.valor === 'string')) {
    out.valor_centavos = Math.round(Number(out.valor) * 100);
    delete out.valor;
  }
  if ('descricao' in out && typeof out.descricao === 'string') {
    out.descricao = stripDiacritics(out.descricao.trim().toLowerCase());
  }
  if ('data_competencia' in out && typeof out.data_competencia === 'string') {
    out.data_competencia = out.data_competencia.slice(0, 10);
  }
  return sha256(JSON.stringify(out));
}

export function computeIdempotencyKey(input: {
  pessoa_id: string;
  entity_id: string;
  tool_name: string;
  operation_type: string;
  payload: unknown;
  file_sha256?: string;
  timestamp?: Date;
}): string {
  // Resolve tenant/agent BEFORE hashing — if there is no active tenant context
  // this throws `MissingTenantContextError` (loud failure). We refuse to
  // compute a key under the shared `'default'` bucket: a key without a tenant
  // attribution would collide cross-tenant in the cache and leak tool output.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();

  if (input.file_sha256) {
    return sha256(
      [
        tenant_id,
        agent_id,
        input.pessoa_id,
        input.entity_id,
        input.tool_name,
        input.operation_type,
        input.file_sha256,
      ].join('|'),
    );
  }
  const bucket = bucketMinutes(input.timestamp ?? new Date(), config.IDEMPOTENCY_BUCKET_MINUTES);
  return sha256(
    [
      tenant_id,
      agent_id,
      input.pessoa_id,
      input.entity_id,
      input.tool_name,
      input.operation_type,
      normalizePayload(input.payload),
      bucket,
    ].join('|'),
  );
}
