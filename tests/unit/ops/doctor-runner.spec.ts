/**
 * `maia doctor` — runner semantics (issue #517 §5).
 *
 * These are the rules a check author relies on and cannot see from inside a
 * check: what a deadline does, what an unavailable dependency does to the
 * checks behind it, what ORDER the report comes out in, and how a verdict
 * becomes an exit code.
 */
import { describe, it, expect } from 'vitest';
import {
  runDoctor,
  exitCodeFor,
  verdictFor,
  EXIT_CODE_BY_VERDICT,
  DEFAULT_TOTAL_DEADLINE_MS,
} from '@/ops/doctor/runner.js';
import type { DoctorCheck, DoctorContext, DoctorResult } from '@/ops/doctor/types.js';

function ctx(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    env: {},
    profile: 'production',
    service: 'runtime',
    online: true,
    migrationsDir: '/nonexistent',
    postgres: null,
    redis: null,
    schemaReadiness: null,
    ...overrides,
  };
}

function check(
  id: string,
  result: DoctorResult | (() => Promise<DoctorResult>),
  extra: Partial<DoctorCheck> = {},
): DoctorCheck {
  return {
    id,
    category: 'runtime',
    criticality: 'blocker',
    describes: id,
    deadlineMs: 50,
    requiresNetwork: false,
    run: typeof result === 'function' ? result : () => Promise.resolve(result),
    ...extra,
  };
}

const ok: DoctorResult = { status: 'pass', summary: 'ok' };

describe('maia doctor · runner', () => {
  it('reports in REGISTRY order, not completion order', async () => {
    const slowFirst = check('a.slow', async () => {
      await new Promise((r) => setTimeout(r, 20));
      return ok;
    });
    const fastSecond = check('b.fast', ok);
    const run = await runDoctor([slowFirst, fastSecond], ctx());
    expect(run.checks.map((c) => c.id)).toEqual(['a.slow', 'b.fast']);
  });

  it('a check that exceeds its own deadline FAILS as timed out, it does not hang', async () => {
    const hangs = check(
      'a.hangs',
      () => new Promise<DoctorResult>(() => {
        /* never settles */
      }),
      { deadlineMs: 20 },
    );
    const run = await runDoctor([hangs], ctx(), { totalDeadlineMs: 5_000 });
    expect(run.checks[0]?.status).toBe('fail');
    expect(run.checks[0]?.timed_out).toBe(true);
    expect(run.checks[0]?.evidence?.breached).toBe('check');
    expect(run.ok).toBe(false);
  });

  it('passes the abort signal INTO the check so a cooperative check can cancel', async () => {
    let sawAbort = false;
    const cooperative = check(
      'a.cooperative',
      (): Promise<DoctorResult> =>
        new Promise((resolve) => {
          // Resolve only via the signal, proving it actually fired.
          setTimeout(() => resolve(ok), 5_000);
        }),
      { deadlineMs: 20 },
    );
    const wrapped: DoctorCheck = {
      ...cooperative,
      run: (c, signal) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
        });
        return cooperative.run(c, signal);
      },
    };
    await runDoctor([wrapped], ctx(), { totalDeadlineMs: 5_000 });
    expect(sawAbort).toBe(true);
  });

  it('a check that THROWS becomes a typed fail carrying only the error class', async () => {
    const boom = check('a.boom', () => {
      const err = Object.assign(new Error('postgres://user:hunter2@db:5432/maia refused'), {
        code: 'ECONNREFUSED',
      });
      return Promise.reject(err);
    });
    const run = await runDoctor([boom], ctx());
    const outcome = run.checks[0]!;
    expect(outcome.status).toBe('fail');
    expect(outcome.evidence?.error_class).toBe('ECONNREFUSED');
    // The driver message — which embeds the DSN and its password — is nowhere.
    expect(JSON.stringify(outcome)).not.toContain('hunter2');
  });

  it('SKIPS a check whose dependency failed, and still runs the INDEPENDENT ones', async () => {
    const dead = check('pg.connect', { status: 'fail', summary: 'down' });
    const dependent = check('pg.version', ok, { dependsOn: ['pg.connect'] });
    const independent = check('redis.connect', ok);
    const run = await runDoctor([dead, dependent, independent], ctx());
    expect(run.checks.map((c) => [c.id, c.status])).toEqual([
      ['pg.connect', 'fail'],
      ['pg.version', 'skip'],
      ['redis.connect', 'pass'],
    ]);
  });

  it('a WARNING dependency still lets the dependent check run', async () => {
    const warned = check('a.warn', { status: 'warn', summary: 'meh' });
    const dependent = check('b.dep', ok, { dependsOn: ['a.warn'] });
    const run = await runDoctor([warned, dependent], ctx());
    expect(run.checks[1]?.status).toBe('pass');
  });

  it('offline mode SKIPS network checks instead of passing them', async () => {
    const networked = check('net.thing', ok, { requiresNetwork: true });
    const run = await runDoctor([networked], ctx({ online: false }));
    expect(run.checks[0]?.status).toBe('skip');
    expect(run.checks[0]?.evidence?.requires_network).toBe(true);
    // The point of the criterion: a skip is not a pass.
    expect(run.summary.pass).toBe(0);
    // …and, on a blocker, it is not neutral either: nothing was proved.
    expect(run.ok).toBe(false);
    expect(verdictFor(run, false)).toBe('incomplete');
    expect(exitCodeFor(run, false)).toBe(3);
  });

  it('`--skip` marks the check SKIP with a visible warning, never silent success', async () => {
    const c = check('a.disabled', ok);
    const run = await runDoctor([c], ctx(), { disabled: ['a.disabled'] });
    expect(run.checks[0]?.status).toBe('skip');
    expect(run.checks[0]?.summary).toContain('DESABILITADO');
    expect(run.checks[0]?.evidence?.disabled).toBe(true);
    // Disabling a BLOCKER cannot buy a green run.
    expect(exitCodeFor(run, false)).toBe(3);
  });

  it('an ADVISORY failure does not block the verdict; a BLOCKER failure does', async () => {
    const advisory = check('a.adv', { status: 'fail', summary: 'nope' }, {
      criticality: 'advisory',
    });
    const advisoryRun = await runDoctor([advisory], ctx());
    expect(advisoryRun.ok).toBe(true);
    expect(exitCodeFor(advisoryRun, false)).toBe(0);

    const blocker = check('a.blk', { status: 'fail', summary: 'nope' });
    const blockerRun = await runDoctor([blocker], ctx());
    expect(blockerRun.ok).toBe(false);
    expect(exitCodeFor(blockerRun, false)).toBe(1);
  });

  it('--strict turns warnings into exit 1 without changing `ok`', async () => {
    const warned = check('a.warn', { status: 'warn', summary: 'meh' });
    const run = await runDoctor([warned], ctx());
    expect(run.ok).toBe(true);
    expect(exitCodeFor(run, false)).toBe(0);
    expect(exitCodeFor(run, true)).toBe(1);
  });

  describe('o veredito INCOMPLETO — um bloqueador não exercido não é aprovação', () => {
    it('um BLOQUEADOR pulado impede `ok`, e sai 3 em vez de 0', async () => {
      const skipped = check('a.blk', { status: 'skip', summary: 'não deu' });
      const run = await runDoctor([skipped], ctx());
      expect(run.ok).toBe(false);
      expect(verdictFor(run, false)).toBe('incomplete');
      expect(exitCodeFor(run, false)).toBe(3);
    });

    it('um ADVISORY pulado não muda nada: não havia bloqueio para provar', async () => {
      const skipped = check('a.adv', { status: 'skip', summary: 'não aplicável' }, {
        criticality: 'advisory',
      });
      const run = await runDoctor([skipped, check('b.ok', ok)], ctx());
      expect(run.ok).toBe(true);
      expect(exitCodeFor(run, false)).toBe(0);
    });

    it('`not_applicable` é a ÚNICA saída de um bloqueador pulado, e é sobre o ambiente', async () => {
      const na = check('a.blk', {
        status: 'skip',
        summary: 'não há console aqui',
        skip_kind: 'not_applicable',
      });
      const run = await runDoctor([na], ctx());
      expect(verdictFor(run, false)).toBe('ready');
      expect(exitCodeFor(run, false)).toBe(0);
    });

    it('um bloqueador REPROVADO ganha do INCOMPLETO: sai 1, não 3', async () => {
      // A dependência morta faz os dependentes pularem; o veredito não pode
      // trocar "provamos que está quebrado" por "não conseguimos olhar".
      const dead = check('pg.connect', { status: 'fail', summary: 'down' });
      const dependent = check('pg.version', ok, { dependsOn: ['pg.connect'] });
      const run = await runDoctor([dead, dependent], ctx());
      expect(verdictFor(run, false)).toBe('not_ready');
      expect(exitCodeFor(run, false)).toBe(1);
    });

    it('o exit 2 continua fora deste mapa: ele é da CLI, não de um veredito', () => {
      expect(Object.values(EXIT_CODE_BY_VERDICT)).not.toContain(2);
      expect(EXIT_CODE_BY_VERDICT).toEqual({ ready: 0, incomplete: 3, not_ready: 1 });
    });
  });

  it('the TOTAL deadline stops the run and the unreached checks say so', async () => {
    const slow = check(
      'a.slow',
      () => new Promise<DoctorResult>(() => {
        /* never */
      }),
      { deadlineMs: 5_000 },
    );
    const never = check('b.never', ok, { dependsOn: ['a.slow'] });
    const run = await runDoctor([slow, never], ctx(), { totalDeadlineMs: 30 });
    expect(run.checks[0]?.timed_out).toBe(true);
    expect(run.checks[0]?.evidence?.breached).toBe('total');
    expect(run.timed_out).toBe(true);
  });

  it('refuses a registry with an unresolvable dependency instead of spinning', async () => {
    const a = check('a', ok, { dependsOn: ['b'] });
    const b = check('b', ok, { dependsOn: ['a'] });
    await expect(runDoctor([a, b], ctx())).rejects.toThrow(/não resolvível/);
  });

  it('counts every status and reports a total duration', async () => {
    const run = await runDoctor(
      [
        check('a', ok),
        check('b', { status: 'warn', summary: 'w' }),
        check('c', { status: 'fail', summary: 'f' }, { criticality: 'advisory' }),
        check('d', { status: 'skip', summary: 's' }),
      ],
      ctx(),
    );
    expect(run.summary).toEqual({ pass: 1, warn: 1, fail: 1, skip: 1 });
    expect(run.duration_ms).toBeGreaterThanOrEqual(0);
    expect(run.checks.every((c) => typeof c.duration_ms === 'number')).toBe(true);
  });

  it('the default total budget is conservative and finite', () => {
    expect(DEFAULT_TOTAL_DEADLINE_MS).toBeGreaterThan(0);
    expect(DEFAULT_TOTAL_DEADLINE_MS).toBeLessThanOrEqual(60_000);
  });
});
