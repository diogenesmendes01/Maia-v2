/**
 * P8.5 — root tRPC AppRouter combining all admin-ui routers.
 */
import { router } from '../server.js';
import { inboxRouter } from './inbox.js';
import { proposalsRouter } from './proposals.js';
import { versionsRouter } from './versions.js';
import { driftRouter } from './drift.js';
import { tracesRouter } from './traces.js';
import { auditRouter } from './audit.js';

export const appRouter = router({
  inbox: inboxRouter,
  proposals: proposalsRouter,
  versions: versionsRouter,
  drift: driftRouter,
  traces: tracesRouter,
  audit: auditRouter,
});

export type AppRouter = typeof appRouter;
