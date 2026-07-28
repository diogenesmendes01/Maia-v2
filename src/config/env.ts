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
 * BOOT IS FAIL-CLOSED IN EVERY PROFILE (owner decision on PR #522 review round
 * 1). An unknown Maia variable, a removed one (tombstone) or a `NODE_ENV` ×
 * `MAIA_ENV` contradiction aborts the boot in `development` exactly as it does
 * in production. Consistency is the point: a `.env` that boots on a laptop and
 * dies in staging is the drift this issue exists to remove.
 *
 * ROLLBACK, WITHOUT A REDEPLOY: `MAIA_CONFIG_STRICT_BOOT=false` reverts to the
 * pre-contract loader (Zod schema + `boot`-scope cross-field rules only). It
 * turns the WHOLE contract guarantee off, so it is a lever to unblock an
 * environment while the real fix lands — see `docs/runbooks/config-contract.md`.
 *
 * Public surface unchanged: `config` and `Config`, with the same keys and the
 * same inferred types as before the contract landed.
 */
import type { z } from 'zod';
import 'dotenv/config';
import { CONTRACT_VERSION, objectSchemaForService } from '@/config/contract.js';
import { evaluateCrossFieldRules } from '@/config/rules.js';
import { resolveProfile } from '@/config/profiles.js';
import { validateConfig } from '@/config/validate.js';
import type { ConfigProblem } from '@/config/metadata.js';

const envSchema = objectSchemaForService('runtime');

export type Config = z.infer<typeof envSchema>;

/** The escape hatch. Read from the raw env — it gates the loader itself. */
function strictBoot(raw: Record<string, string | undefined>): boolean {
  return raw.MAIA_CONFIG_STRICT_BOOT !== 'false';
}

/**
 * Boot failure text. Names the VARIABLE, the RULE and the REMEDIATION of every
 * problem — never a value (the validator redacts by construction; see
 * `src/config/redact.ts`).
 *
 * The first line keeps the historical `Invalid configuration:` prefix so
 * existing log greps and runbooks still match.
 */
function formatBootFailure(problems: readonly ConfigProblem[], profile: string): string {
  const body = problems
    .map((p) => `  - ${p.variable ?? '<root>'} [${p.rule}]: ${p.message}\n      → ${p.remediation}`)
    .join('\n');
  return [
    `Invalid configuration: ${problems.length} problema(s) no profile ${profile} ` +
      `(contrato ${CONTRACT_VERSION}).`,
    '',
    body,
    '',
    'O boot falha fechado em TODOS os profiles (issue #515). Se algum item acima for',
    'uma variável legítima que o contrato ainda não conhece, declare-a em',
    'src/config/contract.ts e rode `npm run config:generate`.',
    '',
    'Para inspecionar o ambiente inteiro de uma vez:',
    '  npm run config:check -- --env-file .env',
    '',
    'ROLLBACK DE EMERGÊNCIA (env-only, sem redeploy): MAIA_CONFIG_STRICT_BOOT=false',
    'volta ao loader anterior e DESLIGA a validação de contrato inteira.',
    'Runbook: docs/runbooks/config-contract.md',
  ].join('\n');
}

/**
 * The pre-contract boot check, preserved for the rollback path: the Zod schema
 * (applied by the caller) plus the `boot`-scope cross-field rules, with their
 * original messages.
 */
function legacyBootProblems(
  cfg: Config,
  raw: Record<string, string | undefined>,
): ConfigProblem[] {
  const { profile } = resolveProfile(raw);
  return evaluateCrossFieldRules({
    values: cfg as unknown as Record<string, unknown>,
    raw,
    profile,
  })
    .filter((f) => f.scope === 'boot' && f.severity === 'error')
    .map((f) => ({
      severity: 'error' as const,
      variable: f.variable,
      rule: f.rule,
      message: f.message,
      remediation: f.remediation,
    }));
}

function loadConfig(): Config {
  const raw = process.env as Record<string, string | undefined>;
  const strict = strictBoot(raw);

  if (strict) {
    // ONE pass over the whole contract: schema, per-profile requirements,
    // cross-field rules, tombstones, unknown keys and the NODE_ENV × MAIA_ENV
    // contradiction. Every problem at once, instead of one per restart.
    const result = validateConfig({ env: raw, service: 'runtime' });
    if (!result.ok) {
      // Throw instead of process.exit(1) — main().catch in index.ts handles
      // fatal logging and exit, and throwing keeps vitest alive when a spec
      // imports a config-dependent module without mocking env.
      throw new Error(formatBootFailure(result.errors, result.profile));
    }
  }

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    // Unreachable under `strict` (validateConfig already reports every schema
    // issue) — this is the rollback path's schema gate.
    const problems: ConfigProblem[] = parsed.error.issues.map((i) => ({
      severity: 'error' as const,
      variable: i.path.join('.') || null,
      rule: `schema/${i.code}`,
      message: i.message,
      remediation: 'Corrija a variável conforme src/config/contract.ts.',
    }));
    throw new Error(formatBootFailure(problems, resolveProfile(raw).profile));
  }

  if (!strict) {
    const problems = legacyBootProblems(parsed.data, raw);
    if (problems.length > 0) {
      throw new Error(formatBootFailure(problems, resolveProfile(raw).profile));
    }
    // Loud on purpose: a silent escape hatch is one nobody remembers to close.
    console.warn(
      '[config] MAIA_CONFIG_STRICT_BOOT=false — validação de contrato DESLIGADA ' +
        '(variável desconhecida, tombstone e contradição de profile não são checados). ' +
        'Rollback temporário; ver docs/runbooks/config-contract.md.',
    );
  }

  return parsed.data;
}

export const config: Config = loadConfig();
