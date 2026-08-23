/**
 * `maia doctor` — output contract and the redaction gate (issue #517 §4).
 *
 * The canary tests here are the ones that matter: a secret VALUE must not
 * survive into stdout, into the JSON, or into an evidence field — including
 * when the check that produced the string never intended to print it (the
 * realistic case is a forwarded driver message, which embeds the DSN).
 */
import { describe, it, expect } from 'vitest';
import {
  renderHuman,
  renderJson,
  redactOutcome,
  DOCTOR_SCHEMA_VERSION,
  type DoctorReportMeta,
} from '@/ops/doctor/report.js';
import { REDACTED } from '@/config/redact.js';
import { exitCodeFor, verdictFor } from '@/ops/doctor/runner.js';
import type { DoctorRun } from '@/ops/doctor/runner.js';
import type { DoctorCheckOutcome } from '@/ops/doctor/types.js';

/**
 * Deliberately low-entropy and repetitive so the repository's secret scanner
 * does not classify the fixture itself as a leak — `generic-api-key` cuts on
 * Shannon entropy > 3.5, and this string has eight distinct characters.
 */
const CANARY = 'canario-canario-canario-canario';

const meta: DoctorReportMeta = {
  run_id: 'run-0000',
  started_at: '2026-01-01T00:00:00.000Z',
  profile: 'production',
  app_version: '9.9.9',
  commit: 'abcdef1234567890',
  online: true,
  strict: false,
};

function summaryOf(checks: readonly DoctorCheckOutcome[]) {
  return {
    pass: checks.filter((c) => c.status === 'pass').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    skip: checks.filter((c) => c.status === 'skip').length,
  };
}

function outcome(over: Partial<DoctorCheckOutcome> = {}): DoctorCheckOutcome {
  return {
    id: 'x.y',
    category: 'runtime',
    criticality: 'blocker',
    status: 'pass',
    summary: 'tudo certo',
    duration_ms: 3,
    timed_out: false,
    ...over,
  };
}

function run(checks: DoctorCheckOutcome[], over: Partial<DoctorRun> = {}): DoctorRun {
  return {
    ok: verdictFor({ checks, summary: summaryOf(checks) }, false) === 'ready',
    checks,
    summary: summaryOf(checks),
    duration_ms: 11,
    timed_out: false,
    ...over,
  };
}

describe('maia doctor · redaction', () => {
  const env = { SMTP_PASS: CANARY };

  it('scrubs a secret VALUE out of the summary', () => {
    const dirty = outcome({ summary: `falhou ao autenticar com ${CANARY}` });
    const clean = redactOutcome(dirty, env);
    expect(clean.summary).not.toContain(CANARY);
    expect(clean.summary).toContain(REDACTED);
  });

  it('scrubs a secret out of EVERY evidence string and every remediation line', () => {
    const dirty = outcome({
      status: 'fail',
      evidence: { dsn: `smtp://user:${CANARY}@mail`, port: 587, tls: true },
      remediation: [`Troque ${CANARY} por um valor novo`],
    });
    const clean = redactOutcome(dirty, env);
    expect(String(clean.evidence?.dsn)).not.toContain(CANARY);
    expect(clean.evidence?.port).toBe(587);
    expect(clean.evidence?.tls).toBe(true);
    expect(clean.remediation?.[0]).not.toContain(CANARY);
  });

  it('the canary survives NEITHER the human render NOR the JSON render', () => {
    const r = run([
      outcome({
        status: 'fail',
        summary: `driver disse: connection to ${CANARY} refused`,
        evidence: { url: `redis://:${CANARY}@cache:6379` },
        remediation: [`Rotacione ${CANARY}`],
      }),
    ]);
    const human = renderHuman(r, meta, env);
    const json = renderJson(r, meta, env);
    expect(human).not.toContain(CANARY);
    expect(json).not.toContain(CANARY);
    expect(human).toContain(REDACTED);
    expect(JSON.parse(json)).toBeTruthy();
  });
});

describe('maia doctor · JSON contract', () => {
  it('carries a stable schema version and the run envelope', () => {
    const parsed = JSON.parse(
      renderJson(run([outcome()]), meta, {}),
    ) as Record<string, unknown>;
    expect(parsed.schema_version).toBe(DOCTOR_SCHEMA_VERSION);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'app_version',
        'checks',
        'commit',
        'duration_ms',
        'ok',
        'online',
        'profile',
        'run_id',
        'schema_version',
        'started_at',
        'strict',
        'summary',
        'timed_out',
        'verdict',
      ].sort(),
    );
  });

  it('carries the VERDICT, not just the boolean — `ok` cannot say "não respondido"', () => {
    const unproven = run([
      outcome({ id: 'postgres.connectivity', status: 'skip', summary: 'offline' }),
    ]);
    const parsed = JSON.parse(renderJson(unproven, meta, {})) as Record<string, unknown>;
    expect(parsed.verdict).toBe('incomplete');
    expect(parsed.ok).toBe(false);
  });

  it('the JSON verdict and the exit code are the SAME decision', () => {
    for (const [checks, strict] of [
      [[outcome({ status: 'warn' })], true],
      [[outcome({ status: 'skip' })], false],
      [[outcome({ status: 'fail' })], false],
      [[outcome()], false],
    ] as [DoctorCheckOutcome[], boolean][]) {
      const r = run(checks);
      const parsed = JSON.parse(renderJson(r, { ...meta, strict }, {})) as { verdict: string };
      expect(parsed.verdict, JSON.stringify(checks)).toBe(
        { 0: 'ready', 1: 'not_ready', 3: 'incomplete' }[exitCodeFor(r, strict)],
      );
    }
  });

  it('every check carries id, status, criticality, duration and remediation', () => {
    const parsed = JSON.parse(renderJson(run([outcome()]), meta, {})) as {
      checks: Record<string, unknown>[];
    };
    expect(Object.keys(parsed.checks[0]!).sort()).toEqual(
      [
        'category',
        'criticality',
        'duration_ms',
        'evidence',
        'id',
        'remediation',
        'skip_kind',
        'status',
        'summary',
        'timed_out',
      ].sort(),
    );
  });

  it('`skip_kind` defaults to `unproven` and is null for anything that is not a skip', () => {
    const parsed = JSON.parse(
      renderJson(
        run([
          outcome({ id: 'a.pass' }),
          outcome({ id: 'b.skip', status: 'skip', criticality: 'advisory' }),
          outcome({ id: 'c.na', status: 'skip', skip_kind: 'not_applicable' }),
        ]),
        meta,
        {},
      ),
    ) as { checks: { id: string; skip_kind: string | null }[] };
    expect(parsed.checks.map((c) => [c.id, c.skip_kind])).toEqual([
      ['a.pass', null],
      ['b.skip', 'unproven'],
      ['c.na', 'not_applicable'],
    ]);
  });

  it('is deterministic for the same run and meta', () => {
    const r = run([outcome(), outcome({ id: 'a.b', status: 'warn' })]);
    expect(renderJson(r, meta, {})).toBe(renderJson(r, meta, {}));
  });
});

describe('maia doctor · human format', () => {
  it('prints one [STATUS] id line per check, with duration', () => {
    const human = renderHuman(run([outcome({ id: 'postgres.connectivity', duration_ms: 18 })]), meta, {});
    expect(human).toMatch(/\[PASS] postgres\.connectivity\s+18ms/);
  });

  it('shows remediation for a failure and the NOT-READY verdict', () => {
    const human = renderHuman(
      run([outcome({ status: 'fail', summary: 'schema atrasado', remediation: ['rode o migrator'] })]),
      meta,
      {},
    );
    expect(human).toContain('[FAIL]');
    expect(human).toContain('Fix: rode o migrator');
    expect(human).toContain('NÃO PRONTO');
  });

  it('hides evidence of passing checks unless --verbose', () => {
    const r = run([outcome({ evidence: { latency_ms: 4 } })]);
    expect(renderHuman(r, meta, {})).not.toContain('latency_ms');
    expect(renderHuman(r, meta, {}, { verbose: true })).toContain('latency_ms');
  });

  it('under --strict a warning is announced as NOT ready', () => {
    const r = run([outcome({ status: 'warn', summary: 'policy frouxa' })]);
    expect(renderHuman(r, meta, {})).toContain('PRONTO');
    expect(renderHuman(r, { ...meta, strict: true }, {})).toContain('NÃO PRONTO');
  });

  /**
   * The regression this pins: `exitCodeFor` treated ANY advisory `fail` as
   * blocking under `--strict`, while `renderHuman` only ever looked at
   * `summary.warn`. `redis.persistence` is advisory and can `fail`, so the
   * shell got 1 while the last line of the report still read `PRONTO`.
   */
  it('an ADVISORY fail under --strict: the text and the exit code agree', () => {
    const r = run([
      outcome({ id: 'redis.persistence', status: 'fail', criticality: 'advisory', summary: 'AOF quebrado' }),
    ]);
    expect(exitCodeFor(r, true)).toBe(1);
    expect(renderHuman(r, { ...meta, strict: true }, {})).toContain('NÃO PRONTO');
    expect(renderHuman(r, { ...meta, strict: true }, {})).not.toMatch(/^PRONTO$/m);

    expect(exitCodeFor(r, false)).toBe(0);
    expect(renderHuman(r, meta, {})).toMatch(/^PRONTO$/m);
  });

  it('a skipped BLOCKER is announced INCOMPLETO and names the checks nobody exercised', () => {
    const r = run([
      outcome({ id: 'postgres.connectivity', status: 'skip', summary: 'requer rede' }),
      outcome({ id: 'redis.memory_pressure', status: 'skip', criticality: 'advisory' }),
    ]);
    const human = renderHuman(r, { ...meta, online: false }, {});
    expect(human).toContain('INCOMPLETO');
    expect(human).toContain('postgres.connectivity');
    // The advisory skip is not the reason and must not be blamed.
    expect(human).not.toContain('redis.memory_pressure —');
    expect(human).not.toMatch(/^PRONTO$/m);
    expect(exitCodeFor(r, false)).toBe(3);
  });

  it('a `not_applicable` skip on a blocker still reads PRONTO', () => {
    const r = run([
      outcome({ id: 'config.admin_boot_gates', status: 'skip', skip_kind: 'not_applicable' }),
    ]);
    expect(renderHuman(r, meta, {})).toMatch(/^PRONTO$/m);
    expect(exitCodeFor(r, false)).toBe(0);
  });
});
