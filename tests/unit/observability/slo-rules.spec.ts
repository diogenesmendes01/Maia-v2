/**
 * Issue #514 §9 — drift guard between `monitoring/alerts/slo.rules.yml` and
 * the code that actually emits the metrics.
 *
 * An alert that references a metric nobody emits is worse than no alert: it
 * looks like coverage and fires never. This spec fails the build when the two
 * drift apart.
 *
 * Parsed with a regex rather than a YAML library on purpose — `yaml` is only a
 * transitive dependency here, and this issue is not allowed to add one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { METRIC_NAMES } from '../../../src/observability/taxonomy.js';

const ROOT = resolve(__dirname, '../../..');
const RULES_PATH = resolve(ROOT, 'monitoring/alerts/slo.rules.yml');
const RUNBOOK_PATH = resolve(ROOT, 'docs/runbooks/observability-slo.md');

const rules = readFileSync(RULES_PATH, 'utf8');

/**
 * `maia_*` metrics emitted OUTSIDE the #514 taxonomy but genuinely present in
 * the codebase. Each entry names its emitter so a future reader can verify the
 * claim instead of trusting the list.
 */
const PRE_EXISTING_METRICS: Record<string, string> = {
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
