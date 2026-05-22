/**
 * P4 Task 8 (Cluster 1) — drift detector: valores (LLM-as-judge).
 *
 * Mesmo padrão de mock do tom.spec, mas o universo testado são os
 * `core_immutable.principles`. Inclui caso "sem princípios definidos →
 * retorna null sem chamar Anthropic".
 *
 * Issue #189 regression coverage:
 *   - Admin-ui profiles that only declare priorities (no real principles)
 *     must NOT trigger VALORES drift (which floors to `alto` → frozen).
 *   - When principles are populated, the detector still operates normally.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DriftRecentMessage } from '@/cognition/drift/types.js';
import { buildProfileVersion } from '../fixtures/agentProfile.js';

const { messagesCreateMock } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn(function (this: unknown) {
    return { messages: { create: messagesCreateMock } };
  });
  return { default: Anthropic };
});

import {
  valoresDetector,
  __test_only_resetNoPrinciplesLogCache,
} from '@/cognition/drift/valores.js';
import { logger } from '@/lib/logger.js';
import type { AgentOperationalProfileVersion, ProfileBody } from '@/db/schema.js';

function makeAnthropicReply(jsonObj: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(jsonObj) }],
  };
}

/**
 * valoresDetector reads `core_immutable.principles` directly from the profile
 * object via a legacy cast (TODO v3.1.1 migration in valores.ts). Until the
 * detector is migrated to read from profile_body.identity.priorities, the
 * fixture must expose core_immutable as a top-level field alongside the
 * canonical profile_body shape.
 */
function makeProfile(opts: { principles?: string[] } = {}) {
  const base = buildProfileVersion({
    _legacy: {
      core_immutable: {
        identity_block: 'Você é a Maia.',
        principles: opts.principles ?? [
          'Separação acima de tudo. PF é PF.',
          'Confirme antes de agir em coisas relevantes.',
          'Direta, não burocrática.',
        ],
      },
      operational_profile: { voice_descriptor: 'pt-br', thresholds: {} },
    },
  });
  // Mirror legacy top-level access that valores.ts relies on during migration.
  return Object.assign(base, {
    core_immutable: {
      identity_block: 'Você é a Maia.',
      principles: opts.principles ?? [
        'Separação acima de tudo. PF é PF.',
        'Confirme antes de agir em coisas relevantes.',
        'Direta, não burocrática.',
      ],
    },
  });
}

function makeAgentMsg(text: string, id = 'm-' + Math.random().toString(36).slice(2)): DriftRecentMessage {
  return {
    id,
    from: 'agent',
    text,
    created_at: new Date(),
  };
}

describe('valoresDetector', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __test_only_resetNoPrinciplesLogCache();
  });

  it('drift_detected=true → retorna DriftEvidence com type valores, payload com violated_principles', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
        drift_detected: true,
        severity_hint: 'alto',
        violated_principles: [0],
        examples: ['msg misturando PF e PJ'],
        reasoning: 'agente sugeriu misturar contas PF e PJ',
      }),
    );

    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Pode lançar isso na conta PF mesmo sendo da empresa.')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.drift_type).toBe('valores');
    expect(out.detected_by).toBe('drift_detector_valores');
    expect(out.payload['severity_hint']).toBe('alto');
    expect(out.payload['violated_principles']).toEqual([0]);
    expect(out.payload['examples']).toEqual(['msg misturando PF e PJ']);
    expect(out.payload['reasoning']).toBe('agente sugeriu misturar contas PF e PJ');
    expect(out.evidence_summary).toContain('misturar contas');
    expect(out.evidence_summary.length).toBeLessThanOrEqual(200);
  });

  it('drift_detected=false → retorna null', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
        drift_detected: false,
        severity_hint: 'baixo',
        violated_principles: [],
        examples: [],
        reasoning: 'consistente com princípios',
      }),
    );

    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Vou registrar na entidade PJ correta.')],
    });

    expect(out).toBeNull();
  });

  it('Anthropic throws → retorna null (defensivo)', async () => {
    messagesCreateMock.mockRejectedValueOnce(new Error('network exploded'));

    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });

    expect(out).toBeNull();
  });

  it('sem princípios definidos → retorna null sem chamar Anthropic', async () => {
    const out = await valoresDetector.detect({
      profile_active: makeProfile({ principles: [] }),
      recent_messages: [makeAgentMsg('algo')],
    });

    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('sem mensagens do agente → retorna null sem chamar Anthropic', async () => {
    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        { id: 'u1', from: 'user', text: 'oi', created_at: new Date() },
      ],
    });

    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('resposta sem JSON parseável → retorna null', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'sem json' }],
    });

    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });

    expect(out).toBeNull();
  });

  it('drift_detected=true sem campos opcionais → defaults aplicados (severity medio)', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: true }),
    );

    const out = await valoresDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.payload['severity_hint']).toBe('medio');
    expect(out.payload['violated_principles']).toEqual([]);
    expect(out.payload['examples']).toEqual([]);
    expect(out.payload['reasoning']).toBe('');
    expect(out.evidence_summary).toBe('drift de valores detectado');
  });

  // -------------------------------------------------------------------------
  // Issue #189 — resolver no longer synthesizes principles from priorities.
  // The detector MUST NOT treat operational priority labels as core value
  // contracts, because the decision engine floors any VALORES violation to
  // `alto` → `frozen` (or `critico` → `rollback`), and admin-ui rows that
  // only declare priorities could otherwise trigger user-visible auto-
  // freezes from routine operational labels.
  // -------------------------------------------------------------------------

  /**
   * Build an admin-ui-style profile: only canonical profile_body.identity is
   * populated — no legacy direct-embed core_immutable.principles, no
   * identity.principles. priorities IS populated (typical setup wizard).
   * This is the exact shape that used to trigger the bug.
   */
  function makeAdminUiProfile(
    opts: { priorities?: string[] } = {},
  ): AgentOperationalProfileVersion {
    const now = new Date();
    return {
      id: 'prof-adminui-1',
      tenant_id: 'tenant-acme',
      agent_id: 'agent-acme',
      version: 1,
      status: 'active',
      profile_body: {
        schema_version: 'v3.1.1-2026-05-15',
        identity: {
          role_descriptor: 'Você é a Acme Bot.',
          voice: { tone: 'profissional', formality: 'medium', verbosity: 'concise' },
          cognitive_limits: {
            max_inference_depth: 3,
            max_speculation_in_response: 0.2,
            confidence_floor_for_action: 0.7,
          },
          priorities: opts.priorities ?? ['paciência', 'clareza'],
          learned_voice_modifiers: [],
        },
        style: { language: 'pt-BR', rhythm: {} },
        metadata: {
          effective_from: now.toISOString(),
          created_by: 'admin_ui',
          previous_version_id: null,
        },
      } as unknown as ProfileBody,
      proposed_by: 'admin_ui',
      proposed_reason: 'admin setup',
      approved_by: 'admin_ui',
      approved_at: now,
      activated_at: now,
      frozen_at: null,
      rolled_back_at: null,
      rollback_reason: null,
      created_at: now,
    };
  }

  it('issue #189 (critical): admin-ui profile with ONLY priorities → no VALORES drift, no Anthropic call (NO freeze trigger)', async () => {
    // The exact bug class: admin-ui profile populated identity.priorities but
    // not principles. Before the fix the resolver synthesized priorities as
    // principles, the detector would audit them, and any apparent violation
    // floored to `alto` → frozen. After the fix the detector skips silently.
    const out = await valoresDetector.detect({
      profile_active: makeAdminUiProfile({
        priorities: ['paciência', 'clareza'],
      }),
      recent_messages: [makeAgentMsg('Vou ser direto pra economizar seu tempo.')],
    });

    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('issue #189: admin-ui profile with only priorities → emits one-shot observability log', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    await valoresDetector.detect({
      profile_active: makeAdminUiProfile(),
      recent_messages: [makeAgentMsg('alguma coisa')],
    });

    const noPrinciplesCalls = infoSpy.mock.calls.filter(
      ([, msg]) => msg === 'valores_drift.no_principles_configured',
    );
    expect(noPrinciplesCalls).toHaveLength(1);
    // Payload carries profile/tenant/agent ids only — never principle text.
    const payload = noPrinciplesCalls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      profile_id: 'prof-adminui-1',
      tenant_id: 'tenant-acme',
      agent_id: 'agent-acme',
    });
    expect(payload).not.toHaveProperty('principles');
    expect(payload).not.toHaveProperty('priorities');

    infoSpy.mockRestore();
  });

  it('issue #189: no-principles log is deduped per profile_id (no spam across runs)', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

    const profile = makeAdminUiProfile();
    await valoresDetector.detect({
      profile_active: profile,
      recent_messages: [makeAgentMsg('one')],
    });
    await valoresDetector.detect({
      profile_active: profile,
      recent_messages: [makeAgentMsg('two')],
    });
    await valoresDetector.detect({
      profile_active: profile,
      recent_messages: [makeAgentMsg('three')],
    });

    const noPrinciplesCalls = infoSpy.mock.calls.filter(
      ([, msg]) => msg === 'valores_drift.no_principles_configured',
    );
    expect(noPrinciplesCalls).toHaveLength(1);

    infoSpy.mockRestore();
  });

  it('issue #189 (positive): profile with REAL identity.principles → detector audits normally and can trigger drift', async () => {
    // Counter-test: when the operator DID declare real principles, the
    // detector still works end-to-end. The resolver lifts identity.principles
    // into the synthesized core_immutable.principles (NOT from priorities)
    // and the LLM-as-judge audits the agent text against them.
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
        drift_detected: true,
        severity_hint: 'alto',
        violated_principles: [0],
        examples: ['agente mentiu sobre saldo'],
        reasoning: 'agente contradisse "honestidade acima de tudo".',
      }),
    );

    const now = new Date();
    const profile: AgentOperationalProfileVersion = {
      id: 'prof-positive-1',
      tenant_id: 'tenant-acme',
      agent_id: 'agent-acme',
      version: 1,
      status: 'active',
      profile_body: {
        schema_version: 'v3.1.1-2026-05-15',
        identity: {
          role_descriptor: 'Você é a Acme Bot.',
          voice: { tone: 'profissional', formality: 'medium', verbosity: 'concise' },
          cognitive_limits: {
            max_inference_depth: 3,
            max_speculation_in_response: 0.2,
            confidence_floor_for_action: 0.7,
          },
          // priorities empty on purpose — would NOT be used either way after fix
          priorities: [],
          principles: ['Honestidade acima de tudo.', 'Transparência sempre.'],
          learned_voice_modifiers: [],
        },
        style: { language: 'pt-BR', rhythm: {} },
        metadata: {
          effective_from: now.toISOString(),
          created_by: 'admin_ui',
          previous_version_id: null,
        },
      } as unknown as ProfileBody,
      proposed_by: 'admin_ui',
      proposed_reason: 'admin setup',
      approved_by: 'admin_ui',
      approved_at: now,
      activated_at: now,
      frozen_at: null,
      rolled_back_at: null,
      rollback_reason: null,
      created_at: now,
    };

    const out = await valoresDetector.detect({
      profile_active: profile,
      recent_messages: [makeAgentMsg('Você tem saldo positivo (na verdade está negativo)')],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.drift_type).toBe('valores');
    expect(out.payload['severity_hint']).toBe('alto');
    expect(out.payload['violated_principles']).toEqual([0]);
    expect(messagesCreateMock).toHaveBeenCalledOnce();
  });
});
