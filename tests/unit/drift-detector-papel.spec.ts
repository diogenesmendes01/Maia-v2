/**
 * P8d §6 — drift detector: papel (LLM-as-judge).
 *
 * Verifica se as mensagens recentes do agente aderem ao `role_descriptor`
 * declarado no `profile_body.identity`. 9º detector (alongside soul_drift
 * de P8b). Padrão idêntico ao `valores.ts`.
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
  papelDriftDetector,
  __test_only_resetFallbackLogCache,
} from '@/cognition/drift/papel.js';
import { logger } from '@/lib/logger.js';

function makeAnthropicReply(jsonObj: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(jsonObj) }],
  };
}

function makeProfile(opts: {
  role_descriptor?: string;
  priorities?: string[];
} = {}) {
  return buildProfileVersion({
    profile_body: {
      identity: {
        role_descriptor: opts.role_descriptor ?? 'atendimento_financeiro_pf',
        voice: { tone: '', formality: 'medium', verbosity: 'concise' },
        cognitive_limits: {
          max_inference_depth: 3,
          max_speculation_in_response: 0.2,
          confidence_floor_for_action: 0.7,
        },
        priorities: opts.priorities ?? ['preservar_capital', 'clareza'],
        learned_voice_modifiers: [],
      },
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

describe('papelDriftDetector (§6)', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __test_only_resetFallbackLogCache();
  });

  it('drift_detected=true → retorna DriftEvidence com type papel_drift, payload completo', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({
        drift_detected: true,
        severity_hint: 'alto',
        off_role_examples: ['parecer jurídico', 'ações tech'],
        observed_role_inferred: 'consultoria_juridica_e_investimentos',
        reasoning: 'Agente ofereceu parecer jurídico mas papel é atendimento financeiro PF.',
      }),
    );

    const out = await papelDriftDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        makeAgentMsg('Vou preparar um parecer jurídico sobre sua causa.'),
        makeAgentMsg('Recomendo investir em ações tech.'),
        makeAgentMsg('Outra mensagem fora do papel.'),
      ],
    });

    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.drift_type).toBe('papel_drift');
    expect(out.detected_by).toBe('drift_detector_papel');
    expect(out.payload['severity_hint']).toBe('alto');
    expect(out.payload['declared_role']).toBe('atendimento_financeiro_pf');
    expect(out.payload['observed_role_inferred']).toBe(
      'consultoria_juridica_e_investimentos',
    );
    const offRole = out.payload['off_role_examples'];
    expect(Array.isArray(offRole)).toBe(true);
    expect(offRole).toHaveLength(2);
    expect(out.evidence_summary).toContain('jurídico');
    expect(out.evidence_summary.length).toBeLessThanOrEqual(200);
  });

  it('drift_detected=false → retorna null', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: false }),
    );
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('Lançado: -R$ 100,00, energia, Itaú.')],
    });
    expect(out).toBeNull();
  });

  it("role_descriptor='unset' → retorna null sem chamar Anthropic", async () => {
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile({ role_descriptor: 'unset' }),
      recent_messages: [makeAgentMsg('alguma mensagem')],
    });
    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it("role_descriptor vazio '' → retorna null sem chamar Anthropic", async () => {
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile({ role_descriptor: '' }),
      recent_messages: [makeAgentMsg('alguma mensagem')],
    });
    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('sem mensagens do agente → retorna null sem chamar Anthropic', async () => {
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [
        { id: 'u1', from: 'user', text: 'oi', created_at: new Date() },
      ],
    });
    expect(out).toBeNull();
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });

  it('Anthropic throws → retorna null (defensivo)', async () => {
    messagesCreateMock.mockRejectedValueOnce(new Error('API down'));
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });
    expect(out).toBeNull();
  });

  it('JSON inválido na resposta → retorna null', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'não tem json' }],
    });
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });
    expect(out).toBeNull();
  });

  it('drift_detected=true sem campos opcionais → defaults aplicados', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: true }),
    );
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile(),
      recent_messages: [makeAgentMsg('algo')],
    });
    expect(out).not.toBeNull();
    if (!out) throw new Error('expected DriftEvidence');
    expect(out.payload['severity_hint']).toBe('medio');
    expect(out.payload['declared_role']).toBe('atendimento_financeiro_pf');
    expect(out.payload['observed_role_inferred']).toBeNull();
    expect(out.payload['off_role_examples']).toEqual([]);
    expect(out.evidence_summary).toBe('papel desviado');
  });

  it('priorities vazias → continua chamando Anthropic (drift independe)', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: false }),
    );
    const out = await papelDriftDetector.detect({
      profile_active: makeProfile({ priorities: [] }),
      recent_messages: [makeAgentMsg('algo')],
    });
    expect(out).toBeNull();
    expect(messagesCreateMock).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Issue #172 — fallback chain when migration 061 backfilled identity.principles
  // but persisted identity.priorities as [].
  // -------------------------------------------------------------------------

  /** Capture the Anthropic user prompt so we can assert which list got rendered. */
  function getLastUserPrompt(): string {
    const calls = messagesCreateMock.mock.calls;
    const last = calls[calls.length - 1] as
      | [{ messages: Array<{ role: string; content: string }> }]
      | undefined;
    if (!last) throw new Error('expected at least one anthropic call');
    return last[0].messages[0].content;
  }

  /**
   * Build a profile in the exact shape migration 061 leaves rows in:
   *  - identity.priorities: []
   *  - identity.principles: [...backfilled from core_immutable.principles]
   *  - core_immutable.principles: [...same list, direct-embed in profile_body]
   *
   * Caller can opt to omit either layer to simulate further degradation.
   */
  function makeMigration061Profile(opts: {
    priorities?: unknown[];
    identityPrinciples?: unknown[];
    coreImmutablePrinciples?: unknown[];
    role_descriptor?: string;
  } = {}) {
    const profile = buildProfileVersion({
      profile_body: {
        identity: {
          role_descriptor: opts.role_descriptor ?? 'atendimento_financeiro_pf',
          voice: { tone: '', formality: 'medium', verbosity: 'concise' },
          cognitive_limits: {
            max_inference_depth: 3,
            max_speculation_in_response: 0.2,
            confidence_floor_for_action: 0.7,
          },
          priorities: (opts.priorities ?? []) as string[],
          // `principles` is an extra field migration 061 writes into
          // profile_body.identity even though the canonical ProfileBody
          // schema doesn't name it. The detector reads it via runtime cast.
          principles: opts.identityPrinciples as string[] | undefined,
          learned_voice_modifiers: [],
        },
      } as Record<string, unknown>,
      _legacy: {
        core_immutable: {
          identity_block: opts.role_descriptor ?? 'atendimento_financeiro_pf',
          principles: (opts.coreImmutablePrinciples ?? []) as string[],
        },
      },
    });
    return profile;
  }

  it('priorities=[] + identity.principles populated → usa identity.principles (fallback 1)', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: false }),
    );
    const out = await papelDriftDetector.detect({
      profile_active: makeMigration061Profile({
        priorities: [],
        identityPrinciples: ['preservar_capital', 'clareza_acima_de_tudo'],
        coreImmutablePrinciples: ['preservar_capital', 'clareza_acima_de_tudo'],
      }),
      recent_messages: [makeAgentMsg('algo')],
    });
    expect(out).toBeNull();
    expect(messagesCreateMock).toHaveBeenCalledOnce();
    const prompt = getLastUserPrompt();
    expect(prompt).toContain('PRIORIDADES: preservar_capital, clareza_acima_de_tudo');
    expect(prompt).not.toContain('PRIORIDADES: (nenhuma)');
  });

  it('priorities=[] + identity.principles=[] + core_immutable.principles populated → usa core_immutable (fallback 2)', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: false }),
    );
    const out = await papelDriftDetector.detect({
      profile_active: makeMigration061Profile({
        priorities: [],
        identityPrinciples: [],
        coreImmutablePrinciples: [
          'Separação acima de tudo.',
          'Confirme antes de agir em coisas relevantes.',
        ],
      }),
      recent_messages: [makeAgentMsg('algo')],
    });
    expect(out).toBeNull();
    const prompt = getLastUserPrompt();
    expect(prompt).toContain(
      'PRIORIDADES: Separação acima de tudo., Confirme antes de agir em coisas relevantes.',
    );
    expect(prompt).not.toContain('PRIORIDADES: (nenhuma)');
  });

  it('tudo vazio → segue auditando role (LLM ainda é chamado, PRIORIDADES=(nenhuma)) e loga warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: false }),
    );
    const out = await papelDriftDetector.detect({
      profile_active: makeMigration061Profile({
        priorities: [],
        identityPrinciples: [],
        coreImmutablePrinciples: [],
        // Force resolver synthesized fallback to also produce nothing by
        // having no priorities AND no principles anywhere reachable. The
        // buildProfileVersion default IDENTITY priorities would otherwise
        // synthesize a core.principles list — we explicitly nuke them all
        // through the overrides above.
      }),
      recent_messages: [makeAgentMsg('algo')],
    });
    expect(out).toBeNull();
    expect(messagesCreateMock).toHaveBeenCalledOnce();
    const prompt = getLastUserPrompt();
    expect(prompt).toContain('PRIORIDADES: (nenhuma)');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ role_descriptor: 'atendimento_financeiro_pf' }),
      'papel_drift.priorities_empty_all_sources',
    );
    warnSpy.mockRestore();
  });

  it('fallback usado uma vez (info) → não loga novamente para o mesmo profile_id', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    messagesCreateMock.mockResolvedValue(
      makeAnthropicReply({ drift_detected: false }),
    );

    const profile = makeMigration061Profile({
      priorities: [],
      identityPrinciples: ['clareza', 'preservar_capital'],
      coreImmutablePrinciples: ['clareza', 'preservar_capital'],
    });

    await papelDriftDetector.detect({
      profile_active: profile,
      recent_messages: [makeAgentMsg('a')],
    });
    await papelDriftDetector.detect({
      profile_active: profile,
      recent_messages: [makeAgentMsg('b')],
    });

    const fallbackLogs = infoSpy.mock.calls.filter(
      ([, msg]) => msg === 'papel_drift.priorities_fallback_used',
    );
    expect(fallbackLogs).toHaveLength(1);
    infoSpy.mockRestore();
  });

  it('non-string entries em principles são filtradas (não vazam pro prompt)', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ drift_detected: false }),
    );
    await papelDriftDetector.detect({
      profile_active: makeMigration061Profile({
        priorities: [],
        identityPrinciples: ['valido', 42, null, { obj: true }, '   '],
        coreImmutablePrinciples: [],
      }),
      recent_messages: [makeAgentMsg('algo')],
    });
    const prompt = getLastUserPrompt();
    expect(prompt).toContain('PRIORIDADES: valido');
    expect(prompt).not.toContain('42');
    expect(prompt).not.toContain('[object Object]');
  });
});
