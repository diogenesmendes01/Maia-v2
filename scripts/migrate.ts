/**
 * `npm run db:migrate` — thin shim over the shared migration runner.
 *
 * Since issue #516 the implementation lives in `src/migrations/` and is used
 * by BOTH this script and the one-shot `migrate` service in the Compose files,
 * so there is exactly one definition of "apply the forward chain". This file
 * exists to keep the historical entrypoint (and its npm script) working.
 *
 * WHAT CHANGED vs. the pre-#516 script, and why:
 *   - execution is serialised by a global advisory lock, so two replicas of a
 *     rolling deploy cannot apply the same file twice;
 *   - every applied migration records a checksum, so editing a merged
 *     migration is detected instead of silently ignored;
 *   - a no-transaction migration that fails leaves `dirty` state and blocks
 *     everything after it, instead of being retried on the next boot as if
 *     nothing had happened;
 *   - the runner never calls `process.exit()` from inside the loop and closes
 *     its pool in `finally` on both paths.
 *
 * `NO_TX_MARKER` and `splitNoTxStatements` are RE-EXPORTED (not reimplemented)
 * so the existing specs and the testcontainer fixture keep importing them from
 * their historical location while sharing one implementation.
 */
import { pathToFileURL } from 'node:url';
import { NO_TX_MARKER, splitNoTxStatements } from '@/migrations/discover.js';
import { describeError } from '@/migrations/log.js';
import { run } from '@/cli/maia.js';

export { NO_TX_MARKER, splitNoTxStatements };

/**
 * Only run when this file is the process entrypoint — NOT when a test imports
 * it to exercise the pure helpers. `import.meta.url` is a `file://` URL; argv[1]
 * is a filesystem path, normalised via `pathToFileURL` so the comparison holds
 * on Windows (`file:///C:/...`) and POSIX alike.
 */
export function isDirectInvocation(entry: string | undefined, metaUrl: string): boolean {
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === metaUrl;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url) && !process.env.MIGRATE_NO_MAIN) {
  run(['migrate', 'up'])
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      // Redacted: a pg connection error carries the DSN in its message.
      process.stderr.write(`db:migrate failed: ${describeError(err)}\n`);
      process.exitCode = 1;
    });
}
