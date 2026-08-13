/**
 * Issue #514 §9 — drift guard between the committed alert rules and the code
 * that actually emits the metrics.
 *
 * An alert that references a metric nobody emits is worse than no alert: it
 * looks like coverage and fires never. This spec fails the build when the two
 * drift apart.
 *
 * Parsed with a regex rather than a YAML library on purpose — `yaml` is only a
 * transitive dependency here, and this issue is not allowed to add one.
 *
 * ISSUE #536 — WHY THIS SCANS A DIRECTORY NOW. The guard was pinned to
 * `monitoring/alerts/slo.rules.yml`. `monitoring/alerts/` then grew three more
 * rule files, and every one of them was outside the guard's reach: a new file
 * could point an alert at a series nobody emits and the suite stayed green —
 * exactly the `maia_llm_calls_total{reason="rate_limit"}` failure this guard
 * was written for, just in a file it was not looking at. The metric check now
 * walks EVERY `*.yml` under `monitoring/alerts/`; a rule file that does not
 * exist yet is covered the day it is added, with no edit here.
 *
 * The checks that encode SLO-specific semantics (turn-counter denominators,
 * queue aggregation, burn rates) stay scoped to `slo.rules.yml`, because they
 * are statements about those rules, not about alert files in general.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { METRIC_NAMES } from '../../../src/observability/taxonomy.js';

const ROOT = resolve(__dirname, '../../..');
const ALERTS_DIR = resolve(ROOT, 'monitoring/alerts');
const RUNBOOK_PATH = resolve(ROOT, 'docs/runbooks/observability-slo.md');

/** Every committed rule file, by basename. */
const RULE_FILES: readonly string[] = readdirSync(ALERTS_DIR)
  .filter((f) => f.endsWith('.yml'))
  .sort();

const RULE_TEXT: Record<string, string> = Object.fromEntries(
  RULE_FILES.map((f) => [f, readFileSync(resolve(ALERTS_DIR, f), 'utf8')]),
);

/**
 * Rule files whose alerts must be narrated in a runbook, and where.
 *
 * A MAP rather than a derivation from each alert's own link: six alerts in
 * `redis.rules.yml` / `working-memory.rules.yml` predate this rule and would
 * fail it today. Widening the map is the cleanup that fixes them — and it is a
 * one-line change per file, which is the point of writing it as data.
 */
const RULES_TO_RUNBOOK: Record<string, string> = {
  'slo.rules.yml': 'docs/runbooks/observability-slo.md',
  'backup.rules.yml': 'docs/runbooks/backup-restore.md',
};

/** The SLO rules specifically — the subject of every `slo.rules.yml` check below. */
const rules = RULE_TEXT['slo.rules.yml']!;

/**
 * `maia_*` metrics emitted OUTSIDE the #514 taxonomy but genuinely present in
 * the codebase. Each entry names its emitter so a future reader can verify the
 * claim instead of trusting the list.
 */
const PRE_EXISTING_METRICS: Record<string, string> = {
  // Emitida direto por `incCounter` em `src/lib/llm/telemetry.ts` — a camada
  // crua, que não passa pelo gate de rótulos da taxonomia. Entrou nas regras
  // quando `MaiaLlmRateLimited` deixou de casar a série legada
  // `maia_llm_calls_total{reason=...}`, que nunca teve `reason` (rodada 3 da
  // review da PR #541).
  maia_llm_requests_total: 'src/lib/llm/telemetry.ts:110',
  maia_audit_events_total: 'src/governance/audit.ts:58',
  maia_audit_write_failed_total: 'src/governance/audit.ts:83',
  maia_tenant_id_default_literal_total: 'src/db/tenant-context.ts:260',
  maia_runtime_trace_envelope_write_failed_total:
    'src/control-plane/runtime-trace/envelope-writer.ts:131',
  maia_baileys_connected: 'src/server.ts:21',
  maia_db_connected: 'src/server.ts:22',
};

/**
 * Every `maia_*` token referenced by the rules, minus Prometheus suffixes.
 *
 * `- name:` lines are skipped: those are GROUP names (`maia_slo_queue`), not
 * metric references. Recording-rule names use the `maia:` namespace rather
 * than `maia_`, so they never collide with a metric name.
 */
function referencedMetrics(text: string): string[] {
  const found = new Set<string>();
  const body = text
    .split('\n')
    .filter((line) => !/^\s*-?\s*name:/.test(line))
    .join('\n');
  for (const m of body.matchAll(/\bmaia_[a-z0-9_]+/g)) {
    const raw = m[0];
    found.add(raw.replace(/_(bucket|sum|count)$/, ''));
  }
  return [...found];
}

describe('issue #514 — SLO rules ↔ code drift guard', () => {
  it('the rules file is present and non-trivial', () => {
    expect(rules.length).toBeGreaterThan(1000);
    expect(rules).toContain('groups:');
  });

  it('every metric the rules reference is actually emitted somewhere', () => {
    const known = new Set<string>([...METRIC_NAMES, ...Object.keys(PRE_EXISTING_METRICS)]);
    const unknown = referencedMetrics(rules).filter((m) => !known.has(m));
    expect(
      unknown,
      `rules reference metrics that nothing emits: ${unknown.join(', ')}`,
    ).toEqual([]);
  });

  it('every alert declares a severity and points at a runbook', () => {
    const alerts = [...rules.matchAll(/- alert: (\w+)/g)].map((m) => m[1]!);
    expect(alerts.length).toBeGreaterThan(10);

    // Split the file per alert block so a missing field is attributed.
    const blocks = rules.split(/- alert: /).slice(1);
    expect(blocks).toHaveLength(alerts.length);
    for (const [i, block] of blocks.entries()) {
      expect(block, `alert ${alerts[i]} has no severity`).toMatch(/severity: (critical|warning)/);
      expect(block, `alert ${alerts[i]} has no runbook link`).toContain('docs/runbooks/');
    }
  });

  it('every alert name is unique', () => {
    const alerts = [...rules.matchAll(/- alert: (\w+)/g)].map((m) => m[1]!);
    expect(new Set(alerts).size).toBe(alerts.length);
  });

  it('covers the alert families the issue requires', () => {
    for (const needle of [
      'MaiaTurnFailureRate', // turn failure rate
      'MaiaQueueOldestJobAge', // oldest queue age
      'MaiaLlmRateLimited', // provider rate limit
      'MaiaWhatsAppDisconnected', // whatsapp disconnected
      'MaiaAuditWriteFailing', // audit write failure
      'MaiaTraceEnvelopeWriteFailing', // trace envelope failure
      'MaiaDlqGrowing', // DLQ growth
      'MaiaErrorBudgetFastBurn', // fast burn
      'MaiaErrorBudgetSlowBurn', // slow burn
    ]) {
      expect(rules, `missing alert family ${needle}`).toContain(needle);
    }
  });

  it('queue gauges aggregate with max, never sum (multi-replica correctness)', () => {
    // Summing a shared-queue gauge multiplies the backlog by the replica count.
    expect(rules).toMatch(/max by \(queue\) \(maia_queue_oldest_job_age_ms\)/);
    expect(rules).not.toMatch(/sum\s*(by\s*\([^)]*\)\s*)?\(maia_queue_oldest_job_age_ms/);
    expect(rules).not.toMatch(/sum\s*(by\s*\([^)]*\)\s*)?\(maia_queue_depth/);
  });

  it('ratio rules guard against divide-by-zero', () => {
    // Without clamp_min, a quiet period turns 0/0 into NaN and the alert
    // silently stops evaluating.
    const ratioRecords = [...rules.matchAll(/- record: (maia:[a-z_0-9:]*ratio[a-z_0-9:]*)/g)];
    expect(ratioRecords.length).toBeGreaterThan(0);
    const clamps = [...rules.matchAll(/clamp_min\(/g)];
    expect(clamps.length).toBeGreaterThanOrEqual(ratioRecords.length);
  });

  describe('SLIs count TERMINAL outcomes only [P2]', () => {
    // `maia_turn_completed_total` is emitted per ATTEMPT. Counting `retryable`
    // in a denominator makes one turn look like several: two retries then
    // success rendered as 3 observations / 33% success. Every aggregation over
    // this counter must therefore either select a specific outcome or filter
    // to the terminal set.
    const TERMINAL_FILTER = 'outcome=~"completed|failed"';

    /**
     * Every `maia_turn_completed_total{...}` selector in EXECUTABLE lines.
     * YAML `#` comments are stripped first — the rationale block above the
     * rules names the metric in prose, and that is not a query.
     */
    function selectors(): string[] {
      const code = rules
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n');
      return [...code.matchAll(/maia_turn_completed_total(\{[^}]*\})?/g)].map(
        (m) => m[1] ?? '',
      );
    }

    it('no selector aggregates the counter without an outcome filter', () => {
      const bare = selectors().filter((s) => !s.includes('outcome'));
      expect(
        bare,
        'maia_turn_completed_total used with no outcome filter — retryable attempts ' +
          'would inflate the denominator',
      ).toEqual([]);
    });

    it('every denominator uses the terminal set', () => {
      // A denominator is the selector inside clamp_min(...).
      const denominators = [...rules.matchAll(/clamp_min\(([\s\S]*?)\), 1e-9\)/g)]
        .map((m) => m[1]!)
        .filter((d) => d.includes('maia_turn_completed_total'));
      expect(denominators.length).toBeGreaterThanOrEqual(4);
      for (const d of denominators) {
        expect(d, `denominator missing the terminal filter: ${d.trim()}`).toContain(
          TERMINAL_FILTER,
        );
      }
    });

    it('retryable is tracked as its OWN sli, not folded into failures', () => {
      expect(rules).toContain('maia:turn_retry_ratio:rate5m');
      expect(rules).toMatch(/maia_turn_completed_total\{outcome="retryable"\}/);
      // …and never as a numerator of the failure ratio.
      const failureBlock = rules.slice(
        rules.indexOf('- record: maia:turn_failure_ratio:rate5m'),
        rules.indexOf('- record: maia:turn_failure_ratio:rate5m:by_tenant'),
      );
      expect(failureBlock).not.toContain('retryable"}[5m]))\n          /');
    });

    it('burn-rate rules use the same terminal denominator as the SLIs', () => {
      const burnBlock = rules.slice(rules.indexOf('maia:turn_error_budget_burn:1h'));
      const burnDenoms = [...burnBlock.matchAll(/clamp_min\(([\s\S]*?)\), 1e-9\)/g)].map(
        (m) => m[1]!,
      );
      expect(burnDenoms.length).toBeGreaterThanOrEqual(2);
      for (const d of burnDenoms) expect(d).toContain(TERMINAL_FILTER);
    });

    it('latency percentiles are computed over COMPLETED turns only', () => {
      // A failed turn never replied (time-to-failure is not latency) and a
      // retryable attempt is a partial attempt.
      const buckets = [...rules.matchAll(/maia_turn_e2e_latency_ms_bucket(\{[^}]*\})?/g)].map(
        (m) => m[1] ?? '',
      );
      expect(buckets.length).toBeGreaterThanOrEqual(2);
      for (const b of buckets) expect(b).toContain('outcome="completed"');
    });
  });

  it('the runbook documents every alert the rules define', () => {
    const runbook = readFileSync(RUNBOOK_PATH, 'utf8');
    const alerts = [...rules.matchAll(/- alert: (\w+)/g)].map((m) => m[1]!);
    const undocumented = alerts.filter((a) => !runbook.includes(a));
    expect(
      undocumented,
      `alerts with no operator guidance: ${undocumented.join(', ')}`,
    ).toEqual([]);
  });

  it('no alert leaks a high-cardinality id through an annotation template', () => {
    for (const forbidden of ['$labels.trace_id', '$labels.conversa_id', '$labels.telefone']) {
      expect(rules).not.toContain(forbidden);
    }
  });
});

/**
 * Issue #536 — the same guard, over EVERY committed rule file.
 *
 * The block above is about `slo.rules.yml` and its SLO semantics. This one is
 * about the property that must hold for any alert file the repository ships,
 * including files that do not exist yet: what an alert queries has to be
 * something the code emits.
 */
describe('issue #536 — every committed alert file is under the drift guard', () => {
  /** Names of every alert in `file`, in declaration order. */
  function alertsIn(file: string): string[] {
    return [...RULE_TEXT[file]!.matchAll(/- alert: (\w+)/g)].map((m) => m[1]!);
  }

  it('the scan actually finds the rule files (a broken glob must not pass silently)', () => {
    // Without this, a renamed directory would make every check below iterate an
    // empty list and report success — the exact shape of failure this guard
    // exists to prevent, one level up.
    expect(RULE_FILES.length).toBeGreaterThanOrEqual(4);
    expect(RULE_FILES).toContain('slo.rules.yml');
    for (const file of RULE_FILES) {
      expect(RULE_TEXT[file], `${file} is empty`).toContain('groups:');
    }
  });

  it('every metric referenced by ANY alert file is actually emitted', () => {
    const known = new Set<string>([...METRIC_NAMES, ...Object.keys(PRE_EXISTING_METRICS)]);
    const unknown: string[] = [];
    for (const file of RULE_FILES) {
      for (const metric of referencedMetrics(RULE_TEXT[file]!)) {
        if (!known.has(metric)) unknown.push(`${file}: ${metric}`);
      }
    }
    expect(
      unknown,
      'alert files reference metrics that nothing emits — add the series to ' +
        'METRIC (src/observability/taxonomy.ts) or, if it is emitted outside the ' +
        'taxonomy, to PRE_EXISTING_METRICS WITH its emitter at file:line: ' +
        unknown.join(', '),
    ).toEqual([]);
  });

  it('every alert name is unique across ALL files, not just within one', () => {
    // Prometheus loads every rule file into one namespace; two alerts sharing a
    // name make a firing alert unattributable to the rule that produced it.
    const all = RULE_FILES.flatMap(alertsIn);
    const seen = new Set<string>();
    const duplicated = all.filter((a) => {
      if (seen.has(a)) return true;
      seen.add(a);
      return false;
    });
    expect(duplicated, `alert names defined twice: ${duplicated.join(', ')}`).toEqual([]);
    expect(all.length).toBeGreaterThan(30);
  });

  it('no alert file leaks a high-cardinality id through an annotation template', () => {
    for (const file of RULE_FILES) {
      for (const forbidden of ['$labels.trace_id', '$labels.conversa_id', '$labels.telefone']) {
        expect(RULE_TEXT[file], `${file} leaks ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('every alert in a mapped file is narrated in its runbook', () => {
    for (const [file, runbookPath] of Object.entries(RULES_TO_RUNBOOK)) {
      // Deleting a mapped rule file deletes coverage; the map is the assertion
      // that it still exists.
      expect(RULE_FILES, `${file} is missing from monitoring/alerts/`).toContain(file);
      const runbook = readFileSync(resolve(ROOT, runbookPath), 'utf8');
      const undocumented = alertsIn(file).filter((a) => !runbook.includes(a));
      expect(
        undocumented,
        `${file}: alerts with no operator guidance in ${runbookPath}: ${undocumented.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('every rule file is declared in the deployment wiring list', () => {
    // There is no committed `prometheus.yml` — the deploy's config lives
    // outside this repository, and `docs/runbooks/observability-slo.md` §8 is
    // the only place that says which files to load. A rules file that exists
    // but is never loaded is the same lie as an alert on a series nobody
    // emits: it looks like coverage and fires never.
    const wiring = readFileSync(RUNBOOK_PATH, 'utf8');
    const unwired = RULE_FILES.filter((f) => !wiring.includes(`/etc/prometheus/rules/${f}`));
    expect(
      unwired,
      'rule files missing from the rule_files list in docs/runbooks/observability-slo.md §8: ' +
        unwired.join(', '),
    ).toEqual([]);
  });

  it('the restore-drill gate is alerted on, and on the series the code emits', () => {
    // The #536 gate specifically: `backup.rules.yml` must query the same series
    // `readinessGauges` produces. Pointing it at a plausible-looking name that
    // nothing emits is what the generic check above catches; this one pins
    // WHICH series, so a silent rename of the gate cannot slip through as
    // "well, the new name is in the taxonomy too".
    const backup = RULE_TEXT['backup.rules.yml'];
    expect(backup, 'monitoring/alerts/backup.rules.yml is gone').toBeDefined();
    expect(backup).toContain('maia_restore_drill_check_level >= 2');
    expect(alertsIn('backup.rules.yml')).toEqual([
      'RestoreDrillEvidenceNotProvable',
      'RestoreDrillEvidenceAging',
    ]);
  });
});
