/**
 * Vitest global setup. Forces deterministic env vars for the schema in
 * `src/config/env.ts` so test runs aren't poisoned by the developer's shell
 * environment. Tests that need a custom config still mock `@/config/env.js`
 * directly via `vi.mock`; this file just keeps the *unmocked* import path
 * from blowing up `loadConfig`.
 */
import { beforeEach } from 'vitest';
import { resolveTestEnv, resolveWorktreeScope } from './helpers/worktree-scope.js';

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

/**
 * UMA derivação, dois processos — revisão da PR #597.
 *
 * `resolveTestEnv()` é a MESMA função que `tests/globalSetup.ts` chama para
 * decidir qual banco criar/migrar e qual db do Redis limpar. Antes, cada
 * arquivo montava as URLs por conta própria e as duas expressões divergiram:
 * o setup global respeitava `REDIS_URL` do ambiente e os workers iam sempre
 * para `redis://localhost:6379`. Com um Redis em porta/host/credencial
 * customizados, o `FLUSHDB` acertava um endpoint e os testes rodavam noutro.
 *
 * `TEST_DB_URL` é o interruptor das specs de integração (sem ela, todas dão
 * `describe.skip`) e NÃO é inventada aqui — `npm test` continua passando sem
 * infra nenhuma. Quando ela existe, sai escopada, e `DATABASE_URL` sai igual a
 * ela: 54 arquivos afirmam essa igualdade antes de rodar.
 */
Object.assign(process.env, { NODE_ENV: 'test' }, resolveTestEnv(process.env, scope));

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
