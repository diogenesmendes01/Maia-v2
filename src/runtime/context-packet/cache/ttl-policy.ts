/**
 * P8a — TTL policy table per slice.
 *
 * Spec §4 — slices with stable data (identity, soul, policy) get longer TTLs.
 * Slices that change per turn (user memories, knowledge facts that learn) get
 * shorter TTLs. All values include jitter ±10% to prevent thundering herd.
 *
 * Jitter is applied at write-time inside SliceCache.set().
 */
import type { SliceName } from '../types.js';

const TTL_TABLE: Record<SliceName, number> = {
  // Identity: rebuilt only when profile rev changes (5min default)
  identity: 300,
  // User: pessoa attributes change slowly, but memories may update per turn
  user: 60,
  // Knowledge: facts/rules learn over time, but lifecycle transitions
  // invalidate cache via bus
  knowledge: 120,
  // Soul biases: drift slowly, invalidated on bias activation
  soul: 600,
  // Policy: stable, invalidated on rule activation/deactivation
  policy: 600,
  // Skill: invalidated on skill activation; relatively stable
  skill: 300,
  // Tool: registry rarely changes; longest TTL
  tool: 900,
  // History: per-turn, never cached at slice level
  history: 5,
  // Audience (#407): the per-agent audience profile changes slowly (governance
  // edits), but a change must be reflected promptly because it gates trust.
  // Mirror identity's 5min — the profile-id is encoded in the cache scope hash,
  // so a profile change self-heals via a fresh key (same strategy as
  // IdentitySliceBuilder) rather than waiting out the TTL.
  audience: 300,
};

const MIN_TTL = 5;
const MAX_TTL = 3600;

export function getTTLForSlice(slice: SliceName): number {
  return TTL_TABLE[slice];
}

/**
 * Apply ±10% jitter to a base TTL. Bounded to [MIN_TTL, MAX_TTL].
 *
 * Deterministic when `rand` is supplied (for tests); non-deterministic
 * otherwise (Math.random).
 */
export function jitteredTTL(baseTTL: number, rand: () => number = Math.random): number {
  const factor = 0.9 + rand() * 0.2; // [0.9, 1.1)
  const jittered = Math.floor(baseTTL * factor);
  return Math.max(MIN_TTL, Math.min(MAX_TTL, jittered));
}

export const TTL_BOUNDS = { MIN_TTL, MAX_TTL };
