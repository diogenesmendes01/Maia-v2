/**
 * PR #775 finding 4 — a listagem de `knowledge_proposal` na fila unificada
 * (`proposalsUnifiedRepo.list`) ignorava o cursor, e `countersByType` ficava
 * fixo em zero para esse tipo mesmo depois de P10 (c2156b29) ter dado à
 * fonte um `list()` funcional.
 *
 * Ao corrigir, um terceiro problema apareceu: NENHUMA das quatro tabelas do
 * KSM (`agent_facts`, `memory_entry`, `learned_rules`, `behavioral_hint`)
 * está em `_availableTables()` (aquele probe só verifica tabelas FUTURAS —
 * policy_rules/soul_biases/skills/capability_proposals/
 * knowledge_pending_review). O loop de `list()` fazia
 * `if (!available.includes(t.nome)) continue`, e como nenhum dos quatro
 * nomes está naquele probe, o `continue` disparava sempre — o SELECT nunca
 * rodava e NENHUM `knowledge_proposal` jamais aparecia na fila,
 * independentemente de dados ou paginação. Este arquivo prova as três
 * pontas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();
const renderedSqls: string[] = [];

// `list()` also unconditionally queries `agent_operational_profile_versions`
// via the drizzle query builder (`db.select()...`) — stub that chain to
// return no rows so this spec stays focused on the raw-SQL KSM block.
const selectChain = {
  from: () => selectChain,
  where: () => selectChain,
  orderBy: () => selectChain,
  limit: async () => [] as unknown[],
};

const dbExecuteMock = vi.fn(async (query: SQL) => {
  const rendered = dialect.sqlToQuery(query);
  renderedSqls.push(rendered.sql);
  const params = rendered.params as unknown[];

  // `_availableTables()` — `list()` early-returns when `capability_proposals`
  // is absent from this probe, so it must be present for the KSM block below
  // to run at all. Deliberately OMIT agent_facts/memory_entry/learned_rules/
  // behavioral_hint here — they were never part of this probe's ARRAY, and
  // that's exactly what finding 4 (once dug into) turned out to be
  // depending on incorrectly. Proves the KSM block does NOT need them in
  // this list to run (they're core tables, always present).
  if (/information_schema\.tables/i.test(rendered.sql)) {
    return { rows: [{ table_name: 'capability_proposals' }] };
  }

  // countersByType's per-table COUNT(*) queries.
  if (/SELECT\s+COUNT\(\*\)/i.test(rendered.sql)) {
    if (/FROM\s+agent_facts/i.test(rendered.sql)) return { rows: [{ count: 2 }] };
    if (/FROM\s+memory_entry/i.test(rendered.sql)) return { rows: [{ count: 3 }] };
    if (/FROM\s+learned_rules/i.test(rendered.sql)) return { rows: [{ count: 0 }] };
    if (/FROM\s+behavioral_hint/i.test(rendered.sql)) return { rows: [{ count: 1 }] };
    return { rows: [{ count: 0 }] };
  }

  // list()'s KSM per-table SELECTs.
  if (/FROM\s+agent_facts/i.test(rendered.sql)) {
    return {
      rows: [
        {
          id: 'fact-1',
          descriptor: 'chave-x',
          created_at: new Date('2026-01-01T00:00:00Z'),
          lifecycle_transitions: [],
        },
      ],
    };
  }

  return { rows: [], _params: params };
});

vi.mock('@/db/client.js', () => ({
  db: { execute: dbExecuteMock, select: () => selectChain },
  withTx: vi.fn(),
}));

vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  renderedSqls.length = 0;
  dbExecuteMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('proposalsUnifiedRepo.list — knowledge_proposal source', () => {
  it('CORRIGIDO: as 4 tabelas do KSM são consultadas mesmo sem constar em _availableTables()', async () => {
    const { proposalsUnifiedRepo } = await import('@/db/repositories/admin-repos.js');
    await proposalsUnifiedRepo.list({ tenantId: 'tenant-a', limit: 20 });

    for (const tabela of ['agent_facts', 'memory_entry', 'learned_rules', 'behavioral_hint']) {
      const queried = renderedSqls.some((s) => new RegExp(`FROM\\s+${tabela}`, 'i').test(s));
      expect(queried, `esperava uma query em ${tabela}`).toBe(true);
    }
  });

  it('sem cursor: nenhum predicado de cursor nas queries do KSM', async () => {
    const { proposalsUnifiedRepo } = await import('@/db/repositories/admin-repos.js');
    await proposalsUnifiedRepo.list({ tenantId: 'tenant-a', limit: 20 });

    const ksmSql = renderedSqls.filter((s) => /FROM\s+agent_facts/i.test(s));
    expect(ksmSql.length).toBeGreaterThan(0);
    for (const s of ksmSql) {
      expect(s).not.toMatch(/created_at.*<.*\$/is);
    }
  });

  it('CORRIGIDO: com cursor, o predicado (created_at, id) < (…) é aplicado às 4 queries do KSM', async () => {
    const { proposalsUnifiedRepo, encodeListCursor } = await import(
      '@/db/repositories/admin-repos.js'
    );
    const cursor = encodeListCursor({ proposed_at: new Date('2026-01-01T00:00:00Z'), id: 'x-1' });

    await proposalsUnifiedRepo.list({ tenantId: 'tenant-a', limit: 20, cursor });

    const ksmSql = renderedSqls.filter((s) => /FROM\s+(agent_facts|memory_entry|learned_rules|behavioral_hint)/i.test(s));
    expect(ksmSql.length).toBeGreaterThan(0);
    for (const s of ksmSql) {
      // Drizzle renders the composite predicate as bound params ($n) — the
      // literal shape proves the ROW comparison, not just that SOME filter
      // exists.
      expect(s, s).toMatch(/created_at.*id.*<.*\(\s*\$\d+.*\$\d+/is);
    }
  });
});

describe('proposalsUnifiedRepo.countersByType — knowledge_proposal', () => {
  it('CORRIGIDO: soma pending_review das 4 tabelas do KSM (antes: fixo em 0)', async () => {
    const { proposalsUnifiedRepo } = await import('@/db/repositories/admin-repos.js');
    const counts = await proposalsUnifiedRepo.countersByType('tenant-a');

    // 2 (agent_facts) + 3 (memory_entry) + 0 (learned_rules) + 1 (behavioral_hint)
    expect(counts.knowledge_proposal).toBe(6);
  });
});
