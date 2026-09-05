/**
 * Issue #536 — a TRAVA: nenhuma política periódica nova entra em operação sem
 * homologação escrita.
 *
 * A direção do dono é literal: *"nenhuma política periódica nova deve ser
 * ativada sem homologação escrita"*. Isso não é uma frase para a matriz — uma
 * frase num documento não reprova nada. Aqui ela vira um campo obrigatório e um
 * conjunto de regras que `tests/unit/ops/retention-homologation-guard.spec.ts`
 * executa a cada rodada.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE É "POLÍTICA PERIÓDICA" AQUI.
 *
 * Um job que, por iniciativa da própria plataforma e numa cadência, destrói
 * dado de titular por PRAZO. É a alavanca oposta ao pedido de um titular: o
 * pedido tem requerente nomeado e obrigação legal; a varredura periódica não
 * tem ninguém pedindo, e por isso ela é a que precisa de homologação.
 *
 * As três de hoje estão declaradas em `PERIODIC_POLICIES` abaixo, com o estado
 * de ativação que o CONTRATO de configuração produz por default — não com o
 * estado que alguém acha que elas têm.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * POR QUE A AUSÊNCIA É ERRO DE TIPO, E NÃO DEFAULT.
 *
 * `ActivationAuthorisation` é união discriminada e OBRIGATÓRIA em
 * `PeriodicPolicy`. Não existe `authorisation?:`, não existe valor implícito, e
 * não existe variante silenciosa: quem declara uma política sem autorização tem
 * de escrever `{ kind: 'none', why: … }` — dizer em voz alta que não há
 * homologação — e aí o guard reprova se ela estiver ativa. Um campo opcional
 * teria produzido o contrário: quem esquecesse de preencher passaria.
 *
 * A variante `owner_ratified_pending_homologation` existe porque o TTL de sete
 * dias do export JÁ ESTÁ ATIVO (varredura horária, `PRIVACY_EXPORT_SWEEP_DRY_RUN`
 * default `false`) e ainda não tem confirmação do DPO. Fingir que ele está
 * homologado seria mentir; fingir que está inativo seria pior. Ela é aceita
 * apenas para as políticas listadas em `GRANDFATHERED_ACTIVATIONS`, que é uma
 * lista FECHADA e congelada — é isso que faz a palavra "nova" da direção do
 * dono ter efeito: uma política que não estava ativa antes desta entrega não
 * consegue usar essa variante.
 *
 * O QUE ESTE MÓDULO NÃO FAZ. Não ativa nada, não apaga nada e não é consultado
 * por nenhum executor. Ele é uma declaração verificável do estado de ativação
 * mais as regras que dizem quando esse estado é ilegítimo.
 */
import {
  DATA_CLASSES,
  UNAPPROVED_POLICY,
  resolveRetention,
  type DataClass,
  type RetentionPolicy,
} from '@/ops/retention/data-classes.js';

/** Quem pode homologar, por escrito, a ativação de uma política periódica. */
export type HomologationAuthority = 'legal_dpo' | 'ops' | 'security';

/**
 * Homologação ESCRITA. Os quatro campos são obrigatórios porque cada um é uma
 * pergunta que alguém fará depois: quem assinou, em que papel, quando, e onde
 * está o registro. Uma homologação sem `recorded_in` é um boato.
 */
export interface WrittenHomologation {
  readonly authority: HomologationAuthority;
  /** Papel ou pessoa que assinou, exatamente como consta do registro. */
  readonly approved_by: string;
  /** ISO-8601. */
  readonly approved_at: string;
  /** Onde o registro assinado vive (documento, ata, issue). */
  readonly recorded_in: string;
}

/**
 * Por que uma política periódica pode estar destruindo dado hoje.
 *
 * União fechada e obrigatória. `'none'` NÃO é uma autorização: é a forma de
 * declarar que não existe uma, e o guard reprova se a política estiver ativa.
 */
export type ActivationAuthorisation =
  | {
      readonly kind: 'written_homologation';
      readonly homologation: WrittenHomologation;
    }
  | {
      /**
       * Ativa por decisão do dono da plataforma, com a homologação ainda
       * DEVIDA. Só vale para `GRANDFATHERED_ACTIVATIONS`.
       */
      readonly kind: 'owner_ratified_pending_homologation';
      readonly ratified_by: 'platform_owner';
      /** Onde a ratificação foi recebida, como veio. */
      readonly ratified_in: string;
      /** De quem a homologação escrita ainda é devida. */
      readonly owed_from: HomologationAuthority;
      /** O que exatamente falta homologar. */
      readonly what_is_owed: string;
    }
  | {
      readonly kind: 'none';
      /** Por que não há autorização — e, portanto, por que não pode ativar. */
      readonly why: string;
    };

export interface PeriodicPolicy {
  /** Identificador estável; é o que a lista de grandfathering referencia. */
  readonly id: string;
  /** Classe do inventário sobre a qual a política age. */
  readonly data_class: string;
  /** Cadência, como está registrada em `src/workers/index.ts`. */
  readonly cadence: string;
  /** O que ela destrói quando está ativa — em uma linha, sem eufemismo. */
  readonly destroys: string;
  /**
   * Está destruindo HOJE, com os defaults do contrato de configuração.
   * Declarado à mão e CONFERIDO contra o contrato pelo guard (ver
   * `dry_run_var`), para que a declaração não possa envelhecer em silêncio.
   */
  readonly active_by_default: boolean;
  /**
   * Variável do contrato cujo default decide a ativação. Convenção do repo:
   * dry-run LIGADO ⇒ política INATIVA. `null` quando não há chave (a política
   * não tem interruptor de dry-run).
   */
  readonly dry_run_var: string | null;
  /** Obrigatório. Sem campo opcional, sem default. */
  readonly authorisation: ActivationAuthorisation;
}

/**
 * As políticas periódicas que existem hoje. Adicionar uma linha aqui sem
 * `authorisation` é erro de compilação; adicioná-la ATIVA sem homologação
 * escrita é reprovação de teste.
 */
export const PERIODIC_POLICIES: readonly PeriodicPolicy[] = Object.freeze([
  {
    id: 'privacy.export.ttl_sweep',
    data_class: 'privacy.export',
    cadence: '50 * * * * (horária) — src/workers/index.ts, `privacy_export_sweep`',
    destroys: 'o pacote `.enc` com os dados consolidados de um titular, vencido o prazo carimbado na emissão',
    // ATIVO. `PRIVACY_EXPORT_SWEEP_DRY_RUN` tem default `false` de propósito:
    // aqui a direção segura é EXECUTAR, porque um varredor inerte deixa o
    // pacote cifrado no disco para sempre.
    active_by_default: true,
    dry_run_var: 'PRIVACY_EXPORT_SWEEP_DRY_RUN',
    authorisation: {
      kind: 'owner_ratified_pending_homologation',
      ratified_by: 'platform_owner',
      ratified_in:
        'issue #536 — política INICIAL de sete dias decidida pelo dono da plataforma (PRIVACY_EXPORT_TTL_DAYS)',
      owed_from: 'legal_dpo',
      what_is_owed:
        'confirmar ou substituir o prazo de sete dias; o mecanismo já está em produção varrendo de hora em hora, então a confirmação é sobre comportamento vigente e não sobre uma proposta',
    },
  },
  {
    id: 'backup.artifact.retention_sweep',
    data_class: 'backup.artifact',
    cadence: '0 4 * * 0 (semanal) — src/workers/index.ts, `backup_retention`',
    destroys: 'artefatos de backup mais velhos que a retenção local/off-site configurada',
    // INATIVA: `RETENTION_DRY_RUN` tem default `true`, então o passe semanal
    // CONTA e não apaga. Ligar isso é o caso exato que a trava cobre.
    active_by_default: false,
    dry_run_var: 'RETENTION_DRY_RUN',
    authorisation: {
      kind: 'none',
      why: 'a janela máxima em que um titular já apagado pode continuar existindo dentro de um artefato retido é decisão aberta de Legal/DPO (classe `backup.artifact`); enquanto ela não for homologada por escrito, desligar o dry-run é ativar uma política periódica sem homologação',
    },
  },
  {
    id: 'retention.class_purge',
    data_class: '*',
    cadence: 'nenhuma — não existe job por classe; `resolveRetention` recusa tudo hoje',
    destroys: 'linhas de qualquer classe do inventário, por prazo, quando uma RETENTION_POLICY aprovada existir',
    active_by_default: false,
    dry_run_var: 'RETENTION_DRY_RUN',
    authorisation: {
      kind: 'none',
      why: 'nenhum prazo por classe foi decidido — `RETENTION_POLICY` ausente ⇒ `resolveRetention` devolve `purgeable: false` para todas as classes. A homologação escrita do prazo é o que falta, por classe',
    },
  },
]);

/**
 * A lista FECHADA de ativações que já estavam de pé quando a trava entrou.
 *
 * É o que dá sentido operacional à palavra "nova": uma política que não está
 * aqui não consegue se declarar ativa apoiada apenas na ratificação do dono.
 * Acrescentar um id aqui é uma mudança visível no diff, discutível na revisão —
 * que é exatamente o efeito pretendido.
 */
export const GRANDFATHERED_ACTIVATIONS: readonly string[] = Object.freeze([
  'privacy.export.ttl_sweep',
]);

/**
 * Classes cuja NÃO-purgabilidade é estrutural e já foi decidida. Promover
 * qualquer uma delas a purgável é uma mudança de desenho, não um ajuste de
 * prazo, e o guard a trata como tal.
 */
export const RATIFIED_NON_PURGEABLE: Readonly<Record<string, string>> = Object.freeze({
  'privacy.tombstone':
    'ratificada pelo dono na issue #536: não-purgável é mais forte que um prazo mínimo, porque elimina a aritmética "mínimo do tombstone > máximo do backup" em vez de tentar acertá-la',
  'postgres.financial':
    'retenção contábil estatutária sobrepõe o apagamento; o prazo e a base legal são decisão aberta de Legal/DPO',
  'gateway.baileys_session':
    'segredo operacional: o ciclo de vida é rotação/revogação e o caminho de recuperação é o re-pareamento, não a expiração por prazo',
});

export type HomologationViolationCode =
  /** Ativa e declarando que não há autorização. */
  | 'active_without_authorisation'
  /** Ativa apoiada só na ratificação do dono, e não está no grandfathering. */
  | 'new_activation_without_written_homologation'
  /** A declaração de ativação não bate com o default do contrato. */
  | 'activation_declaration_mismatch'
  /** Uma classe resolve purgável e nenhuma política homologada a cobre. */
  | 'purgeable_class_without_homologated_policy'
  /** Uma classe estruturalmente não-purgável deixou de ser. */
  | 'ratified_non_purgeable_class_became_purgeable';

export interface HomologationViolation {
  readonly code: HomologationViolationCode;
  readonly policy_id: string | null;
  readonly data_class: string | null;
  /** Frase única, legível na saída do teste, dizendo o que fazer. */
  readonly detail: string;
}

export interface HomologationAuditInput {
  /** Default: `PERIODIC_POLICIES`. */
  readonly policies?: readonly PeriodicPolicy[];
  /** Default: `DATA_CLASSES`. */
  readonly classes?: readonly DataClass[];
  /** Política de retenção em vigor. Default: `UNAPPROVED_POLICY`. */
  readonly retentionPolicy?: RetentionPolicy;
  /**
   * Lê o DEFAULT do contrato para uma variável de dry-run. Injetado para que
   * este módulo não importe configuração; o guard passa um leitor que consulta
   * `ENV_CONTRACT` de verdade, e não uma cópia à mão. `undefined` ⇒ variável
   * desconhecida, e isso também é uma violação (a declaração aponta para uma
   * chave que não existe mais).
   */
  readonly dryRunDefault?: (varName: string) => boolean | undefined;
  /** Default: `GRANDFATHERED_ACTIVATIONS`. */
  readonly grandfathered?: readonly string[];
}

/** Uma autorização que basta para uma política JÁ ATIVA, dada a lista fechada. */
function authorises(policy: PeriodicPolicy, grandfathered: readonly string[]): boolean {
  switch (policy.authorisation.kind) {
    case 'written_homologation':
      return true;
    case 'owner_ratified_pending_homologation':
      return grandfathered.includes(policy.id);
    case 'none':
      return false;
  }
}

/**
 * O guard. Devolve TODA violação encontrada — nunca lança e nunca para na
 * primeira: um relatório que mostra uma violação por vez faz o revisor
 * consertar em N rodadas e é como uma segunda violação passa despercebida.
 *
 * Puro. Sem relógio, sem IO, sem `process.env`.
 */
export function auditPeriodicPolicies(
  input: HomologationAuditInput = {},
): HomologationViolation[] {
  const policies = input.policies ?? PERIODIC_POLICIES;
  const classes = input.classes ?? DATA_CLASSES;
  const retentionPolicy = input.retentionPolicy ?? UNAPPROVED_POLICY;
  const grandfathered = input.grandfathered ?? GRANDFATHERED_ACTIVATIONS;
  const violations: HomologationViolation[] = [];

  for (const p of policies) {
    if (p.active_by_default && p.authorisation.kind === 'none') {
      violations.push({
        code: 'active_without_authorisation',
        policy_id: p.id,
        data_class: p.data_class,
        detail:
          `a política periódica '${p.id}' está ATIVA e declara que não há autorização ` +
          `("${p.authorisation.why}"). Nenhuma política periódica é ativada sem homologação ` +
          `escrita: preencha 'authorisation' com uma WrittenHomologation ou mantenha-a inativa.`,
      });
    }
    if (
      p.active_by_default &&
      p.authorisation.kind === 'owner_ratified_pending_homologation' &&
      !grandfathered.includes(p.id)
    ) {
      violations.push({
        code: 'new_activation_without_written_homologation',
        policy_id: p.id,
        data_class: p.data_class,
        detail:
          `a política periódica '${p.id}' foi ativada apoiada apenas na ratificação do dono, ` +
          `e ela não está em GRANDFATHERED_ACTIVATIONS. A ratificação cobre o que já estava de ` +
          `pé; uma política NOVA exige homologação escrita de '${p.authorisation.owed_from}' antes de ativar.`,
      });
    }
    if (p.dry_run_var !== null && input.dryRunDefault) {
      const dryRun = input.dryRunDefault(p.dry_run_var);
      if (dryRun === undefined) {
        violations.push({
          code: 'activation_declaration_mismatch',
          policy_id: p.id,
          data_class: p.data_class,
          detail:
            `a política '${p.id}' diz que sua ativação é decidida por '${p.dry_run_var}', e essa ` +
            `variável não existe no contrato de configuração. A declaração de ativação virou ficção.`,
        });
      } else if (!dryRun !== p.active_by_default) {
        violations.push({
          code: 'activation_declaration_mismatch',
          policy_id: p.id,
          data_class: p.data_class,
          detail:
            `a política '${p.id}' declara active_by_default=${String(p.active_by_default)}, mas o ` +
            `default de '${p.dry_run_var}' no contrato é ${String(dryRun)} — ou seja, ela ` +
            `${dryRun ? 'NÃO destrói' : 'DESTRÓI'} com a configuração default. ` +
            `Se ela passou a destruir, a homologação escrita vem ANTES de ligar.`,
        });
      }
    }
  }

  const homologatedClasses = new Set(
    policies.filter((p) => authorises(p, grandfathered)).map((p) => p.data_class),
  );

  for (const c of classes) {
    const frozenReason = RATIFIED_NON_PURGEABLE[c.id];
    if (frozenReason !== undefined && c.purge_mechanism !== 'not_purgeable') {
      violations.push({
        code: 'ratified_non_purgeable_class_became_purgeable',
        policy_id: null,
        data_class: c.id,
        detail:
          `'${c.id}' deixou de ser 'not_purgeable' (agora '${c.purge_mechanism}'). Essa classe é ` +
          `estruturalmente não-purgável: ${frozenReason}. Promovê-la é uma mudança de DESENHO e ` +
          `precisa da homologação escrita registrada antes, não depois.`,
      });
    }
    const verdict = resolveRetention(c.id, retentionPolicy);
    if (!verdict.purgeable) continue;
    if (homologatedClasses.has(c.id) || homologatedClasses.has('*')) continue;
    violations.push({
      code: 'purgeable_class_without_homologated_policy',
      policy_id: null,
      data_class: c.id,
      detail:
        `a classe '${c.id}' resolve purgável (${String(verdict.retention_days)} dias, política ` +
        `'${verdict.policy_version}') e nenhuma política periódica homologada a cobre. ` +
        `Um prazo em vigor sem homologação escrita é exatamente o que a trava da issue #536 impede.`,
    });
  }

  return violations;
}
