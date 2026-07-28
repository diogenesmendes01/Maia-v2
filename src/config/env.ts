/**
 * Runtime configuration singleton.
 *
 * Since issue #515 this file is a THIN LOADER: the schema, the defaults and the
 * cross-field rules all come from the pure contract
 * (`src/config/contract.ts` + `src/config/rules.ts`). This module is the only
 * one that still has import-time side effects (`dotenv/config` + `loadConfig()`),
 * which is exactly why the contract is kept separate — the CLI, `maia doctor`
 * (#517), the migration runner (#516) and the tests import the contract and get
 * schema + validation WITHOUT booting the world.
 *
 * Public surface unchanged: `config` and `Config`, with the same keys and the
 * same inferred types as before the contract landed. Boot failure messages are
 * preserved verbatim by the `scope: 'boot'` rules in `rules.ts`.
 */
import { z } from 'zod';
import 'dotenv/config';
import { objectSchemaForService } from '@/config/contract.js';
import { evaluateCrossFieldRules } from '@/config/rules.js';
import { resolveProfile } from '@/config/profiles.js';

const envSchema = objectSchemaForService('runtime').superRefine((cfg, ctx) => {
  const raw = process.env as Record<string, string | undefined>;
  const { profile } = resolveProfile(raw);
  const findings = evaluateCrossFieldRules({
    values: cfg as unknown as Record<string, unknown>,
    raw,
    profile,
  });
  for (const f of findings) {
    // BOOT SCOPE ONLY. The contract-scope rules are enforced by
    // `maia config check` / `maia doctor`; wiring them into boot is a
    // deliberate later rollout step (#515 "Migration e rollout", passo 8) so
    // this change cannot break a running deployment.
    if (f.scope !== 'boot' || f.severity !== 'error') continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      ...(f.variable ? { path: [f.variable] } : {}),
      message: f.message,
    });
  }
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    // Throw instead of process.exit(1) - main().catch in index.ts handles
    // fatal logging and exit. Throwing keeps vitest alive when a spec file
    // imports a config-dependent module without mocking env.
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return result.data;
}

export const config: Config = loadConfig();
