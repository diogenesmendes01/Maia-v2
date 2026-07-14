import {
  pessoasRepo,
  conversasRepo,
  agentAudienceProfilesRepo,
} from '@/db/repositories.js';
import { resolveScope, type ResolvedPermission } from '@/governance/permissions.js';
import type { Pessoa, Conversa } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import {
  buildAudienceContext,
  type AudienceContext,
} from '@/identity/audience-context.js';

export type ResolvedIdentity = {
  kind: 'resolved';
  pessoa: Pessoa;
  scope: { entidades: string[]; byEntity: Map<string, ResolvedPermission> };
  conversa: Conversa;
  is_quarantined: boolean;
  /**
   * Issue #407: who this pessoa is FOR THIS AGENT, derived per-turn from the
   * `agent_audience_profiles` relation + resolved scope. Always present on the
   * `resolved` path — a pessoa with no ACTIVE audience profile never reaches
   * here (it is failed closed to `{ kind: 'quarantined' }`).
   */
  audience: AudienceContext;
};

export type ResolveResult =
  | ResolvedIdentity
  | { kind: 'unknown'; telefone: string }
  | { kind: 'blocked'; pessoa: Pessoa; reason: string }
  | { kind: 'quarantined'; pessoa: Pessoa };

export async function resolveIdentity(input: {
  telefone_whatsapp: string;
  /**
   * Fase 0 (spec roteamento v4 §1.6): canal (linha) que recebeu o inbound. A
   * identidade da conversa inclui o canal — com um agente em N linhas, a
   * MESMA pessoa em duas linhas são DUAS conversas. NULL cobre o caminho
   * legado (probe sem canal): comporta-se como antes.
   */
  channel_id?: string | null;
}): Promise<ResolveResult> {
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

  // Issue #407 — fail-closed audience resolution (invariant #5). A known
  // pessoa must have an ACTIVE per-agent audience profile to be served. The
  // profile is looked up scoped to the current (tenant_id, agent_id), so the
  // SAME phone can be `customer` for one agent and `employee` for another.
  const profile = await agentAudienceProfilesRepo.findByPessoa(pessoa.id);
  if (!profile) {
    // Known pessoa, but NO relation with this agent → block (audited).
    await audit({
      acao: 'audience_blocked_no_profile',
      pessoa_id: pessoa.id,
      metadata: { tenant_id: pessoa.tenant_id, agent_id: pessoa.agent_id },
    });
    return { kind: 'quarantined', pessoa };
  }
  if (profile.status !== 'active') {
    // Relation exists but is inactive/quarantined/blocked → fail closed.
    await audit({
      acao: 'audience_quarantined',
      pessoa_id: pessoa.id,
      metadata: {
        tenant_id: pessoa.tenant_id,
        agent_id: pessoa.agent_id,
        audience_profile_id: profile.id,
        profile_status: profile.status,
      },
    });
    return { kind: 'quarantined', pessoa };
  }

  const scope = await resolveScope(pessoa);

  const audience = buildAudienceContext({
    pessoa,
    profile,
    allowed_entity_ids: scope.entidades,
  });
  if (!audience) {
    // Defensive: buildAudienceContext only returns null for a missing/inactive
    // profile, both already handled above. Treat any residual null as a
    // fail-closed quarantine rather than serving without an AudienceContext.
    await audit({
      acao: 'audience_quarantined',
      pessoa_id: pessoa.id,
      metadata: {
        tenant_id: pessoa.tenant_id,
        agent_id: pessoa.agent_id,
        audience_profile_id: profile.id,
        reason: 'build_returned_null',
      },
    });
    return { kind: 'quarantined', pessoa };
  }

  await audit({
    acao: 'audience_resolved',
    pessoa_id: pessoa.id,
    metadata: {
      tenant_id: pessoa.tenant_id,
      agent_id: pessoa.agent_id,
      audience_profile_id: audience.audience_profile_id,
      audience_type: audience.audience_type,
      trust_level: audience.trust_level,
    },
  });

  let conversa = await conversasRepo.findActive(pessoa.id, input.channel_id ?? undefined);

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
    // 090: conversas novas do caminho resolvido nascem COM canal (spec §1.6).
    conversa = await conversasRepo.create({
      pessoa_id: pessoa.id,
      escopo_entidades: scope.entidades,
      channel_id: input.channel_id ?? null,
    });
    logger.info({ pessoa_id: pessoa.id, conversa_id: conversa.id }, 'conversa.created');
  } else {
    // Review PR #496 (alto 6): conversa LEGADA (channel NULL) reencontrada
    // por um inbound RESOLVIDO é vinculada ao canal na hora — sem isso, com
    // 2+ linhas ativas a resposta lançaria `channel_ambiguous` e a conversa
    // ficaria muda até encerrar. CAS no repo: na corrida entre linhas a
    // primeira vence; a perdedora reencontra/cria a conversa da própria
    // linha (mesma semântica do miss normal).
    if (input.channel_id && conversa.channel_id === null) {
      const bound = await conversasRepo.bindChannelIfNull(conversa.id, input.channel_id);
      if (bound) {
        conversa = { ...conversa, channel_id: input.channel_id };
        logger.info(
          { conversa_id: conversa.id, channel_id: input.channel_id },
          'conversa.legacy_bound_to_channel',
        );
      } else {
        conversa = await conversasRepo.findActive(pessoa.id, input.channel_id);
        if (!conversa) {
          conversa = await conversasRepo.create({
            pessoa_id: pessoa.id,
            escopo_entidades: scope.entidades,
            channel_id: input.channel_id,
          });
          logger.info(
            { pessoa_id: pessoa.id, conversa_id: conversa.id },
            'conversa.created',
          );
        }
      }
    }
    await conversasRepo.touch(conversa.id);
  }
  return { kind: 'resolved', pessoa, scope, conversa, is_quarantined: false, audience };
}
