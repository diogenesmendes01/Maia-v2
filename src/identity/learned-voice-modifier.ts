/**
 * P8d §4 — LearnedVoiceModifier: tipo concreto + Zod validator.
 *
 * Substitui `unknown[]` no `ProfileBody.identity.learned_voice_modifiers`.
 * Cada modifier representa um ajuste DELTA aplicado sobre a voz declarada
 * (Identity Contract §0.3). Modifiers são propostos por detectores de drift
 * (ex.: tom) ou pelo Admin UI; aprovados via fluxo de Proposal Diff & Approval.
 *
 * Invariantes (master §15):
 *  - learned_voice_modifiers NUNCA sobrescreve campos da Identity (§11)
 *  - confidence é fórmula determinística sobre evidence (NUNCA LLM)
 *  - evidence_count >= 3 (mín. para considerar um modifier proponível)
 *
 * P8d entrega o tipo + validação no write-path; populating automático fica
 * para P9b (drift detector tom) e P8.5 (Admin UI).
 */
import { z } from 'zod';

export type VoiceDimension =
  | 'tone'
  | 'formality'
  | 'verbosity'
  | 'rhythm'
  | 'vocabulary'
  | 'emoji_usage';

export interface LearnedVoiceModifier {
  id: string; // UUID v4
  dimension: VoiceDimension;
  delta:
    | { kind: 'shift'; from: string; to: string }
    | { kind: 'amplify'; factor: number } // [0.5, 2.0]
    | { kind: 'append'; phrase: string }; // max 200 chars
  confidence: number; // [0, 1] — fórmula determinística (NÃO LLM)
  evidence_count: number; // >= 3
  status: 'proposed' | 'active' | 'deprecated' | 'rolled_back';
  proposed_by: string;
  proposed_at: string; // ISO datetime
  approved_by: string | null;
  approved_at: string | null; // ISO datetime
  expires_at: string | null;
  evidence_refs: string[]; // pelo menos 1 trace_id/message_id
}

export const LearnedVoiceModifierSchema = z.object({
  id: z.string().uuid(),
  dimension: z.enum(['tone', 'formality', 'verbosity', 'rhythm', 'vocabulary', 'emoji_usage']),
  delta: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('shift'),
      from: z.string().min(1),
      to: z.string().min(1),
    }),
    z.object({
      kind: z.literal('amplify'),
      factor: z.number().min(0.5).max(2.0),
    }),
    z.object({
      kind: z.literal('append'),
      phrase: z.string().min(1).max(200),
    }),
  ]),
  confidence: z.number().min(0).max(1),
  evidence_count: z.number().int().min(3),
  status: z.enum(['proposed', 'active', 'deprecated', 'rolled_back']),
  proposed_by: z.string().min(1),
  proposed_at: z.string().datetime(),
  approved_by: z.string().nullable(),
  approved_at: z.string().datetime().nullable(),
  expires_at: z.string().datetime().nullable(),
  evidence_refs: z.array(z.string()).min(1),
});
