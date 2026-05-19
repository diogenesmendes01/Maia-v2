/**
 * P10a (Codex review round-2 finding 2) — KSM propose persists
 * table-native columns into the create payload.
 *
 * Before this fix the facade coerced everything to generic scope
 * strings:
 *   - facts          → escopo='user:<id>' (legacy reads need 'pessoa:<id>')
 *   - rules          → tipo='classificacao' hard-coded (LLM tipo lost)
 *   - memory/hints   → scope_type=<KnowledgeScope literal> (legacy
 *                       findRelevant looks for 'interlocutor'/'role'/
 *                       'channel'/'conversation'/'agent')
 *
 * The fix adds an explicit `native` carrier to KnowledgeProposalInput
 * with per-kind table-native fields. The repos facade reads them and
 * writes them verbatim into the legacy columns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Captured = {
  lifecycle_status: string;
  native?: Record<string, unknown>;
};
const captured = new Map<string, Captured>();

vi.mock('@/control-plane/knowledge-state-machine/repos.js', () => {
  class KnowledgeConflictError extends Error {}
  return {
    KnowledgeConflictError,
    knowledgeRepos: {
      async create(input: {
        lifecycle_status: string;
        native?: Record<string, unknown>;
      }): Promise<string> {
        const id = `00000000-0000-0000-0000-${Math.floor(
          Math.random() * 1e12,
        )
          .toString(16)
          .padStart(12, '0')}`;
        captured.set(id, {
          lifecycle_status: input.lifecycle_status,
          native: input.native,
        });
        return id;
      },
      async findById() {
        return null;
      },
      async update() {
        /* no-op */
      },
    },
  };
});

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    cognitiveModuleLogRepo: { record: vi.fn().mockResolvedValue(undefined) },
  };
});

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  captured.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Finding 2 — KSM propose persists table-native columns', () => {
  it('fact with native.fact_escopo/chave round-trips into the create payload', async () => {
    const { KnowledgeStateMachine } = await import(
      '@/control-plane/knowledge-state-machine/state-machine.js'
    );
    const pessoaId = '11111111-2222-3333-4444-555555555555';
    const result = await KnowledgeStateMachine.propose({
      trace_id: 't',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      kind: 'fact',
      scope: 'user',
      scope_value: pessoaId,
      key: 'p1.foo',
      content: { content: 'hi', subject_id: pessoaId },
      content_text: 'hi',
      confidence: 0.7,
      origin: 'llm_inference',
      source: 'unit-test',
      native: {
        fact_escopo: `pessoa:${pessoaId}`,
        fact_chave: 'p1.foo',
      },
    });

    const row = captured.get(result.proposal_id)!;
    // conf=0.7 + non-rule + llm_inference → low risk + ephemeral.
    expect(row.lifecycle_status).toBe('ephemeral');
    expect(row.native?.fact_escopo).toBe(`pessoa:${pessoaId}`);
    expect(row.native?.fact_chave).toBe('p1.foo');
  });

  it('rule with native preserves tipo/contexto/acao verbatim', async () => {
    const { KnowledgeStateMachine } = await import(
      '@/control-plane/knowledge-state-machine/state-machine.js'
    );
    const result = await KnowledgeStateMachine.propose({
      trace_id: 't',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      kind: 'rule',
      scope: 'agent',
      key: 'tom_resposta',
      content: { tipo: 'tom_resposta', contexto: 'cliente bravo', acao: 'tom calmo' },
      content_text: '[tom_resposta] cliente bravo -> tom calmo',
      confidence: 0.8,
      origin: 'llm_inference',
      source: 'unit-test',
      native: {
        rule_tipo: 'tom_resposta',
        rule_contexto: 'cliente bravo',
        rule_acao: 'tom calmo',
      },
    });
    const row = captured.get(result.proposal_id)!;
    // Rule always lands in pending_review (master §2.6).
    expect(row.lifecycle_status).toBe('pending_review');
    expect(row.native?.rule_tipo).toBe('tom_resposta');
    expect(row.native?.rule_contexto).toBe('cliente bravo');
    expect(row.native?.rule_acao).toBe('tom calmo');
  });

  it('memory with interlocutor scope preserves subject_id + interlocutor_id', async () => {
    const { KnowledgeStateMachine } = await import(
      '@/control-plane/knowledge-state-machine/state-machine.js'
    );
    const pid = '22222222-3333-4444-5555-666666666666';
    const result = await KnowledgeStateMachine.propose({
      trace_id: 't',
      tenant_id: 'tenant-a',
      agent_id: 'agent-a',
      kind: 'memory',
      scope: 'user',
      scope_value: pid,
      key: 'preference',
      content: { conteudo: 'gosta de café' },
      content_text: 'gosta de café',
      confidence: 0.7,
      origin: 'llm_inference',
      source: 'unit-test',
      native: {
        memory_type: 'preference',
        memory_scope_type: 'interlocutor',
        memory_subject_id: pid,
        memory_interlocutor_id: pid,
        memory_sensitivity: 'low',
      },
    });
    const row = captured.get(result.proposal_id)!;
    expect(row.native?.memory_scope_type).toBe('interlocutor');
    expect(row.native?.memory_interlocutor_id).toBe(pid);
    expect(row.native?.memory_subject_id).toBe(pid);
  });

  it('hint with native.hint_scope_type preserves role/channel/conversation/interlocutor', async () => {
    const { KnowledgeStateMachine } = await import(
      '@/control-plane/knowledge-state-machine/state-machine.js'
    );
    for (const scopeType of [
      'role',
      'channel',
      'conversation',
      'interlocutor',
    ] as const) {
      const result = await KnowledgeStateMachine.propose({
        trace_id: 't',
        tenant_id: 'tenant-a',
        agent_id: 'agent-a',
        kind: 'behavioral_hint',
        scope: 'agent',
        scope_value: 'subj-1',
        key: 'behavioral_hint',
        content: { hint_text: 'be patient' },
        content_text: 'be patient',
        confidence: 0.7,
        origin: 'llm_inference',
        source: 'unit-test',
        native: {
          hint_scope_type: scopeType,
          hint_subject_id: 'subj-1',
          hint_derived_sensitivity: 'medium',
        },
      });
      const row = captured.get(result.proposal_id)!;
      expect(row.native?.hint_scope_type).toBe(scopeType);
      expect(row.native?.hint_subject_id).toBe('subj-1');
    }
  });
});
