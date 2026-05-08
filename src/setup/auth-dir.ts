import { resolve, sep } from 'node:path';

/**
 * Whitelist + blacklist guard for `BAILEYS_AUTH_DIR`.
 *
 * `recovery.ts` does an `rm(BAILEYS_AUTH_DIR, { recursive: true, force: true })`
 * on every WhatsApp `LoggedOut` event — fully automated, no human in the loop.
 * If `BAILEYS_AUTH_DIR` is misconfigured (`/`, `/etc`, project root, an empty
 * string that resolves to CWD), the recovery flow becomes a destructive wipe.
 *
 * This helper rejects the obvious foot-guns at boot and at the rm site:
 *  - filesystem roots (POSIX `/`, Windows drive roots like `C:\`)
 *  - common system dirs (`/home`, `/root`, `/etc`, `/var`, `/usr`)
 *  - the process CWD (i.e. the project root)
 *  - paths whose final segment doesn't contain "baileys" — a positive marker
 *    for "this is meant to be a Baileys session dir", not a config mistake
 */
const FORBIDDEN_PREFIXES = ['/', '/home', '/root', '/etc', '/var', '/usr'];

export function assertSafeAuthDir(p: string): string {
  if (!p || p.trim() === '') {
    throw new Error('BAILEYS_AUTH_DIR is empty');
  }
  const abs = resolve(p);

  if (abs === '/' || /^[A-Z]:\\?$/i.test(abs)) {
    throw new Error(`refusing to use filesystem root as BAILEYS_AUTH_DIR (${abs})`);
  }

  for (const f of FORBIDDEN_PREFIXES) {
    if (abs === resolve(f)) {
      throw new Error(`refusing to use system path as BAILEYS_AUTH_DIR (${abs})`);
    }
  }

  if (abs === resolve(process.cwd())) {
    throw new Error(`refusing to use CWD as BAILEYS_AUTH_DIR (${abs})`);
  }

  // Positive marker: the path must contain a "baileys" segment somewhere.
  // Catches typos that resolve to /home/maia, /opt/data, etc.
  const segments = abs.split(sep);
  if (!segments.some((s) => s.toLowerCase().includes('baileys'))) {
    throw new Error(
      `BAILEYS_AUTH_DIR must contain a "baileys" path segment (got ${abs})`,
    );
  }

  return abs;
}
