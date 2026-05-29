/**
 * P8d §5 — identity-slice-builder.
 *
 * Constrói `IdentitySlice` (consumido pelo ContextPacket de P8a) a partir
 * do `agent_operational_profile_versions.profile_body` ativo. Builder é
 * stateless (cache fica em P8a). Defensivo a profile_body malformado
 * — devolve defaults seguros.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/db/repositories.js', () => ({
  operationalProfileVersionsRepo: { getActive: vi.fn() },
}));

import { buildIdentitySlice } from '@/runtime/context-assembly/slice-builders/identity-slice-builder.js';
import type { AgentOperationalProfileVersion, ProfileBody } from '@/db/schema.js';
import { operationalProfileVersionsRepo } from '@/db/repositories.js';

const getActiveMock = vi.mocked(operationalProfileVersionsRepo.getActive);

function makeProfile(overrides?: {
  status?: string;
  identity?: Record<string, unknown>;
  schema_version?: string;
}): AgentOperationalProfileVersion {
  const now = new Date();
  const identity = overrides?.identity ?? {
    role_descriptor: 'atendimento_financeiro_pf',
    voice: { tone: 'claro', formality: 'medium', verbosity: 'concise' },
    cognitive_limits: {
      max_inference_depth: 3,
      max_speculation_in_response: 0.2,
      confidence_floor_for_action: 0.7,
    },
    priorities: ['preservar_capital', 'clareza'],
    learned_voice_modifiers: [],
    principles: ['transparência', 'segurança'],
    identity_block: 'Você é a Maia.',
  };
  const profile_body = {
    schema_version: overrides?.schema_version ?? 'v3.1.1-2026-05-15',
    identity,
    style: { language: 'pt-BR', rhythm: {} },
    metadata: {
      effective_from: now.toISOString(),
      created_by: 'test',
      previous_version_id: null,
    },
  };
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    tenant_id: 'default',
    agent_id: 'default',
    version: 1,
    status: overrides?.status ?? 'active',
    profile_body: profile_body as unknown as ProfileBody,
    proposed_by: 'system_seed',
    proposed_reason: null,
    approved_by: 'system_seed',
    approved_at: now,
    activated_at: now,
    frozen_at: null,
    rolled_back_at: null,
    rollback_reason: null,
    created_at: now,
  } as unknown as AgentOperationalProfileVersion;
}

describe('identity-slice-builder (§5)', () => {
  beforeEach(() => {
    getActiveMock.mockReset();
  });

  it('returns null when no active profile', async () => {
    getActiveMock.mockResolvedValue(null);
    expect(await buildIdentitySlice({ depth: 'minimal' })).toBeNull();
  });

  it("returns null when profile.status !== 'active' (defesa runtime)", async () => {
    getActiveMock.mockResolvedValue(makeProfile({ status: 'frozen' }));
    expect(await buildIdentitySlice({ depth: 'minimal' })).toBeNull();
  });

  it('depth=minimal includes role, priorities, voice, cognitive_limits, version metadata', async () => {
    getActiveMock.mockResolvedValue(makeProfile());
    const slice = await buildIdentitySlice({ depth: 'minimal' });
    expect(slice).not.toBeNull();
    if (!slice) throw new Error('expected slice');
    expect(slice.role_descriptor).toBe('atendimento_financeiro_pf');
    expect(slice.priorities).toEqual(['preservar_capital', 'clareza']);
    expect(slice.voice.tone).toBe('claro');
    expect(slice.voice.formality).toBe('medium');
    expect(slice.cognitive_limits.max_inference_depth).toBe(3);
    expect(slice.schema_version).toBe('v3.1.1-2026-05-15');
    expect(slice.version_number).toBe(1);
    expect(slice.version_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(slice.identity_block).toBe('Você é a Maia.');
    // depth=minimal → sem principles, sem active_voice_modifiers
    expect(slice.principles).toBeUndefined();
    expect(slice.active_voice_modifiers).toBeUndefined();
  });

  it('depth=full includes principles + active_voice_modifiers', async () => {
    getActiveMock.mockResolvedValue(
      makeProfile({
        identity: {
          role_descriptor: 'atendimento_financeiro_pf',
          voice: { tone: 'claro', formality: 'medium', verbosity: 'concise' },
          cognitive_limits: {
            max_inference_depth: 3,
            max_speculation_in_response: 0.2,
            confidence_floor_for_action: 0.7,
          },
          priorities: [],
          principles: ['transparência', 'segurança'],
          identity_block: '',
          learned_voice_modifiers: [
            {
              id: '550e8400-e29b-41d4-a716-446655440001',
              dimension: 'tone',
              delta: { kind: 'shift', from: 'x', to: 'y' },
              confidence: 0.9,
              evidence_count: 5,
              status: 'active',
              proposed_by: 'detector',
              proposed_at: '2026-05-15T00:00:00Z',
              approved_by: null,
              approved_at: null,
              expires_at: null,
              evidence_refs: ['msg_1', 'msg_2', 'msg_3'],
            },
            {
              id: '550e8400-e29b-41d4-a716-446655440002',
              dimension: 'formality',
              delta: { kind: 'amplify', factor: 1.2 },
              confidence: 0.7,
              evidence_count: 3,
              status: 'deprecated',
              proposed_by: 'detector',
              proposed_at: '2026-05-15T00:00:00Z',
              approved_by: null,
              approved_at: null,
              expires_at: null,
              evidence_refs: ['msg_3'],
            },
          ],
        },
      }),
    );
    const slice = await buildIdentitySlice({ depth: 'full' });
    if (!slice) throw new Error('expected slice');
    expect(slice.principles).toEqual(['transparência', 'segurança']);
    expect(slice.active_voice_modifiers).toBeDefined();
    expect(slice.active_voice_modifiers).toHaveLength(1);
    expect(slice.active_voice_modifiers![0]!.status).toBe('active');
    expect(slice.active_voice_modifiers![0]!.dimension).toBe('tone');
  });

  it('depth=full omits active_voice_modifiers when nenhum está active', async () => {
    getActiveMock.mockResolvedValue(
      makeProfile({
        identity: {
          role_descriptor: 'atendimento',
          voice: { tone: '', formality: 'medium', verbosity: 'concise' },
          cognitive_limits: {
            max_inference_depth: 3,
            max_speculation_in_response: 0.2,
            confidence_floor_for_action: 0.7,
          },
          priorities: [],
          principles: [],
          identity_block: '',
          learned_voice_modifiers: [
            {
              id: '550e8400-e29b-41d4-a716-446655440002',
              dimension: 'formality',
              delta: { kind: 'amplify', factor: 1.2 },
              confidence: 0.7,
              evidence_count: 3,
              status: 'deprecated',
              proposed_by: 'detector',
              proposed_at: '2026-05-15T00:00:00Z',
              approved_by: null,
              approved_at: null,
              expires_at: null,
              evidence_refs: ['msg_3'],
            },
          ],
        },
      }),
    );
    const slice = await buildIdentitySlice({ depth: 'full' });
    if (!slice) throw new Error('expected slice');
    expect(slice.active_voice_modifiers).toBeUndefined();
  });

  it('handles malformed profile_body defensively', async () => {
    getActiveMock.mockResolvedValue(
      makeProfile({ identity: {} as Record<string, unknown> }),
    );
    const slice = await buildIdentitySlice({ depth: 'minimal' });
    if (!slice) throw new Error('expected slice');
    expect(slice.role_descriptor).toBe('unset');
    expect(slice.priorities).toEqual([]);
    expect(slice.voice.formality).toBe('medium'); // default
    expect(slice.cognitive_limits.max_inference_depth).toBe(3); // default
  });

  it('filters non-string priorities', async () => {
    getActiveMock.mockResolvedValue(
      makeProfile({
        identity: {
          role_descriptor: 'role',
          voice: { tone: '', formality: 'medium', verbosity: 'concise' },
          cognitive_limits: {
            max_inference_depth: 3,
            max_speculation_in_response: 0.2,
            confidence_floor_for_action: 0.7,
          },
          priorities: ['valid', 123, null, 'also_valid'],
          learned_voice_modifiers: [],
        },
      }),
    );
    const slice = await buildIdentitySlice({ depth: 'minimal' });
    if (!slice) throw new Error('expected slice');
    expect(slice.priorities).toEqual(['valid', 'also_valid']);
  });

  // Issue #192 — migration 061 leaves identity.priorities=[] intentionally;
  // only the p8d slug migration may populate canonical priorities. The slice
  // MUST NOT synthesize priorities from principles, otherwise the prompt
  // renderer ends up surfacing human principles text in the priorities
  // channel. principles remain reachable via slice.principles (depth=full).
  it('Issue #192: priorities=[] + identity.principles → slice.priorities stays []', async () => {
    getActiveMock.mockResolvedValue(
      makeProfile({
        identity: {
          role_descriptor: 'atendimento_financeiro_pf',
          voice: { tone: 'claro', formality: 'medium', verbosity: 'concise' },
          cognitive_limits: {
            max_inference_depth: 3,
            max_speculation_in_response: 0.2,
            confidence_floor_for_action: 0.7,
          },
          priorities: [],
          principles: ['transparência radical', 'preservar a evidência'],
          identity_block: '',
          learned_voice_modifiers: [],
        },
      }),
    );
    const slice = await buildIdentitySlice({ depth: 'full' });
    if (!slice) throw new Error('expected slice');
    expect(slice.priorities).toEqual([]);
    // principles still reachable through the dedicated channel.
    expect(slice.principles).toEqual(['transparência radical', 'preservar a evidência']);
  });

  it('Issue #192: priorities=[] + core_immutable.principles → slice.priorities stays []', async () => {
    const profile = makeProfile({
      identity: {
        role_descriptor: 'atendimento_financeiro_pf',
        voice: { tone: 'claro', formality: 'medium', verbosity: 'concise' },
        cognitive_limits: {
          max_inference_depth: 3,
          max_speculation_in_response: 0.2,
          confidence_floor_for_action: 0.7,
        },
        priorities: [],
        learned_voice_modifiers: [],
      },
    });
    // Direct-embed legacy layer left by migration 061.
    (profile.profile_body as unknown as Record<string, unknown>).core_immutable =
      { principles: ['transparência radical', 'preservar a evidência'] };
    getActiveMock.mockResolvedValue(profile);
    const slice = await buildIdentitySlice({ depth: 'full' });
    if (!slice) throw new Error('expected slice');
    expect(slice.priorities).toEqual([]);
  });

  it('Issue #192: depth=minimal also keeps slice.priorities=[] when only principles exist', async () => {
    getActiveMock.mockResolvedValue(
      makeProfile({
        identity: {
          role_descriptor: 'atendimento_financeiro_pf',
          voice: { tone: 'claro', formality: 'medium', verbosity: 'concise' },
          cognitive_limits: {
            max_inference_depth: 3,
            max_speculation_in_response: 0.2,
            confidence_floor_for_action: 0.7,
          },
          priorities: [],
          principles: ['transparência radical'],
          identity_block: '',
          learned_voice_modifiers: [],
        },
      }),
    );
    const slice = await buildIdentitySlice({ depth: 'minimal' });
    if (!slice) throw new Error('expected slice');
    expect(slice.priorities).toEqual([]);
  });

  it('uses defaults when cognitive_limits is missing', async () => {
    getActiveMock.mockResolvedValue(
      makeProfile({
        identity: {
          role_descriptor: 'role',
          voice: { tone: '', formality: 'medium', verbosity: 'concise' },
          priorities: [],
          learned_voice_modifiers: [],
        },
      }),
    );
    const slice = await buildIdentitySlice({ depth: 'minimal' });
    if (!slice) throw new Error('expected slice');
    expect(slice.cognitive_limits.max_inference_depth).toBe(3);
    expect(slice.cognitive_limits.max_speculation_in_response).toBe(0.2);
    expect(slice.cognitive_limits.confidence_floor_for_action).toBe(0.7);
  });
});
