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
 * ─────────────────────────────────────────────────────────────────────────
 * DUAS CAMADAS, UM AVALIADOR (PR #737, decisão do dono de 2026-09-07).
 *
 * `auditPeriodicPolicies()` alcança o que está DECLARADO no código e os
 * DEFAULTS do contrato — roda no CI, sem ambiente. Ele não vê um operador que
 * exporte `RETENTION_DRY_RUN=false` ou instale uma `RETENTION_POLICY` real.
 *
 * `evaluatePeriodicPolicyActivation(cfg)` alcança a configuração EFETIVA: ele
 * recebe a configuração JÁ PARSEADA (o `Config` de `src/config/env.ts`, ou os
 * `values` que `validateConfig` produz para cada serviço no preflight) e diz,
 * por política, se ela DESTRÓI com esses valores e se tem autorização para
 * isso. O MESMO avaliador é chamado em dois lugares — `npm run config:preflight`
 * (`src/config/preflight.ts`, antes do `docker compose up`) e o boot
 * (`src/index.ts`, passo `config`, antes de banco, filas e workers) — para que
 * não existam duas leituras do que é "ativa".
 *
 * O interruptor de rollback do loader de configuração (`MAIA_CONFIG_STRICT_BOOT`,
 * lido SÓ em `src/config/env.ts`) não chega aqui: este módulo não lê
 * `process.env`, não recebe o valor dele e não tem parâmetro para desligar a
 * trava. Aquele interruptor governa a validação de CONTRATO; uma política
 * periódica destruindo dado de titular sem homologação escrita não é uma
 * inconsistência de contrato, é a coisa que a direção do dono proíbe.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * O QUE ESTE MÓDULO NÃO FAZ. Não ativa nada, não apaga nada e não é consultado
 * por nenhum executor. Ele é uma declaração verificável do estado de ativação
 * mais as regras que dizem quando esse estado é ilegítimo — e o veredito que
 * preflight e boot usam para recusar um ambiente que o contradiga.
 */
import {
  DATA_CLASSES,
  UNAPPROVED_POLICY,
  parseRetentionPolicy,
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
  /**
   * Variável que carrega a `RETENTION_POLICY` aprovada, quando a ativação
   * EFETIVA exige, além do dry-run desligado, uma política que nomeie ao menos
   * uma classe purgável (`parseRetentionPolicy` já descarta as não-purgáveis).
   * `null` quando o dry-run sozinho decide. Obrigatório: uma política que
   * dependa da RETENTION_POLICY e não diga isso aqui seria avaliada como ativa
   * só pelo dry-run — falso positivo hoje, e amanhã a razão de alguém afrouxar
   * a trava.
   */
  readonly policy_var: string | null;
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
    policy_var: null,
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
    // Só o dry-run decide: o passe semanal apaga artefatos pelo prazo de
    // BACKUP_RETENTION_*_DAYS, sem consultar RETENTION_POLICY.
    policy_var: null,
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
    // Dry-run desligado E uma RETENTION_POLICY aprovada nomeando ao menos uma
    // classe purgável: é o par que faz `resolveRetention` devolver
    // `purgeable: true` para alguma classe.
    policy_var: 'RETENTION_POLICY',
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

// ───────────────────────────────────────────────────────────────────────────
// A configuração EFETIVA — o mesmo avaliador no preflight e no boot (PR #737)
// ───────────────────────────────────────────────────────────────────────────

/**
 * A configuração JÁ PARSEADA, vista como mapa de nome → valor. É o que o
 * `Config` de `src/config/env.ts` é (o objeto do schema
 * `objectSchemaForService('runtime')`) e o que `validateConfig(...).values`
 * devolve por serviço no preflight. Só chaves de contrato entram; o avaliador
 * lê as que cada política declara em `dry_run_var`/`policy_var` e nada mais.
 */
export type EffectiveConfigView = Readonly<Record<string, unknown>>;

export type EffectiveActivationViolationCode =
  /** A política DESTRÓI com estes valores e não tem homologação escrita. */
  | 'destructive_policy_active_without_homologation'
  /**
   * A configuração não traz um valor tipado para a variável que decide a
   * ativação. Fail-closed: o que não está provado inativo não é tratado como
   * inativo — o chamador passou uma configuração que não permite decidir.
   */
  | 'activation_undeterminable';

/**
 * Uma violação da configuração efetiva. O contrato de saída é o do preflight e
 * do boot (`src/config/preflight.ts`, `src/config/env.ts`): NOME da variável,
 * REGRA e REMEDIAÇÃO — nunca o valor. Nenhum campo aqui carrega o conteúdo de
 * `RETENTION_POLICY` nem o valor de um dry-run; só os nomes.
 */
export interface EffectiveActivationViolation {
  readonly code: EffectiveActivationViolationCode;
  readonly policy_id: string;
  readonly data_class: string;
  /** As variáveis que decidem a ativação desta política, pelo NOME. */
  readonly variables: readonly string[];
  /** Identificador estável, greppável — mesmo formato das regras do contrato. */
  readonly rule:
    | 'homologation/active-without-written-homologation'
    | 'homologation/activation-undeterminable';
  readonly message: string;
  readonly remediation: string;
}

export interface PolicyActivationVerdict {
  readonly id: string;
  readonly data_class: string;
  /** Destrói com a configuração efetiva recebida. */
  readonly active_effective: boolean;
  /** Tem autorização que baste para estar ativa (homologação escrita, ou grandfathering). */
  readonly authorised: boolean;
  /** As variáveis lidas para decidir `active_effective`, pelo nome. */
  readonly deciding_variables: readonly string[];
  readonly violation?: EffectiveActivationViolation;
}

export interface HomologationVerdict {
  /** `true` ⇔ nenhuma violação. */
  readonly ok: boolean;
  readonly policies: readonly PolicyActivationVerdict[];
  readonly violations: readonly EffectiveActivationViolation[];
}

export interface EvaluateActivationInput {
  /** Default: `PERIODIC_POLICIES`. */
  readonly policies?: readonly PeriodicPolicy[];
  /** Default: `GRANDFATHERED_ACTIVATIONS`. */
  readonly grandfathered?: readonly string[];
}

/**
 * As variáveis de configuração que decidem a ativação EFETIVA de alguma
 * política periódica declarada. Quem avalia um subset do contrato que não as
 * declara (o `migrator`, o `admin-ui`) não tem o que avaliar: aquele processo
 * não executa política periódica nenhuma.
 */
export function periodicPolicyDecidingVariables(
  policies: readonly PeriodicPolicy[] = PERIODIC_POLICIES,
): readonly string[] {
  const out = new Set<string>();
  for (const p of policies) {
    if (p.dry_run_var !== null) out.add(p.dry_run_var);
    if (p.policy_var !== null) out.add(p.policy_var);
  }
  return [...out].sort();
}

/**
 * O avaliador da configuração EFETIVA. PURO: sem I/O, sem relógio, sem
 * `process.env`, sem banco — recebe a configuração parseada e devolve o
 * veredito por política. É chamado pelo `config:preflight` para cada serviço
 * cujo subset declara as variáveis decisórias, e pelo boot (`src/index.ts`)
 * com o `config` do processo, ANTES de banco, filas e workers.
 *
 * Não existe parâmetro para desligá-lo, e ele não conhece o interruptor de
 * rollback do loader de contrato — de propósito: ver o cabeçalho do módulo.
 *
 * Fonte da verdade da ativação: o valor EFETIVO das variáveis que cada
 * política declara. Convenção do repo: dry-run LIGADO ⇒ política INATIVA.
 * Quando `policy_var` está declarado, a ativação exige ALÉM disso uma
 * `RETENTION_POLICY` que `parseRetentionPolicy` aceite e que nomeie ao menos
 * uma classe purgável — exatamente a condição sob a qual `resolveRetention`
 * passa a devolver `purgeable: true` para alguma classe.
 */
export function evaluatePeriodicPolicyActivation(
  cfg: EffectiveConfigView,
  input: EvaluateActivationInput = {},
): HomologationVerdict {
  const policies = input.policies ?? PERIODIC_POLICIES;
  const grandfathered = input.grandfathered ?? GRANDFATHERED_ACTIVATIONS;
  const verdicts: PolicyActivationVerdict[] = [];

  for (const p of policies) {
    const deciding: string[] = [];
    if (p.dry_run_var !== null) deciding.push(p.dry_run_var);
    if (p.policy_var !== null) deciding.push(p.policy_var);
    const authorised = authorises(p, grandfathered);

    let active: boolean;
    let undeterminable: string | null = null;

    if (p.dry_run_var === null) {
      // Sem interruptor: o estado declarado é o efetivo.
      active = p.active_by_default;
    } else {
      const dryRun = cfg[p.dry_run_var];
      if (typeof dryRun !== 'boolean') {
        undeterminable = p.dry_run_var;
        active = true;
      } else {
        active = !dryRun;
      }
    }

    if (undeterminable === null && active && p.policy_var !== null) {
      const raw = cfg[p.policy_var];
      if (raw !== undefined && typeof raw !== 'string') {
        undeterminable = p.policy_var;
      } else {
        const policy = parseRetentionPolicy(raw);
        active = policy.approved && Object.keys(policy.classes).length > 0;
      }
    }

    let violation: EffectiveActivationViolation | undefined;
    if (undeterminable !== null) {
      violation = {
        code: 'activation_undeterminable',
        policy_id: p.id,
        data_class: p.data_class,
        variables: deciding,
        rule: 'homologation/activation-undeterminable',
        message:
          `a configuração recebida não traz um valor tipado para '${undeterminable}', que decide se ` +
          `a política periódica '${p.id}' destrói. Sem esse valor a trava não consegue provar que ` +
          `ela está inativa, e o que não está provado inativo não passa.`,
        remediation:
          `Avalie a trava com a configuração parseada pelo contrato (src/config/contract.ts) do ` +
          `serviço que executa a política; se '${undeterminable}' saiu do contrato, atualize ` +
          `PERIODIC_POLICIES em src/ops/privacy/homologation.ts.`,
      };
    } else if (active && !authorised) {
      const why = describeMissingAuthorisation(p.authorisation);
      violation = {
        code: 'destructive_policy_active_without_homologation',
        policy_id: p.id,
        data_class: p.data_class,
        variables: deciding,
        rule: 'homologation/active-without-written-homologation',
        message:
          `a política periódica '${p.id}' está ATIVA nesta configuração — decidida por ` +
          `${deciding.map((v) => `'${v}'`).join(' + ')} — e ${why}. Ela destrói: ${p.destroys}. ` +
          `Nenhuma política periódica é ativada sem homologação escrita (issue #536).`,
        remediation:
          `Desative-a nesta configuração (${deciding.map((v) => `'${v}'`).join(', ')}) até que a ` +
          `homologação escrita exista; então registre-a em 'authorisation' da política em ` +
          `src/ops/privacy/homologation.ts e ligue. O interruptor de rollback do contrato de ` +
          `configuração não desliga esta trava — ver docs/runbooks/config-contract.md §4.1.`,
      };
    }

    verdicts.push({
      id: p.id,
      data_class: p.data_class,
      active_effective: active,
      authorised,
      deciding_variables: deciding,
      ...(violation ? { violation } : {}),
    });
  }

  const violations = verdicts.flatMap((v) => (v.violation ? [v.violation] : []));
  return { ok: violations.length === 0, policies: verdicts, violations };
}

/** Por que a autorização declarada NÃO basta para uma política ativa. */
function describeMissingAuthorisation(a: ActivationAuthorisation): string {
  switch (a.kind) {
    case 'none':
      return `declara que não há autorização ("${a.why}")`;
    case 'owner_ratified_pending_homologation':
      return (
        `está apoiada só na ratificação do dono e não está em GRANDFATHERED_ACTIVATIONS ` +
        `(homologação escrita devida de '${a.owed_from}')`
      );
    case 'written_homologation':
      // Inalcançável: `authorises` aceita homologação escrita sempre. Fica
      // explícito para o switch continuar exaustivo se a união crescer.
      return 'tem homologação escrita';
  }
}

/**
 * A mensagem de morte do boot: variável, regra e remediação por violação, sem
 * nenhum valor. O prefixo é greppável e distinto do `Invalid configuration:`
 * do contrato de propósito — um operador que leia o log tem de saber que NÃO
 * é o loader de configuração que recusou, e que o rollback daquele loader não
 * se aplica aqui.
 */
export function formatHomologationBootFailure(
  violations: readonly EffectiveActivationViolation[],
): string {
  const body = violations
    .map(
      (v) =>
        `  - ${v.variables.join(' + ')} [${v.rule}] política '${v.policy_id}': ${v.message}\n` +
        `      → ${v.remediation}`,
    )
    .join('\n');
  return [
    `HOMOLOGATION BOOT REFUSED: ${violations.length} política(s) periódica(s) destrutiva(s) ` +
      `ativa(s) na configuração efetiva sem homologação escrita (issue #536).`,
    '',
    body,
    '',
    'Nenhum worker foi iniciado. Esta trava é independente da validação de contrato:',
    'o interruptor de rollback do loader (config-contract.md §4.1) NÃO a desliga.',
    'Matriz: docs/architecture/concerns/data-retention-matrix.md, seção "The lock".',
  ].join('\n');
}

/**
 * O erro que `src/index.ts` lança quando o veredito reprova. Carrega as
 * violações estruturadas para o log e a mensagem formatada para o `maia.fatal`.
 */
export class HomologationBootRefusedError extends Error {
  readonly violations: readonly EffectiveActivationViolation[];
  constructor(violations: readonly EffectiveActivationViolation[]) {
    super(formatHomologationBootFailure(violations));
    this.name = 'HomologationBootRefusedError';
    this.violations = violations;
  }
}
