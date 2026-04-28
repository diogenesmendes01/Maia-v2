/**
 * Entity-leak suite — must always pass.
 * This is a placeholder structure: when a real Postgres is available, the suite
 * is wired in and asserts that every entity-scoped repository read refuses
 * cross-entity rows.
 *
 * For unit-only test runs (no DB), the suite is skipped via `describe.skip`.
 */
import { describe, it } from 'vitest';

describe.skip('entity-leak suite (requires Postgres)', () => {
  it('transacoes: pessoa A scope cannot return entity B rows', () => {
    // Implementação completa em B8 quando o ambiente provê Postgres.
    // 1) cria pessoa A com permissão em entidade A
    // 2) cria pessoa B com permissão em entidade B
    // 3) insere transações em A e B
    // 4) chama transacoesRepo.byScope({ entidades: [A] }) e verifica que
    //    nenhuma linha de B aparece
  });

  it('contas: pessoa A scope cannot return entity B contas', () => {
    // mesmo padrão para contasRepo.byEntities
  });

  it('contrapartes: pessoa A scope cannot return entity B contrapartes', () => {
    // mesmo padrão para contrapartesRepo.byScope
  });
});
