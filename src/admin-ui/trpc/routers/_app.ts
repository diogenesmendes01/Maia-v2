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
import { tenantsRouter } from './tenants.js';
import { agentsRouter } from './agents.js';
import { channelPoliciesRouter } from './channelPolicies.js';
import { channelLinesRouter } from './channelLines.js';
import { dashboardRouter } from './dashboard.js';
import { capabilitiesRouter } from './capabilities.js';
import { proceduresRouter } from './procedures.js';
import { knowledgeRouter } from './knowledge.js';
import { llmSettingsRouter } from './llmSettings.js';
import { toolsCatalogRouter } from './tools-catalog.js';
import { skillsRouter } from './skills.js';
import { playgroundRouter } from './playground.js';
import { objectivesRouter } from './objectives.js';
import { mcpRouter } from './mcp.js';

export const appRouter = router({
  inbox: inboxRouter,
  proposals: proposalsRouter,
  versions: versionsRouter,
  drift: driftRouter,
  traces: tracesRouter,
  audit: auditRouter,
  tenants: tenantsRouter,
  agents: agentsRouter,
  channelPolicies: channelPoliciesRouter,
  channelLines: channelLinesRouter,
  dashboard: dashboardRouter,
  capabilities: capabilitiesRouter,
  procedures: proceduresRouter,
  knowledge: knowledgeRouter,
  llmSettings: llmSettingsRouter,
  toolsCatalog: toolsCatalogRouter,
  skills: skillsRouter,
  playground: playgroundRouter,
  objectives: objectivesRouter,
  mcp: mcpRouter,
});

export type AppRouter = typeof appRouter;
