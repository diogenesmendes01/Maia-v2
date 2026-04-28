import { db } from '@/db/client.js';
import { permissoes, pessoas } from '@/db/schema.js';
import { eq, inArray, and, ne } from 'drizzle-orm';
import { audit } from './audit.js';
import { entityStatesRepo } from '@/db/repositories.js';

const LOCKDOWN_KEY = 'lockdown_snapshot';

export async function activateLockdown(actor_pessoa_id: string): Promise<{ suspended: number }> {
  const ownerIds = await db
    .select({ id: pessoas.id })
    .from(pessoas)
    .where(inArray(pessoas.tipo, ['dono', 'co_dono']));
  const ownerSet = ownerIds.map((r) => r.id);
  const affected = await db
    .select()
    .from(permissoes)
    .where(and(eq(permissoes.status, 'ativa')));
  const toSuspend = affected.filter((p) => !ownerSet.includes(p.pessoa_id));
  const snapshot = toSuspend.map((p) => ({ id: p.id, status_before: p.status }));
  // Persist snapshot in entity_states.flags keyed by global record (we use one entry per id)
  if (snapshot.length > 0) {
    // store in a singleton row keyed by a fixed UUID — fallback: keep in self-state metadata
    // For simplicity, we use entity_states flags on the first entity in scope; or we store per entity
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
    await db.update(permissoes).set({ status: 'suspensa' }).where(eq(permissoes.id, p.id));
  }
  await audit({
    acao: 'emergency_lockdown_activated',
    pessoa_id: actor_pessoa_id,
    metadata: { suspended: toSuspend.length },
  });
  return { suspended: toSuspend.length };
}

export async function liftLockdown(actor_pessoa_id: string): Promise<{ restored: number }> {
  const states = await db.select().from(pessoas).where(ne(pessoas.tipo, 'dono'));
  let restored = 0;
  // Fetch all entity_states and restore where snapshot exists
  const { entity_states } = await import('@/db/schema.js');
  const rows = await db.select().from(entity_states);
  for (const row of rows) {
    const flags = (row.flags as Record<string, unknown>) ?? {};
    const snapshot = (flags[LOCKDOWN_KEY] as Array<{ id: string; status_before: string }> | undefined) ?? [];
    for (const s of snapshot) {
      await db
        .update(permissoes)
        .set({ status: s.status_before as 'ativa' | 'suspensa' | 'revogada' | 'pendente' })
        .where(eq(permissoes.id, s.id));
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
