import { db } from '@/db/client.js';
import { permissoes, pessoas, entity_states } from '@/db/schema.js';
import { eq, inArray, and, ne } from 'drizzle-orm';
import { audit } from './audit.js';
import { entityStatesRepo } from '@/db/repositories.js';
import { getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';

const LOCKDOWN_KEY = 'lockdown_snapshot';

/**
 * Emergency kill-switch (P4). Dead code today (0 prod callers — only doc
 * references in `runtime/decision/prod-env.ts`), but a retained capability, so
 * NOT deleted (#355). Made flip-safe + isolation-correct here.
 *
 * DISPOSITION = PER-TENANT (NOT `system`). `activateLockdown`/`liftLockdown`
 * operate exclusively on per-tenant tables (`pessoas`, `permissoes`,
 * `entity_states` — all carry `tenant_id`+`agent_id`). The H4 contract already
 * baked this verdict into `entityStatesRepo.byId/upsert` (src/db/repositories.ts):
 * lockdown "predates tenant context"; if wired up it MUST run under a real
 * tenant/agent context and a cross-tenant `entity_states` write is exactly the
 * bug H4 closes. Wrapping in `runWithSystemContext` would be the anti-pattern: a
 * system-wide sweep over per-tenant permission tables would suspend/restore EVERY
 * tenant's permissões at once and write `(system, system)` entity_states rows.
 *
 * So: bind `tenant_id`/`agent_id` from ALS and scope every query to the running
 * tuple. This (1) fixes the latent cross-tenant sweep (the old raw `db` queries
 * had NO tenant predicate and iterated ALL tenants' rows), and (2) is flip-safe —
 * `getCurrentTenant()`/`getCurrentAgent()` reject the `'default'` literal under
 * `MAIA_REJECT_DEFAULT_LITERAL`, so the kill-switch fails loud (never silently
 * lockdowns the wrong/all tenants) instead of running on the rejected sentinel.
 */
export async function activateLockdown(actor_pessoa_id: string): Promise<{ suspended: number }> {
  // Fail-loud bind: throws MissingTenantContextError outside ALS and
  // DefaultLiteralRejectedError on the `'default'` literal once the flip is on.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const ownerIds = await db
    .select({ id: pessoas.id })
    .from(pessoas)
    .where(
      and(
        eq(pessoas.tenant_id, tenant_id),
        eq(pessoas.agent_id, agent_id),
        inArray(pessoas.tipo, ['dono', 'co_dono']),
      ),
    );
  const ownerSet = ownerIds.map((r) => r.id);
  const affected = await db
    .select()
    .from(permissoes)
    .where(
      and(
        eq(permissoes.tenant_id, tenant_id),
        eq(permissoes.agent_id, agent_id),
        eq(permissoes.status, 'ativa'),
      ),
    );
  const toSuspend = affected.filter((p) => !ownerSet.includes(p.pessoa_id));
  const snapshot = toSuspend.map((p) => ({ id: p.id, status_before: p.status }));
  // Persist snapshot in entity_states.flags (one entry per entidade in scope).
  // entityStatesRepo.byId/upsert self-scope by tenant+agent from the same ALS.
  if (snapshot.length > 0) {
    for (const e of new Set(toSuspend.map((p) => p.entidade_id).filter((x): x is string => !!x))) {
      const st = await entityStatesRepo.byId(e);
      const flags = (st?.flags as Record<string, unknown>) ?? {};
      const list = (flags[LOCKDOWN_KEY] as Array<unknown> | undefined) ?? [];
      const fresh = snapshot.filter((s) => toSuspend.find((t) => t.id === s.id)?.entidade_id === e);
      flags[LOCKDOWN_KEY] = [...list, ...fresh];
      await entityStatesRepo.upsert({ entidade_id: e, flags });
    }
  }
  for (const p of toSuspend) {
    // Scope the mutation by tenant+agent (not bare `WHERE id = ?`) — the
    // toSuspend rows are already tenant-filtered, but the predicate makes the
    // write structurally cross-tenant-safe (cf. tenant-isolation.md §5).
    await db
      .update(permissoes)
      .set({ status: 'suspensa' })
      .where(
        and(
          eq(permissoes.id, p.id),
          eq(permissoes.tenant_id, tenant_id),
          eq(permissoes.agent_id, agent_id),
        ),
      );
  }
  await audit({
    acao: 'emergency_lockdown_activated',
    pessoa_id: actor_pessoa_id,
    metadata: { suspended: toSuspend.length },
  });
  return { suspended: toSuspend.length };
}

export async function liftLockdown(actor_pessoa_id: string): Promise<{ restored: number }> {
  // Fail-loud bind (see activateLockdown): real tenant/agent or throw.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const states = await db
    .select()
    .from(pessoas)
    .where(
      and(
        eq(pessoas.tenant_id, tenant_id),
        eq(pessoas.agent_id, agent_id),
        ne(pessoas.tipo, 'dono'),
      ),
    );
  let restored = 0;
  // Restore from snapshots held in THIS tenant/agent's entity_states only.
  const rows = await db
    .select()
    .from(entity_states)
    .where(
      and(eq(entity_states.tenant_id, tenant_id), eq(entity_states.agent_id, agent_id)),
    );
  for (const row of rows) {
    const flags = (row.flags as Record<string, unknown>) ?? {};
    const snapshot = (flags[LOCKDOWN_KEY] as Array<{ id: string; status_before: string }> | undefined) ?? [];
    for (const s of snapshot) {
      await db
        .update(permissoes)
        .set({ status: s.status_before as 'ativa' | 'suspensa' | 'revogada' | 'pendente' })
        .where(
          and(
            eq(permissoes.id, s.id),
            eq(permissoes.tenant_id, tenant_id),
            eq(permissoes.agent_id, agent_id),
          ),
        );
      restored++;
    }
    delete flags[LOCKDOWN_KEY];
    await entityStatesRepo.upsert({ entidade_id: row.entidade_id, flags });
  }
  void states;
  await audit({
    acao: 'emergency_lockdown_lifted',
    pessoa_id: actor_pessoa_id,
    metadata: { restored },
  });
  return { restored };
}
