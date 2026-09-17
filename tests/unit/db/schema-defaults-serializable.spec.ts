/**
 * PR #766 — todo default de coluna do schema precisa sobreviver ao
 * `JSON.stringify` que o drizzle-kit faz no snapshot.
 *
 * ─── O que reprovou ────────────────────────────────────────────────────────
 *
 * O job `round-trip do drizzle-kit (generate + up + down)` reprovou com
 * "esperava 1 arquivo _up.sql …, achei 0", sem erro nenhum no log. A causa são
 * dois `bigint(…, { mode: 'bigint' }).default(0n)` do P03.1
 * (`conversation_controls.control_epoch` e `engine_runs.last_event_sequence`):
 * o drizzle-kit 0.31.10 copia o default cru para o snapshot e depois faz
 * `JSON.parse(JSON.stringify(...))`, que lança `Do not know how to serialize a
 * BigInt`. O próprio drizzle-kit engole a exceção e sai com código 0, e a sonda
 * descarta a saída de processo que saiu com 0 — duas camadas escondendo o erro.
 *
 * Este spec pega a classe inteira do defeito sem rodar o drizzle-kit nem abrir
 * banco: percorre toda tabela exportada e exige que todo default NÃO-SQL
 * serialize. Default SQL (`sql\`0\``) não entra no snapshot como valor cru.
 *
 * ─── Por que `sql\`0\`` e não `mode: 'number'` ─────────────────────────────
 *
 * O `mode: 'bigint'` é deliberado (o contrato serializa epoch como decimal e
 * um contador de banco não deve depender de 2^53 — comentário da coluna). A
 * correção troca só a FORMA do default, preservando o tipo; o caso de paridade
 * abaixo prende as duas coisas e confere que a migration 140 declara o mesmo
 * `DEFAULT 0`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { is, SQL, sql } from 'drizzle-orm';
import { bigint, getTableConfig, PgDialect, PgTable, pgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../../src/db/schema.js';

type Achado = { tabela: string; coluna: string; erro: string };

/** Defaults não-SQL que não sobrevivem ao `JSON.stringify` do snapshot. */
function defaultsNaoSerializaveis(tabelas: PgTable[]): Achado[] {
  const achados: Achado[] = [];
  for (const t of tabelas) {
    const cfg = getTableConfig(t);
    for (const c of cfg.columns) {
      if (!c.hasDefault || c.default === undefined || is(c.default, SQL)) continue;
      try {
        JSON.stringify({ default: c.default });
      } catch (e) {
        achados.push({ tabela: cfg.name, coluna: c.name, erro: (e as Error).message });
      }
    }
  }
  return achados;
}

const tabelasDoSchema = (): PgTable[] =>
  Object.values(schema).filter((v): v is PgTable => is(v, PgTable));

const renderizar = (s: SQL): string => new PgDialect().sqlToQuery(s).sql;

describe('schema — defaults serializáveis pelo drizzle-kit', () => {
  it('a varredura não é vácua: inspeciona o schema inteiro', () => {
    // Hoje são 113 tabelas; o piso folgado só existe para pegar um import que
    // devolvesse nada e deixasse o caso seguinte verde sem olhar coluna nenhuma.
    expect(tabelasDoSchema().length).toBeGreaterThanOrEqual(100);
  });

  it('nenhuma coluna do schema tem default não-SQL que o JSON.stringify recuse', () => {
    expect(defaultsNaoSerializaveis(tabelasDoSchema())).toEqual([]);
  });

  it('o detector ACUSA bigint com default `0n` (controle positivo)', () => {
    const sintetica = pgTable('sintetica_default_bigint', {
      v: bigint('v', { mode: 'bigint' }).notNull().default(0n),
    });
    expect(defaultsNaoSerializaveis([sintetica])).toEqual([
      expect.objectContaining({ tabela: 'sintetica_default_bigint', coluna: 'v' }),
    ]);
  });

  it('o detector aceita default SQL e bigint em modo number (controles negativos)', () => {
    const sintetica = pgTable('sintetica_default_ok', {
      a: bigint('a', { mode: 'bigint' }).notNull().default(sql`0`),
      b: bigint('b', { mode: 'number' }).notNull().default(0),
    });
    expect(defaultsNaoSerializaveis([sintetica])).toEqual([]);
  });

  it('as duas colunas corrigidas mantêm o tipo bigint e o DEFAULT 0 da migration 140', () => {
    const migration = readFileSync(
      resolve(__dirname, '../../../migrations/140_engine_run_journal.sql'),
      'utf8',
    );
    for (const [tabela, coluna] of [
      [schema.conversation_controls, 'control_epoch'],
      [schema.engine_runs, 'last_event_sequence'],
    ] as const) {
      const col = getTableConfig(tabela).columns.find((c) => c.name === coluna);
      expect(col, coluna).toBeDefined();
      // O modo bigint é o motivo da coluna existir assim — não pode virar number.
      expect(col!.columnType, coluna).toBe('PgBigInt64');
      expect(col!.hasDefault, coluna).toBe(true);
      expect(is(col!.default, SQL), `${coluna}: default precisa ser SQL`).toBe(true);
      expect(renderizar(col!.default as SQL), coluna).toBe('0');
      expect(migration, coluna).toContain(`${coluna} bigint NOT NULL DEFAULT 0`);
    }
  });
});
