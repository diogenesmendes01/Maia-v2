/**
 * AudienceContext — the runtime answer to "who is this person FOR THIS
 * AGENT, on this channel, this turn?" (issue #407).
 *
 * DERIVED, NOT PERSISTED. It is assembled per-turn from:
 *   - the resolved `pessoa` (already scoped to tenant_id + agent_id),
 *   - that pessoa's `agent_audience_profile` (the per-agent relation),
 *   - the resolved entity scope (`resolveScope()` → allowed_entity_ids),
 *   - the channel the message arrived on.
 *
 * Invariants:
 *   #1 tenant isolation — every field is scoped to the resolving
 *      (tenant_id, agent_id); `contact_id` is the pessoa.id (Opção A).
 *   #3 trust is computed — `audience_type` / `trust_level` come from the
 *      governed profile, never from the LLM.
 *   #5 fail-closed — a pessoa with NO active audience profile does NOT get an
 *      AudienceContext; the resolver treats it as quarantined (see
 *      `resolveAudienceContext`).
 *
 * The enum literals are the single source of truth in `src/shared/audience.ts`
 * — reused unchanged by the downstream skill-by-audience policy (#409).
 */
import type { AudienceType, TrustLevel } from '@/shared/audience.js';
import type { AgentAudienceProfile, AudienceStatus, Pessoa } from '@/db/schema.js';

export interface AudienceContext {
  tenant_id: string;
  agent_id: string;
  /** Channel the turn arrived on. `null` when not yet resolved (single-agent today). */
  channel_id: string | null;
  channel_type: string;
  /** = pessoa.id (Opção A — `contact_identities` split is a #407 non-goal). */
  contact_id: string;
  audience_profile_id: string;
  /** Governance-derived (invariant #3) — never LLM-declared. */
  audience_type: AudienceType;
  /** Governance-derived (invariant #3) — never LLM-declared. */
  trust_level: TrustLevel;
  /** permission_profile ids attached to the relation (drives future policy). */
  permission_profiles: string[];
  /** Entity ids the contact may act on, from `resolveScope()`. */
  allowed_entity_ids: string[];
  status: AudienceStatus;
}

/** Default channel descriptor — single-agent-per-channel today (MULTI_CHANNEL OFF). */
export const DEFAULT_CHANNEL_TYPE = 'whatsapp';

/**
 * Pure assembly of the AudienceContext from its already-resolved parts. Kept
 * side-effect free (no DB, no audit) so it is trivially unit-testable and so
 * the resolver owns the fail-closed / audit decisions. Returns `null` when the
 * profile is missing or not `active` — the caller MUST fail closed on null.
 */
export function buildAudienceContext(input: {
  pessoa: Pessoa;
  profile: AgentAudienceProfile | null;
  allowed_entity_ids: string[];
  channel_id?: string | null;
  channel_type?: string;
}): AudienceContext | null {
  const { pessoa, profile } = input;
  if (!profile || profile.status !== 'active') return null;

  return {
    tenant_id: pessoa.tenant_id,
    agent_id: pessoa.agent_id,
    channel_id: input.channel_id ?? null,
    channel_type: input.channel_type ?? DEFAULT_CHANNEL_TYPE,
    contact_id: pessoa.id,
    audience_profile_id: profile.id,
    audience_type: profile.audience_type,
    trust_level: profile.trust_level,
    permission_profiles: profile.permission_profile_ids ?? [],
    allowed_entity_ids: input.allowed_entity_ids,
    status: profile.status,
  };
}
