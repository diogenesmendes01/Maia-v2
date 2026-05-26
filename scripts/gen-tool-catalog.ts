/**
 * Generator — produces the committed, side-effect-free tool-catalog artifact
 * consumed by the Admin UI `/tools` screen.
 *
 * WHY THIS EXISTS (PR #207 round 2):
 *   The `/tools` catalog router used to `import('@/tools/_registry.js')` at
 *   request time. That registry transitively imports the gateway
 *   (`send-proactive-message → gateway/baileys → gateway/presence` with a
 *   top-level `setInterval`, and `gateway/queue` with a top-level
 *   `new IORedis(...)` + `new Queue(...)`). So the first authenticated
 *   `/tools` request installed an orphan presence-sweep timer + a Redis
 *   connection + a BullMQ queue inside the admin-ui process.
 *
 *   Lazifying each gateway module (queue/presence are backend hot-path infra)
 *   was rejected as risky. Instead we precompute the catalog ONCE here, at
 *   build/dev time, into a plain-data TS module that the router imports
 *   directly — pulling in ZERO handler/gateway code.
 *
 * WHAT IT WRITES:
 *   `src/admin-ui/generated/tool-catalog.ts`, exporting a typed
 *   `TOOL_CATALOG: ToolCatalogEntry[]`. Each entry carries the static metadata
 *   for one tool (incl. feature-gated tools, with their gating `feature_flag`
 *   NAME). It deliberately omits `enabled` — that depends on the live config
 *   flags and is computed by the router per request from `feature_flag`.
 *
 * DETERMINISM:
 *   `buildToolCatalog()` already returns entries sorted by name; we re-sort
 *   defensively so the drift-guard test (which deep-equals the committed file)
 *   is stable regardless of registry insertion order.
 *
 * ENV STUBS (must be set BEFORE any `@/` import):
 *   Importing the registry pulls `@/config/env`, whose Zod schema validates
 *   eagerly at module load. We stub the minimal required vars (mirroring the
 *   build-time stubs in `src/admin-ui/Dockerfile`) so this generator runs in a
 *   clean shell / CI with no real secrets.
 *
 * EVENT LOOP:
 *   Importing the registry opens a Redis connection + the presence interval,
 *   which keep the event loop alive. We `process.exit(0)` at the end so the
 *   generator terminates instead of hanging.
 */

// ── env stubs — BEFORE any `@/` import (env validates at module load) ───────
function stubEnv(): void {
  const defaults: Record<string, string> = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://gen:gen@localhost:5432/gen',
    POSTGRES_USER: 'gen',
    POSTGRES_PASSWORD: 'gengengen',
    POSTGRES_DB: 'gen',
    REDIS_URL: 'redis://localhost:6379',
    WHATSAPP_NUMBER_MAIA: '+5500000000000',
    OWNER_TELEFONE_WHATSAPP: '+5511111111111',
    OWNER_NOME: 'gen',
    ANTHROPIC_API_KEY: 'sk-ant-gen',
    OPENROUTER_API_KEY: 'sk-or-gen',
    VOYAGE_API_KEY: 'voyage-gen',
    ALERT_CHANNELS: 'log',
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
  }
}
stubEnv();

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(
  __dirname,
  '..',
  'src',
  'admin-ui',
  'generated',
  'tool-catalog.ts',
);

/**
 * Build the catalog rows from the registry. Dynamic import so the env stubs
 * above are guaranteed set before `@/config/env` evaluates.
 */
async function buildRows(): Promise<string> {
  const { buildToolCatalog } = await import('@/tools/_registry.js');
  const { describeZodObject } = await import('@/tools/describe-schema.js');

  const rows = buildToolCatalog()
    .map(({ tool, feature_flag }) => ({
      name: tool.name,
      description: tool.description,
      side_effect: tool.side_effect,
      operation_type: tool.operation_type,
      sensitive: tool.sensitive ?? false,
      // The gating flag NAME (env-var name for config-gated tools,
      // `FeatureFlagName` value for declared-flag / KSM tools), or null.
      feature_flag,
      required_actions: [...tool.required_actions],
      // Flat field list ([{ name, type, optional }]). NOTE: `enabled` is
      // intentionally NOT included — it is runtime state computed by the router.
      inputs: describeZodObject(tool.input_schema),
    }))
    // Defensive stable sort (buildToolCatalog already sorts) for a stable diff.
    .sort((a, b) => a.name.localeCompare(b.name));

  return JSON.stringify(rows, null, 2);
}

async function main(): Promise<void> {
  const rowsJson = await buildRows();

  const banner = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Produced by \`scripts/gen-tool-catalog.ts\` (\`npm run gen:tool-catalog\`).
 * A side-effect-free, plain-data snapshot of every tool the LLM can call,
 * consumed by the Admin UI Tools Catalog router
 * (\`src/admin-ui/trpc/routers/tools-catalog.ts\`).
 *
 * Importing this module pulls in ZERO tool handlers / gateway code — that is
 * the whole point (the router used to dynamically import the registry, which
 * transitively booted the presence sweep timer + a Redis connection + a BullMQ
 * queue inside the admin-ui process). Regenerate with \`npm run gen:tool-catalog\`
 * whenever a tool's name / description / schema / gating flag changes; the
 * drift-guard test fails otherwise.
 *
 * \`enabled\` is deliberately absent here — it is runtime state derived from the
 * live config feature flags and computed by the router per request from
 * \`feature_flag\`.
 */

/** One field of a tool's input schema (flattened by \`describeZodObject\`). */
export interface ToolCatalogInput {
  /** The object key. */
  name: string;
  /** A short, human-readable type label (e.g. \`string\`, \`enum(a|b)\`, \`string[]\`). */
  type: string;
  /** True when the field is \`.optional()\`, \`.nullable()\`, or has a \`.default()\`. */
  optional: boolean;
}

/** Static metadata for one catalog tool (no runtime \`enabled\`). */
export interface ToolCatalogEntry {
  name: string;
  description: string;
  side_effect: 'none' | 'read' | 'write' | 'communication';
  operation_type:
    | 'create'
    | 'correct'
    | 'cancel'
    | 'update_meta'
    | 'parse_only'
    | 'read'
    | 'communicate';
  sensitive: boolean;
  /** Gating flag NAME (env-var name or \`FeatureFlagName\` value), or null when ungated. */
  feature_flag: string | null;
  required_actions: string[];
  inputs: ToolCatalogInput[];
}
`;

  const body = `\nexport const TOOL_CATALOG: ToolCatalogEntry[] = ${rowsJson};\n`;

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, banner + body, 'utf8');

  console.log(
    `[gen-tool-catalog] wrote ${OUTPUT_PATH} (${JSON.parse(rowsJson).length} tools)`,
  );
}

main()
  .then(() => {
    // The registry import opened a Redis connection + the presence interval,
    // which keep the event loop alive. Exit explicitly so this terminates.
    process.exit(0);
  })
  .catch((err) => {
    console.error('[gen-tool-catalog] failed:', err);
    process.exit(1);
  });
