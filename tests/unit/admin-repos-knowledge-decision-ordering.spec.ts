/**
 * PR #775 finding 3 — `proposalsUnifiedRepo.decideAtomically`, ramo
 * `knowledge_proposal`, não pode gravar `proposal_approvals` quando a decisão
 * FALHA.
 *
 * Antes: `not_found`/`invalid_source_status` só apareciam DEPOIS do INSERT de
 * `proposal_approvals` + `admin_audit_log`, via `applyKnowledgeDecisionTx`. Um
 * `return { ok: false, ... }` de DENTRO do `withTx` COMMITA (só uma exceção
 * faz rollback — ver `withTx` em src/db/client.ts) — então ficava uma
 * aprovação registrada sem a transição correspondente.
 *
 * Depois: a linha canônica é lida sob LOCK (`knowledgeRepos.findById(...,
 * { forUpdate: true })`) e validada ANTES de qualquer INSERT — mesmo padrão
 * do ramo `capability_proposal` no mesmo arquivo. Qualquer falha residual de
 * `applyKnowledgeDecisionTx` DEPOIS do INSERT agora lança (rollback total) em
 * vez de retornar.
 *
 * Este arquivo prova as duas pontas: (1) nenhum INSERT acontece quando o
 * pré-check reprova, e (2) uma falha pós-INSERT lança em vez de retornar
 * `ok:false` silenciosamente.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const callOrder: string[] = [];

const findByIdMock = vi.fn();
vi.mock('@/control-plane/knowledge-state-machine/repos.js', () => ({
  knowledgeRepos: { findById: findByIdMock },
}));

const applyKnowledgeDecisionTxMock = vi.fn();
vi.mock('@/learning/approval-adapter.js', () => ({
  applyKnowledgeDecisionTx: applyKnowledgeDecisionTxMock,
}));

const dbExecuteMock = vi.fn().mockResolvedValue({ rows: [] });

// Minimal fake `tx` — `knowledgeRepos` and `applyKnowledgeDecisionTx` are
// fully mocked above, so this fake never needs to render real SQL; it only
// needs to look like the two `tx.insert(table).values(v)[.returning()]`
// call shapes the `knowledge_proposal` branch uses, and to record ordering.
function fakeInsertResult(rows: Array<Record<string, unknown>>) {
  const result: {
    returning: () => Promise<Array<Record<string, unknown>>>;
    then: (resolve: (v: unknown) => void) => void;
  } = {
    returning: async () => rows,
    then: (resolve) => resolve(undefined),
  };
  return result;
}

function makeFakeTx() {
  return {
    insert: (table: { [Symbol.toStringTag]?: string } & Record<string, unknown>) => ({
      values: (vals: Record<string, unknown>) => {
        // `proposal_approvals` vs `admin_audit_log` — distinguish by shape
        // (approvals carry `decision`; audit rows carry `action`) since both
        // tables are real drizzle table objects imported from schema.js.
        if ('decision' in vals) {
          callOrder.push('insert:proposal_approvals');
          return fakeInsertResult([{ id: 'appr-1', ...vals }]);
        }
        callOrder.push('insert:admin_audit_log');
        return fakeInsertResult([{ id: 'audit-1', ...vals }]);
      },
    }),
  };
}

vi.mock('@/db/client.js', () => ({
  db: { execute: dbExecuteMock },
  withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(makeFakeTx())),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const BASE_INPUT = {
  tenantId: 'tenant-a',
  proposalId: '11111111-1111-4111-8111-111111111111',
  type: 'knowledge_proposal' as const,
  approvalClass: 'single',
  actorId: 'user-1',
  actorRole: 'admin',
  decision: 'approved' as const,
  comment: 'ok',
  knowledgeKind: 'fact' as const,
  agentId: 'agent-a',
  dualComplete: true,
};

beforeEach(() => {
  callOrder.length = 0;
  findByIdMock.mockReset();
  applyKnowledgeDecisionTxMock.mockReset();
  dbExecuteMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('decideAtomically — knowledge_proposal valida sob lock ANTES de inserir a aprovação', () => {
  it('precheck reprova (invalid_source_status) — NENHUM insert acontece', async () => {
    findByIdMock.mockResolvedValue({ id: 'x', lifecycle_status: 'active' });

    const { proposalsUnifiedRepo } = await import('@/db/repositories/admin-repos.js');
    const result = await proposalsUnifiedRepo.decideAtomically(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'invalid_source_status' });
    // The whole point of finding 3: an approval row must NEVER exist for a
    // decision that didn't take effect.
    expect(callOrder).toEqual([]);
    expect(applyKnowledgeDecisionTxMock).not.toHaveBeenCalled();
  });

  it('precheck reprova (not_found) — NENHUM insert acontece', async () => {
    findByIdMock.mockResolvedValue(null);

    const { proposalsUnifiedRepo } = await import('@/db/repositories/admin-repos.js');
    const result = await proposalsUnifiedRepo.decideAtomically(BASE_INPUT);

    expect(result).toEqual({ ok: false, reason: 'not_found' });
    expect(callOrder).toEqual([]);
  });

  it('precheck usa forUpdate: true — trava a linha antes de decidir', async () => {
    findByIdMock.mockResolvedValue({ id: 'x', lifecycle_status: 'active' });

    const { proposalsUnifiedRepo } = await import('@/db/repositories/admin-repos.js');
    await proposalsUnifiedRepo.decideAtomically(BASE_INPUT);

    expect(findByIdMock).toHaveBeenCalledWith(
      'fact',
      BASE_INPUT.proposalId,
      expect.anything(),
      { forUpdate: true },
    );
  });

  it('precheck aprova — insere approval + audit ANTES de aplicar a decisão, nessa ordem', async () => {
    findByIdMock.mockResolvedValue({ id: 'x', lifecycle_status: 'pending_review' });
    applyKnowledgeDecisionTxMock.mockResolvedValue({
      ok: true,
      from: 'pending_review',
      to: 'active',
    });

    const { proposalsUnifiedRepo } = await import('@/db/repositories/admin-repos.js');
    const result = await proposalsUnifiedRepo.decideAtomically(BASE_INPUT);

    expect(result).toMatchObject({ ok: true, sourceTransitioned: true });
    expect(callOrder).toEqual(['insert:proposal_approvals', 'insert:admin_audit_log']);
    expect(applyKnowledgeDecisionTxMock).toHaveBeenCalledTimes(1);
  });

  it('precheck aprova mas applyKnowledgeDecisionTx falha depois do insert — LANÇA (rollback), não retorna ok:false', async () => {
    // Only reachable if the transition table diverges from the pre-check —
    // an invariant violation. The approval + audit rows just inserted must
    // not survive a decision that didn't take effect, so this MUST throw
    // (withTx rolls back on throw, never on a returned value).
    findByIdMock.mockResolvedValue({ id: 'x', lifecycle_status: 'pending_review' });
    applyKnowledgeDecisionTxMock.mockResolvedValue({
      ok: false,
      reason: 'illegal_transition',
      detail: 'unexpected',
    });

    const { proposalsUnifiedRepo } = await import('@/db/repositories/admin-repos.js');
    await expect(proposalsUnifiedRepo.decideAtomically(BASE_INPUT)).rejects.toThrow();
    // The inserts DID happen (this is the tx that gets rolled back by a real
    // Postgres client on throw) — the assertion here is on the CONTRACT
    // (throw, not a silently-committed ok:false), not on physical rollback,
    // which `withTx` (src/db/client.ts) already owns and isn't re-proven here.
    expect(callOrder).toEqual(['insert:proposal_approvals', 'insert:admin_audit_log']);
  });
});
