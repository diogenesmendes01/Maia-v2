/**
 * Shared resolver for the legacy 4-layer payload that the v3.1.1 refactor
 * collapsed into `agent_operational_profile_versions.profile_body`.
 *
 * Consumers (renderer, drift detectors, slice builders) MUST go through
 * this helper rather than reading the layout directly. Single source of
 * truth so every reader stays aligned with what the writers
 * (`seedInitialOperationalProfile`, `operationalProfileVersionsRepo.create`,
 * migration 061) emit.
 *
 * Read precedence per layer:
 *   1. `profile_body.{layer}` — the production path. Both
 *      proposal-generator and migration 061 embed the legacy payload
 *      directly under profile_body.
 *   2. top-level `row.{layer}` — test fixtures / hand-built rows.
 *   3. synthesized view derived from `profile_body.identity.*` — for
 *      newly-created admin-ui rows that have no legacy payload.
 *
 * The synthesized fallback is intentionally lossy (the canonical ProfileBody
 * doesn't model `principles` strings or `thresholds`), but with cognitive
 * limits it can at least surface admin-ui calibrated parameters.
 */
import type { AgentOperationalProfileVersion } from '@/db/schema.js';

export interface LegacyCoreImmutable {
  identity_block?: string;
  principles?: unknown[];
}

export interface LegacyOperationalProfile {
  voice_descriptor?: string;
  thresholds?: Record<string, unknown>;
}

export interface LegacyEpisodicEntry {
  summary?: string;
  mention_allowed?: boolean;
  proactive_use?: boolean;
}

export interface LegacyEpisodicTemp {
  entries?: LegacyEpisodicEntry[];
}

export type LegacyGrowthBacklog = unknown[] | { items?: unknown[] };

export interface ResolvedLegacyPayload {
  core_immutable: LegacyCoreImmutable;
  operational_profile: LegacyOperationalProfile;
  episodic_temp: LegacyEpisodicTemp;
  growth_backlog: LegacyGrowthBacklog;
  /** True when at least one layer came from the synthesized canonical view. */
  synthesized: boolean;
}

function hasAnyContent(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/**
 * Resolve the legacy 4-layer view from a Drizzle-shaped or top-level-merged
 * row. Returns empty layers when no payload is reachable — callers that need
 * to short-circuit on "no identity content" can check
 * `result.core_immutable.principles?.length`.
 */
export function resolveLegacyPayload(
  version: AgentOperationalProfileVersion | { profile_body?: unknown },
): ResolvedLegacyPayload {
  const row = version as unknown as {
    profile_body?: {
      identity?: {
        role_descriptor?: unknown;
        identity_block?: unknown;
        voice?: { tone?: unknown };
        principles?: unknown[];
        priorities?: unknown[];
        cognitive_limits?: Record<string, unknown>;
      };
      core_immutable?: LegacyCoreImmutable;
      operational_profile?: LegacyOperationalProfile;
      episodic_temp?: LegacyEpisodicTemp;
      growth_backlog?: LegacyGrowthBacklog;
    };
    core_immutable?: LegacyCoreImmutable;
    operational_profile?: LegacyOperationalProfile;
    episodic_temp?: LegacyEpisodicTemp;
    growth_backlog?: LegacyGrowthBacklog;
  };

  const body = row.profile_body ?? {};

  // Synthesized view from the canonical profile_body.identity.*. Used only
  // when no direct-embed or top-level legacy data is reachable. Includes
  // `thresholds` derived from cognitive_limits so admin-ui-calibrated
  // parameters surface in the legacy renderer/detectors.
  const synthesizedCore: LegacyCoreImmutable = {
    identity_block:
      typeof body.identity?.identity_block === 'string'
        ? body.identity.identity_block
        : typeof body.identity?.role_descriptor === 'string'
          ? body.identity.role_descriptor
          : undefined,
    principles: Array.isArray(body.identity?.principles)
      ? body.identity!.principles
      : Array.isArray(body.identity?.priorities)
        ? body.identity!.priorities
        : undefined,
  };
  const synthesizedOp: LegacyOperationalProfile = {
    voice_descriptor:
      typeof body.identity?.voice?.tone === 'string'
        ? body.identity.voice.tone
        : undefined,
    thresholds:
      body.identity?.cognitive_limits &&
      typeof body.identity.cognitive_limits === 'object'
        ? { ...body.identity.cognitive_limits }
        : undefined,
  };

  function pick<T extends object>(
    embedded: T | undefined,
    topVal: T | undefined,
    synthesized: T,
  ): { value: T; from: 'embedded' | 'top' | 'synthesized' } {
    if (embedded && hasAnyContent(embedded)) return { value: embedded, from: 'embedded' };
    if (topVal && hasAnyContent(topVal)) return { value: topVal, from: 'top' };
    return { value: synthesized, from: 'synthesized' };
  }

  const core = pick<LegacyCoreImmutable>(
    body.core_immutable,
    row.core_immutable,
    synthesizedCore,
  );
  const op = pick<LegacyOperationalProfile>(
    body.operational_profile,
    row.operational_profile,
    synthesizedOp,
  );
  const episodic =
    body.episodic_temp ?? row.episodic_temp ?? ({} as LegacyEpisodicTemp);
  const growth =
    body.growth_backlog ?? row.growth_backlog ?? ([] as LegacyGrowthBacklog);

  return {
    core_immutable: core.value,
    operational_profile: op.value,
    episodic_temp: episodic,
    growth_backlog: growth,
    synthesized: core.from === 'synthesized' || op.from === 'synthesized',
  };
}
