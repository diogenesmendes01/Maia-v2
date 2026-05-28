import crypto from 'crypto';

/**
 * Invalid scope error — thrown by key builders when `tenant_id` or `agent_id`
 * is empty / null / undefined / non-string. Centralised to keep the fail-closed
 * invariant uniform across every cache key builder in the codebase.
 *
 * Issue #235 (Codex reval): silently accepting an empty `agent_id` would
 * degrade the v2 cache to tenant-wide scoping (`...:tenant:::depth:...`),
 * which is exactly the cross-agent leak the v1→v2 bump was meant to close.
 * Throw early instead of writing a malformed key.
 */
export class InvalidCacheScopeError extends Error {
  readonly code = 'INVALID_CACHE_SCOPE';
  constructor(field: 'tenant_id' | 'agent_id', value: unknown) {
    super(
      `cache-keys: ${field} must be a non-empty string (received ${typeof value}=${JSON.stringify(value)})`,
    );
    this.name = 'InvalidCacheScopeError';
  }
}

/**
 * Fail-closed scope guard. Every cache key builder MUST call this first.
 *
 * Why a helper instead of inline checks: keeps the invariant impossible to
 * forget when adding new builders, and gives every callsite the same error
 * shape (`InvalidCacheScopeError`) so callers / observability can react
 * uniformly.
 */
export function assertValidScope(tenant_id: unknown, agent_id: unknown): void {
  if (typeof tenant_id !== 'string' || tenant_id.length === 0) {
    throw new InvalidCacheScopeError('tenant_id', tenant_id);
  }
  if (typeof agent_id !== 'string' || agent_id.length === 0) {
    throw new InvalidCacheScopeError('agent_id', agent_id);
  }
}

/**
 * Build the cache key for a user slice.
 *
 * Issue #235 (HIGH, in-scope): `buildUserSlice` resolves memories and hints
 * scoped by `agent_id` (see `user-slice-builder.ts:57, 67`), but until v2 the
 * cache key omitted it — two agents inside the same tenant looking at the
 * same pessoa would collide on cached slices and leak each other's memories
 * if a real cache backend were wired.
 *
 * Version bumped from v1 → v2 to invalidate any pre-existing cache entries
 * written without `agent_id` in the key. Pre-fix entries are unreachable;
 * the next lookup misses and the slice is rebuilt with the correct
 * agent-scoped key.
 */
export function buildUserSliceCacheKey(args: {
  tenant_id: string;
  agent_id: string;
  pessoa_id: string;
  depth: string;
  intent_label?: string;
  scope_hint?: string[];
}): string {
  assertValidScope(args.tenant_id, args.agent_id);
  const scopeHash = args.scope_hint ? crypto.createHash('sha256').update(JSON.stringify(args.scope_hint)).digest('hex').slice(0, 8) : 'default';
  const intentHash = args.intent_label ? crypto.createHash('sha256').update(args.intent_label).digest('hex').slice(0, 8) : 'none';
  return `user_slice:v2:${args.tenant_id}:${args.agent_id}:${args.pessoa_id}:${args.depth}:${intentHash}:${scopeHash}`;
}

/**
 * Build the cache key for a knowledge slice.
 *
 * Issue #235 (LOW, latent): the slice builder scopes by `agent_id` (see
 * `knowledge-slice-builder.ts` — `boundary.agent_id` is threaded into
 * `rulesResolver.list` / `factsResolver.list`), so the cache key MUST also
 * include `agent_id`. Without it, agents inside the same tenant would
 * silently collide on cached slices if a real cache backend were wired —
 * leaking another agent's rule/fact set inside the same tenant.
 *
 * Version bumped from v1 → v2 to invalidate any pre-existing cache rows
 * that were written without `agent_id` in the key. Pre-fix entries become
 * unreachable; the next lookup misses and the slice is rebuilt with the
 * correct agent-scoped key.
 */
export function buildKnowledgeSliceCacheKey(args: {
  tenant_id: string;
  agent_id: string;
  depth: string;
  scope_hint?: string[];
  domain?: string;
  intent_label?: string;
}): string {
  assertValidScope(args.tenant_id, args.agent_id);
  const scopeHash = args.scope_hint ? crypto.createHash('sha256').update(JSON.stringify(args.scope_hint)).digest('hex').slice(0, 8) : 'default';
  const intentHash = args.intent_label ? crypto.createHash('sha256').update(args.intent_label).digest('hex').slice(0, 8) : 'none';
  const domain = args.domain ?? 'global';
  return `knowledge_slice:v2:${args.tenant_id}:${args.agent_id}:${args.depth}:${scopeHash}:${domain}:${intentHash}`;
}
