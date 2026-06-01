import { auditRepo } from '@/db/repositories.js';
import type { AuditAction } from './audit-actions.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import {
  runWithSystemContext,
  tryGetCurrentContext,
} from '@/db/tenant-context.js';

/**
 * Audit writer used across the entire system. Originally `auditRepo.write`
 * applied `applyTenantGuard` unconditionally — but several callers (setup
 * CSRF/token failures, baileys pairing/QR, bot-detection, startup/shutdown,
 * worker bootstraps) run OUTSIDE any `runWithTenantContext`. The unconditional
 * guard threw `MissingTenantContextError`, the `try/catch` below silently
 * swallowed it, and the row was lost — invisible to the audit watcher.
 *
 * Fix (PR #75 review #3): if no tenant context is active, wrap the write in
 * a synthetic `system` tenant/agent context. Migration 014 seeds the row.
 * In-tenant callers are untouched — `tryGetCurrentContext()` returns the
 * caller's context and the inner branch runs directly.
 *
 * The catch is preserved as a last-resort safety net: an unexpected DB error
 * shouldn't break the calling business logic, but it MUST emit a log + metric
 * so monitoring picks it up.
 */
export async function audit(input: {
  acao: AuditAction;
  pessoa_id?: string | null;
  entidade_alvo?: string | null;
  alvo_id?: string | null;
  conversa_id?: string | null;
  mensagem_id?: string | null;
  occurrence_id?: string | null;
  diff?: { before?: unknown; after?: unknown } | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const payload = {
    acao: input.acao,
    pessoa_id: input.pessoa_id ?? null,
    entidade_alvo: input.entidade_alvo ?? null,
    alvo_id: input.alvo_id ?? null,
    conversa_id: input.conversa_id ?? null,
    mensagem_id: input.mensagem_id ?? null,
    occurrence_id: input.occurrence_id ?? null,
    diff: (input.diff ?? null) as object | null,
    metadata: input.metadata ?? {},
  };

  const write = async (): Promise<void> => {
    await auditRepo.write(payload);
    // Issue #271: include tenant_id/agent_id labels so dashboards/alerts can
    // distinguish per-tenant rate-limit overage (and every other audit action)
    // instead of seeing one global aggregate. Read from the active ALS context
    // — when this branch runs, write() is always inside a runWithTenantContext
    // (either the caller's, or the synthetic `system` bucket below).
    const ctx = tryGetCurrentContext();
    incCounter('maia_audit_events_total', {
      action: input.acao,
      tenant_id: ctx?.tenant_id ?? 'system',
      agent_id: ctx?.agent_id ?? 'system',
    });
  };

  // Capture caller context BEFORE entering the fallback so the failure-path
  // counter (below) sees the same tenant attribution as the success path —
  // otherwise an in-tenant write that DB-errors would be labeled `system`.
  const callerCtx = tryGetCurrentContext();

  try {
    if (callerCtx) {
      await write();
    } else {
      // System bucket — preserves the row for setup/gateway/startup events
      // that legitimately have no tenant attached. Visible to the audit
      // watcher; distinct from 'default' (the legacy single-tenant Maia).
      // Uses the canonical `runWithSystemContext` helper (issue #323) so the
      // reserved sentinel lives in exactly one place.
      await runWithSystemContext(write);
    }
  } catch (err) {
    logger.error({ err, acao: input.acao }, 'audit.write_failed');
    incCounter('maia_audit_write_failed_total', {
      action: input.acao,
      tenant_id: callerCtx?.tenant_id ?? 'system',
      agent_id: callerCtx?.agent_id ?? 'system',
    });
  }
}

/**
 * Issue #366 — TRANSACTIONAL, FAIL-LOUD audit for FINANCIAL mutations.
 *
 * `audit()` above is best-effort: it swallows a failed audit insert (log +
 * metric only) so business logic isn't broken by a transient DB hiccup. For
 * money-moving writes that is a compliance gap — the ledger/balance change can
 * commit while the audit insert silently fails, leaving a balance change with
 * no audit row.
 *
 * `auditTx` closes that gap: it writes the audit row on the SAME `tx` handle as
 * the money-moving write (via `auditRepo.writeTx`) and does NOT catch — so a
 * failed insert PROPAGATES and rolls back the enclosing `withTx` (ledger +
 * balance + audit are atomic). Tenant attribution is resolved exactly like
 * `audit()`: in-tenant callers write under the active ALS context, callers with
 * no context fall back to the synthetic `system` bucket via
 * `runWithSystemContext` (so the row is never lost AND its tenant guard is
 * stamped consistently). The success-path metric is emitted identically; a
 * failure deliberately surfaces to the caller instead of bumping the
 * failure counter and continuing.
 *
 * Callers wiring this in MUST set `tool.audits_in_tx = true` so the dispatcher
 * skips its post-commit `audit()` (no duplicate audit row).
 */
export async function auditTx(
  tx: typeof import('@/db/client.js').db,
  input: {
    acao: AuditAction;
    pessoa_id?: string | null;
    entidade_alvo?: string | null;
    alvo_id?: string | null;
    conversa_id?: string | null;
    mensagem_id?: string | null;
    occurrence_id?: string | null;
    diff?: { before?: unknown; after?: unknown } | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const payload = {
    acao: input.acao,
    pessoa_id: input.pessoa_id ?? null,
    entidade_alvo: input.entidade_alvo ?? null,
    alvo_id: input.alvo_id ?? null,
    conversa_id: input.conversa_id ?? null,
    mensagem_id: input.mensagem_id ?? null,
    occurrence_id: input.occurrence_id ?? null,
    diff: (input.diff ?? null) as object | null,
    metadata: input.metadata ?? {},
  };

  const write = async (): Promise<void> => {
    await auditRepo.writeTx(tx, payload);
    const ctx = tryGetCurrentContext();
    incCounter('maia_audit_events_total', {
      action: input.acao,
      tenant_id: ctx?.tenant_id ?? 'system',
      agent_id: ctx?.agent_id ?? 'system',
    });
  };

  // Same tenant-context resolution as `audit()` (ALS / system-bucket fallback)
  // — but NO try/catch: a failed audit insert MUST propagate so the enclosing
  // `withTx` rolls the money-moving write back.
  if (tryGetCurrentContext()) {
    await write();
  } else {
    await runWithSystemContext(write);
  }
}
