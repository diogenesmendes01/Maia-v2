import { auditRepo } from '@/db/repositories.js';
import type { AuditAction } from './audit-actions.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import {
  runWithTenantContext,
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
    incCounter('maia_audit_events_total', { action: input.acao });
  };

  try {
    if (tryGetCurrentContext()) {
      await write();
    } else {
      // System bucket — preserves the row for setup/gateway/startup events
      // that legitimately have no tenant attached. Visible to the audit
      // watcher; distinct from 'default' (the legacy single-tenant Maia).
      await runWithTenantContext(
        { tenant_id: 'system', agent_id: 'system' },
        write,
      );
    }
  } catch (err) {
    logger.error({ err, acao: input.acao }, 'audit.write_failed');
    incCounter('maia_audit_write_failed_total', { action: input.acao });
  }
}
