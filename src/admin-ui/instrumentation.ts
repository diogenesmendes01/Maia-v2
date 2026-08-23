/**
 * O BOOT do console (issue #596).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que a validação vive AQUI
 * ─────────────────────────────────────────────────────────────────────────
 * `instrumentation.ts` é o único ponto do Next.js que roda UMA vez, no
 * processo do servidor, ANTES do primeiro request — e cujo erro impede o
 * servidor de servir. `BaseServer.prepare()` carrega este módulo e
 * `prepareImpl()` faz `await ensureInstrumentationRegistered(...)`
 * (`next/dist/server/lib/router-utils/instrumentation-globals.external.js`),
 * que re-lança o que `register()` lançar. Ou seja: `register()` que lança =
 * container que não sobe. É essa a definição de fail-closed que a issue pede,
 * e nenhuma outra superfície do Next a tem:
 *
 *   - `middleware.ts` roda no runtime EDGE, por request, e não alcança o
 *     contrato (`node:crypto`, `dotenv`);
 *   - `app/layout.tsx` e as rotas são carregadas SOB DEMANDA — o erro
 *     apareceria como um 500 na primeira navegação, não como um boot
 *     reprovado, e uma rota que ninguém visita nunca o produziria;
 *   - `./lib/auth.ts` já rodava `resolveSecret()`/`oidcProviderEnabled()` no
 *     topo do módulo, mas só é carregado quando alguém bate em `/api/auth/*`
 *     ou numa página autenticada. "Descobre-se quando alguém tenta entrar" é
 *     exatamente o modo de falha da issue.
 *
 * O `next build` NÃO passa por aqui, de propósito e por construção do próprio
 * Next: `registerInstrumentation` sai cedo quando
 * `NEXT_PHASE === 'phase-production-build'`. A imagem continua construível sem
 * `.env.admin` — o gate é do BOOT, não da build.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * `NEXT_RUNTIME`
 * ─────────────────────────────────────────────────────────────────────────
 * O Next chama `register()` uma vez por runtime. Só o `nodejs` pode ler o
 * contrato (o edge não tem `node:crypto` nem `dotenv`), então o guard abaixo
 * não é otimização: sem ele o bundle edge falharia a compilar.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Dinâmico de propósito: mantém o grafo de imports do bundle edge livre do
  // contrato, que é código de Node.
  const { assertAdminBootConfig } = await import('./lib/boot-config.js');
  assertAdminBootConfig();
}
