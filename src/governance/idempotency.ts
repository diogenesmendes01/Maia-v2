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
 *     - The #287 consolidation (shared `buildCacheKey` in
 *       `src/lib/cache-key.ts`) deliberately does NOT cover this module:
 *       these are sha256 HASH INPUTS joined with `'|'`, not Redis keys.
 *       Re-joining them via `buildCacheKey` (which joins with `':'`) would
 *       change the hashed bytes, so every idempotency key/payload hash
 *       computed after deploy would differ from rows already stored in
 *       Postgres — re-opening the exact #318 migration window (a legit
 *       retry of an ALREADY-EXECUTED financial side effect would miss the
 *       cache and EXECUTE AGAIN for the row's remaining TTL). That is not
 *       a transient blip, so the inline per-segment encoding stays. Any
 *       future byte-layout change must ride a PAYLOAD_HASH_VERSION_PREFIX
 *       bump plus a repositories.ts legacy-comparison path, as #318 did.
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

/**
 * Version tag prepended to every `computePayloadHash` output (issue #318
 * migration-window fix).
 *
 * WHY a version prefix?
 *   #318 changed the hash ENCODING (per-segment `encodeURIComponent` before
 *   the `'|'` join) to close a delimiter-aliasing collision. That changes the
 *   bytes for any input containing a `'|'` — so a `payload_hash` computed AFTER
 *   #318 deploys can differ from one stored BEFORE it. The repo's #299/#301
 *   revalidation compares the freshly computed hash against the stored row's
 *   `payload_hash`; a legacy (pre-#318) stored value would never match the new
 *   format, turning a legit idempotent retry into a spurious `collision`
 *   (fail-closed typed error) for the entry's remaining TTL.
 *
 *   The tag makes the format SELF-DESCRIBING: stored hashes written by this
 *   build carry `PAYLOAD_HASH_VERSION_PREFIX`; legacy rows have no prefix. The
 *   comparison sites in `src/db/repositories.ts` use that to special-case
 *   legacy rows (skip the collision, fall back to pre-#318 hit/wait-resolve
 *   behavior) while keeping STRICT revalidation for new-vs-new comparisons.
 *   Bump this (`v2` → `v3` …) on any future change to the hashed byte layout.
 */
export const PAYLOAD_HASH_VERSION_PREFIX = 'v2:';

/**
 * True iff `hash` was produced by the CURRENT (versioned) `computePayloadHash`.
 * A stored value WITHOUT this prefix is a legacy (pre-#318) hash that cannot be
 * revalidated against the new encoding — callers must NOT treat a mismatch
 * against it as a collision. See `PAYLOAD_HASH_VERSION_PREFIX`.
 */
export function isVersionedPayloadHash(hash: string): boolean {
  return hash.startsWith(PAYLOAD_HASH_VERSION_PREFIX);
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
 * The returned string is `PAYLOAD_HASH_VERSION_PREFIX + <64-hex sha256>`
 * (e.g. `v2:ab12…`). The prefix lets the repo's revalidation distinguish a
 * current-format hash from a legacy pre-#318 stored value (issue #318
 * migration-window fix). Callers treat the value as an opaque token — store
 * it and compare it verbatim.
 *
 * Issue #299, #318.
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
  // Per-segment encode before joining — same delimiter-safety treatment
  // `computeIdempotencyKey` applies (see file-level "DELIMITER SAFETY"
  // docstring + `encodeSegment`). Without this, a raw `'|'` inside any
  // free-form segment (pessoa_id, entity_id, tool_name, operation_type)
  // could realign the boundaries so two distinct fingerprints serialize to
  // the same string and collide on SHA-256 — a FALSE payload-hash match,
  // which is exactly the integrity check this function exists to enforce
  // (issue #318, #301 follow-up).
  //
  // Version prefix (issue #318 migration-window fix): the result is tagged
  // with `PAYLOAD_HASH_VERSION_PREFIX` so the comparison sites in
  // `src/db/repositories.ts` can distinguish a hash written by THIS build
  // (revalidatable, strict) from a legacy pre-#318 stored hash (NOT
  // revalidatable — a mismatch against it must NOT raise a collision).
  return `${PAYLOAD_HASH_VERSION_PREFIX}${sha256(parts.map(encodeSegment).join('|'))}`;
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
