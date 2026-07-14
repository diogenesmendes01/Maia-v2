/**
 * Spec perfil-inbox v4 §1.4 — caracterização do wrapper legado após a
 * extração do primitivo `approveAndActivateInTx`:
 *
 *   - o InTx FALHA SEMPRE POR THROW (`ProfileTransitionError`), e o wrapper
 *     traduz cada razão de volta ao resultado tipado HISTÓRICO (mesmos
 *     shapes dos cenários #171/#173/#182/#186 — as suites de integração
 *     issue-166/issue-177 continuam rodando contra o wrapper sem mudanças,
 *     completando a caracterização em DB real);
 *   - no sucesso, o audit do wrapper é escrito DENTRO da MESMA tx;
 *   - `rejectProposedInTx` segue o mesmo contrato de throw.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { txInsertValues, withTxMock } = vi.hoisted(() => {
  const txInsertValues = vi.fn(async () => undefined);
  const fakeTx = { insert: vi.fn(() => ({ values: txInsertValues })) };
  return {
    txInsertValues,
    withTxMock: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx)),
  };
});

vi.mock('../../src/db/client.js', () => ({
  db: {},
  withTx: withTxMock,
  pgErrorCode: () => undefined,
}));
vi.mock('../../src/db/tenant-context.js', () => ({
  getCurrentTenant: () => 't1',
  getCurrentAgent: () => 'a1',
}));
vi.mock('../../src/db/tenant-guard.js', () => ({ applyTenantGuard: (x: unknown) => x }));
vi.mock('../../src/db/repositories/profile-internal.js', () => ({
  validateProfileBodyP8d: vi.fn(),
  readExpectedPredecessor: vi.fn(),
  isMigratedLegacy: vi.fn(),
  lockParentAgent: vi.fn(),
  acquireNextVersionForAgent: vi.fn(),
}));

import {
  operationalProfileVersionsRepo,
  ProfileTransitionError,
} from '../../src/db/repositories/profile-repos.js';

const ARGS = {
  tenant_id: 't1',
  agent_id: 'a1',
  id: 'v2-id',
  actor_id: 'user-1',
  actor_role: 'owner',
  comment: 'ok',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('approveAndActivateAtomic — tradução do contrato de THROW (caracterização)', () => {
  function stubInTxThrow(detail: ConstructorParameters<typeof ProfileTransitionError>[0]) {
    return vi
      .spyOn(operationalProfileVersionsRepo, 'approveAndActivateInTx')
      .mockRejectedValueOnce(new ProfileTransitionError(detail));
  }

  it('sucesso: resultado ok + audit agent_profile_approve DENTRO da mesma tx', async () => {
    vi.spyOn(operationalProfileVersionsRepo, 'approveAndActivateInTx').mockResolvedValueOnce({
      activated: { id: 'v2-id', version: 2 },
      frozen_previous: { id: 'v1-id', version: 1 },
      expected_predecessor: 'v1-id',
    });
    const r = await operationalProfileVersionsRepo.approveAndActivateAtomic(ARGS);
    expect(r).toEqual({
      ok: true,
      activated: { id: 'v2-id', version: 2 },
      frozen_previous: { id: 'v1-id', version: 1 },
    });
    // Audit dentro da MESMA tx do withTx (review v3 do spec).
    expect(withTxMock).toHaveBeenCalledTimes(1);
    expect(txInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_profile_approve',
        resource_id: 'v2-id',
        change_summary: expect.objectContaining({
          new_version: 2,
          previous_active_id: 'v1-id',
          expected_predecessor_id: 'v1-id',
        }),
      }),
    );
  });

  it.each([
    ['not_found', { reason: 'not_found' as const }, { ok: false, reason: 'not_found' }],
    [
      'invalid_source_status',
      { reason: 'invalid_source_status' as const },
      { ok: false, reason: 'invalid_source_status' },
    ],
    ['agent_missing', { reason: 'agent_missing' as const }, { ok: false, reason: 'agent_missing' }],
    [
      'transition_failed',
      { reason: 'transition_failed' as const },
      { ok: false, reason: 'transition_failed' },
    ],
    [
      'predecessor_conflict',
      { reason: 'predecessor_conflict' as const, expected: 'v1-id', current: 'v9-id' },
      { ok: false, reason: 'predecessor_conflict', expected: 'v1-id', current: 'v9-id' },
    ],
    [
      'migrated_legacy_proposal',
      { reason: 'migrated_legacy_proposal' as const, expected: null, current: 'v9-id' },
      { ok: false, reason: 'migrated_legacy_proposal', expected: null, current: 'v9-id' },
    ],
    [
      'missing_predecessor',
      {
        reason: 'missing_predecessor' as const,
        proposed_version: 3,
        current_predecessor: 'v9-id',
      },
      {
        ok: false,
        reason: 'missing_predecessor',
        proposed_version: 3,
        current_predecessor: 'v9-id',
      },
    ],
  ])('throw %s ⇒ resultado tipado idêntico ao pré-extração', async (_name, detail, expected) => {
    stubInTxThrow(detail as never);
    const r = await operationalProfileVersionsRepo.approveAndActivateAtomic(ARGS);
    expect(r).toEqual(expected);
    // Falha ⇒ nenhum audit gravado por este caminho (rollback total na tx real).
    expect(txInsertValues).not.toHaveBeenCalled();
  });

  it('erro NÃO-tipado propaga inalterado (nunca vira resultado tipado)', async () => {
    vi.spyOn(operationalProfileVersionsRepo, 'approveAndActivateInTx').mockRejectedValueOnce(
      new Error('db exploded'),
    );
    await expect(operationalProfileVersionsRepo.approveAndActivateAtomic(ARGS)).rejects.toThrow(
      'db exploded',
    );
  });
});
