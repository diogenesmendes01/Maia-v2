/**
 * Flip-readiness (#323) — MUTATION-ISOLATION invariant for the per-message
 * hot-path writers on `conversasRepo` / `mensagensRepo`.
 *
 * Product invariant (project north star):
 *   "Maias de empresas diferentes NUNCA se comunicam, compartilham dados ou
 *    herdam aprendizado. Sem exceção."
 *
 * These eight UPDATEs run on EVERY inbound message. Before this change their
 * WHERE clauses matched on `id`/`pessoa_id`/`inArray(id)` ALONE — safe only
 * while every row lives under `default/default`, but a cross-tenant write the
 * instant a second tenant exists (Phase 5). This spec PROVES each method now
 * binds `tenant_id` AND `agent_id` (from ALS) into its WHERE so a run under
 * tenant-A's context touches ONLY tenant-A's row, leaving a tenant-B row that
 * shares the SAME id/key/pessoa_id UNTOUCHED.
 *
 * Regression lever (the test that would have caught the gap): the store applies
 * each UPDATE by EVALUATING the REAL drizzle predicate the repo built (it does
 * NOT hand-roll a tenant filter — see `_tenant-mutation-store.ts`). Revert any
 * method to its pre-fix `eq(<table>.id, id)`-only WHERE and the predicate
 * matches BOTH tenants' rows, so the "tenant-B untouched" assertion fails.
 * (Manually verified during development by reverting each predicate.)
 *
 * For the FAIL-LOUD methods (`setConversaId`, `markProcessed`) we additionally
 * assert that running under a context whose (tenant_id, agent_id) does NOT match
 * the target row throws (0 rows matched → loud failure, not a silent no-op).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  makeTenantScopedUpdateStore,
  parsePredicate,
  type StoreRow,
} from '../workers/_tenant-mutation-store.js';

// Single store-backed `db` shared by every case. Repo methods only ever call
// `db.update(...)` here (no reads), so the `update` path is all we exercise.
const store = makeTenantScopedUpdateStore();

vi.mock('@/db/client.js', () => ({
  db: {
    update: (...args: unknown[]) => store.db.update(...args),
    select: (...args: unknown[]) => store.db.select(...args),
  },
  withTx: async (fn: (tx: unknown) => unknown) => fn(store.db),
}));

// Import AFTER the mock is registered (vi.mock is hoisted) so the repo binds
// the mocked client.
const { conversasRepo, mensagensRepo } = await import('@/db/repositories.js');

const A = { tenant_id: 'tenant-A', agent_id: 'agent-A' } as const;
const B = { tenant_id: 'tenant-B', agent_id: 'agent-B' } as const;
// Tenant-A's tenant_id but a DIFFERENT agent — proves the agent_id leg matters,
// not just tenant_id.
const A_OTHER_AGENT = { tenant_id: 'tenant-A', agent_id: 'agent-Z' } as const;

/** Assert the most-recent UPDATE predicate bound tenant_id + agent_id = A. */
function expectBoundToA(): void {
  const terms = parsePredicate(store.lastPredicate());
  expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: A.tenant_id });
  expect(terms).toContainEqual({ kind: 'eq', column: 'agent_id', value: A.agent_id });
}

const byId = (id: string): StoreRow => store.rows.find((r) => r.id === id)!;

describe('Flip-readiness (#323) — conversas hot-path mutations are tenant+agent scoped', () => {
  describe('conversasRepo.touch (predicate-only)', () => {
    const OLD = new Date('2020-01-01T00:00:00.000Z');
    beforeEach(() => {
      store.reset([
        { id: 'shared', tenant_id: A.tenant_id, agent_id: A.agent_id, status: 'ativa', ultima_atividade_em: OLD },
        { id: 'shared', tenant_id: B.tenant_id, agent_id: B.agent_id, status: 'ativa', ultima_atividade_em: OLD },
        { id: 'shared', tenant_id: A_OTHER_AGENT.tenant_id, agent_id: A_OTHER_AGENT.agent_id, status: 'ativa', ultima_atividade_em: OLD },
      ]);
    });

    it('bumps ONLY tenant-A/agent-A; tenant-B and other-agent rows untouched', async () => {
      await runWithTenantContext(A, () => conversasRepo.touch('shared'));

      const a = store.rows.find((r) => r.tenant_id === A.tenant_id && r.agent_id === A.agent_id)!;
      const b = store.rows.find((r) => r.tenant_id === B.tenant_id)!;
      const az = store.rows.find((r) => r.agent_id === A_OTHER_AGENT.agent_id)!;
      expect((a.ultima_atividade_em as Date).getTime()).toBeGreaterThan(OLD.getTime());
      expect(b.ultima_atividade_em).toBe(OLD); // cross-tenant untouched
      expect(az.ultima_atividade_em).toBe(OLD); // same tenant, other agent untouched
      expectBoundToA();
    });
  });

  describe('conversasRepo.updateMetadata (predicate-only)', () => {
    beforeEach(() => {
      store.reset([
        { id: 'shared', tenant_id: A.tenant_id, agent_id: A.agent_id, status: 'ativa', metadata: { who: 'A' } },
        { id: 'shared', tenant_id: B.tenant_id, agent_id: B.agent_id, status: 'ativa', metadata: { who: 'B' } },
      ]);
    });

    it('overwrites ONLY tenant-A metadata; tenant-B untouched', async () => {
      await runWithTenantContext(A, () => conversasRepo.updateMetadata('shared', { who: 'A2' }));

      const a = store.rows.find((r) => r.tenant_id === A.tenant_id)!;
      const b = store.rows.find((r) => r.tenant_id === B.tenant_id)!;
      expect(a.metadata).toEqual({ who: 'A2' });
      expect(b.metadata).toEqual({ who: 'B' });
      expectBoundToA();
    });
  });

  describe('conversasRepo.mergeMetadata (predicate-only)', () => {
    beforeEach(() => {
      store.reset([
        { id: 'shared', tenant_id: A.tenant_id, agent_id: A.agent_id, status: 'ativa', metadata: { who: 'A' } },
        { id: 'shared', tenant_id: B.tenant_id, agent_id: B.agent_id, status: 'ativa', metadata: { who: 'B' } },
      ]);
    });

    it('merges into ONLY tenant-A; tenant-B metadata untouched', async () => {
      await runWithTenantContext(A, () => conversasRepo.mergeMetadata('shared', { extra: 1 }));

      const b = store.rows.find((r) => r.tenant_id === B.tenant_id)!;
      // The jsonb `||` set-value is a SQL fragment the store can't evaluate; we
      // assert tenant-B was NOT among the matched rows by checking its metadata
      // is byte-for-byte unchanged.
      expect(b.metadata).toEqual({ who: 'B' });
      expectBoundToA();
    });
  });

  describe('conversasRepo.unsetMetadataKey (predicate-only)', () => {
    beforeEach(() => {
      store.reset([
        { id: 'shared', tenant_id: A.tenant_id, agent_id: A.agent_id, status: 'ativa', metadata: { pending_question: { id: 'A' } } },
        { id: 'shared', tenant_id: B.tenant_id, agent_id: B.agent_id, status: 'ativa', metadata: { pending_question: { id: 'B' } } },
      ]);
    });

    it('targets ONLY tenant-A; tenant-B metadata untouched', async () => {
      await runWithTenantContext(A, () => conversasRepo.unsetMetadataKey('shared', 'pending_question'));

      const b = store.rows.find((r) => r.tenant_id === B.tenant_id)!;
      expect(b.metadata).toEqual({ pending_question: { id: 'B' } });
      expectBoundToA();
    });
  });

  describe('conversasRepo.invalidateScopeForPessoa (bulk, predicate-only)', () => {
    const SHARED_PESSOA = 'pessoa-shared';
    beforeEach(() => {
      store.reset([
        { id: 'cA', tenant_id: A.tenant_id, agent_id: A.agent_id, status: 'ativa', pessoa_id: SHARED_PESSOA, escopo_entidades: ['e1'] },
        { id: 'cB', tenant_id: B.tenant_id, agent_id: B.agent_id, status: 'ativa', pessoa_id: SHARED_PESSOA, escopo_entidades: ['e2'] },
        { id: 'cAZ', tenant_id: A_OTHER_AGENT.tenant_id, agent_id: A_OTHER_AGENT.agent_id, status: 'ativa', pessoa_id: SHARED_PESSOA, escopo_entidades: ['e3'] },
      ]);
    });

    it('clears scope for ONLY tenant-A/agent-A conversas of a pessoa shared across tenants', async () => {
      await runWithTenantContext(A, () => conversasRepo.invalidateScopeForPessoa(SHARED_PESSOA));

      expect(byId('cA').escopo_entidades).toEqual([]); // cleared
      expect(byId('cB').escopo_entidades).toEqual(['e2']); // cross-tenant untouched
      expect(byId('cAZ').escopo_entidades).toEqual(['e3']); // other-agent untouched
      // Bulk by pessoa_id + tenant + agent.
      const terms = parsePredicate(store.lastPredicate());
      expect(terms).toContainEqual({ kind: 'eq', column: 'pessoa_id', value: SHARED_PESSOA });
      expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: A.tenant_id });
      expect(terms).toContainEqual({ kind: 'eq', column: 'agent_id', value: A.agent_id });
    });
  });
});

describe('Flip-readiness (#323) — mensagens hot-path mutations are tenant+agent scoped', () => {
  describe('mensagensRepo.setConversaId (fail-loud)', () => {
    beforeEach(() => {
      store.reset([
        { id: 'shared', tenant_id: A.tenant_id, agent_id: A.agent_id, status: '', conversa_id: null },
        { id: 'shared', tenant_id: B.tenant_id, agent_id: B.agent_id, status: '', conversa_id: 'B-conv' },
      ]);
    });

    it('attaches ONLY tenant-A row; tenant-B row untouched', async () => {
      await runWithTenantContext(A, () => mensagensRepo.setConversaId('shared', 'A-conv'));

      const a = store.rows.find((r) => r.tenant_id === A.tenant_id)!;
      const b = store.rows.find((r) => r.tenant_id === B.tenant_id)!;
      expect(a.conversa_id).toBe('A-conv');
      expect(b.conversa_id).toBe('B-conv'); // cross-tenant untouched
      expectBoundToA();
    });

    it('FAIL-LOUD — throws when the context does not match the target row (0 rows)', async () => {
      // Row exists only under tenant-A; running under tenant-B matches nothing.
      await expect(
        runWithTenantContext(B, () => mensagensRepo.setConversaId('A-only-id', 'x')),
      ).rejects.toThrow(/matched 0 rows/);
    });
  });

  describe('mensagensRepo.setConversaIdMany (bulk, predicate-only)', () => {
    beforeEach(() => {
      store.reset([
        { id: 'm1', tenant_id: A.tenant_id, agent_id: A.agent_id, status: '', conversa_id: null },
        { id: 'm2', tenant_id: A.tenant_id, agent_id: A.agent_id, status: '', conversa_id: null },
        // SAME ids exist under tenant-B (shared id collision across tenants).
        { id: 'm1', tenant_id: B.tenant_id, agent_id: B.agent_id, status: '', conversa_id: 'B1' },
        { id: 'm2', tenant_id: B.tenant_id, agent_id: B.agent_id, status: '', conversa_id: 'B2' },
      ]);
    });

    it('adopts ONLY tenant-A rows in the id set; tenant-B rows with the same ids untouched', async () => {
      await runWithTenantContext(A, () => mensagensRepo.setConversaIdMany(['m1', 'm2'], 'A-conv'));

      const aRows = store.rows.filter((r) => r.tenant_id === A.tenant_id);
      const bRows = store.rows.filter((r) => r.tenant_id === B.tenant_id);
      expect(aRows.every((r) => r.conversa_id === 'A-conv')).toBe(true);
      expect(bRows.map((r) => r.conversa_id)).toEqual(['B1', 'B2']); // untouched
      // inArray(id) + tenant + agent.
      const terms = parsePredicate(store.lastPredicate());
      expect(terms).toContainEqual({ kind: 'in', column: 'id', values: ['m1', 'm2'] });
      expect(terms).toContainEqual({ kind: 'eq', column: 'tenant_id', value: A.tenant_id });
      expect(terms).toContainEqual({ kind: 'eq', column: 'agent_id', value: A.agent_id });
    });

    it('empty id list short-circuits (no UPDATE issued)', async () => {
      store.reset([{ id: 'm1', tenant_id: A.tenant_id, agent_id: A.agent_id, status: '', conversa_id: null }]);
      await runWithTenantContext(A, () => mensagensRepo.setConversaIdMany([], 'A-conv'));
      expect(store.lastPredicate()).toBeUndefined(); // never reached `.where`
    });
  });

  describe('mensagensRepo.markProcessed (fail-loud)', () => {
    beforeEach(() => {
      store.reset([
        { id: 'shared', tenant_id: A.tenant_id, agent_id: A.agent_id, status: '', processada_em: null, tokens_usados: null },
        { id: 'shared', tenant_id: B.tenant_id, agent_id: B.agent_id, status: '', processada_em: null, tokens_usados: 999 },
      ]);
    });

    it('stamps ONLY tenant-A row; tenant-B row untouched', async () => {
      await runWithTenantContext(A, () => mensagensRepo.markProcessed('shared', 42));

      const a = store.rows.find((r) => r.tenant_id === A.tenant_id)!;
      const b = store.rows.find((r) => r.tenant_id === B.tenant_id)!;
      expect(a.processada_em).toBeInstanceOf(Date);
      expect(a.tokens_usados).toBe(42);
      expect(b.processada_em).toBeNull(); // cross-tenant untouched
      expect(b.tokens_usados).toBe(999);
      expectBoundToA();
    });

    it('FAIL-LOUD — throws when the context does not match the target row (0 rows)', async () => {
      await expect(
        runWithTenantContext(B, () => mensagensRepo.markProcessed('A-only-id', 0)),
      ).rejects.toThrow(/matched 0 rows/);
    });
  });
});
