/**
 * Working memory — short-lived per-conversation buffers backed by Redis.
 *
 * TENANT/AGENT-ISOLATION INVARIANT (issue #231, north star principle):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * Every Redis key emitted by this module is prefixed with `tenant_id` AND
 * `agent_id`, both pulled from the AsyncLocalStorage tenant context via
 * `getCurrentTenant()` / `getCurrentAgent()`. There is NO fallback to a
 * "default" or empty namespace — if a caller forgets to wrap the operation
 * in `runWithTenantContext`, the underlying accessor throws a
 * `MissingTenantContextError`. That is a LOUD failure by design (consistent
 * with the procedural-memory mutators in `rulesRepo` after #230/#232): the
 * tenant boundary is INVIOLABLE, so masking a missing-context bug with a
 * shared fallback key is strictly worse than crashing.
 *
 * Defense-in-depth rationale (issue #231):
 *   Conversation IDs are UUIDs and (today) globally unique, so a missing
 *   namespace doesn't surface as an observable cross-tenant leak. But the
 *   invariant says "every state passes through tenant_id + agent_id, no
 *   exception" — and any future change to ID generation, or a future
 *   test/seed reusing fixed IDs across tenants, would silently reintroduce
 *   a real leak. Prefixing now eliminates that class of bug at the storage
 *   layer.
 *
 * Key formats:
 *   working:${tenant_id}:${agent_id}:conv:${conversa_id}:messages
 *
 * Cache-invalidation note: this is a backwards-incompatible key change.
 * Any pre-existing Redis entries under the OLD prefix (`working:conv:…`)
 * are no longer reachable through the public API and will age out via the
 * existing 24h TTL on the message buffer. No explicit migration job is
 * required — the data is short-lived by construction and the buffers are
 * rebuilt from the inbound stream within one conversation.
 *
 * Note on the removed `rateLimit` helper (#270/#274): a prior `rateLimit`
 * export was removed as dead code (no callers in repo, fail-open on
 * Redis-down, INCR/EXPIRE race, no tenant scope). Do NOT resurrect it
 * here. If working-memory ever needs an agent-scoped limiter, follow the
 * PR #258 gateway pattern (Lua/MULTI atomicity, fail-CLOSED on Redis-down,
 * `maia:ratelimit:${tenant_id}:${agent_id}:...` key prefix).
 */
import { redis, isRedisConnected } from '@/lib/redis.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

function workingMessagesKey(conversa_id: string): string {
  // `getCurrentTenant()` / `getCurrentAgent()` throw `MissingTenantContextError`
  // if the caller isn't wrapped in `runWithTenantContext` — see invariant block.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  return `working:${tenant_id}:${agent_id}:conv:${conversa_id}:messages`;
}

export async function pushMessage(conversa_id: string, role: 'user' | 'assistant', text: string): Promise<void> {
  if (!isRedisConnected()) return;
  const key = workingMessagesKey(conversa_id);
  await redis.rpush(key, JSON.stringify({ role, text, ts: Date.now() }));
  await redis.ltrim(key, -20, -1);
  await redis.expire(key, 60 * 60 * 24);
}

export async function readRecent(conversa_id: string): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
  if (!isRedisConnected()) return [];
  const key = workingMessagesKey(conversa_id);
  const items = await redis.lrange(key, 0, -1);
  return items
    .map((s) => {
      try {
        return JSON.parse(s) as { role: 'user' | 'assistant'; text: string };
      } catch {
        return null;
      }
    })
    .filter((x): x is { role: 'user' | 'assistant'; text: string } => x !== null);
}
