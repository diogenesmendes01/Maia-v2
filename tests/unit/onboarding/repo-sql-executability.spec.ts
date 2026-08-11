/**
 * Issue #519 — prova SEM BANCO de que o SQL das queries de `onboarding-repos`
 * é EXECUTÁVEL, não só bem escopado.
 *
 * Motivação, com nome e sobrenome: as duas queries que filtram estado terminal
 * nasceram como ``sql`${col} <> ALL(${terminal})` ``, com `terminal` sendo um
 * array JS. O Drizzle interpola array JS como TUPLA de parâmetros — o SQL saía
 * `<> ALL(($2, $3, $4))`, e o Postgres recusa com
 * `op ANY/ALL (array) requires array on right side`.
 *
 * Nada pegou isso antes de o CI subir um Postgres de verdade:
 *
 *  - os testes unitários usam store falso e nunca compilam SQL;
 *  - `readiness-facts-scope.spec.ts` compila o `WHERE`, mas afirma predicados
 *    de tenant, e o SQL quebrado CONTINHA os predicados certos;
 *  - a suíte de integração que exercita a query só roda com `TEST_DB_URL`.
 *
 * Este teste fecha essa lacuna na lane sem banco: compila o `WHERE` real e
 * afirma a forma do operador. Um array JS reintroduzido em qualquer predicado
 * de conjunto volta a falhar aqui, em segundos, em vez de só no CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const captured: SQL[] = [];

function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: (w: SQL) => {
      captured.push(w);
      return chain;
    },
    orderBy: () => chain,
    for: () => chain,
    limit: () => Promise.resolve([]),
    then: (resolve: (v: unknown) => unknown) => resolve([]),
  };
  return chain;
}

vi.mock('../../../src/db/client.js', () => ({
  db: { select: () => makeChain(), execute: () => Promise.resolve({ rows: [] }) },
  withTx: vi.fn(),
  pgErrorCode: () => undefined,
}));

function compile(where: SQL): string {
  return new PgDialect().sqlToQuery(where).sql;
}

/**
 * `ALL(` / `ANY(` seguido de `(` é o dedo na ferida: o Postgres exige um array
 * do lado direito, e `(($2, $3, $4))` é um construtor de linha.
 */
const ROW_CONSTRUCTOR_ON_SET_OP = /\b(?:ALL|ANY)\s*\(\s*\(/i;

beforeEach(() => {
  captured.length = 0;
});

describe('onboarding-repos — SQL executável nos predicados de conjunto', () => {
  it('listForTenant não emite construtor de linha do lado direito de ALL/ANY', async () => {
    const { onboardingRunsRepo } = await import(
      '../../../src/db/repositories/onboarding-repos.js'
    );
    await onboardingRunsRepo.listForTenant({ tenant_id: 'acme' });

    expect(captured, 'nenhum WHERE capturado').toHaveLength(1);
    const sql = compile(captured[0]!);
    expect(sql).not.toMatch(ROW_CONSTRUCTOR_ON_SET_OP);
    // Escopo de tenant continua provado junto: um não vale sem o outro.
    expect(sql).toContain('"tenant_id"');
    expect(sql.toLowerCase()).toContain('not in');
  });

  it('expireStale não emite construtor de linha do lado direito de ALL/ANY', async () => {
    const { onboardingRunsRepo } = await import(
      '../../../src/db/repositories/onboarding-repos.js'
    );
    await onboardingRunsRepo.expireStale(new Date('2026-01-01T00:00:00Z'));

    expect(captured, 'nenhum WHERE capturado').toHaveLength(1);
    const sql = compile(captured[0]!);
    expect(sql).not.toMatch(ROW_CONSTRUCTOR_ON_SET_OP);
    expect(sql).toContain('"expires_at"');
    expect(sql.toLowerCase()).toContain('not in');
  });

  it('o conjunto terminal vem de TERMINAL_STATES, não de literal duplicado', async () => {
    const { TERMINAL_STATES } = await import('../../../src/onboarding/state-machine.js');
    const { onboardingRunsRepo } = await import(
      '../../../src/db/repositories/onboarding-repos.js'
    );
    await onboardingRunsRepo.listForTenant({ tenant_id: 'acme' });

    // Um placeholder por estado terminal: se alguém acrescentar um estado
    // terminal na máquina e esquecer o repo, a contagem denuncia.
    const params = new PgDialect().sqlToQuery(captured[0]!).params;
    for (const state of TERMINAL_STATES) {
      expect(params, `estado terminal '${state}' ausente do predicado`).toContain(state);
    }
  });

  it('include_terminal remove o predicado de estado e mantém o de tenant', async () => {
    const { onboardingRunsRepo } = await import(
      '../../../src/db/repositories/onboarding-repos.js'
    );
    await onboardingRunsRepo.listForTenant({ tenant_id: 'acme', include_terminal: true });

    const sql = compile(captured[0]!);
    expect(sql).toContain('"tenant_id"');
    expect(sql.toLowerCase()).not.toContain('not in');
  });
});
