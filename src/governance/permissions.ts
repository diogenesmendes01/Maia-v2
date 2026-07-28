import { permissoesRepo, profilesRepo, pessoasRepo } from '@/db/repositories.js';
import type { Permissao, PermissionProfile, Pessoa } from '@/db/schema.js';
import type { ActionKey } from './audit-actions.js';
// Import circular benigno: financial-authorization importa `profileAllows`
// daqui; os dois usos são em tempo de chamada (nunca em module-init).
import { evaluateFinancialAuthorization } from './financial-authorization.js';

export type EffectiveLimits = {
  /**
   * Limite individual (permissão explícita ?? limite_default do profile).
   * `null` = nenhum limite individual configurado — a decisão financeira cai
   * direto para o teto global. Nunca amplia VALOR_LIMITE_DURO.
   */
  valor_max: number | null;
  naturezas_permitidas?: string[];
  categorias_permitidas?: string[];
  horario_permitido?: { dias: number[]; inicio: string; fim: string };
};

export type ResolvedPermission = {
  permissao: Permissao;
  profile: PermissionProfile;
  effective_limits: EffectiveLimits;
};

/**
 * Resolve which entities this person may act on, and under which profile.
 *
 * Issue #511 — the profile lookup was inside the loop: one `profilesRepo.byId`
 * per permission, so a person with 100 entity permissions cost 101 round-trips
 * on the fixed 10-connection pool BEFORE the turn had done anything. Profiles
 * are now fetched in a single batched, tenant-scoped statement, making the cost
 * exactly two queries regardless of how many entities the person can reach.
 *
 * Authorization semantics are unchanged, deliberately:
 *   - an unresolvable profile still SKIPS the permission (no profile → no
 *     grant, the fail-closed reading), it does not fall back to a default;
 *   - limits are still merged per permission by `mergeLimits`, so an explicit
 *     `limites` override still wins over the profile default;
 *   - iteration order still follows `perms`, so the resulting `entidades` array
 *     and the rendered scope block stay byte-identical to before.
 *
 * The batch read is ALSO strictly safer than the loop it replaces:
 * `profilesRepo.byIds` binds (tenant_id, agent_id) from ALS, while the
 * `byId` it replaces matched on the profile id alone — a `permissoes` row
 * pointing at a foreign profile id used to resolve to that other tenant's
 * action list and spend limit.
 */
export async function resolveScope(
  pessoa: Pessoa,
): Promise<{ entidades: string[]; byEntity: Map<string, ResolvedPermission> }> {
  if (pessoa.status !== 'ativa') return { entidades: [], byEntity: new Map() };
  const perms = await permissoesRepo.forPessoa(pessoa.id);
  const withEntity = perms.filter((p) => p.entidade_id);
  if (withEntity.length === 0) return { entidades: [], byEntity: new Map() };

  const profiles = await profilesRepo.byIds(withEntity.map((p) => p.profile_id));
  const byProfileId = new Map(profiles.map((pr) => [pr.id, pr]));

  const byEntity = new Map<string, ResolvedPermission>();
  const entidades: string[] = [];
  for (const p of withEntity) {
    const profile = byProfileId.get(p.profile_id);
    if (!profile) continue;
    const effective_limits = mergeLimits(p, profile);
    byEntity.set(p.entidade_id!, { permissao: p, profile, effective_limits });
    entidades.push(p.entidade_id!);
  }
  return { entidades, byEntity };
}

function mergeLimits(p: Permissao, profile: PermissionProfile): EffectiveLimits {
  const explicit = (p.limites ?? {}) as Partial<EffectiveLimits>;
  // Precedência: limite explícito da permissão > limite_default do profile >
  // null (sem limite individual). `limite_default` vem do Postgres como string
  // numeric; um valor não-numérico vira 0 (fail-closed: bloqueia tudo) em vez
  // de NaN (que tornaria toda comparação falsa e liberaria o valor).
  const profileDefault =
    profile.limite_default !== null && profile.limite_default !== undefined
      ? Number(profile.limite_default)
      : null;
  const valor_max =
    explicit.valor_max ?? (profileDefault !== null && Number.isNaN(profileDefault) ? 0 : profileDefault);
  return {
    valor_max,
    naturezas_permitidas: explicit.naturezas_permitidas,
    categorias_permitidas: explicit.categorias_permitidas,
    horario_permitido: explicit.horario_permitido,
  };
}

export function profileAllows(profile: PermissionProfile, action: ActionKey): boolean {
  if (profile.acoes.includes('*')) return true;
  return profile.acoes.includes(action);
}

export function canAct(input: {
  pessoa: Pessoa;
  resolved: ResolvedPermission | null;
  action: ActionKey;
  valor?: number;
  natureza?: string;
  categoria_id?: string;
  now?: Date;
}): { allowed: true } | { allowed: false; reason: string } {
  if (input.pessoa.status !== 'ativa') {
    return { allowed: false, reason: `pessoa.status='${input.pessoa.status}'` };
  }
  if (!input.resolved) {
    return { allowed: false, reason: 'no permission for entity' };
  }
  if (input.resolved.permissao.status !== 'ativa') {
    return { allowed: false, reason: `permissao.status='${input.resolved.permissao.status}'` };
  }
  if (!profileAllows(input.resolved.profile, input.action)) {
    return { allowed: false, reason: `profile lacks action '${input.action}'` };
  }
  if (input.valor !== undefined) {
    // Fase 0 cap. 1 — a decisão de valor é do avaliador financeiro único
    // (limite individual + natureza/categoria/horário + teto global), nunca
    // só do teto global. `require_*` NÃO nega aqui: a classificação de
    // confirmação é aplicada pelo dispatcher; canAct responde apenas se a
    // ação é possível para esta pessoa/permissão/valor.
    const decision = evaluateFinancialAuthorization({
      pessoa: input.pessoa,
      resolved: input.resolved,
      action: input.action,
      valor: input.valor,
      natureza: input.natureza,
      categoria_id: input.categoria_id,
      now: input.now,
    });
    if (decision.decision === 'deny') {
      return { allowed: false, reason: decision.reason_code };
    }
  }
  return { allowed: true };
}

export function isOwnerType(pessoa: Pessoa): boolean {
  return pessoa.tipo === 'dono' || pessoa.tipo === 'co_dono';
}

export async function listOwners(): Promise<Pessoa[]> {
  const all = await pessoasRepo.list();
  return all.filter(isOwnerType).filter((p) => p.status === 'ativa');
}
