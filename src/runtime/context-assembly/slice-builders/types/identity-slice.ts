/**
 * P8d §5 — IdentitySlice TS type.
 *
 * Slice da Identity (parte do ContextPacket — P8a) consumido pelo
 * Agent Runtime (P9b). Sempre derivado da versão `active` do
 * `agent_operational_profile_versions`.
 *
 * Campos `principles` e `active_voice_modifiers` só estão presentes
 * quando o builder é chamado com `depth='full'`.
 */
import type { LearnedVoiceModifier } from '@/identity/learned-voice-modifier.js';

export interface IdentitySlice {
  role_descriptor: string;
  identity_block: string;
  priorities: string[];
  voice: {
    tone: string;
    formality: 'low' | 'medium' | 'high';
    /**
     * Alinhado com `ProfileBody.identity.voice.verbosity` (concise|medium|detailed).
     * O master spec menciona `concise|balanced|verbose` mas o schema canônico
     * é o do db/schema.ts.
     */
    verbosity: 'concise' | 'medium' | 'detailed';
  };
  cognitive_limits: {
    max_inference_depth: number;
    max_speculation_in_response: number;
    confidence_floor_for_action: number;
  };
  principles?: string[]; // só em depth='full'
  active_voice_modifiers?: LearnedVoiceModifier[]; // só em depth='full' E quando há active

  schema_version: string;
  version_id: string; // FK lógico ao agent_operational_profile_versions.id
  version_number: number;
}
