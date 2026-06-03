/**
 * Issue #410 — baseline.core tools are callable with the correct contract.
 *
 * DoD (b): a baseline agent can `request_confirmation` / `handoff_to_owner` /
 * `audit_decision` (and the rest of the baseline floor) — i.e. the tools EXIST,
 * are CALLABLE, and carry the correct `side_effect` / `required_actions` /
 * `audit_action`. We exercise the handlers directly with a minimal ctx (the
 * established per-tool unit-test pattern in this dir).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const saveFactMock = vi.fn();
const auditMock = vi.fn();
const recentInConversationMock = vi.fn();

vi.mock('../../../src/memory/semantic.js', () => ({
  saveFact: saveFactMock,
}));
vi.mock('../../../src/governance/audit.js', () => ({
  audit: auditMock,
}));
vi.mock('../../../src/db/repositories.js', () => ({
  mensagensRepo: { recentInConversation: recentInConversationMock },
}));
vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  saveFactMock.mockReset();
  auditMock.mockReset();
  recentInConversationMock.mockReset();
});

const ctx = {
  pessoa: { id: 'p1' },
  conversa: { id: 'c1' },
  scope: { entidades: ['e1'], byEntity: new Map() },
  mensagem_id: 'm1',
  request_id: 'r1',
  idempotency_key: 'ik1',
} as never;

describe('read_turn_context (none)', () => {
  it('returns recent messages of the conversa, oldest-first', async () => {
    recentInConversationMock.mockResolvedValueOnce([
      { direcao: 'out', tipo: 'texto', conteudo: 'B', created_at: new Date('2026-01-02T00:00:00Z') },
      { direcao: 'in', tipo: 'texto', conteudo: 'A', created_at: new Date('2026-01-01T00:00:00Z') },
    ]);
    const { readTurnContextTool } = await import('../../../src/tools/read-turn-context.js');
    expect(readTurnContextTool.side_effect).toBe('none');
    expect(readTurnContextTool.required_actions).toEqual([]);
    expect(readTurnContextTool.audit_action).toBe('turn_context_read');

    const out = await readTurnContextTool.handler({ limit: 20 } as never, ctx);
    expect(recentInConversationMock).toHaveBeenCalledWith('c1', 20);
    expect(out.conversa_id).toBe('c1');
    // recentInConversation returns newest-first; the tool reverses to chrono.
    expect(out.messages.map((m) => m.conteudo)).toEqual(['A', 'B']);
  });

  it('schema rejects limit over 50', async () => {
    const { readTurnContextTool } = await import('../../../src/tools/read-turn-context.js');
    expect(readTurnContextTool.input_schema.safeParse({ limit: 999 }).success).toBe(false);
  });
});

describe('remember_safe_fact (write, save_safe_fact)', () => {
  it('FORCES scope to the caller pessoa and never accepts an arbitrary escopo', async () => {
    saveFactMock.mockResolvedValueOnce({ id: 'fact-1' });
    const { rememberSafeFactTool } = await import('../../../src/tools/remember-safe-fact.js');
    expect(rememberSafeFactTool.side_effect).toBe('write');
    expect(rememberSafeFactTool.required_actions).toEqual(['save_safe_fact']);
    expect(rememberSafeFactTool.audit_action).toBe('safe_fact_remembered');

    const out = await rememberSafeFactTool.handler(
      { chave: 'preferred_name', valor: 'Di' } as never,
      ctx,
    );
    expect(out).toEqual({ fact_id: 'fact-1', escopo: 'pessoa:p1' });
    // Scope forced to pessoa:<self>, fonte pinned to 'aprendido'.
    expect(saveFactMock).toHaveBeenCalledWith({
      escopo: 'pessoa:p1',
      chave: 'preferred_name',
      valor: 'Di',
      fonte: 'aprendido',
    });
    // The input schema has no `escopo` field — the LLM cannot widen scope.
    expect(rememberSafeFactTool.input_schema.safeParse({
      chave: 'k', valor: 'v', escopo: 'global',
    }).success).toBe(true); // extra key ignored by zod object (non-strict)
    const parsed = rememberSafeFactTool.input_schema.parse({
      chave: 'k', valor: 'v', escopo: 'global',
    }) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('escopo');
  });
});

describe('request_confirmation (none) — asks, never acts', () => {
  it('returns awaiting_confirmation with the rendered prompt; no side effect', async () => {
    const { requestConfirmationTool } = await import('../../../src/tools/request-confirmation.js');
    expect(requestConfirmationTool.side_effect).toBe('none');
    expect(requestConfirmationTool.required_actions).toEqual([]);
    expect(requestConfirmationTool.audit_action).toBe('confirmation_requested');

    const out = await requestConfirmationTool.handler(
      { action_summary: 'Cancelar a transação X', question: 'Confirma?' } as never,
      ctx,
    );
    expect(out.status).toBe('awaiting_confirmation');
    expect(out.prompt).toContain('Cancelar a transação X');
    expect(out.prompt).toContain('Confirma?');
    // It does not write/communicate — saveFact/audit untouched.
    expect(saveFactMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('handoff_to_owner (communication, escalate_to_owner) — INTERNAL escalation', () => {
  it('raises an internal handoff signal, NOT an external send', async () => {
    const { handoffToOwnerTool } = await import('../../../src/tools/handoff-to-owner.js');
    expect(handoffToOwnerTool.side_effect).toBe('communication');
    expect(handoffToOwnerTool.required_actions).toEqual(['escalate_to_owner']);
    // NOT the external-send action key.
    expect(handoffToOwnerTool.required_actions).not.toContain('send_proactive_message');
    expect(handoffToOwnerTool.audit_action).toBe('owner_handoff_requested');

    const out = await handoffToOwnerTool.handler(
      { reason: 'fora do escopo', summary: 'cliente pediu reembolso', urgency: 'high' } as never,
      ctx,
    );
    expect(out).toEqual({
      status: 'handoff_requested',
      reason: 'fora do escopo',
      urgency: 'high',
    });
    // No PlannedEffect extractor → never enqueues an external WhatsApp send.
    expect(handoffToOwnerTool.extractEffect).toBeUndefined();
  });
});

describe('audit_decision (none) — wrapper over audit()', () => {
  it('writes a decision_audited row with the FIXED action label and rationale', async () => {
    auditMock.mockResolvedValueOnce(undefined);
    const { auditDecisionTool } = await import('../../../src/tools/audit-decision.js');
    expect(auditDecisionTool.side_effect).toBe('none');
    expect(auditDecisionTool.required_actions).toEqual([]);
    expect(auditDecisionTool.audit_action).toBe('decision_audited');

    const out = await auditDecisionTool.handler(
      { decision: 'declined_refund', rationale: 'no validation' } as never,
      ctx,
    );
    expect(out).toEqual({ recorded: true });
    expect(auditMock).toHaveBeenCalledTimes(1);
    const call = auditMock.mock.calls[0]![0] as { acao: string; metadata: Record<string, unknown> };
    expect(call.acao).toBe('decision_audited'); // fixed; cannot be forged
    expect(call.metadata).toMatchObject({ decision: 'declined_refund', rationale: 'no validation' });
  });
});

describe('explain_limitation (none) — honest "I cannot"', () => {
  it('composes a message including reason and optional suggestion', async () => {
    const { explainLimitationTool } = await import('../../../src/tools/explain-limitation.js');
    expect(explainLimitationTool.side_effect).toBe('none');
    expect(explainLimitationTool.required_actions).toEqual([]);
    expect(explainLimitationTool.audit_action).toBe('limitation_explained');

    const out = await explainLimitationTool.handler(
      {
        requested: 'fazer um pagamento',
        reason: 'não tenho permissão financeira.',
        suggestion: 'Peça ao dono para habilitar.',
      } as never,
      ctx,
    );
    expect(out.status).toBe('limitation_explained');
    expect(out.message).toContain('fazer um pagamento');
    expect(out.message).toContain('não tenho permissão financeira.');
    expect(out.message).toContain('Peça ao dono para habilitar.');
  });
});
