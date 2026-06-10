/**
 * IdentitySliceBuilder — combined P8a + P8d.
 *
 * P8a (class-based, production wiring):
 *   `IdentitySliceBuilder` SliceBuilder<IdentityRequirements, IdentitySlice>
 *   using a port + cache, used by production-builder-set and flag-hot-path.
 *
 * P8d (function-based, direct repo):
 *   `buildIdentitySlice({ depth })` reads
 *   `operationalProfileVersionsRepo.getActive()` directly and returns the
 *   `IdentitySlice` shape used by p8d tests (incl. legacy `core_immutable`
 *   fallback for identity_block/principles).
 *
 * Both APIs return the same `IdentitySlice` type (extended w/ optional
 * p8d fields: identity_block, principles, active_voice_modifiers,
 * version_number).
 *
 * Spec §3.3 / Plan Task 5 (P8a) + P8d §5.
 *
 * Depth semantics:
 *  - 'minimal' → role_descriptor, voice, cognitive_limits, schema_version,
 *                version_id (+ priorities, identity_block, version_number
 *                when source data has them)
 *  - 'full'    → 'minimal' + priorities + learned_voice_modifiers + principles
 *                + active_voice_modifiers (when present)
 */
import { createHash } from 'node:crypto';
import type {
  BaseContextPacket,
  IdentitySlice,
} from '../../context-packet/types.js';
import type { LearnedVoiceModifier } from '@/identity/learned-voice-modifier.js';
import { sliceCacheKey, type SliceCache } from '../../context-packet/cache/slice-cache.js';
import { getTTLForSlice } from '../../context-packet/cache/ttl-policy.js';
import type {
  SliceBuilder,
  SliceBuilderInput,
  SliceBuilderResult,
} from './_types.js';
import { operationalProfileVersionsRepo } from '@/db/repositories.js';

export interface IdentityRequirements {
  depth: 'minimal' | 'full';
}

/**
 * Repo port — what the builder needs from the operational profile repo.
 * The real implementation reads agent_operational_profile_versions where
 * status='active'. P4 shipped the concrete repo
 * (operationalProfileVersionsRepo), and production-builder-set binds it via
 * `realIdentityPort` (#206); this port shape remains for DI and tests.
 */
export interface OperationalProfilePort {
  getActive(
    tenant_id: string,
    agent_id: string,
  ): Promise<OperationalProfileRecord | null>;
}

export interface OperationalProfileRecord {
  id: string;
  profile_body: {
    schema_version?: string;
    identity: {
      role_descriptor: string;
      voice: { tone: string; formality: string; verbosity: string };
      cognitive_limits: {
        max_inference_depth: number;
        max_speculation_in_response: number;
        confidence_floor_for_action: number;
      };
      priorities?: string[];
      learned_voice_modifiers?: Array<{
        aspect: string;
        modifier: string;
        strength: number;
      }>;
    };
  };
}

const EMPTY_IDENTITY: IdentitySlice = {
  role_descriptor: '',
  voice: { tone: '', formality: 'medium', verbosity: 'concise' },
  cognitive_limits: {
    max_inference_depth: 0,
    max_speculation_in_response: 0,
    confidence_floor_for_action: 0.5,
  },
  priorities: [],
  learned_voice_modifiers: [],
  schema_version: 'v3.1.1-2026-05-15',
  version_id: '',
};

export class IdentitySliceBuilder
  implements SliceBuilder<IdentityRequirements, IdentitySlice>
{
  readonly name = 'identity' as const;

  constructor(
    private readonly repo: OperationalProfilePort,
    private readonly cache: SliceCache,
  ) {}

  cacheKey(base: BaseContextPacket, req: IdentityRequirements): string {
    const scope = hashShort({
      agent_id: base.agent_id,
      depth: req.depth,
      // Issue #200 codex review [HIGH]: bumped from 'v3.1.1' to
      // 'v3.1.1-issue192' so post-deploy lookups generate a fresh cache key.
      // Pre-fix entries (which leaked principles into slice.priorities) become
      // unreachable and the strict extraction always re-runs. Without this
      // bump, leaked cache rows continue to serve the cross-channel leak for
      // up to one full identity TTL (5min) after deploy. See migration 061's
      // SQL comment forbidding this leak.
      schema_version: 'v3.1.1-issue192',
    });
    return sliceCacheKey(base.tenant_id, base.agent_id, 'identity', scope);
  }

  /**
   * Build a cache key whose scope hash ALSO encodes the active profile's
   * `id` (the "version stamp"). This is the key actually used by `build()`
   * for cache get/set so that a profile state change (freeze, rollback, or
   * a brand-new active row) naturally produces a DIFFERENT key — the next
   * lookup misses and we re-read the post-state-change row.
   *
   * Issue #206 follow-up (Codex round 2, [HIGH]): without the version stamp,
   * once `(tenant, agent, depth, schema_version)` cached a slice, subsequent
   * `build()` calls served it for up to one identity TTL (300s) even after
   * the control-plane state transitioned the profile out of `active`. The
   * agent would keep emitting revoked operational instructions for minutes
   * after the rollback.
   *
   * `wireDefaultInvalidationHandlers` exists in
   * `src/runtime/context-packet/cache/invalidation-bus.ts` but is NOT
   * dispatched from production write paths (no
   * `identity_profile_activated`/`identity_profile_rolled_back` emitter in
   * `src/`). Rather than wire a post-tx event bus (which can fail, drop, or
   * race the cached turn between commit and delivery), encode the version
   * directly in the cache key — self-healing, no missed events.
   *
   * Tenant isolation: tenant_id is still in the key prefix via
   * `sliceCacheKey`; the active profile id is per-tenant by the schema's
   * `(tenant_id, agent_id, status='active')` partial unique index. Two
   * tenants cannot collide.
   *
   * @param activeProfileId  the `id` of the current active row, or `null`
   *                         when there's no active profile (post-rollback /
   *                         post-freeze with no new active).
   */
  private versionedCacheKey(
    base: BaseContextPacket,
    req: IdentityRequirements,
    activeProfileId: string | null,
  ): string {
    const scope = hashShort({
      agent_id: base.agent_id,
      depth: req.depth,
      schema_version: 'v3.1.1-issue192',
      // Stamp the active profile's id (or a "no-active" sentinel) into the
      // scope hash. Any state change that flips this value produces a fresh
      // key on the next call.
      active_profile_id: activeProfileId ?? '__no_active__',
    });
    return sliceCacheKey(base.tenant_id, base.agent_id, 'identity', scope);
  }

  async build(
    input: SliceBuilderInput<IdentityRequirements>,
  ): Promise<SliceBuilderResult<IdentitySlice>> {
    const start = performance.now();
    throwIfAborted(input.signal);

    // Issue #206 follow-up (Codex round 2, [HIGH]): fetch the active profile
    // BEFORE the cache lookup so the cache key can encode the active row's
    // `id`. This converts "stale-until-TTL" into a self-healing miss
    // whenever the active-row id changes (freeze → no row; rollback → no
    // row; new active → different row).
    //
    // Cost trade-off: we pay one indexed DB lookup per turn (the
    // `agent_op_profile_tenant_agent_status_idx` index makes this O(1) in
    // practice). What the cache still buys us: skipping the JSON.parse of
    // `profile_body` + the slice-extraction work (priorities, principles,
    // voice modifiers) on hits. Profile bodies are small but the extraction
    // is non-trivial, especially under high turn rates.
    //
    // If a future profile read becomes expensive (e.g. body grows large
    // enough that the index lookup dominates), reintroduce a lighter
    // `getActiveIdAndStatus()` probe — same cache-key strategy, smaller
    // payload. The contract (cache invalidates on state change) does NOT
    // depend on the probe shape.
    const record = await this.repo.getActive(
      input.base.tenant_id,
      input.base.agent_id,
    );
    throwIfAborted(input.signal);

    const key = this.versionedCacheKey(
      input.base,
      input.requirements,
      record?.id ?? null,
    );

    // Cache lookup (now keyed by the active profile id, so a state change
    // since the previous turn naturally falls through to a fresh build).
    const cached = await this.cache.get<IdentitySlice>(key);
    if (cached) {
      return {
        slice: cached,
        cache_hit: true,
        duration_ms: performance.now() - start,
      };
    }

    if (!record) {
      // No active profile — return empty slice. Cache briefly so we don't
      // hammer the DB.
      await this.cache.set(key, EMPTY_IDENTITY, 60);
      return {
        slice: EMPTY_IDENTITY,
        cache_hit: false,
        duration_ms: performance.now() - start,
      };
    }

    const body = record.profile_body;
    // Issue #192: priorities MUST come strictly from identity.priorities.
    // Migration 061 intentionally leaves identity.priorities=[] for legacy
    // rows — only `scripts/p8d-migration-priorities.ts` may slug-extract
    // canonical priorities. The earlier fallback (this builder used to
    // synthesize priorities from identity.principles / core_immutable.principles
    // when priorities was empty) leaked human-readable principle text into
    // slice.priorities, which build-prompt-from-packet renders as
    // "## Prioridades" — exactly the cross-channel leak the migration's
    // comment forbids. principles surface through their own channel
    // (slice.principles, populated below for depth='full'); never via
    // priorities.
    const explicitPriorities = Array.isArray(body.identity.priorities)
      ? body.identity.priorities.filter((p): p is string => typeof p === 'string')
      : [];
    const slice: IdentitySlice = {
      role_descriptor: body.identity.role_descriptor,
      voice: body.identity.voice,
      cognitive_limits: body.identity.cognitive_limits,
      priorities: input.requirements.depth === 'full' ? explicitPriorities : [],
      learned_voice_modifiers:
        input.requirements.depth === 'full'
          ? (body.identity.learned_voice_modifiers ?? [])
          : [],
      schema_version: body.schema_version ?? 'v3.1.1-2026-05-15',
      version_id: record.id,
    };

    // Issue #200 codex review [MEDIUM]: populate slice.principles for
    // depth='full' from identity.principles → core_immutable.principles.
    // Mirrors the function-form builder (buildIdentitySlice below). Without
    // this, migrated rows (priorities=[], principles=[...]) lose operational
    // guidance entirely until scripts/p8d-migration-priorities.ts runs.
    // The dedicated principles channel is rendered under "## Princípios" by
    // build-prompt-from-packet — strictly separate from "## Prioridades".
    if (input.requirements.depth === 'full') {
      const bodyAsRec = body as unknown as Record<string, unknown>;
      const identityRec = (bodyAsRec.identity ?? {}) as Record<string, unknown>;
      const coreImm = (bodyAsRec.core_immutable ?? {}) as Record<string, unknown>;
      const principlesRaw = Array.isArray(identityRec.principles)
        ? identityRec.principles
        : Array.isArray(coreImm.principles)
          ? coreImm.principles
          : null;
      if (principlesRaw) {
        const principles = (principlesRaw as unknown[]).filter(
          (p): p is string => typeof p === 'string',
        );
        if (principles.length > 0) slice.principles = principles;
      }
    }

    await this.cache.set(key, slice, getTTLForSlice('identity'));
    return {
      slice,
      cache_hit: false,
      duration_ms: performance.now() - start,
    };
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function hashShort(obj: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(obj))
    .digest('hex')
    .substring(0, 12);
}

// ─── P8d §5 — function-style API ──────────────────────────────────────────────

/**
 * P8d §5 — buildIdentitySlice (function form).
 *
 * Reads `operationalProfileVersionsRepo.getActive()` directly (no port, no
 * cache — cache lives in P8a's class-based builder). Returns null when
 * there's no active profile or the row's status drifted from 'active'.
 *
 * Falls back to legacy `profile_body.core_immutable.identity_block /
 * principles` so rows seeded before the P8d proposal-generator fix still
 * surface populated slices.
 */
export async function buildIdentitySlice(args: {
  depth: 'minimal' | 'full';
}): Promise<IdentitySlice | null> {
  const profile = await operationalProfileVersionsRepo.getActive();
  if (!profile || profile.status !== 'active') return null;

  const body = (profile.profile_body ?? {}) as Record<string, unknown>;
  const identity = (body.identity ?? {}) as Record<string, unknown>;

  // Review #100 fix: fall back to profile_body.core_immutable for identity_block
  // and principles. seedInitialOperationalProfile (P4) wrote those under the
  // legacy `core_immutable` shape; the seed now also writes them under
  // `identity` (canonical), but the fallback keeps slices populated for rows
  // that were seeded before the proposal-generator fix landed.
  const coreImmutable = (body.core_immutable ?? {}) as Record<string, unknown>;
  const identityBlock =
    typeof identity.identity_block === 'string' && identity.identity_block.length > 0
      ? identity.identity_block
      : typeof coreImmutable.identity_block === 'string'
        ? coreImmutable.identity_block
        : '';

  const slice: IdentitySlice = {
    role_descriptor:
      typeof identity.role_descriptor === 'string' ? identity.role_descriptor : 'unset',
    identity_block: identityBlock,
    // Issue #192: priorities MUST come strictly from identity.priorities.
    // Migration 061 intentionally leaves identity.priorities=[] for legacy
    // rows — only `scripts/p8d-migration-priorities.ts` may slug-extract
    // canonical priorities. principles surface through slice.principles
    // (populated below for depth='full'); never through slice.priorities.
    priorities: Array.isArray(identity.priorities)
      ? (identity.priorities as unknown[]).filter(
          (p): p is string => typeof p === 'string',
        )
      : [],
    voice: extractVoice(identity.voice),
    cognitive_limits: extractCognitiveLimits(identity.cognitive_limits),
    learned_voice_modifiers: [],
    schema_version:
      typeof body.schema_version === 'string' ? body.schema_version : 'unknown',
    version_id: profile.id,
    version_number: profile.version,
  };

  if (args.depth === 'full') {
    const principlesRaw = Array.isArray(identity.principles)
      ? identity.principles
      : Array.isArray(coreImmutable.principles)
        ? coreImmutable.principles
        : null;
    if (principlesRaw) {
      slice.principles = (principlesRaw as unknown[]).filter(
        (p): p is string => typeof p === 'string',
      );
    }
    const mods = Array.isArray(identity.learned_voice_modifiers)
      ? (identity.learned_voice_modifiers as LearnedVoiceModifier[])
      : [];
    const active = mods.filter((m) => m && m.status === 'active');
    if (active.length > 0) slice.active_voice_modifiers = active;
  }

  return slice;
}

function extractVoice(voiceRaw: unknown): IdentitySlice['voice'] {
  if (typeof voiceRaw === 'object' && voiceRaw !== null) {
    const v = voiceRaw as Record<string, unknown>;
    const formality = ['low', 'medium', 'high'].includes(String(v.formality))
      ? (v.formality as IdentitySlice['voice']['formality'])
      : 'medium';
    const verbosity = ['concise', 'medium', 'detailed'].includes(String(v.verbosity))
      ? (v.verbosity as IdentitySlice['voice']['verbosity'])
      : 'concise';
    return {
      tone: typeof v.tone === 'string' ? v.tone : '',
      formality,
      verbosity,
    };
  }
  return { tone: '', formality: 'medium', verbosity: 'concise' };
}

function extractCognitiveLimits(clRaw: unknown): IdentitySlice['cognitive_limits'] {
  if (typeof clRaw === 'object' && clRaw !== null) {
    const cl = clRaw as Record<string, unknown>;
    return {
      max_inference_depth:
        typeof cl.max_inference_depth === 'number' ? cl.max_inference_depth : 3,
      max_speculation_in_response:
        typeof cl.max_speculation_in_response === 'number'
          ? cl.max_speculation_in_response
          : 0.2,
      confidence_floor_for_action:
        typeof cl.confidence_floor_for_action === 'number'
          ? cl.confidence_floor_for_action
          : 0.7,
    };
  }
  return {
    max_inference_depth: 3,
    max_speculation_in_response: 0.2,
    confidence_floor_for_action: 0.7,
  };
}
