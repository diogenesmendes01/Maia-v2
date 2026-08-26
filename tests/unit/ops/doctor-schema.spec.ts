/**
 * `maia doctor` — a costura read-only do veredito de schema (issue #517).
 *
 * `getSchemaReadiness()` (#516) é o ÚNICO consumidor do pool do doctor que não
 * passa pelo handle estreito: ele pede um cliente e emite várias consultas. O
 * adapter que satisfazia essa forma entregava um cliente cru — sem
 * `BEGIN READ ONLY`, sem `statement_timeout` — e o teste negativo de read-only
 * empurrava mutação só pelo `ctx.postgres`, então este caminho não era
 * exercido por ninguém.
 *
 * Aqui ficam as regras que um pool falso prova sem banco: QUAIS comandos são
 * emitidos, em que ordem, e o que acontece com o cliente quando o deadline
 * dispara. O que só um Postgres real prova — que a mutação é recusada com
 * SQLSTATE 25006 e que uma leitura travada não segura o `pool.end()` — está em
 * `tests/integration/doctor-real-deps.spec.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  SCHEMA_READINESS_STATEMENT_COUNT,
  SCHEMA_READINESS_STATEMENT_TIMEOUT_MS,
  SchemaEvaluationAbortedError,
  withReadOnlySchemaTransaction,
} from '@/ops/doctor/schema.js';
import { schemaReadinessCheck } from '@/ops/doctor/checks/postgres.js';
import type { PgPoolLike } from '@/ops/doctor/postgres.js';

interface FakeClient {
  readonly issued: string[];
  released: number;
  destroyed: number;
}

/** Pool falso que registra tudo o que o adapter fez com o cliente. */
function fakePool(
  onQuery?: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>,
): { pool: PgPoolLike; client: FakeClient } {
  const client: FakeClient = { issued: [], released: 0, destroyed: 0 };
  const pool: PgPoolLike = {
    connect: () =>
      Promise.resolve({
        query: async <R extends Record<string, unknown>>(sql: string) => {
          client.issued.push(sql);
          if (onQuery && !/^(BEGIN|SET LOCAL|ROLLBACK)/.test(sql)) {
            return (await onQuery(sql)) as unknown as { rows: R[] };
          }
          return { rows: [] as R[] };
        },
        release: (destroy?: boolean) => {
          if (destroy === true) client.destroyed += 1;
          else client.released += 1;
        },
      }),
  };
  return { pool, client };
}

describe('maia doctor · avaliação de schema em transação READ ONLY', () => {
  it('abre BEGIN READ ONLY e aplica statement_timeout ANTES da primeira consulta', async () => {
    const { pool, client } = fakePool();
    await withReadOnlySchemaTransaction(pool, async (roPool) => {
      const c = await roPool.connect();
      await c.query('SELECT 1');
      c.release();
      return null;
    });
    expect(client.issued).toEqual([
      'BEGIN READ ONLY',
      `SET LOCAL statement_timeout = ${SCHEMA_READINESS_STATEMENT_TIMEOUT_MS}`,
      'SELECT 1',
      'ROLLBACK',
    ]);
    expect(client.released).toBe(1);
    expect(client.destroyed).toBe(0);
  });

  it('o statement_timeout é MENOR que o deadline do check, com folga para TODAS as consultas do caminho de leitura', () => {
    // `describeLedger` + `readLedger` + `readInvalidIndexes` (#658) = três
    // consultas. Se o teto por statement fosse >= um terço do deadline, uma
    // leitura lenta estouraria o prazo do check antes de o servidor cortar a
    // consulta.
    expect(SCHEMA_READINESS_STATEMENT_COUNT).toBe(3);
    expect(SCHEMA_READINESS_STATEMENT_TIMEOUT_MS).toBeLessThan(schemaReadinessCheck.deadlineMs);
    expect(
      SCHEMA_READINESS_STATEMENT_TIMEOUT_MS * SCHEMA_READINESS_STATEMENT_COUNT,
    ).toBeLessThanOrEqual(schemaReadinessCheck.deadlineMs);
  });

  it('devolve o cliente mesmo quando a avaliação LANÇA, e ainda faz ROLLBACK', async () => {
    const { pool, client } = fakePool();
    await expect(
      withReadOnlySchemaTransaction(pool, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(client.issued).toContain('ROLLBACK');
    expect(client.released).toBe(1);
    expect(client.destroyed).toBe(0);
  });

  /**
   * O coração do achado: com o deadline estourado, uma consulta pode continuar
   * em voo segurando o cliente. Devolver esse cliente ao pool é o que faz o
   * `pool.end()` da CLI esperar — e um `ROLLBACK` enfileirado atrás da consulta
   * travada esperaria junto. Por isso a conexão é DESTRUÍDA.
   */
  it('quando o sinal dispara, DESTRÓI a conexão em vez de devolvê-la ao pool', async () => {
    const { pool, client } = fakePool();
    const controller = new AbortController();
    const promise = withReadOnlySchemaTransaction(
      pool,
      () =>
        new Promise<never>(() => {
          /* uma leitura que nunca responde */
        }),
      { signal: controller.signal },
    );
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(SchemaEvaluationAbortedError);
    expect(client.destroyed).toBe(1);
    expect(client.released).toBe(0);
    // Nada de ROLLBACK: ele entraria na fila atrás da consulta travada.
    expect(client.issued).not.toContain('ROLLBACK');
  });

  it('um sinal JÁ abortado nem chega a esperar pela avaliação', async () => {
    const { pool, client } = fakePool();
    let started = false;
    await expect(
      withReadOnlySchemaTransaction(
        pool,
        () => {
          started = true;
          return new Promise<never>(() => {
            /* nunca */
          });
        },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toBeInstanceOf(SchemaEvaluationAbortedError);
    expect(started).toBe(true);
    expect(client.destroyed).toBe(1);
  });

  it('o cliente emprestado NÃO é devolvido pelo consumidor: a vida dele é do adapter', async () => {
    const { pool, client } = fakePool();
    await withReadOnlySchemaTransaction(pool, async (roPool) => {
      const a = await roPool.connect();
      a.release();
      const b = await roPool.connect();
      b.release();
      return null;
    });
    // Duas conexões lógicas, UMA devolução real — no fim, pelo adapter.
    expect(client.released).toBe(1);
  });
});
