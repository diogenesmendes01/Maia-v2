/**
 * P8.5 — tRPC HTTP fetch handler. Mounted at /api/trpc/[trpc].
 */
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '../../../../trpc/routers/_app.js';
import { createTRPCContext } from '../../../../trpc/context.js';

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ headers: req.headers }),
    /**
     * Issue #518 — TODA resposta tRPC é `no-store`.
     *
     * `channelLines.getPairingStatus` devolve o QR/código de pareamento no
     * corpo; é material de credencial de vida curta e não pode ficar em cache
     * de browser, de proxy nem no bfcache. Aplicar a política ao router
     * inteiro (em vez de só a essa rota) é deliberado: o console é uma
     * superfície de governança sob sessão, nada aqui deveria ser cacheado, e
     * uma regra global não pode ser esquecida ao adicionar a próxima
     * procedure sensível.
     *
     * `referrer-policy: no-referrer` fecha o outro vetor: nenhuma URL do
     * console (que carrega ids de tenant/agente/canal) vaza para host
     * externo. O mesmo header cobre as PÁGINAS em next.config.mjs.
     */
    responseMeta: () => ({
      headers: {
        'cache-control': 'no-store, no-cache, must-revalidate',
        pragma: 'no-cache',
        'referrer-policy': 'no-referrer',
      },
    }),
    onError: ({ path, error }) => {
      console.error(`[tRPC] ${path ?? '<unknown>'} → ${error.code}: ${error.message}`);
    },
  });

export { handler as GET, handler as POST };
