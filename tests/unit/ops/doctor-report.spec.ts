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
    ok: checks.every((c) => !(c.status === 'fail' && c.criticality === 'blocker')),
    checks,
    summary: {
      pass: checks.filter((c) => c.status === 'pass').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      fail: checks.filter((c) => c.status === 'fail').length,
      skip: checks.filter((c) => c.status === 'skip').length,
    },
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
      ].sort(),
    );
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
        'status',
        'summary',
        'timed_out',
      ].sort(),
    );
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
});
