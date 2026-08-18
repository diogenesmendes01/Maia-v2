/**
 * Vitest global setup. Forces deterministic env vars for the schema in
 * `src/config/env.ts` so test runs aren't poisoned by the developer's shell
 * environment. Tests that need a custom config still mock `@/config/env.js`
 * directly via `vi.mock`; this file just keeps the *unmocked* import path
 * from blowing up `loadConfig`.
 */
import { beforeEach } from 'vitest';
import {
  BASE_REDIS_URL,
  BASE_TEST_DB_URL,
  resolveWorktreeScope,
  scopedDatabaseName,
  scopedDatabaseUrl,
  scopedRedisUrl,
} from './helpers/worktree-scope.js';

/**
 * Issue #571 — isolamento por worktree.
 *
 * Numa worktree ligada, `scope` deixa de ser `null` e TODA a infra de teste
 * passa a apontar para um banco Postgres e um db lógico do Redis exclusivos
 * daquela árvore. No checkout principal e no CI (`.git` é diretório, não
 * arquivo) `scope` é `null` e nada muda — os valores abaixo são exatamente os
 * de antes.
 *
 * A derivação é pura, então este arquivo (que roda em CADA worker) e
 * `tests/globalSetup.ts` (que roda uma vez, e é quem cria e migra o banco)
 * chegam ao mesmo destino sem depender de herança de env entre processos.
 */
const scope = resolveWorktreeScope();

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = scopedDatabaseUrl(BASE_TEST_DB_URL, scope);
process.env.POSTGRES_USER = 'maia_test';
process.env.POSTGRES_PASSWORD = 'test1234';
process.env.POSTGRES_DB = scopedDatabaseName('maia_test', scope);
process.env.REDIS_URL = scopedRedisUrl(BASE_REDIS_URL, scope);

/**
 * `TEST_DB_URL` é o interruptor das specs de integração (sem ela, todas dão
 * `describe.skip`). NÃO a inventamos aqui — `npm test` continua passando sem
 * infra nenhuma. Mas quando ela existe, ela é REESCRITA para o banco desta
 * worktree: quem copiou a URL compartilhada do README ganha isolamento sem
 * saber que precisava dele.
 *
 * As specs afirmam `DATABASE_URL === TEST_DB_URL` antes de rodar (54 arquivos);
 * escrever as duas com a mesma função é o que mantém essa igualdade de pé.
 */
if (process.env.TEST_DB_URL) {
  process.env.TEST_DB_URL = scopedDatabaseUrl(process.env.TEST_DB_URL, scope);
  process.env.DATABASE_URL = process.env.TEST_DB_URL;
}
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-placeholder';
process.env.OPENROUTER_API_KEY = 'sk-or-test-placeholder';
process.env.WHATSAPP_NUMBER_MAIA = '+5500000000000';
process.env.OWNER_TELEFONE_WHATSAPP = '+5511111111111';
process.env.OWNER_NOME = 'Test Owner';
process.env.VOYAGE_API_KEY = 'test-voyage-key';
process.env.ALERT_CHANNELS = 'log';

// issue #323: PRODUCTION defaults `MAIA_REJECT_DEFAULT_LITERAL` ON (reject the
// 'default' literal fail-closed, opt-out). The unit suite uses 'default' as a
// generic mock tenant in many unrelated tests, so the TEST baseline is OFF; the
// dedicated rejection/flip tests set it to 'true' (or delete it) per-case. A
// beforeEach re-asserts the baseline so a per-case override never leaks across
// tests (threads share process.env).
process.env.MAIA_REJECT_DEFAULT_LITERAL = 'false';
beforeEach(() => {
  process.env.MAIA_REJECT_DEFAULT_LITERAL = 'false';
});
