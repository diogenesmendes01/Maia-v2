/**
 * Typed builder for the live AgentOperationalProfileVersion shape (v3.1.1).
 *
 * The production table has a single JSONB column `profile_body` (ProfileBody).
 * The renderer and detectors still read the legacy 4-layer keys
 * (core_immutable / operational_profile / episodic_temp / growth_backlog) that
 * the generator embeds as extra fields inside profile_body during the migration
 * window.  Both layers are represented here so spec authors can assert against
 * either form without casting.
 *
 * Usage:
 *   buildProfileVersion()                          — sensible defaults
 *   buildProfileVersion({ status: 'proposed' })    — override top-level fields
 *   buildProfileVersion({ profile_body: { ... } }) — full body override
 */
import type { AgentOperationalProfileVersion, ProfileBody } from '@/db/schema.js';
import { PROFILE_BODY_SCHEMA_VERSION } from '@/db/schema.js';

/** Minimal shape embedded inside profile_body for legacy consumers. */
export type LegacyProfileEmbed = {
  core_immutable: {
    identity_block: string;
    principles: string[];
  };
  operational_profile: {
    voice_descriptor: string;
    thresholds: Record<string, unknown>;
  };
  episodic_temp: {
    entries?: Array<{
      summary?: string;
      mention_allowed?: boolean;
      proactive_use?: boolean;
    }>;
  };
  growth_backlog:
    | unknown[]
    | { items?: unknown[] };
};

export type BuiltProfileVersion = AgentOperationalProfileVersion & {
  /** Legacy keys embedded in profile_body by proposal-generator during migration. */
  readonly _legacy: LegacyProfileEmbed;
};

/** Partial override type for buildProfileVersion. */
export type ProfileVersionOverrides = Partial<
  Omit<AgentOperationalProfileVersion, 'profile_body'>
> & {
  profile_body?: Partial<ProfileBody & LegacyProfileEmbed>;
  _legacy?: Partial<LegacyProfileEmbed>;
};

const DEFAULT_IDENTITY_BLOCK =
  'Você é a **Maia**, assistente financeira pessoal do Mendes.';
const DEFAULT_PRINCIPLES = [
  'Separação acima de tudo. PF é PF. Cada empresa é uma entidade independente.',
  'Confirme antes de agir em coisas relevantes.',
  'Direta, não burocrática.',
];
const DEFAULT_VOICE_DESCRIPTOR =
  'Português brasileiro, registro coloquial-profissional. Sem emojis.';

/**
 * Build a valid AgentOperationalProfileVersion for use in specs.
 *
 * The returned object satisfies the Drizzle-inferred type AND embeds the
 * legacy 4-layer keys inside profile_body so renderer/detector code that
 * reads via (version as unknown) cast keeps working.
 */
export function buildProfileVersion(
  overrides: ProfileVersionOverrides = {},
): AgentOperationalProfileVersion {
  const now = new Date();

  const legacyBase: LegacyProfileEmbed = {
    core_immutable: {
      identity_block:
        overrides._legacy?.core_immutable?.identity_block ?? DEFAULT_IDENTITY_BLOCK,
      principles:
        overrides._legacy?.core_immutable?.principles ?? DEFAULT_PRINCIPLES,
    },
    operational_profile: {
      voice_descriptor:
        overrides._legacy?.operational_profile?.voice_descriptor ??
        DEFAULT_VOICE_DESCRIPTOR,
      thresholds:
        overrides._legacy?.operational_profile?.thresholds ?? {},
    },
    episodic_temp: overrides._legacy?.episodic_temp ?? {},
    growth_backlog: overrides._legacy?.growth_backlog ?? [],
  };

  const profileBodyBase: ProfileBody & LegacyProfileEmbed = {
    schema_version: PROFILE_BODY_SCHEMA_VERSION,
    identity: {
      role_descriptor: legacyBase.core_immutable.identity_block,
      voice: { tone: 'coloquial-profissional', formality: 'medium', verbosity: 'medium' },
      cognitive_limits: {
        max_inference_depth: 3,
        max_speculation_in_response: 0.2,
        confidence_floor_for_action: 0.8,
      },
      priorities: legacyBase.core_immutable.principles,
      learned_voice_modifiers: [],
    },
    style: { language: 'pt-BR', rhythm: {} },
    metadata: {
      effective_from: now.toISOString(),
      created_by: 'system_seed',
      previous_version_id: null,
    },
    // Legacy mirror for renderer/detector consumers (migration window).
    ...legacyBase,
    ...(overrides.profile_body as Partial<ProfileBody & LegacyProfileEmbed> | undefined),
  };

  const { profile_body: _pb, _legacy: _l, ...topLevelOverrides } = overrides;

  return {
    id: 'prof-fixture-1',
    tenant_id: 'default',
    agent_id: 'default',
    version: 1,
    status: 'active',
    profile_body: profileBodyBase as unknown as ProfileBody,
    proposed_by: 'system_seed',
    proposed_reason: 'initial seed from self_state + maia-prompt.md',
    approved_by: 'system_seed',
    approved_at: now,
    activated_at: now,
    frozen_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: now,
    ...topLevelOverrides,
  };
}

/**
 * Extract legacy core_immutable block from a built profile version.
 * Convenience helper for assertions.
 */
export function legacyCore(v: AgentOperationalProfileVersion): LegacyProfileEmbed['core_immutable'] {
  return (v.profile_body as unknown as LegacyProfileEmbed).core_immutable;
}

/**
 * Extract legacy operational_profile from a built profile version.
 */
export function legacyOp(v: AgentOperationalProfileVersion): LegacyProfileEmbed['operational_profile'] {
  return (v.profile_body as unknown as LegacyProfileEmbed).operational_profile;
}
