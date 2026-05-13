import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression test for PR #75 review finding #1 (Codex) / #C1 (Superpowers):
 *
 * `pessoasRepo` is tenant-aware since migration 009 but, before this fix, its
 * methods skipped `getCurrentTenant()` and `applyTenantGuard`. That meant:
 *   • findByPhone returned rows across all tenants → identity resolution leak
 *   • create dropped rows under the DB default 'default' regardless of context
 *
 * This test pins the FIXED behaviour:
 *   • methods called WITHOUT a tenant context throw MissingTenantContextError
 *   • create runs through applyTenantGuard, so the inserted row carries the
 *     active tenant_id/agent_id (not the schema default)
 */

const { dbSelect, dbInsert, dbUpdate } = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbInsert: vi.fn(),
  dbUpdate: vi.fn(),
}));

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: () => dbSelect(),
    insert: () => dbInsert(),
    update: () => dbUpdate(),
  },
}));

import { pessoasRepo } from '../../src/db/repositories.js';
import {
  runWithTenantContext,
  MissingTenantContextError,
} from '../../src/db/tenant-context.js';

function chainable(values: unknown): unknown {
  const c: Record<string, unknown> = {};
  // Drizzle's builder methods are themselves chainable; the terminal call
  // returns a Promise. We make every method return `c` and also expose
  // `.then` so `await chain` resolves to `values`.
  for (const k of [
    'from',
    'where',
    'limit',
    'orderBy',
    'offset',
    'values',
    'returning',
    'set',
    'onConflictDoUpdate',
    'onConflictDoNothing',
  ] as const) {
    c[k] = () => c;
  }
  (c as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(values).then(resolve);
  return c;
}

describe('pessoasRepo — tenant scoping (PR #75 #C2)', () => {
  beforeEach(() => {
    dbSelect.mockReset();
    dbInsert.mockReset();
    dbUpdate.mockReset();
    dbSelect.mockReturnValue(chainable([]));
    dbInsert.mockReturnValue(chainable([{ id: 'p1', tenant_id: 't-a', agent_id: 'agent-a' }]));
    dbUpdate.mockReturnValue(chainable([]));
  });

  it('findByPhone OUTSIDE tenant context throws MissingTenantContextError', async () => {
    await expect(pessoasRepo.findByPhone('+5511999990001')).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });

  it('findById OUTSIDE tenant context throws MissingTenantContextError', async () => {
    await expect(pessoasRepo.findById('some-id')).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });

  it('list OUTSIDE tenant context throws MissingTenantContextError', async () => {
    await expect(pessoasRepo.list()).rejects.toBeInstanceOf(
      MissingTenantContextError,
    );
  });

  it('create OUTSIDE tenant context throws MissingTenantContextError', async () => {
    // applyTenantGuard runs synchronously and throws before db.insert is touched.
    await expect(
      pessoasRepo.create({
        nome: 'X',
        telefone_whatsapp: '+5511999990002',
        email: null,
        cpf: null,
        status: 'ativa',
        preferencias: {},
        metadata: {},
      } as Parameters<typeof pessoasRepo.create>[0]),
    ).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('create INSIDE tenant context injects tenant_id/agent_id via applyTenantGuard', async () => {
    // Capture the value passed to the insert builder.
    let inserted: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {};
    chain.values = (v: Record<string, unknown>) => {
      inserted = v;
      return chain;
    };
    chain.returning = () =>
      Promise.resolve([{ id: 'p1', tenant_id: 't-a', agent_id: 'agent-a' }]);
    dbInsert.mockReturnValueOnce(chain);

    await runWithTenantContext(
      { tenant_id: 't-a', agent_id: 'agent-a' },
      () =>
        pessoasRepo.create({
          nome: 'X',
          telefone_whatsapp: '+5511999990002',
          email: null,
          cpf: null,
          status: 'ativa',
          preferencias: {},
          metadata: {},
        } as Parameters<typeof pessoasRepo.create>[0]),
    );

    expect(inserted).not.toBeNull();
    expect((inserted as Record<string, unknown>).tenant_id).toBe('t-a');
    expect((inserted as Record<string, unknown>).agent_id).toBe('agent-a');
  });
});
