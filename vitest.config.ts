import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Post-Codex-review #101: admin-ui has its own node_modules (Next.js +
// @trpc/server). When admin-ui router code runs under vitest from the repo
// root, two copies of @trpc/server would be loaded — root's (for the test
// file's import) and admin-ui's (for the router's import). Two copies ⇒ two
// distinct TRPCError classes ⇒ `instanceof TRPCError` fails. We alias both
// resolvers to whichever copy actually exists at test time so a single class
// instance is shared.
const adminUiTrpcServer = resolve(__dirname, 'src/admin-ui/node_modules/@trpc/server');
const rootTrpcServer = resolve(__dirname, 'node_modules/@trpc/server');
const trpcServerAlias = existsSync(rootTrpcServer)
  ? rootTrpcServer
  : existsSync(adminUiTrpcServer)
    ? adminUiTrpcServer
    : undefined;

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      ...(trpcServerAlias ? { '@trpc/server': trpcServerAlias } : {}),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
    exclude: ['tests/admin-ui/e2e/**'],
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // ───────────────────────────────────────────────────────────────────────
    // Orçamento de tempo — issue #545, medido, não estimado
    // ───────────────────────────────────────────────────────────────────────
    // O default do vitest é 5000ms, e ele é MENOR que o custo de carregar a
    // frio o grafo de módulos de produção. Medição nesta máquina (4 vCPU),
    // cada import isolado num arquivo próprio, cache de transform frio, sem
    // nenhum trabalho de teste no corpo:
    //
    //   import('@/gateway/baileys.js')     5.77s · 6.40s · 6.64s · 6.83s
    //   import('@/agent/core.js')          6.38s · 6.60s
    //   import('@/lib/pdf/_sweeper.js')    5.83s · 6.38s   (reexporta baileys)
    //   import('@/db/repositories.js')     1.92s · 2.47s
    //
    // ~52% disso é transformação Vite do nosso próprio grafo TS, e o cache de
    // transform é COMPARTILHADO pela rodada. Ou seja: o custo de um arquivo
    // depende de ele ter sido agendado cedo (cache frio) ou tarde (cache
    // quente) — o vermelho virava loteria de ordenação. Numa rodada completa
    // com 2x de superlotação de workers (`--maxWorkers=8` em 4 vCPU, proxy do
    // runner do CI) o primeiro teste de ~20 arquivos ficou entre 5.9s e 8.4s,
    // com pico de 8367ms em `tests/unit/voice-flow.spec.ts`.
    //
    // 20000ms = 2.4x o pior valor observado (8367ms). Abaixo disso o CI
    // continua reprovando por prazo de import; muito acima, o prazo deixa de
    // ser um limite.
    //
    // O QUE ISTO CEGA, explicitamente: (a) um corpo travado (promise que nunca
    // resolve, deadlock) queima 20s em vez de 5s antes de reprovar; (b) um
    // teste que regredir de 50ms para qualquer coisa abaixo de 20s de trabalho
    // REAL não é mais pego pelo prazo. (a) é aceitável — os jobs têm teto de
    // 10/15 min e um travamento sistemático estoura o job, que é uma falha
    // legível. (b) é coberto pelo relatório de lentos do reporter em
    // `tests/reporters/diagnostico-reporter.ts`, que imprime no fim de TODA
    // rodada os testes acima de `MAIA_TEST_SLOW_MS` — a distribuição saudável
    // é nítida (8420 de 8691 testes abaixo de 100ms), então uma regressão de
    // desempenho aparece como linha nova na lista.
    //
    // NÃO é orçamento por lane (unit vs integration): a medição mostra que os
    // arquivos mais caros são de `tests/unit/` (voice-flow, pdf-sweeper,
    // baileys-*), não de integração. Separar por lane seria uma ficção.
    testTimeout: 20_000,
    // Mesmo motivo, e o default de hook eram 10000ms — só 1.2x o pior import
    // medido. `beforeAll` é o lugar CERTO para o import pesado (precedente:
    // `tests/integration/pending-gate-concurrency.spec.ts`, #545/#562), e esse
    // lugar precisa de orçamento que caiba o import.
    hookTimeout: 20_000,
    // `slowTestThreshold` alimenta o `diagnostic().slow` do vitest e o
    // destaque do reporter default. 1000ms deixa passar o ruído normal e
    // marca exatamente a faixa dominada por import a frio.
    slowTestThreshold: 1_000,
    // Bloco de diagnóstico no FIM do log, depois do sumário do default. Ver
    // `tests/reporters/diagnostico-reporter.ts` — ele denuncia prazo estourado
    // mesmo quando o `retry` absorveu o estouro e a rodada ficou verde, e
    // lista os mais lentos (o controle compensatório do prazo de 20s).
    reporters: ['default', resolve(__dirname, 'tests/reporters/diagnostico-reporter.ts')],
    // A handful of integration specs share process-wide singletons (Decision
    // Engine module-level caches, the Baileys presence handle, etc.) and
    // flake when they run after a polluting test file in the same worker.
    // Retrying once absorbs the flake without hiding a real regression — a
    // true failure surfaces on the second attempt too.
    retry: 1,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
    },
  },
});
