/**
 * Gate de paridade `src/db/schema.ts` ↔ `migrations/`.
 *
 * O banco do job `integration` do CI é o resultado de TODAS as migrations
 * (`npm run db:migrate` roda antes da suíte). Toda tabela desse catálogo tem de
 * estar declarada em `schema.ts`, e toda tabela de `schema.ts` tem de existir no
 * catálogo. Tabela só de um lado é uma de duas falhas:
 *
 *  - só no banco: migration sem espelho Drizzle — repositório que escreve nela
 *    o faz por SQL cru, sem tipo, e o `drizzle-kit` não a enxerga;
 *  - só no `schema.ts`: Drizzle apontando para tabela que nenhuma migration
 *    cria — a primeira query quebra em produção, não no CI.
 *
 * Compara só TABELAS (`relkind` r/p, sem partição, sem objeto de extensão).
 * Exceção do lado do banco é declarada abaixo com motivo, e a exceção que
 * deixar de valer reprova também, para a lista não apodrecer.
 *
 * Skipped sem `TEST_DB_URL` (o job `integration` não admite pulado).
 */
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '@/db/schema.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

/** Tabelas que as migrations criam e o Drizzle não declara de propósito. */
const SO_NO_BANCO: ReadonlyMap<string, string> = new Map([
  ['public.schema_migrations', 'ledger do runner de migrations (src/migrations/ledger.ts, 108)'],
  [
    'public.agent_memories_cleanup_backup',
    'quarentena do scripts/reflection-memory-cleanup.ts (063), lida só por SQL cru',
  ],
  [
    'public.channels_line_normalization_091_backup',
    'backup que o down da 091 usa para restaurar o external_id original',
  ],
]);

function tabelasDoDrizzle(): Set<string> {
  const out = new Set<string>();
  for (const valor of Object.values(schema)) {
    if (!is(valor, PgTable)) continue;
    const cfg = getTableConfig(valor);
    out.add(`${cfg.schema ?? 'public'}.${cfg.name}`);
  }
  return out;
}

async function tabelasDoBanco(): Promise<Set<string>> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const r = await c.query<{ t: string }>(`
      SELECT n.nspname || '.' || c.relname AS t
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         AND n.nspname NOT LIKE 'pg_temp_%'
         AND c.relkind IN ('r', 'p')
         AND NOT c.relispartition
         AND NOT EXISTS (
           SELECT 1 FROM pg_depend dep WHERE dep.objid = c.oid AND dep.deptype = 'e'
         )`);
    return new Set(r.rows.map((x) => x.t));
  } finally {
    await c.end();
  }
}

d('paridade schema.ts ↔ migrations', () => {
  it('toda tabela das migrations está no schema.ts, e vice-versa', async () => {
    const drizzle = tabelasDoDrizzle();
    const banco = await tabelasDoBanco();
    // Anti-vacuidade: um import quebrado ou um banco vazio não passa como "igual".
    expect(drizzle.size).toBeGreaterThan(50);
    expect(banco.size).toBeGreaterThan(50);

    // As duas direções num objeto só: o diagnóstico mostra tudo de uma vez.
    expect({
      migration_sem_espelho_no_schema_ts: [...banco]
        .filter((t) => !drizzle.has(t) && !SO_NO_BANCO.has(t))
        .sort(),
      schema_ts_sem_migration: [...drizzle].filter((t) => !banco.has(t)).sort(),
    }).toEqual({ migration_sem_espelho_no_schema_ts: [], schema_ts_sem_migration: [] });
  });

  it('toda exceção declarada ainda é tabela só do banco', async () => {
    const drizzle = tabelasDoDrizzle();
    const banco = await tabelasDoBanco();
    const vencidas = [...SO_NO_BANCO.keys()].filter((t) => !banco.has(t) || drizzle.has(t));
    expect(vencidas, 'exceção que não vale mais: tire-a de SO_NO_BANCO').toEqual([]);
  });
});
