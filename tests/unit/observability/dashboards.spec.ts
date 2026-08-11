import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { METRIC_NAMES } from '../../../src/observability/taxonomy.js';

/**
 * Issue #535 §3 — drift guard for the versioned dashboards.
 *
 * Same failure this issue opens by describing, one surface over: a panel
 * pointing at a series nobody emits LOOKS like coverage and renders "No data"
 * forever. The dashboards are committed JSON precisely so this check can exist
 * — a dashboard clicked together in the Grafana UI cannot be tested.
 */
const ROOT = resolve(__dirname, '../../..');
const DASHBOARD_DIR = resolve(ROOT, 'monitoring/dashboards');
const RULES = readFileSync(resolve(ROOT, 'monitoring/alerts/slo.rules.yml'), 'utf8');

const FILES = readdirSync(DASHBOARD_DIR).filter((f) => f.endsWith('.json'));

/**
 * `maia_*` metrics emitted OUTSIDE the #514/#535 taxonomy. Each names its
 * emitter so a future reader can verify rather than trust — same contract as
 * `slo-rules.spec.ts`.
 */
const PRE_EXISTING_METRICS: Record<string, string> = {
  maia_turns_current: 'src/observability/turn-state-collector.ts:94',
  maia_turn_state_age_seconds: 'src/observability/turn-state-collector.ts:95',
  maia_llm_latency_ms: 'src/lib/llm/telemetry.ts:114',
  maia_llm_calls_total: 'src/lib/llm/telemetry.ts:109',
  maia_llm_tokens_total: 'src/lib/llm/telemetry.ts:145',
};

interface Panel {
  id?: number;
  type?: string;
  title?: string;
  description?: string;
  gridPos?: { h: number; w: number; x: number; y: number };
  targets?: { expr?: string; legendFormat?: string }[];
}

interface Dashboard {
  uid?: string;
  title?: string;
  description?: string;
  tags?: string[];
  panels?: Panel[];
}

function load(file: string): Dashboard {
  return JSON.parse(readFileSync(resolve(DASHBOARD_DIR, file), 'utf8')) as Dashboard;
}

function expressions(dash: Dashboard): string[] {
  return (dash.panels ?? []).flatMap((p) =>
    (p.targets ?? []).map((t) => t.expr ?? '').filter(Boolean),
  );
}

describe('issue #535 — versioned dashboards', () => {
  it('ships at least one dashboard, as JSON in the repo', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(3);
  });

  it('every file is valid JSON with a stable uid and a title', () => {
    const uids = new Set<string>();
    for (const file of FILES) {
      const dash = load(file);
      expect(dash.uid, `${file} has no uid`).toBeTruthy();
      expect(dash.title, `${file} has no title`).toBeTruthy();
      // A duplicated uid makes provisioning silently overwrite one dashboard
      // with the other.
      expect(uids.has(dash.uid!), `${file} reuses uid ${dash.uid}`).toBe(false);
      uids.add(dash.uid!);
    }
  });

  it('every metric a panel queries is actually emitted', () => {
    const known = new Set<string>([...METRIC_NAMES, ...Object.keys(PRE_EXISTING_METRICS)]);
    const unknown = new Set<string>();
    for (const file of FILES) {
      for (const expr of expressions(load(file))) {
        for (const m of expr.matchAll(/\bmaia_[a-z0-9_]+/g)) {
          const name = m[0]!.replace(/_(bucket|sum|count)$/, '');
          if (!known.has(name)) unknown.add(`${file}: ${name}`);
        }
      }
    }
    expect([...unknown], 'panels query metrics nothing emits').toEqual([]);
  });

  it('every recording rule a panel references exists in slo.rules.yml', () => {
    const defined = new Set(
      [...RULES.matchAll(/- record: (maia:[a-z_0-9:]+)/g)].map((m) => m[1]!),
    );
    const missing = new Set<string>();
    for (const file of FILES) {
      for (const expr of expressions(load(file))) {
        for (const m of expr.matchAll(/\bmaia:[a-z_0-9:]+/g)) {
          if (!defined.has(m[0]!)) missing.add(`${file}: ${m[0]}`);
        }
      }
    }
    expect([...missing], 'panels reference undefined recording rules').toEqual([]);
  });

  it('no panel plots a high-cardinality id or PII', () => {
    // These are not metric labels by construction (`labels.ts`), so a panel
    // grouping by one would render nothing — but the intent is the bug worth
    // catching, not the empty graph.
    for (const file of FILES) {
      for (const expr of expressions(load(file))) {
        for (const forbidden of [
          'trace_id',
          'conversa_id',
          'mensagem_id',
          'telefone',
          'phone',
          'jid',
          'pessoa',
        ]) {
          expect(expr, `${file} plots ${forbidden}`).not.toContain(forbidden);
        }
      }
    }
  });

  it('shared-queue gauges aggregate with max, never sum', () => {
    // Every replica reports the SAME shared Redis queue / Postgres backlog;
    // summing multiplies the backlog by the replica count.
    for (const file of FILES) {
      for (const expr of expressions(load(file))) {
        for (const shared of [
          'maia_queue_depth',
          'maia_queue_oldest_job_age_ms',
          'maia_scheduler_lag_ms',
          'maia_scheduler_backlog',
        ]) {
          if (!expr.includes(shared)) continue;
          expect(expr, `${file} sums the shared gauge ${shared}`).not.toMatch(
            new RegExp(`sum\\s*(by\\s*\\([^)]*\\)\\s*)?\\(\\s*(rate\\()?${shared}`),
          );
        }
      }
    }
  });

  it('per-process gauges are broken down by instance, not averaged away', () => {
    // One pool and one socket per process: collapsing replicas hides the
    // saturated one inside the average.
    for (const file of FILES) {
      for (const expr of expressions(load(file))) {
        if (!expr.includes('maia_db_pool')) continue;
        if (expr.startsWith('maia:')) continue; // recording rule already scopes it
        expect(expr, `${file} aggregates maia_db_pool without instance`).toContain(
          'instance',
        );
      }
    }
  });

  it('every panel explains itself — a graph with no rationale is not a runbook', () => {
    for (const file of FILES) {
      for (const panel of load(file).panels ?? []) {
        if (panel.type === 'row') continue;
        expect(panel.description, `${file}: panel "${panel.title}" has no description`)
          .toBeTruthy();
      }
    }
  });

  it('panels do not overlap on the grid', () => {
    for (const file of FILES) {
      const seen = new Map<string, string>();
      for (const panel of load(file).panels ?? []) {
        const g = panel.gridPos;
        expect(g, `${file}: panel "${panel.title}" has no gridPos`).toBeTruthy();
        for (let y = g!.y; y < g!.y + g!.h; y++) {
          for (let x = g!.x; x < g!.x + g!.w; x++) {
            const cell = `${x},${y}`;
            expect(
              seen.get(cell),
              `${file}: "${panel.title}" overlaps "${seen.get(cell)}" at ${cell}`,
            ).toBeUndefined();
            seen.set(cell, panel.title ?? String(panel.id));
          }
        }
      }
    }
  });

  it('the README lists every dashboard file', () => {
    const readme = readFileSync(resolve(DASHBOARD_DIR, 'README.md'), 'utf8');
    for (const file of FILES) {
      expect(readme, `README does not mention ${file}`).toContain(file);
    }
  });
});
