/**
 * `.env` file parsing for the configuration contract (issue #515).
 *
 * WHY THIS IS A ONE-LINE WRAPPER, AND WHY IT MATTERS
 *
 * The whole point of the contract is that there is exactly ONE interpretation
 * of a configuration file. The runtime loads `.env` through `dotenv/config`
 * (`src/config/env.ts`), so anything that reads the same file for validation
 * has to agree with dotenv EXACTLY — otherwise `maia config check` and the boot
 * disagree about what the file says, which is worse than not checking at all.
 *
 * The first implementation hand-rolled the parse and diverged immediately:
 *   ALERT_CHANNELS=log # somente log
 * dotenv yields `log`; the hand-rolled parser yielded `log # somente log`, so
 * the CLI reported an unknown alert channel for a file the runtime boots fine.
 * Quoting, escapes and multi-line values diverged too. Review round 1 on
 * PR #522 flagged it; `tests/unit/config/env-file.spec.ts` now pins parity.
 *
 * PURITY: `dotenv.parse(src)` is a pure string → object function. It is the
 * SIDE-EFFECTING entry point `dotenv/config` (and `dotenv.config()`) that reads
 * the filesystem and mutates `process.env` — neither is used here, and
 * `tests/unit/config/contract-purity.spec.ts` enforces that no pure module
 * reaches them.
 */
import dotenv from 'dotenv';

/**
 * Parse `.env` content exactly the way the runtime does.
 *
 * Delegates to `dotenv.parse` — the same parser `dotenv/config` uses in
 * `src/config/env.ts` — so the CLI, the validator and the boot can never
 * disagree about what a line means.
 */
export function parseEnvFile(content: string): Record<string, string> {
  return dotenv.parse(content);
}
