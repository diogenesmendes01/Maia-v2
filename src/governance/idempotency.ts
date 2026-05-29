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
 * DELIMITER SAFETY (PR #273 review iter 2/4):
 *   The hash inputs are joined with `'|'`. In production, IDs cannot contain
 *   `'|'` because the admin UI enforces a strict charset on tenant/agent
 *   slugs:
 *     - `src/admin-ui/trpc/routers/tenants.ts:27-31` —
 *       `regex(/^[a-z0-9][a-z0-9_-]*$/, ...)` (max 64 chars)
 *     - `src/admin-ui/trpc/routers/agents.ts:36-40` —
 *       identical regex, identical bound.
 *   `'|'` is not in `[a-z0-9_-]`, so the `(tenant_id, agent_id)` pair cannot
 *   alias into another tuple via the delimiter (Codex reval refuted the
 *   primary's B1 with this evidence).
 *
 *   Even so, we apply `encodeURIComponent` per segment as defense in depth:
 *     - `runWithTenantContext` (`src/db/tenant-context.ts:24-29`) takes
 *       arbitrary strings; the admin routers are the only enforcement
 *       point. A non-admin caller could (today, in principle) route a
 *       non-conforming id and re-open the aliasing risk.
 *     - We want consistency with PR #252 (`src/gateway/bot-detection.ts:102-111`)
 *       and PR #257 (`src/tools/_vision-cache.ts:62`) — both URI-encode
 *       per segment when concatenating tenant-scoped cache keys.
 *     - The centralization effort lives in issue #287
 *       ("standardize Redis key encoding URI-safe vs raw ':'") which will
 *       introduce a shared `buildCacheKey` helper. Until #287 lands we
 *       apply the encoding inline here.
 *   Note: applying `encodeURIComponent` AFTER the `tenant_id`/`agent_id`
 *   normalization re-encodes the existing valid chars too, which is fine
 *   because the encoding is deterministic and only the hash matters
 *   downstream — same inputs still produce the same key.
 *
 * Proven by `tests/unit/governance/idempotency-cross-tenant.spec.ts`.
 */
import { sha256, bucketMinutes, canonicalize, stripDiacritics } from '@/lib/utils.js';
import { config } from '@/config/env.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

/**
 * Per-segment encoder for the hash-input join. See file-level docstring
 * "DELIMITER SAFETY" — admin UI already prevents `'|'` from appearing in
 * tenant/agent slugs in production; this is defense in depth against
 * non-admin code paths (e.g. test harnesses, future routers) that could
 * inject arbitrary strings into the tenant context.
 *
 * Number segments (e.g. `bucket`) are coerced to string first so that
 * `encodeURIComponent` accepts them without TS narrowing complaints.
 */
function encodeSegment(s: string | number): string {
  return encodeURIComponent(String(s));
}

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

/**
 * Compute a stable hash of the FULL request fingerprint, distinct from
 * `computeIdempotencyKey`. Used by the repo as a defense-in-depth check
 * on cache hits: if `(tenant_id, agent_id, key)` matches but `payload_hash`
 * differs, the row is a key collision (truncated hash, derivator bug, or
 * unflushed cache after a schema change) — return null and warn.
 *
 * Why a separate hash and not just the idempotency_key?
 *   - `computeIdempotencyKey` bakes in a bucket-minutes timestamp (so the
 *     same payload in different buckets is treated as a fresh action).
 *   - On a hit, what we want to verify is "is the cached *payload* the same
 *     payload I'm asking about?". Re-computing the full key would always
 *     match (we used it to find the row in the first place), so we need an
 *     independent fingerprint of the inputs that actually feed the side
 *     effect: pessoa_id, entity_id, tool_name, operation_type, normalized
 *     payload, file_sha256. We deliberately exclude the bucket so this is
 *     bucket-independent.
 *   - SHA256 of the canonicalized tuple — 256-bit, no truncation, no
 *     dialect dependency. Collision probability negligible vs. the original
 *     concern of key collision.
 *
 * Issue #299.
 */
export function computePayloadHash(input: {
  pessoa_id: string;
  entity_id: string;
  tool_name: string;
  operation_type: string;
  payload: unknown;
  file_sha256?: string;
}): string {
  const parts = [
    input.pessoa_id,
    input.entity_id,
    input.tool_name,
    input.operation_type,
    input.file_sha256 ?? '',
    // For file-based ops the payload itself is meaningless (file_sha256 is
    // the fingerprint); for textual ops it's the normalized payload hash.
    input.file_sha256 ? '' : normalizePayload(input.payload),
  ];
  return sha256(parts.join('|'));
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
      ]
        .map(encodeSegment)
        .join('|'),
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
    ]
      .map(encodeSegment)
      .join('|'),
  );
}
