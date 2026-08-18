/**
 * `maia doctor` — the check runner (issue #517 §5).
 *
 * Responsibilities, and nothing else: deadlines, dependency skipping, bounded
 * concurrency, deterministic ordering, and the overall verdict. It performs no
 * I/O of its own; every socket belongs to a check, through the narrow handles
 * on `DoctorContext`.
 *
 * ### Deadlines
 *
 * Two, and they compose. Each check carries its own `deadlineMs`; the run
 * carries a total. A check races against `AbortSignal.any([total, own])`, so
 * whichever fires first wins and the check is reported `fail` + `timed_out`
 * with the deadline that was breached in the evidence — never a silent hang
 * and never a `pass` inferred from "it did not complain".
 *
 * The signal is PASSED to the check, so a check that can cancel its own work
 * (a `pg` query with a statement timeout, an `AbortSignal`-aware fetch) does.
 * The race is what bounds the wall clock either way: a check that ignores its
 * signal still yields a verdict on time, it just leaves work running behind
 * it. That is acceptable for a read-only process that exits immediately after.
 *
 * ### Ordering
 *
 * Checks run with bounded concurrency (independent ones overlap — a dead
 * Redis must not add its full deadline to the Postgres answer), but the OUTPUT
 * is always sorted by registry order. Two runs against the same environment
 * produce byte-identical reports modulo durations and `run_id`.
 *
 * ### Verdict
 *
 * `fail` on a `blocker` check ⇒ not ready. `fail` on an `advisory` check is
 * reported as-is but counted as a warning. `skip` never makes a run ready that
 * would otherwise not be, and never makes one unready either — it is the
 * honest "not answered" that the issue asks for instead of a false success.
 */
import type {
  DoctorCheck,
  DoctorCheckOutcome,
  DoctorContext,
  DoctorResult,
  DoctorStatus,
} from './types.js';

/** Default per-check deadline when a check does not set one. */
export const DEFAULT_CHECK_DEADLINE_MS = 5_000;

/** Default budget for the whole run. Conservative: a doctor must return. */
export const DEFAULT_TOTAL_DEADLINE_MS = 30_000;

/** How many checks may be in flight at once. */
export const DEFAULT_CONCURRENCY = 4;

export interface DoctorRunOptions {
  readonly totalDeadlineMs?: number;
  readonly concurrency?: number;
  /** Check ids the operator disabled explicitly (`--skip`). */
  readonly disabled?: readonly string[];
  /** Injected clock, in milliseconds. Defaults to `performance.now()`. */
  readonly now?: () => number;
}

export interface DoctorRunSummary {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly skip: number;
}

export interface DoctorRun {
  /** `true` when no blocker failed. Warnings do not clear this flag. */
  readonly ok: boolean;
  readonly checks: readonly DoctorCheckOutcome[];
  readonly summary: DoctorRunSummary;
  readonly duration_ms: number;
  /** `true` when the TOTAL deadline fired, so some checks never ran. */
  readonly timed_out: boolean;
}

/** Statuses that let a dependent check proceed. */
const SATISFIED: ReadonlySet<DoctorStatus> = new Set<DoctorStatus>(['pass', 'warn']);

function outcome(
  check: DoctorCheck,
  result: DoctorResult,
  durationMs: number,
  timedOut = false,
): DoctorCheckOutcome {
  return {
    id: check.id,
    category: check.category,
    criticality: check.criticality,
    duration_ms: Math.round(durationMs),
    timed_out: timedOut,
    ...result,
  };
}

/**
 * Error CLASS only, never the message.
 *
 * A `pg` error message embeds the connection string (password included) and an
 * ioredis one embeds host:port. The issue's invariant is explicit: "falha de um
 * adapter vira resultado tipado, não stack trace com dados sensíveis".
 */
export function errorClass(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  if (err instanceof Error) return err.constructor.name;
  return 'UnknownError';
}

/**
 * Run one check under its deadline. Never throws: a check that throws becomes
 * a typed `fail` carrying only the error class.
 */
async function runOne(
  check: DoctorCheck,
  ctx: DoctorContext,
  total: AbortSignal,
  now: () => number,
): Promise<DoctorCheckOutcome> {
  const started = now();
  const deadlineMs = check.deadlineMs > 0 ? check.deadlineMs : DEFAULT_CHECK_DEADLINE_MS;

  if (total.aborted) {
    return outcome(
      check,
      {
        status: 'fail',
        summary: `não executado: o orçamento total do doctor acabou antes deste check`,
        evidence: { check_deadline_ms: deadlineMs },
        remediation: [
          'Aumente o orçamento total com `--timeout <ms>`, ou reduza o conjunto com `--only <categoria>`.',
        ],
      },
      0,
      true,
    );
  }

  const own = AbortSignal.timeout(deadlineMs);
  const signal = AbortSignal.any([total, own]);

  const finished = await Promise.race([
    check
      .run(ctx, signal)
      .then((result) => ({ kind: 'result' as const, result }))
      .catch((err: unknown) => ({ kind: 'threw' as const, err })),
    new Promise<{ kind: 'aborted' }>((resolve) => {
      if (signal.aborted) {
        resolve({ kind: 'aborted' });
        return;
      }
      signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
    }),
  ]);

  const duration = now() - started;

  if (finished.kind === 'aborted') {
    const totalFired = total.aborted;
    return outcome(
      check,
      {
        status: 'fail',
        summary: totalFired
          ? 'interrompido: o orçamento TOTAL do doctor foi atingido'
          : `deadline de ${deadlineMs}ms atingido sem resposta`,
        evidence: {
          check_deadline_ms: deadlineMs,
          breached: totalFired ? 'total' : 'check',
        },
        remediation: [
          totalFired
            ? 'Aumente `--timeout <ms>` ou rode menos categorias com `--only`.'
            : `O alvo não respondeu em ${deadlineMs}ms. Verifique latência de rede, saturação do serviço e regras de firewall.`,
        ],
      },
      duration,
      true,
    );
  }

  if (finished.kind === 'threw') {
    return outcome(
      check,
      {
        status: 'fail',
        summary: `o check lançou (${errorClass(finished.err)})`,
        evidence: { error_class: errorClass(finished.err) },
        remediation: [
          'Rode com `--verbose` para o detalhe redigido e verifique o serviço alvo.',
        ],
      },
      duration,
    );
  }

  return outcome(check, finished.result, duration);
}

/**
 * Execute the registry.
 *
 * Dependencies are honoured by WAVES: a check whose `dependsOn` is not yet
 * decided waits; once its dependencies are decided, it either runs or is
 * skipped. Within a wave, checks run with bounded concurrency.
 */
export async function runDoctor(
  checks: readonly DoctorCheck[],
  ctx: DoctorContext,
  options: DoctorRunOptions = {},
): Promise<DoctorRun> {
  const now = options.now ?? (() => performance.now());
  const totalMs = options.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const disabled = new Set(options.disabled ?? []);
  const started = now();
  const total = AbortSignal.timeout(totalMs);

  const order = new Map(checks.map((c, i) => [c.id, i]));
  const decided = new Map<string, DoctorCheckOutcome>();
  let remaining = checks.filter((c) => !decided.has(c.id));

  while (remaining.length > 0) {
    const ready: DoctorCheck[] = [];
    const blocked: DoctorCheck[] = [];
    for (const check of remaining) {
      const deps = check.dependsOn ?? [];
      if (deps.every((d) => decided.has(d) || !order.has(d))) ready.push(check);
      else blocked.push(check);
    }

    // A dependency cycle (or a reference to a check that is not in the
    // registry AND never decides) would spin forever. Fail loudly instead:
    // this is a programming error in the registry, not an environment state.
    if (ready.length === 0) {
      throw new Error(
        `doctor: dependência não resolvível entre os checks: ${blocked.map((c) => c.id).join(', ')}`,
      );
    }

    const wave: DoctorCheckOutcome[] = [];
    for (let i = 0; i < ready.length; i += concurrency) {
      const slice = ready.slice(i, i + concurrency);
      const done = await Promise.all(
        slice.map(async (check): Promise<DoctorCheckOutcome> => {
          if (disabled.has(check.id)) {
            return outcome(
              check,
              {
                status: 'skip',
                summary: 'DESABILITADO explicitamente por `--skip` — nada foi verificado aqui',
                evidence: { disabled: true },
              },
              0,
            );
          }
          const unmet = (check.dependsOn ?? []).filter((d) => {
            const dep = decided.get(d);
            return dep === undefined || !SATISFIED.has(dep.status);
          });
          if (unmet.length > 0) {
            return outcome(
              check,
              {
                status: 'skip',
                summary: `depende de ${unmet.join(', ')}, que não passou`,
                evidence: { unmet_dependencies: unmet.join(',') },
              },
              0,
            );
          }
          if (check.requiresNetwork && !ctx.online) {
            return outcome(
              check,
              {
                status: 'skip',
                summary: 'requer rede; o modo offline não abre conexão alguma',
                evidence: { requires_network: true },
                remediation: ['Rode com `--online` para exercer este check.'],
              },
              0,
            );
          }
          return runOne(check, ctx, total, now);
        }),
      );
      wave.push(...done);
    }

    for (const o of wave) decided.set(o.id, o);
    remaining = checks.filter((c) => !decided.has(c.id));
  }

  const results = [...decided.values()].sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );

  const summary: DoctorRunSummary = {
    pass: results.filter((r) => r.status === 'pass').length,
    warn: results.filter((r) => r.status === 'warn').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skip: results.filter((r) => r.status === 'skip').length,
  };

  const blockerFailed = results.some((r) => r.status === 'fail' && r.criticality === 'blocker');

  return {
    ok: !blockerFailed,
    checks: results,
    summary,
    duration_ms: Math.round(now() - started),
    timed_out: results.some((r) => r.timed_out),
  };
}

/**
 * Exit code contract (issue §4). `2` is NOT produced here — it belongs to the
 * CLI and means "invalid usage or the doctor itself broke", which must never be
 * confused with "the environment is unhealthy".
 */
export function exitCodeFor(run: DoctorRun, strict: boolean): 0 | 1 {
  if (!run.ok) return 1;
  if (strict && (run.summary.warn > 0 || run.summary.fail > 0)) return 1;
  return 0;
}
