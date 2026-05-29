import {
  redis,
  isRedisConnected,
  isRedisOomError,
  recordRedisOomDegraded,
} from '@/lib/redis.js';
import { logger } from '@/lib/logger.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

const TTL_SECONDS = 3600;
// Versioned prefix. `v2` was used by the previous iteration of this PR (only
// tenant_id in the key). Bumping to `v3` invalidates all entries written
// under the old prefixes — the `agent_id` segment changes the namespace and
// any pre-existing entry could not have been written by a same-(tenant,
// agent) flow, so reusing it would be cross-agent pollution. Old entries age
// out via the existing 1h TTL; no migration job required.
const KEY_PREFIX = 'maia:vision:v3:';

/**
 * Best-effort vision-result cache. Lets two different pessoas / entidades
 * reuse the same parse within the SAME (tenant, agent) without paying the
 * Vision API cost twice. The dispatcher's idempotency layer (see
 * `governance/idempotency.ts`) keys on `(pessoa_id, entity_id, file_sha256)`,
 * which is too narrow to catch the cross-pessoa case within an agent.
 *
 * TENANT-ISOLATION INVARIANT (issue #250, project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Before this fix the key was `maia:vision:${tool}:${sha256}` — a same-hash
 * file uploaded by tenant A and then by tenant B would serve B the *cached*
 * result that was computed for A. The current prompts (`BOLETO_PROMPT`,
 * `RECEIPT_PROMPT` in `src/lib/vision.ts`) are static per-tool, so the
 * semantic risk of seeing "tenant-A's prompt artifacts" is small — but the
 * compliance angle remains: a Vision parse served from another tenant's
 * cache leaves NO audit trail for tenant B's processing event.
 *
 * AFTER this fix (v3 — PR #257 reval):
 *   - Key is
 *     `maia:vision:v3:${enc(tenant_id)}:${enc(agent_id)}:${enc(tool)}:${enc(sha256)}`,
 *     where `tenant_id` / `agent_id` are resolved from `getCurrentTenant()` /
 *     `getCurrentAgent()` (AsyncLocalStorage via `@/db/tenant-context`) and
 *     each segment is URI-encoded so `:` (the segment separator) and `%` can
 *     NEVER appear unescaped inside a segment. Rationale (review #257 v2
 *     reval — canonical cache contract):
 *       - The Maia cache contract is `tenant_id + agent_id` everywhere
 *         (#235/#241/#242/#272). Two agents of the SAME tenant must not
 *         collide on the cache key, even when the production prompts are
 *         currently static per-tool — same defence-in-depth posture as the
 *         vector / procedural / working memory layers.
 *       - `tenants.id` is text/free-form (slug), so a tenant slug containing
 *         `:` (e.g. `acme:dev`) would otherwise collide with a
 *         `(tenant=acme, ...)` tuple where another segment starts with `:` —
 *         defeating the isolation invariant. `encodeURIComponent` makes the
 *         encoding reversible and segment-unambiguous (the only `%` in a
 *         key is a quoting prefix introduced by us).
 *   - Missing tenant context throws `MissingTenantContextError` — loud
 *     failure, never a silent fall-through to a shared bucket. Rationale:
 *     a cache entry written under a wrong/empty namespace would be
 *     unrecoverable cross-tenant pollution; better to surface the misuse
 *     than mask it.
 *   - The old `v2`/un-versioned prefixes are no longer reachable through
 *     this API; pre-existing entries age out via the existing 1h TTL
 *     (`TTL_SECONDS`). No explicit migration is required — the data is
 *     short-lived by construction.
 *
 * OBSERVABILITY (PR #257 reval — gap closed):
 *   - Hit / miss are logged at debug level with `{ tenant_id, agent_id,
 *     tool }` so cache effectiveness can be sliced per (tenant, agent)
 *     without leaking the sha256 (which is PII-adjacent via the file
 *     content). Counter-style metrics are out of scope for this module; the
 *     pino logs are the source of truth that downstream telemetry can
 *     aggregate.
 *   - Read/write failure logs include `tenant_id` and `agent_id` (previous
 *     iteration only included `tool`).
 *
 * Cache misses (Redis down, deserialization error) remain silently ignored
 * — the tool falls back to a fresh Vision call.
 */

/**
 * Build the (tenant, agent)-scoped Redis key. Each segment is URI-encoded so
 * the `:` delimiter is unambiguous: a tenant slug like `acme:dev` becomes
 * `acme%3Adev`, which can never collide with a tuple where the tenant is
 * `acme` and another segment starts with `dev:`. Exported via the module's
 * two public functions only — not part of the API surface.
 */
function buildKey(
  tenant_id: string,
  agent_id: string,
  tool: string,
  file_sha256: string,
): string {
  return (
    `${KEY_PREFIX}` +
    `${encodeURIComponent(tenant_id)}:` +
    `${encodeURIComponent(agent_id)}:` +
    `${encodeURIComponent(tool)}:` +
    `${encodeURIComponent(file_sha256)}`
  );
}

export async function getCachedVision<T>(tool: string, file_sha256: string): Promise<T | null> {
  // Resolve tenant + agent BEFORE the Redis call — if there is no active
  // context this throws `MissingTenantContextError`. We refuse to serve a
  // cached vision result without a (tenant, agent) attribution.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  if (!isRedisConnected()) return null;
  try {
    const v = await redis.get(buildKey(tenant_id, agent_id, tool, file_sha256));
    if (v) {
      logger.debug({ tenant_id, agent_id, tool }, 'vision_cache.hit');
      return JSON.parse(v) as T;
    }
    logger.debug({ tenant_id, agent_id, tool }, 'vision_cache.miss');
    return null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenant_id, agent_id, tool },
      'vision_cache.read_failed',
    );
    return null;
  }
}

export async function setCachedVision(
  tool: string,
  file_sha256: string,
  value: unknown,
): Promise<void> {
  // Same invariant as getCachedVision — refuse to write without a
  // (tenant, agent) attribution. A vision result written into the shared
  // bucket would be served to ANY tenant on subsequent reads.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  if (!isRedisConnected()) return;
  try {
    await redis.setex(
      buildKey(tenant_id, agent_id, tool, file_sha256),
      TTL_SECONDS,
      JSON.stringify(value),
    );
  } catch (err) {
    // OOM handling (#309): this cache is best-effort and Postgres/Vision API
    // is the source of truth — a write miss just means the NEXT identical
    // file pays the Vision API cost again (the read path already returns null
    // and the tool re-runs). FAIL-OPEN is safe: the key is tenant+agent-scoped
    // so dropping the write has no isolation impact. We single out OOM for its
    // own counter (capacity signal feeding the runbook §4.5 alert) but the
    // pre-existing fail-open behaviour is unchanged for every write failure.
    if (isRedisOomError(err)) {
      recordRedisOomDegraded('vision_cache.set', { tenant_id, agent_id, tool });
      return;
    }
    logger.warn(
      { err: (err as Error).message, tenant_id, agent_id, tool },
      'vision_cache.write_failed',
    );
  }
}
