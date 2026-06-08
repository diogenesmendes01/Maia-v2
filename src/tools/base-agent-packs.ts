/**
 * Single source of truth for the per-agent capability FLOOR. Kept import-free
 * (no registry/gateway chain) so `db/repositories.ts` can import it without
 * violating the deliberate separation documented at repositories.ts:~4691.
 *
 * = baseline.core (universal, conservative) + the platform-default domain packs
 * the platform grants to EVERY agent (issue: calendar as base capability).
 */
export const BASE_AGENT_PACKS = ['baseline.core', 'domain.calendar'] as const;
