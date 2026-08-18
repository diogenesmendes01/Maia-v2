/**
 * `maia doctor` — rendering, and the LAST redaction gate (issue #517 §4).
 *
 * Everything the operator ever sees goes through `redactOutcome()` here, which
 * runs `scrubSecrets()` (`src/config/redact.ts`) over every string a check
 * produced: summary, evidence values and remediation lines. Checks are written
 * never to interpolate a secret in the first place; this is defence in depth,
 * because the thing that leaks is not the string we wrote, it is the driver
 * message we forwarded (`pg` embeds the whole DSN, password included, in
 * `error.message`).
 *
 * Two consequences worth stating, since a future check author will hit them:
 *
 *   1. Redaction is by VALUE, from the environment snapshot, not by variable
 *      name. Any contract secret present in `env` is replaced wherever it
 *      appears, including inside a URL we did not build.
 *   2. `scrubSecrets` skips values shorter than 4 chars — replacing those
 *      would mangle unrelated text without protecting anything. A 3-character
 *      "secret" is not a secret.
 *
 * The JSON contract carries `schema_version` and is additive-only: consumers
 * pin the major, and a new field never renames or removes an existing one.
 */
import { scrubSecrets } from '@/config/redact.js';
import type { DoctorCheckOutcome, DoctorStatus } from './types.js';
import type { DoctorRun } from './runner.js';

/**
 * Version of the JSON contract below.
 *
 * Bump the MAJOR when an existing field changes meaning or disappears; bump
 * the MINOR when a field is added. `tests/unit/ops/doctor-report.spec.ts` pins
 * the shape so a change here cannot land silently.
 */
export const DOCTOR_SCHEMA_VERSION = '1.0';

export interface DoctorReportMeta {
  /** Random per-run id, for correlating a human report with its JSON. */
  readonly run_id: string;
  readonly started_at: string;
  readonly profile: string;
  readonly app_version: string;
  readonly commit: string | null;
  readonly online: boolean;
  readonly strict: boolean;
}

const STATUS_LABEL: Record<DoctorStatus, string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skip: 'SKIP',
};

/** Scrub every operator-visible string of a single outcome. */
export function redactOutcome(
  outcome: DoctorCheckOutcome,
  env: Readonly<Record<string, string | undefined>>,
): DoctorCheckOutcome {
  const snapshot = env as Record<string, string | undefined>;
  const evidence = outcome.evidence
    ? Object.fromEntries(
        Object.entries(outcome.evidence).map(([k, v]) => [
          k,
          typeof v === 'string' ? scrubSecrets(v, snapshot) : v,
        ]),
      )
    : undefined;
  return {
    ...outcome,
    summary: scrubSecrets(outcome.summary, snapshot),
    ...(evidence ? { evidence } : {}),
    ...(outcome.remediation
      ? { remediation: outcome.remediation.map((r) => scrubSecrets(r, snapshot)) }
      : {}),
  };
}

function redactRun(run: DoctorRun, env: Readonly<Record<string, string | undefined>>): DoctorRun {
  return { ...run, checks: run.checks.map((c) => redactOutcome(c, env)) };
}

/**
 * Human format. Stable and greppable: one `[STATUS] id` line per check, with
 * evidence and remediation indented beneath. Durations are printed for every
 * check and for the run (issue: "a duração de cada check e a duração total são
 * reportadas").
 */
export function renderHuman(
  run: DoctorRun,
  meta: DoctorReportMeta,
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly verbose?: boolean } = {},
): string {
  const safe = redactRun(run, env);
  const lines: string[] = [];
  lines.push(
    `maia doctor — profile ${meta.profile} · v${meta.app_version}` +
      `${meta.commit ? ` · ${meta.commit.slice(0, 12)}` : ''} · ${meta.online ? 'online' : 'offline'}`,
  );
  lines.push(`run_id ${meta.run_id}`);
  lines.push('');

  for (const c of safe.checks) {
    const label = STATUS_LABEL[c.status];
    const duration = `${c.duration_ms}ms`;
    lines.push(`[${label}] ${c.id.padEnd(34)} ${duration.padStart(7)}  ${c.summary}`);
    const showEvidence = c.status !== 'pass' || options.verbose === true;
    if (showEvidence && c.evidence) {
      for (const [k, v] of Object.entries(c.evidence)) lines.push(`       ${k}: ${String(v)}`);
    }
    for (const r of c.remediation ?? []) lines.push(`       Fix: ${r}`);
  }

  lines.push('');
  lines.push(
    `${safe.summary.pass} pass · ${safe.summary.warn} warn · ${safe.summary.fail} fail · ` +
      `${safe.summary.skip} skip — ${safe.duration_ms}ms`,
  );
  if (safe.timed_out) {
    lines.push('ATENÇÃO: pelo menos um check estourou o deadline; o diagnóstico está incompleto.');
  }
  const verdict = safe.ok
    ? meta.strict && safe.summary.warn > 0
      ? 'NÃO PRONTO (--strict: warnings contam como bloqueio)'
      : 'PRONTO'
    : 'NÃO PRONTO — há bloqueador';
  lines.push(verdict);
  return lines.join('\n');
}

/** The versioned JSON contract. */
export function renderJson(
  run: DoctorRun,
  meta: DoctorReportMeta,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const safe = redactRun(run, env);
  return `${JSON.stringify(
    {
      schema_version: DOCTOR_SCHEMA_VERSION,
      run_id: meta.run_id,
      started_at: meta.started_at,
      profile: meta.profile,
      app_version: meta.app_version,
      commit: meta.commit,
      online: meta.online,
      strict: meta.strict,
      ok: safe.ok,
      timed_out: safe.timed_out,
      duration_ms: safe.duration_ms,
      summary: safe.summary,
      checks: safe.checks.map((c) => ({
        id: c.id,
        category: c.category,
        criticality: c.criticality,
        status: c.status,
        summary: c.summary,
        duration_ms: c.duration_ms,
        timed_out: c.timed_out,
        evidence: c.evidence ?? null,
        remediation: c.remediation ?? [],
      })),
    },
    null,
    2,
  )}\n`;
}
