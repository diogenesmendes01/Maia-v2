import { sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { audit_log } from '@/db/schema.js';
import type { AuditAction } from '@/governance/audit-actions.js';
import { sendAlert } from '@/lib/alerts.js';
import { logger } from '@/lib/logger.js';

/**
 * Audit-driven anomaly watcher. Runs every minute via the worker registry
 * (see src/workers/index.ts). Reads from `audit_log` and emits alerts via
 * `sendAlert` when a rule trips. Throttled to 30 min per rule to avoid spam.
 *
 * Two rule shapes:
 *  - ThresholdRule: count of `acao` in the last `window_min` minutes >= threshold
 *  - StuckRule: latest `acao` (within last 24h) has no matching `mate_acao`
 *    after it AND was emitted more than `window_min` minutes ago
 *
 * Throttle is in-memory (Map). Process restart resets it — acceptable: the
 * next tick will re-detect and re-alert if the condition is still true.
 */
type Severity = 'critical' | 'urgent' | 'info';

type ThresholdRule = {
  kind: 'threshold';
  id: string;
  acao: AuditAction;
  threshold: number;
  window_min: number;
  severity: Severity;
};

type StuckRule = {
  kind: 'stuck';
  id: string;
  acao: AuditAction;
  mate_acao: AuditAction;
  window_min: number;
  severity: Severity;
};

type Rule = ThresholdRule | StuckRule;

const RULES: Rule[] = [
  // 3+ token-mismatch responses in 5 min — someone is farming the bootstrap
  // token. Critical because successful guess === full /setup access.
  {
    kind: 'threshold',
    id: 'setup_unauthorized_farm',
    acao: 'setup_unauthorized_access',
    threshold: 3,
    window_min: 5,
    severity: 'critical',
  },
  // NOTE: a setup_csrf_attack rule (acao: 'setup_csrf_mismatch') is the
  // natural twin of the rule above and was prototyped here, but the
  // `setup_csrf_mismatch` action is introduced on `chore/setup-hardening`,
  // not on main. To keep this PR mergeable directly against main without a
  // born-dead rule, the CSRF rule will be added in the same PR that ships
  // the action emission.
  // Recovery started but not completed within 1 min — recovery normally
  // takes ~3 s, anything over a minute means the rm/rotateToken/sendAlert
  // chain is wedged and operator must SSH.
  {
    kind: 'stuck',
    id: 'pairing_recovery_stuck',
    acao: 'pairing_recovery_started',
    mate_acao: 'pairing_recovery_completed',
    window_min: 1,
    severity: 'urgent',
  },
  // LLM circuit open for >5 min — the breaker auto-resets after a window;
  // 5+ min without a `closed` event means the upstream is down at length.
  {
    kind: 'stuck',
    id: 'llm_circuit_long_open',
    acao: 'llm_circuit_opened',
    mate_acao: 'llm_circuit_closed',
    window_min: 5,
    severity: 'urgent',
  },
  // 3+ anomalous-volume blocks in 1 h — multiple bots within an hour.
  {
    kind: 'threshold',
    id: 'bot_volume_burst',
    acao: 'auto_blocked_anomalous_volume',
    threshold: 3,
    window_min: 60,
    severity: 'info',
  },
];

const THROTTLE_MS = 30 * 60 * 1000;
const lastAlertedAt = new Map<string, number>();

async function checkThreshold(rule: ThresholdRule): Promise<void> {
  const cutoff = new Date(Date.now() - rule.window_min * 60_000);
  const r = await db.execute<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c FROM ${audit_log}
    WHERE acao = ${rule.acao} AND created_at > ${cutoff}
  `);
  const count = (r.rows[0]?.c as number | undefined) ?? 0;
  if (count >= rule.threshold) {
    await maybeAlert(
      rule,
      `${count} \`${rule.acao}\` events in the last ${rule.window_min} min (threshold ${rule.threshold}).`,
    );
  }
}

async function checkStuck(rule: StuckRule): Promise<void> {
  const olderThan = new Date(Date.now() - rule.window_min * 60_000);
  const r = await db.execute<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c FROM ${audit_log} a
    WHERE a.acao = ${rule.acao}
      AND a.created_at < ${olderThan}
      AND a.created_at > NOW() - INTERVAL '1 day'
      AND NOT EXISTS (
        SELECT 1 FROM ${audit_log} b
        WHERE b.acao = ${rule.mate_acao}
          AND b.created_at >= a.created_at
      )
  `);
  const stuck = (r.rows[0]?.c as number | undefined) ?? 0;
  if (stuck > 0) {
    await maybeAlert(
      rule,
      `${stuck} \`${rule.acao}\` event(s) older than ${rule.window_min} min without a matching \`${rule.mate_acao}\`.`,
    );
  }
}

async function maybeAlert(rule: Rule, detail: string): Promise<void> {
  const last = lastAlertedAt.get(rule.id) ?? 0;
  if (Date.now() - last < THROTTLE_MS) {
    logger.debug(
      { rule: rule.id, throttle_remaining_s: Math.round((THROTTLE_MS - (Date.now() - last)) / 1000) },
      'audit_watcher.throttled',
    );
    return;
  }
  lastAlertedAt.set(rule.id, Date.now());
  const subject = `[${rule.severity.toUpperCase()}] audit_watcher: ${rule.id}`;
  const body = `Audit watcher rule "${rule.id}" tripped.\n\n${detail}\n\nReview the audit log around the indicated window.`;
  await sendAlert({ subject, body }).catch((err) =>
    logger.warn(
      { err: (err as Error).message, rule: rule.id },
      'audit_watcher.alert_send_failed',
    ),
  );
  logger.warn({ rule: rule.id, severity: rule.severity, detail }, 'audit_watcher.alerted');
}

export async function runAuditWatcher(): Promise<void> {
  for (const rule of RULES) {
    try {
      if (rule.kind === 'threshold') await checkThreshold(rule);
      else await checkStuck(rule);
    } catch (err) {
      logger.error(
        { err: (err as Error).message, rule: rule.id },
        'audit_watcher.check_failed',
      );
    }
  }
}

/** Test-only export so unit tests can read/clear the throttle map. */
export const _internal = { lastAlertedAt, RULES };
