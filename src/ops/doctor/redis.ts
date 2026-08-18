/**
 * `maia doctor` — the read-only Redis handle (issue #517 §2).
 *
 * Redis has no per-connection read-only mode we can switch on (`replica-read-only`
 * is a server role, not a client flag), so the guarantee here is a CLOSED
 * ALLOWLIST: a command outside `DOCTOR_REDIS_ALLOWED` throws before it reaches
 * the socket. That is weaker than the Postgres guarantee — it is our code
 * refusing, not the server — so the list is deliberately tiny and includes the
 * SUBCOMMAND where the subcommand is what makes the difference:
 * `CONFIG GET` reads, `CONFIG SET` writes, and only the first is spelled here.
 *
 * The doctor therefore never runs a canary `SET`/`DEL` to prove connectivity,
 * which is what a naive liveness check does and what the issue forbids
 * ("nenhuma escrita de teste").
 */
import type { DoctorRedis } from './types.js';

/**
 * Commands the doctor may issue. Multi-word entries are `COMMAND|SUBCOMMAND`
 * and are matched on both tokens.
 *
 * Adding to this list is a review-worthy change: every entry must be
 * observably free of side effects on the server. `DBSIZE` and `INFO` are;
 * `CLIENT SETNAME`, `MEMORY DOCTOR` (which can allocate) and anything under
 * `SCRIPT` are not, and are absent on purpose.
 */
export const DOCTOR_REDIS_ALLOWED: ReadonlySet<string> = new Set([
  'PING',
  'INFO',
  'DBSIZE',
  'CONFIG|GET',
]);

export interface RedisCommandClient {
  /** ioredis' generic command entry point. */
  call(command: string, ...args: string[]): Promise<unknown>;
}

export class RedisCommandNotAllowedError extends Error {
  readonly code = 'DOCTOR_REDIS_COMMAND_NOT_ALLOWED';
  constructor(command: string) {
    super(
      `maia doctor is read-only: the command "${command}" is not in the doctor allowlist ` +
        `(${[...DOCTOR_REDIS_ALLOWED].join(', ')}).`,
    );
    this.name = 'RedisCommandNotAllowedError';
  }
}

/** `PING` → `PING`; `CONFIG GET x` → `CONFIG|GET`. */
export function allowlistKey(command: string, args: readonly string[]): string {
  const head = command.toUpperCase();
  if (head === 'CONFIG') return `CONFIG|${(args[0] ?? '').toUpperCase()}`;
  return head;
}

/** Throws `RedisCommandNotAllowedError` for anything outside the allowlist. */
export function assertRedisCommandAllowed(command: string, args: readonly string[]): void {
  const key = allowlistKey(command, args);
  if (!DOCTOR_REDIS_ALLOWED.has(key)) throw new RedisCommandNotAllowedError(key);
}

export interface ReadOnlyRedisOptions {
  /**
   * Supplies the class of the last transport error the caller observed on the
   * client's `error` event. See `DoctorRedis.lastErrorClass`.
   */
  readonly lastErrorClass?: () => string | null;
}

/** Wrap a client into the narrow read-only handle checks receive. */
export function readOnlyRedis(
  client: RedisCommandClient,
  options: ReadOnlyRedisOptions = {},
): DoctorRedis {
  async function call(command: string, ...args: string[]): Promise<unknown> {
    assertRedisCommandAllowed(command, args);
    return client.call(command, ...args);
  }
  return {
    lastErrorClass: () => options.lastErrorClass?.() ?? null,
    async ping(): Promise<string> {
      return String(await call('PING'));
    },
    async info(section?: string): Promise<string> {
      return String(section ? await call('INFO', section) : await call('INFO'));
    },
    async configGet(parameter: string): Promise<Readonly<Record<string, string>>> {
      const raw = await call('CONFIG', 'GET', parameter);
      // RESP2 returns a flat [k, v, k, v]; RESP3 returns a map object.
      if (Array.isArray(raw)) {
        const out: Record<string, string> = {};
        for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
        return out;
      }
      if (raw && typeof raw === 'object') {
        return Object.fromEntries(
          Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
        );
      }
      return {};
    },
  };
}

/**
 * Parse an `INFO` payload into a flat map. Section headers (`# Memory`) and
 * blank lines are dropped; the format is `key:value` per line, CRLF-separated.
 */
export function parseRedisInfo(text: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}
