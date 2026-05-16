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
    onError: ({ path, error }) => {
      // eslint-disable-next-line no-console
      console.error(`[tRPC] ${path ?? '<unknown>'} → ${error.code}: ${error.message}`);
    },
  });

export { handler as GET, handler as POST };
