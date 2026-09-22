/**
 * P09 (spec §7.7, §10 linha P09) — PUBLICADOR e REVOGAÇÃO.
 *
 * ─── O que publicar significa aqui ──────────────────────────────────────────
 *
 * Tornar um bundle compilado alcançável por um destino, sob um digest. Não é
 * "copiar arquivos": é registrar que ESTE digest está autorizado para ESTE
 * escopo, e que qualquer outro não está.
 *
 * ─── Imutabilidade, e o que ela custa quando falta ──────────────────────────
 *
 * Um bundle publicado NÃO é atualizado no lugar. Republicar o mesmo digest é
 * idempotente; publicar conteúdo diferente exige digest diferente, e portanto
 * uma publicação nova.
 *
 * A razão é o wrapper: ele confere o digest antes de executar. Se a publicação
 * mudasse o conteúdo sob o mesmo digest, a conferência passaria a aprovar duas
 * coisas diferentes com a mesma assinatura — e a assinatura deixaria de
 * significar algo.
 *
 * ─── Revogação é estado, não deleção ───────────────────────────────────────
 *
 * Revogar marca; não apaga. Apagar destruiria o rastro de que aquele conteúdo
 * ESTEVE publicado, que é exatamente o que uma investigação precisa. E o
 * §7.4.1 é explícito sobre o vizinho disso: `revoked` é terminal absoluto —
 * uma vez revogado, não volta. Republicar exige publicação NOVA, com decisão
 * humana própria.
 */
import { logger } from '@/lib/logger.js';
import type { CompiledBundleV1 } from './compiler.js';

/** Onde o bundle passa a ser alcançável. */
export type PublishTargetV1 = {
  tenant_id: string;
  /** `null` = tenant-wide. NÃO é global (§7.7.1). */
  agent_id: string | null;
};

export type PublicationRecordV1 = {
  bundle_digest: string;
  skill_id: string;
  version: number;
  target: PublishTargetV1;
  /** Quem autorizou. Metadado PRIVADO: não entra no bundle. */
  approved_by: string;
  published_at: string;
  revoked_at: string | null;
  revoked_reason: string | null;
};

/**
 * A porta de persistência.
 *
 * Injetada porque o armazenamento do publicador é decisão de implantação
 * (§7.7.1 fala de `<storage-publicador>`), e porque um módulo que decide o que
 * pode ser publicado não deve arrastar um cliente de storage para ser
 * importado.
 */
export type PublicationStoreV1 = {
  findByDigest(digest: string): Promise<PublicationRecordV1 | null>;
  /** Publicações VIVAS do mesmo (skill, escopo). Usado para supersedência. */
  listLiveFor(input: { skill_id: string; target: PublishTargetV1 }): Promise<PublicationRecordV1[]>;
  insert(record: PublicationRecordV1, files: CompiledBundleV1['files']): Promise<void>;
  markRevoked(input: { bundle_digest: string; revoked_at: string; reason: string }): Promise<void>;
};

export type PublishResultV1 =
  | { kind: 'published'; record: PublicationRecordV1; superseded: string[] }
  | { kind: 'idempotent'; record: PublicationRecordV1 }
  | { kind: 'refused'; reason: 'digest_revoked' | 'digest_conflict'; detail: string };

/**
 * Publica um bundle compilado.
 *
 * `now` é injetado para o teste não depender do relógio. Ele NÃO entra no
 * digest — ver o cabeçalho do compilador.
 */
export async function publishBundle(input: {
  bundle: CompiledBundleV1;
  skill_id: string;
  version: number;
  target: PublishTargetV1;
  approved_by: string;
  store: PublicationStoreV1;
  now?: () => Date;
}): Promise<PublishResultV1> {
  const agora = (input.now ?? (() => new Date()))().toISOString();
  const digest = input.bundle.bundle_digest;

  const existente = await input.store.findByDigest(digest);
  if (existente !== null) {
    /**
     * Digest revogado NÃO volta.
     *
     * Republicar o mesmo conteúdo depois de uma revogação apagaria a decisão
     * de revogar sem que ninguém a revisse: o digest é o mesmo, então nada no
     * sistema distinguiria "voltou por decisão" de "voltou por acidente de
     * um pipeline que rodou de novo". Conteúdo revogado que precise voltar
     * sobe como publicação NOVA, com aprovação própria.
     */
    if (existente.revoked_at !== null) {
      return {
        kind: 'refused',
        reason: 'digest_revoked',
        detail: `digest revogado em ${existente.revoked_at}: ${existente.revoked_reason ?? ''}`,
      };
    }

    /**
     * Mesmo digest, outro alvo ou outra skill: conflito.
     *
     * O digest é função do conteúdo, e o conteúdo inclui o escopo — então
     * isto só acontece se alguém montou o registro à mão. Recusar é o único
     * desfecho honesto: aceitar sobrescreveria uma publicação viva.
     */
    if (
      existente.skill_id !== input.skill_id ||
      existente.target.tenant_id !== input.target.tenant_id ||
      existente.target.agent_id !== input.target.agent_id
    ) {
      return {
        kind: 'refused',
        reason: 'digest_conflict',
        detail: 'digest já publicado para outra skill ou outro escopo',
      };
    }

    // Republicação idêntica: idempotente, e sem segunda linha.
    return { kind: 'idempotent', record: existente };
  }

  const record: PublicationRecordV1 = {
    bundle_digest: digest,
    skill_id: input.skill_id,
    version: input.version,
    target: input.target,
    approved_by: input.approved_by,
    published_at: agora,
    revoked_at: null,
    revoked_reason: null,
  };

  await input.store.insert(record, input.bundle.files);

  /**
   * Versões anteriores VIVAS da mesma skill no mesmo escopo são revogadas por
   * supersedência.
   *
   * Sem isso, duas versões ficariam publicadas ao mesmo tempo e a escolha de
   * qual roda passaria a depender de quem lê primeiro. Publicar a nova é a
   * decisão; deixar a velha viva seria manter uma decisão antiga em vigor sem
   * ninguém ter dito que ela continua valendo.
   *
   * A supersedência acontece DEPOIS do insert: se ela falhar, o estado é duas
   * publicações vivas — visível e corrigível. Na ordem inversa, a falha
   * deixaria ZERO publicações vivas, e a skill sairia do ar.
   */
  const vivas = await input.store.listLiveFor({
    skill_id: input.skill_id,
    target: input.target,
  });
  const superseded: string[] = [];
  for (const antiga of vivas) {
    if (antiga.bundle_digest === digest) continue;
    await input.store.markRevoked({
      bundle_digest: antiga.bundle_digest,
      revoked_at: agora,
      reason: `superseded_by:${digest}`,
    });
    superseded.push(antiga.bundle_digest);
  }

  logger.info(
    {
      skill_id: input.skill_id,
      version: input.version,
      bundle_digest: digest,
      tenant_id: input.target.tenant_id,
      agent_id: input.target.agent_id,
      superseded: superseded.length,
    },
    'learning.bundle_published',
  );

  return { kind: 'published', record, superseded };
}

export type RevokeResultV1 =
  | { kind: 'revoked'; bundle_digest: string }
  | { kind: 'already_revoked'; bundle_digest: string; at: string }
  | { kind: 'not_found' };

/**
 * Revoga uma publicação.
 *
 * Idempotente por construção: revogar duas vezes devolve `already_revoked` com
 * a data ORIGINAL, e não sobrescreve. Sobrescrever moveria a data para a frente
 * a cada retry de um operador nervoso, e a data é o que responde "desde quando
 * isto não valia mais?".
 */
export async function revokeBundle(input: {
  bundle_digest: string;
  reason: string;
  store: PublicationStoreV1;
  now?: () => Date;
}): Promise<RevokeResultV1> {
  const existente = await input.store.findByDigest(input.bundle_digest);
  if (existente === null) return { kind: 'not_found' };
  if (existente.revoked_at !== null) {
    return {
      kind: 'already_revoked',
      bundle_digest: input.bundle_digest,
      at: existente.revoked_at,
    };
  }

  const agora = (input.now ?? (() => new Date()))().toISOString();
  await input.store.markRevoked({
    bundle_digest: input.bundle_digest,
    revoked_at: agora,
    reason: input.reason,
  });

  logger.warn(
    { bundle_digest: input.bundle_digest, reason: input.reason },
    'learning.bundle_revoked',
  );
  return { kind: 'revoked', bundle_digest: input.bundle_digest };
}
