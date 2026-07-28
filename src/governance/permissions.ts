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

export async function resolveScope(
  pessoa: Pessoa,
): Promise<{ entidades: string[]; byEntity: Map<string, ResolvedPermission> }> {
  if (pessoa.status !== 'ativa') return { entidades: [], byEntity: new Map() };
  const perms = await permissoesRepo.forPessoa(pessoa.id);
  const byEntity = new Map<string, ResolvedPermission>();
  const entidades: string[] = [];
  for (const p of perms) {
    if (!p.entidade_id) continue;
    const profile = await profilesRepo.byId(p.profile_id);
    if (!profile) continue;
    const effective_limits = mergeLimits(p, profile);
    byEntity.set(p.entidade_id, { permissao: p, profile, effective_limits });
    entidades.push(p.entidade_id);
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
