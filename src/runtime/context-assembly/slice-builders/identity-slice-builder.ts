/**
 * P8d §5 — identity-slice-builder.
 *
 * Constrói `IdentitySlice` (consumido pelo `ContextPacket` de P8a) a partir
 * do `agent_operational_profile_versions.profile_body` ativo. Stateless:
 * cache fica em P8a. Defensivo a `profile_body` malformado — devolve defaults
 * seguros em vez de crash.
 *
 * Depth semantics:
 *   - 'minimal' → role + identity_block + priorities + voice + cognitive_limits
 *                 + version metadata
 *   - 'full'    → +principles +active_voice_modifiers (quando há)
 *
 * Returns `null` quando não existe versão `active` ou quando a coluna
 * `status` divergiu (defesa runtime).
 */
import type { IdentitySlice } from './types/identity-slice.js';
import type { LearnedVoiceModifier } from '@/identity/learned-voice-modifier.js';
import { operationalProfileVersionsRepo } from '@/db/repositories.js';

export async function buildIdentitySlice(args: {
  depth: 'minimal' | 'full';
}): Promise<IdentitySlice | null> {
  const profile = await operationalProfileVersionsRepo.getActive();
  if (!profile || profile.status !== 'active') return null;

  const body = (profile.profile_body ?? {}) as Record<string, unknown>;
  const identity = (body.identity ?? {}) as Record<string, unknown>;

  const slice: IdentitySlice = {
    role_descriptor:
      typeof identity.role_descriptor === 'string' ? identity.role_descriptor : 'unset',
    identity_block:
      typeof identity.identity_block === 'string' ? identity.identity_block : '',
    priorities: Array.isArray(identity.priorities)
      ? (identity.priorities as unknown[]).filter((p): p is string => typeof p === 'string')
      : [],
    voice: extractVoice(identity.voice),
    cognitive_limits: extractCognitiveLimits(identity.cognitive_limits),
    schema_version:
      typeof body.schema_version === 'string' ? body.schema_version : 'unknown',
    version_id: profile.id,
    version_number: profile.version,
  };

  if (args.depth === 'full') {
    if (Array.isArray(identity.principles)) {
      slice.principles = (identity.principles as unknown[]).filter(
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
