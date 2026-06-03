/**
 * AudienceSliceBuilder (issue #407).
 *
 * Builds the per-agent audience slice — the `AudienceContext` for the turn's
 * contact (`base.actor.pessoa_id`) under the active (tenant, agent). Mirrors
 * the IdentitySliceBuilder pattern: a narrow repo port + the shared SliceCache,
 * with the cache key scoped by (tenant_id, agent_id, contact_id) AND
 * version-stamped by the active profile id so a governance edit self-heals on
 * the next turn instead of waiting out the TTL.
 *
 * Fail-closed (invariant #5): when there is no contact, or no ACTIVE audience
 * profile, the slice is `{ audience: null }`. Callers MUST treat a null
 * audience as "no relationship with this agent" — never as a permissive
 * default. (The authoritative fail-closed BLOCK happens earlier, in
 * `resolveIdentity`; this builder is the read-side projection for context
 * assembly and is deliberately side-effect free — no audit here.)
 *
 * NOTE: this slice is NOT yet wired into `buildContextPacket`'s
 * ExecutionContextPacket assembly (that is #410). It is registered in the
 * production builder set + TTL policy so the cache key / TTL / invalidation
 * machinery treat it uniformly, and so #410 can assemble it without re-deriving
 * the contract.
 */
import { createHash } from 'node:crypto';
import type { BaseContextPacket } from '../../context-packet/types.js';
import type { AudienceContext } from '@/identity/audience-context.js';
import { buildAudienceContext } from '@/identity/audience-context.js';
import { sliceCacheKey, type SliceCache } from '../../context-packet/cache/slice-cache.js';
import { getTTLForSlice } from '../../context-packet/cache/ttl-policy.js';
import type {
  SliceBuilder,
  SliceBuilderInput,
  SliceBuilderResult,
} from './_types.js';
import type { AgentAudienceProfile, Pessoa } from '@/db/schema.js';

export interface AudienceRequirements {
  depth: 'minimal' | 'full';
}

/** The audience slice payload — the derived AudienceContext, or null when none. */
export interface AudienceSlice {
  audience: AudienceContext | null;
}

/**
 * Repo port — what the builder needs to project the audience slice. The real
 * implementation reads `pessoasRepo` + `agentAudienceProfilesRepo` +
 * `resolveScope`, all tenant-scoped via the ALS context. Kept as a port so the
 * builder stays unit-testable without a DB.
 */
export interface AudienceRepoPort {
  /** The turn's contact, scoped to the active (tenant, agent). */
  getPessoa(contact_id: string): Promise<Pessoa | null>;
  /** The contact's per-agent audience profile, scoped to the active (tenant, agent). */
  getProfile(contact_id: string): Promise<AgentAudienceProfile | null>;
  /** Entity ids the contact may act on (from resolveScope). */
  getAllowedEntityIds(pessoa: Pessoa): Promise<string[]>;
}

const EMPTY_AUDIENCE: AudienceSlice = { audience: null };

export class AudienceSliceBuilder
  implements SliceBuilder<AudienceRequirements, AudienceSlice>
{
  readonly name = 'audience' as const;

  constructor(
    private readonly repo: AudienceRepoPort,
    private readonly cache: SliceCache,
  ) {}

  /**
   * Cache key scoped by (tenant_id, agent_id, contact_id) — exactly the tuple
   * the issue specifies. tenant_id + agent_id are also in the key prefix via
   * `sliceCacheKey`, so two agents on one tenant cannot collide on a cached
   * audience even if they share a contact phone.
   */
  cacheKey(base: BaseContextPacket, req: AudienceRequirements): string {
    const scope = hashShort({
      agent_id: base.agent_id,
      contact_id: base.actor.pessoa_id ?? '__no_contact__',
      depth: req.depth,
      schema_version: 'v1-issue407',
    });
    return sliceCacheKey(base.tenant_id, base.agent_id, 'audience', scope);
  }

  /**
   * Version-stamped key: encodes the active profile id so a governance change
   * (status flip, reassignment) produces a fresh key on the next turn. Same
   * self-healing strategy as IdentitySliceBuilder.versionedCacheKey.
   */
  private versionedCacheKey(
    base: BaseContextPacket,
    req: AudienceRequirements,
    profile: AgentAudienceProfile | null,
  ): string {
    const scope = hashShort({
      agent_id: base.agent_id,
      contact_id: base.actor.pessoa_id ?? '__no_contact__',
      depth: req.depth,
      schema_version: 'v1-issue407',
      audience_profile_id: profile?.id ?? '__no_active__',
      // Mutable version stamp (review #5): any in-place edit bumps `updated_at`
      // via the DB trigger → a fresh key, so a deactivated/reassigned profile
      // never serves its prior (active) AudienceContext stale until the TTL.
      // `status` is encoded too so a status flip cannot collide with the active
      // entry within the same updated_at granularity.
      audience_status: profile?.status ?? '__none__',
      audience_version:
        profile?.updated_at != null
          ? new Date(profile.updated_at).toISOString()
          : '__none__',
    });
    return sliceCacheKey(base.tenant_id, base.agent_id, 'audience', scope);
  }

  async build(
    input: SliceBuilderInput<AudienceRequirements>,
  ): Promise<SliceBuilderResult<AudienceSlice>> {
    const start = performance.now();
    throwIfAborted(input.signal);

    const contactId = input.base.actor.pessoa_id;
    if (!contactId) {
      // No contact on this turn → no audience. Cache briefly under the
      // no-contact key.
      const key = this.versionedCacheKey(input.base, input.requirements, null);
      await this.cache.set(key, EMPTY_AUDIENCE, 60);
      return { slice: EMPTY_AUDIENCE, cache_hit: false, duration_ms: performance.now() - start };
    }

    // Read the profile BEFORE the cache lookup so the key can encode its id +
    // status + updated_at — converts "stale-until-TTL" into a self-healing miss
    // on any profile change (review #5).
    const profile = await this.repo.getProfile(contactId);
    throwIfAborted(input.signal);

    const key = this.versionedCacheKey(input.base, input.requirements, profile);

    // Fail-closed FIRST (invariant #5): a missing or non-active profile yields a
    // null audience and must NEVER return a cached *active* slice. Checked
    // before the cache read so an in-place deactivation can't be masked by a hit
    // on a stale active entry.
    if (!profile || profile.status !== 'active') {
      await this.cache.set(key, EMPTY_AUDIENCE, 60);
      return { slice: EMPTY_AUDIENCE, cache_hit: false, duration_ms: performance.now() - start };
    }

    const cached = await this.cache.get<AudienceSlice>(key);
    if (cached) {
      return { slice: cached, cache_hit: true, duration_ms: performance.now() - start };
    }

    const pessoa = await this.repo.getPessoa(contactId);
    throwIfAborted(input.signal);
    if (!pessoa) {
      await this.cache.set(key, EMPTY_AUDIENCE, 60);
      return { slice: EMPTY_AUDIENCE, cache_hit: false, duration_ms: performance.now() - start };
    }

    const allowed = await this.repo.getAllowedEntityIds(pessoa);
    throwIfAborted(input.signal);

    const audience = buildAudienceContext({
      pessoa,
      profile,
      allowed_entity_ids: allowed,
    });
    const slice: AudienceSlice = { audience };
    await this.cache.set(key, slice, getTTLForSlice('audience'));
    return { slice, cache_hit: false, duration_ms: performance.now() - start };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function hashShort(obj: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').substring(0, 12);
}
