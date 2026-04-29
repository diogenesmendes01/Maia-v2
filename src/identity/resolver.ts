import { pessoasRepo, conversasRepo } from '@/db/repositories.js';
import { resolveScope, type ResolvedPermission } from '@/governance/permissions.js';
import type { Pessoa, Conversa } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';

export type ResolvedIdentity = {
  kind: 'resolved';
  pessoa: Pessoa;
  scope: { entidades: string[]; byEntity: Map<string, ResolvedPermission> };
  conversa: Conversa;
  is_quarantined: boolean;
};

export type ResolveResult =
  | ResolvedIdentity
  | { kind: 'unknown'; telefone: string }
  | { kind: 'blocked'; pessoa: Pessoa; reason: string }
  | { kind: 'quarantined'; pessoa: Pessoa };

export async function resolveIdentity(input: { telefone_whatsapp: string }): Promise<ResolveResult> {
  const pessoa = await pessoasRepo.findByPhone(input.telefone_whatsapp);
  if (!pessoa) {
    await audit({ acao: 'unknown_number_message_received', metadata: { telefone: input.telefone_whatsapp } });
    return { kind: 'unknown', telefone: input.telefone_whatsapp };
  }
  if (pessoa.status === 'inativa' || pessoa.status === 'bloqueada') {
    return { kind: 'blocked', pessoa, reason: `status='${pessoa.status}'` };
  }
  if (pessoa.status === 'quarentena') {
    return { kind: 'quarantined', pessoa };
  }
  const scope = await resolveScope(pessoa);
  let conversa = await conversasRepo.findActive(pessoa.id);

  // Spec 05 §11.2: idle conversation rotation. New activity after >7d closes
  // the prior conversa (background summarizer fills contexto_resumido later)
  // and starts fresh.
  const ROTATION_MS = 7 * 24 * 60 * 60 * 1000;
  if (
    conversa &&
    conversa.ultima_atividade_em &&
    Date.now() - new Date(conversa.ultima_atividade_em).getTime() > ROTATION_MS
  ) {
    await conversasRepo.close(conversa.id, '');
    logger.info({ pessoa_id: pessoa.id, conversa_id: conversa.id }, 'conversa.rotated_idle');
    conversa = null;
  }

  if (!conversa) {
    conversa = await conversasRepo.create({
      pessoa_id: pessoa.id,
      escopo_entidades: scope.entidades,
    });
    logger.info({ pessoa_id: pessoa.id, conversa_id: conversa.id }, 'conversa.created');
  } else {
    await conversasRepo.touch(conversa.id);
  }
  return { kind: 'resolved', pessoa, scope, conversa, is_quarantined: false };
}
