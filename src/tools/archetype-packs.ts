/**
 * Archetype → domain-pack mapping (issue #470).
 *
 * Single source of truth for which EXTRA packs an agent receives at creation
 * based on the function ("arquétipo") chosen in the wizard. Always composed
 * ON TOP of `BASE_AGENT_PACKS` (baseline.core + domain.calendar) — least
 * privilege: a salesperson never sees finance tools.
 *
 * Kept import-free (no registry/gateway chain), same rationale as
 * `base-agent-packs.ts`: `db/repositories/tenant-repos.ts` and the admin-ui
 * router both import this without pulling tool implementations.
 *
 * Pack ids MUST exist in `TOOL_PACKS` (grant-math.ts) — pinned by a unit
 * test, and `resolvePackTools` is fail-closed anyway (unknown pack grants
 * nothing).
 */
export const ARCHETYPE_IDS = [
  'vendedor',
  'suporte',
  'financeiro',
  'agendador',
  'custom',
] as const;

export type ArchetypeId = (typeof ARCHETYPE_IDS)[number];

export const ARCHETYPE_PACK_MAP: Readonly<Record<ArchetypeId, readonly string[]>> = {
  vendedor: ['domain.sales'],
  suporte: ['domain.support'],
  financeiro: ['domain.finance'],
  // domain.calendar já está em BASE_AGENT_PACKS — o agendador opera com o
  // floor da plataforma (e pode receber domain.calendar.admin via grant
  // explícito quando precisar gerir a agenda de terceiros).
  agendador: [],
  custom: [],
};

export function isArchetypeId(s: string): s is ArchetypeId {
  return (ARCHETYPE_IDS as readonly string[]).includes(s);
}
