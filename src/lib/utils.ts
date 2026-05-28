import { createHash, randomUUID } from 'node:crypto';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function uuid(): string {
  return randomUUID();
}

/**
 * Sleep for `ms` milliseconds. When `signal` is provided, the wait is
 * cancellable: an abort clears the timer and rejects with an AbortError-
 * shaped exception so callers can short-circuit instead of waiting the
 * full backoff out. Mirrors the `abortableSleep` pattern from
 * `src/lib/claude.ts` so retry loops elsewhere can reuse this helper
 * without each rolling its own timer/listener bookkeeping.
 *
 * If the signal is already aborted on entry, we reject synchronously
 * without scheduling any timer. The `name = 'AbortError'` on the rejected
 * Error matches what `AbortSignal.throwIfAborted()` emits, so callers
 * that use `err.name === 'AbortError'` discriminate cancellation from
 * generic failures (Issue #256 — KSM.revoke cancellation).
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('sleep_aborted', { cause: signal.reason });
      err.name = 'AbortError';
      reject(err);
      return;
    }
    let onAbort: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        const err = new Error('sleep_aborted', { cause: signal.reason });
        err.name = 'AbortError';
        reject(err);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function bucket5min(date: Date | number): string {
  return bucketMinutes(date, 5);
}

export function bucketMinutes(date: Date | number, minutes: number): string {
  const t = typeof date === 'number' ? date : date.getTime();
  const bucketMs = Math.max(1, minutes) * 60 * 1000;
  const aligned = Math.floor(t / bucketMs) * bucketMs;
  return new Date(aligned).toISOString();
}

export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = canonicalize(obj[k]);
  }
  return out;
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function trigramSet(s: string): Set<string> {
  const norm = '  ' + stripDiacritics(s.toLowerCase().trim()) + '  ';
  const grams = new Set<string>();
  for (let i = 0; i < norm.length - 2; i++) grams.add(norm.slice(i, i + 3));
  return grams;
}

export function trigramSim(a: string, b: string): number {
  const sa = trigramSet(a);
  const sb = trigramSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersect = 0;
  for (const g of sa) if (sb.has(g)) intersect++;
  const union = sa.size + sb.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

export class TypedError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'TypedError';
  }
}

export function assertNever(_x: never, msg = 'unexpected'): never {
  throw new TypedError('assertion_never', msg);
}
