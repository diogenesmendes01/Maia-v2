import crypto from 'crypto';

export function buildUserSliceCacheKey(args: {
  tenant_id: string;
  pessoa_id: string;
  depth: string;
  intent_label?: string;
  scope_hint?: string[];
}): string {
  const scopeHash = args.scope_hint ? crypto.createHash('sha256').update(JSON.stringify(args.scope_hint)).digest('hex').slice(0, 8) : 'default';
  const intentHash = args.intent_label ? crypto.createHash('sha256').update(args.intent_label).digest('hex').slice(0, 8) : 'none';
  return `user_slice:v1:${args.tenant_id}:${args.pessoa_id}:${args.depth}:${intentHash}:${scopeHash}`;
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
  const scopeHash = args.scope_hint ? crypto.createHash('sha256').update(JSON.stringify(args.scope_hint)).digest('hex').slice(0, 8) : 'default';
  const intentHash = args.intent_label ? crypto.createHash('sha256').update(args.intent_label).digest('hex').slice(0, 8) : 'none';
  const domain = args.domain ?? 'global';
  return `knowledge_slice:v2:${args.tenant_id}:${args.agent_id}:${args.depth}:${scopeHash}:${domain}:${intentHash}`;
}
