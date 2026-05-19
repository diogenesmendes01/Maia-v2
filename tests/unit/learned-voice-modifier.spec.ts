/**
 * P8d §4 — LearnedVoiceModifier Zod validator.
 *
 * Substitui o `unknown[]` no `ProfileBody.identity.learned_voice_modifiers`
 * por um shape concreto + validação. Owner do write-path (repositories.ts)
 * usa esta validação em `operationalProfileVersionsRepo.create`.
 */
import { describe, it, expect } from 'vitest';
import {
  LearnedVoiceModifierSchema,
  type LearnedVoiceModifier,
} from '@/identity/learned-voice-modifier.js';

describe('LearnedVoiceModifier (§4)', () => {
  const validModifier: LearnedVoiceModifier = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    dimension: 'tone',
    delta: { kind: 'shift', from: 'formal', to: 'casual' },
    confidence: 0.85,
    evidence_count: 5,
    status: 'active',
    proposed_by: 'drift_detector_tom',
    proposed_at: '2026-05-15T10:00:00Z',
    approved_by: 'founder',
    approved_at: '2026-05-15T11:00:00Z',
    expires_at: null,
    evidence_refs: ['msg_001', 'msg_002', 'msg_003'],
  };

  it('validates correct LearnedVoiceModifier (kind=shift)', () => {
    expect(() => LearnedVoiceModifierSchema.parse(validModifier)).not.toThrow();
  });

  it('validates amplify delta (factor in [0.5, 2.0])', () => {
    const modWithAmp: LearnedVoiceModifier = {
      ...validModifier,
      delta: { kind: 'amplify', factor: 1.5 },
    };
    expect(() => LearnedVoiceModifierSchema.parse(modWithAmp)).not.toThrow();
  });

  it('validates append delta (phrase ≤ 200 chars)', () => {
    const modWithAppend: LearnedVoiceModifier = {
      ...validModifier,
      delta: { kind: 'append', phrase: 'adding a note' },
    };
    expect(() => LearnedVoiceModifierSchema.parse(modWithAppend)).not.toThrow();
  });

  it('rejects evidence_count < 3', () => {
    expect(() =>
      LearnedVoiceModifierSchema.parse({ ...validModifier, evidence_count: 2 }),
    ).toThrow();
  });

  it('rejects confidence outside [0, 1]', () => {
    expect(() =>
      LearnedVoiceModifierSchema.parse({ ...validModifier, confidence: 1.5 }),
    ).toThrow();
    expect(() =>
      LearnedVoiceModifierSchema.parse({ ...validModifier, confidence: -0.1 }),
    ).toThrow();
  });

  it('rejects amplify factor outside [0.5, 2.0]', () => {
    const badFactor = { ...validModifier, delta: { kind: 'amplify', factor: 2.5 } };
    expect(() => LearnedVoiceModifierSchema.parse(badFactor)).toThrow();
  });

  it('rejects append phrase > 200 chars', () => {
    const longPhrase = 'a'.repeat(201);
    const bad = { ...validModifier, delta: { kind: 'append', phrase: longPhrase } };
    expect(() => LearnedVoiceModifierSchema.parse(bad)).toThrow();
  });

  it('rejects invalid UUID in id', () => {
    expect(() =>
      LearnedVoiceModifierSchema.parse({ ...validModifier, id: 'not-a-uuid' }),
    ).toThrow();
  });

  it('rejects invalid dimension', () => {
    expect(() =>
      LearnedVoiceModifierSchema.parse({ ...validModifier, dimension: 'invalid_dim' }),
    ).toThrow();
  });

  it('requires at least 1 evidence_ref', () => {
    expect(() =>
      LearnedVoiceModifierSchema.parse({ ...validModifier, evidence_refs: [] }),
    ).toThrow();
  });

  it('rejects invalid status enum', () => {
    expect(() =>
      LearnedVoiceModifierSchema.parse({ ...validModifier, status: 'unknown' }),
    ).toThrow();
  });

  it('accepts all 6 valid dimensions', () => {
    const dims = ['tone', 'formality', 'verbosity', 'rhythm', 'vocabulary', 'emoji_usage'] as const;
    for (const d of dims) {
      expect(() =>
        LearnedVoiceModifierSchema.parse({ ...validModifier, dimension: d }),
      ).not.toThrow();
    }
  });

  it('accepts all 4 valid statuses', () => {
    const statuses = ['proposed', 'active', 'deprecated', 'rolled_back'] as const;
    for (const s of statuses) {
      expect(() =>
        LearnedVoiceModifierSchema.parse({ ...validModifier, status: s }),
      ).not.toThrow();
    }
  });
});
