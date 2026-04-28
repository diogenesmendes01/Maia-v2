import { permissoesRepo, profilesRepo, pessoasRepo } from '@/db/repositories.js';
import type { Permissao, PermissionProfile, Pessoa } from '@/db/schema.js';
import type { ActionKey } from './audit-actions.js';
import { config } from '@/config/env.js';

export type EffectiveLimits = {
  valor_max: number;
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
  return {
    valor_max: explicit.valor_max ?? Number(profile.limite_default ?? 0),
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
    if (input.valor > config.VALOR_LIMITE_DURO) {
      return { allowed: false, reason: 'above hard limit' };
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
