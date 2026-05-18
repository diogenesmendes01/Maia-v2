/**
 * P8.5 — NextAuth v5 API route handler.
 *
 * round-2 fix: NextAuth(config) returns { handlers, auth, ... }, not a
 * route-handler function. Export handlers.GET / handlers.POST as required by
 * Next.js App Router.
 */
import { handlers } from '../../../../lib/auth.js';

export const { GET, POST } = handlers;
