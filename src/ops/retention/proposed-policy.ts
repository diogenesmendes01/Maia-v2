/**
 * Issue #536 — the owner's retention proposal, materialised.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS A PROPOSAL FOR HOMOLOGATION BY THE DPO AND THE ACCOUNTANT.
 * IT IS NOT LEGAL ADVICE, AND IT IS NOT A STATEMENT OF COMPLIANCE.
 *
 * The LGPD sets NO universal retention periods. It requires purpose,
 * necessity and elimination at the end of processing, save for the specific
 * exceptions it lists (arts. 6º and 15–18, plus ANPD guidance). Articles 173
 * and 174 of the CTN contain five-year windows for tax assessment and
 * collection — they are NOT a universal retention table, and the initial
 * milestone of each document has to be validated by the accountant.
 *
 * So every number below is an OPERATIONAL DEFAULT, configurable, PENDING
 * HOMOLOGATION — never an assertion that the platform is compliant. The
 * mechanism enforces that rather than trusting this comment:
 *
 *   - `approved_by` is the `pending_dpo_homologation` sentinel, so
 *     `parseRetentionPolicy` returns `homologated: false`;
 *   - every class ships `dry_run: true`, so nothing is armed even if the
 *     global lever is turned off;
 *   - `resolveActivation` refuses `enforce` on a non-homologated policy.
 *
 * Loading this policy therefore starts COUNTING and changes no deletion.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHY IT IS CODE AND NOT ONLY A TABLE IN A MARKDOWN FILE. A proposal an
 * operator must retype into an env var is a proposal that will be retyped
 * wrong. This module is the value that ships in `.env.example`, the value the
 * contract's `example` is pinned to, and the value the matrix document is
 * checked against — one artifact, three consumers, no transcription step.
 */
import {
  type RetentionPolicyInput,
  PENDING_HOMOLOGATION_APPROVER,
  getDataClass,
} from './data-classes.js';
import { DEFAULT_TOMBSTONE_MIN_DAYS } from './tombstone-floor.js';

/** Bump when the proposal changes: cycle observation is per version. */
export const PROPOSED_POLICY_VERSION = 'v1-proposta-owner-2026-07';

/**
 * Re-exported so the proposal reads standalone: the approver value that marks
 * a policy as awaiting homologation, and the literal an operator will read in
 * their env file.
 */
export { PENDING_HOMOLOGATION_APPROVER };

/** When the owner tabled the proposal — NOT when anyone approved it. */
export const PROPOSED_AT = '2026-07-31T00:00:00.000Z';

/** How a class's period is expressed. Not every class is "delete after N days". */
export type ProposedPeriodKind =
  /** Delete/anonymise/redact once N days elapse. */
  | 'purge_after'
  /** A MINIMUM the deployment must honour; the class is not purgeable in v1. */
  | 'minimum_floor'
  /** Clamped by a source class — see `./derivation.ts`. */
  | 'inherited'
  /** No period proposed: the class needs its own purpose first. */
  | 'undecided'
  /** No retention question here. */
  | 'not_applicable';

export interface ProposedClassPolicy {
  data_class: string;
  kind: ProposedPeriodKind;
  /** Days shipped in `RETENTION_POLICY.classes`, when the class carries one. */
  retention_days: number | null;
  /** The proposal in the owner's words. */
  policy: string;
  /**
   * The legal/operational basis AS DECLARED IN THE PROPOSAL. Declared, not
   * established: naming a basis here is what the DPO homologates or rejects.
   */
  declared_basis: string;
  /** What still depends on homologation before this row can be enforced. */
  pending_homologation: readonly string[];
}

/**
 * The proposal, per class. Mirrors
 * `docs/architecture/concerns/data-retention-matrix.md`; the drift between the
 * two is a test failure, not something a reader has to notice.
 */
export const PROPOSED_POLICY_ROWS: readonly ProposedClassPolicy[] = Object.freeze([
  {
    data_class: 'postgres.messages',
    kind: 'purge_after',
    retention_days: 180,
    policy:
      '180 dias após a última atividade da conversa. Vinculada a disputa ou obrigação legal, entra em legal hold e não expira.',
    declared_basis:
      'execução do atendimento e prestação de contas ao próprio titular; eliminação ao término do tratamento (LGPD art. 15), com as exceções do art. 16 quando houver disputa',
    pending_homologation: Object.freeze([
      'o DPO confirma 180 dias e a base declarada',
      'definir "última atividade" (última mensagem da conversa vs. último contato da pessoa) — hoje não há coluna que a materialize',
      'confirmar que legal hold é o único prolongamento aceito',
    ]),
  },
  {
    data_class: 'postgres.messages.audio_transcript',
    kind: 'purge_after',
    retention_days: 30,
    policy: 'Transcrições de áudio: 30 dias, prazo mais curto que o corpo da mensagem.',
    declared_basis:
      'necessidade (LGPD art. 6º, III): a transcrição existe para processar o turno, não para constituir histórico',
    pending_homologation: Object.freeze([
      'o DPO confirma o prazo mais curto para voz',
      'PRÉ-REQUISITO TÉCNICO: não existe coluna nem seletor de transcrição — hoje ela vive em `mensagens.conteudo`; sem esse seletor a classe conta zero e não é executável',
    ]),
  },
  {
    data_class: 'postgres.conversations',
    kind: 'inherited',
    retention_days: 180,
    policy:
      'O shell identificável NÃO sobrevive às mensagens. Estatística só permanece se for efetivamente anônima — sem telefone, JID, título, snippet ou identificador correlacionável.',
    declared_basis:
      'o shell é envelope das mensagens e não tem finalidade própria; dado anonimizado sai do escopo da lei (LGPD art. 12), desde que a anonimização seja irreversível',
    pending_homologation: Object.freeze([
      'o DPO confirma que a estatística proposta é efetivamente anônima e não apenas pseudonimizada',
      'PRÉ-REQUISITO TÉCNICO: a rotina que extrai a estatística anônima antes de apagar o shell não existe',
    ]),
  },
  {
    data_class: 'postgres.people',
    kind: 'purge_after',
    retention_days: 180,
    policy:
      'Após fim da relação, 180 dias de inatividade ou pedido de eliminação deferido: apagar nome, telefone, e-mail, JID, CPF e demais identificadores diretos; conservar só ID aleatório e estatística anônima. Identificador exigido contabilmente fica restrito ao registro financeiro correspondente.',
    declared_basis:
      'eliminação ao término do tratamento (LGPD art. 15) e atendimento ao art. 18, VI; a conservação restrita ao registro financeiro é exceção do art. 16, I (cumprimento de obrigação legal)',
    pending_homologation: Object.freeze([
      'o DPO confirma a lista de identificadores diretos a apagar',
      'o contador confirma QUAL identificador o registro financeiro exige, e por quê',
      'PRÉ-REQUISITO TÉCNICO: o executor de anonimização de `pessoas` não existe',
    ]),
  },
  {
    data_class: 'postgres.memory',
    kind: 'inherited',
    retention_days: 180,
    policy:
      'Herda o MENOR prazo das fontes e nunca prolonga silenciosamente a vida de uma mensagem.',
    declared_basis:
      'necessidade (LGPD art. 6º, III): memória derivada não pode ter finalidade mais ampla que o dado do qual deriva',
    pending_homologation: Object.freeze([
      'o DPO confirma a herança como regra, e não caso a caso',
    ]),
  },
  {
    data_class: 'postgres.memory.pinned',
    kind: 'undecided',
    retention_days: null,
    policy:
      'Memória fixada explicitamente pelo usuário exige finalidade e prazo próprios — por isso NÃO herda o prazo da fonte, e por isso ainda não tem período proposto.',
    declared_basis:
      'a fixar: um ato explícito do usuário sugere consentimento/legítimo interesse próprio, mas a finalidade precisa ser declarada antes do prazo',
    pending_homologation: Object.freeze([
      'declarar a finalidade da memória fixada',
      'só então propor o prazo — um número antes da finalidade seria exatamente a suposição jurídica que a #520 proíbe',
    ]),
  },
  {
    data_class: 'postgres.financial',
    kind: 'minimum_floor',
    retention_days: null,
    policy:
      'Piso operacional de 5 anos + exercício corrente, com extensão por disputa ou legal hold. Não purgável a pedido.',
    declared_basis:
      'obrigação legal/regulatória e exercício regular de direitos (LGPD art. 16, I e III). Os arts. 173–174 do CTN têm janelas de cinco anos, mas NÃO constituem tabela universal de retenção — o marco inicial depende do documento',
    pending_homologation: Object.freeze([
      'O CONTADOR valida o marco inicial de CADA tipo de documento — é dele a decisão, não do código',
      'o DPO confirma que a exceção contábil prevalece sobre um pedido de eliminação, e em que extensão',
    ]),
  },
  {
    data_class: 'postgres.audit',
    kind: 'purge_after',
    retention_days: 180,
    policy:
      'Redigir conteúdo livre e identificadores após 180 dias. Conservar 5 anos apenas o esqueleto probatório: pseudônimo do ator, ação, decisão, política, timestamps, hashes e resultado.',
    declared_basis:
      'exercício regular de direitos e prestação de contas (LGPD art. 16, II e III); "auditabilidade não justifica conservar conteúdo bruto indefinidamente"',
    pending_homologation: Object.freeze([
      'o DPO e o time de segurança confirmam QUAIS campos podem ser redigidos sem destruir o valor probatório',
      'confirmar os 5 anos do esqueleto — hoje é piso operacional, não prazo legal apurado',
      'PRÉ-REQUISITO TÉCNICO: o executor de redaction de `audit_logs` não existe',
    ]),
  },
  {
    data_class: 'postgres.traces',
    kind: 'purge_after',
    retention_days: 30,
    policy:
      '30 dias para prompts, respostas e bodies de debug. Extensão só por legal hold ligado a incidente concreto. PRIMEIRA CLASSE A ATIVAR.',
    declared_basis:
      'necessidade (LGPD art. 6º, III): o corpo do trace existe para depurar um incidente recente, não para constituir histórico',
    pending_homologation: Object.freeze([
      'o DPO confirma 30 dias',
      'confirmar que legal hold ligado a incidente é o único prolongamento',
    ]),
  },
  {
    data_class: 'media.blobs',
    kind: 'purge_after',
    retention_days: 7,
    policy:
      'Efêmera, SEM backup: apagar em até 7 dias após processamento bem-sucedido. Comprovante que precise de guarda vai para uma futura classe documental cifrada, não fica no blob genérico.',
    declared_basis:
      'necessidade (LGPD art. 6º, III): o blob existe para ser processado; o resultado do processamento é o que tem finalidade duradoura',
    pending_homologation: Object.freeze([
      'o DPO confirma que o descarte da mídia bruta é aceitável para o titular',
      'PRÉ-REQUISITO TÉCNICO: não existe a classe documental cifrada para onde um comprovante deveria migrar, nem o executor que varre `/app/media`',
    ]),
  },
  {
    data_class: 'gateway.baileys_session',
    kind: 'not_applicable',
    retention_days: null,
    policy:
      'Segredo operacional, não dado pessoal. Ciclo de vida é rotação/revogação; recuperação é re-pareamento.',
    declared_basis: 'não é tratamento de dado pessoal do titular — decisão do dono de segurança',
    pending_homologation: Object.freeze([
      'o dono de segurança aprova re-pareamento vs. backup cifrado',
    ]),
  },
  {
    data_class: 'queue.redis',
    kind: 'not_applicable',
    retention_days: null,
    policy: 'Reconstruível a partir do Postgres. TTLs pertencem a ops.',
    declared_basis: 'sem dado pessoal independente — a fonte da verdade é o Postgres',
    pending_homologation: Object.freeze([]),
  },
  {
    data_class: 'backup.artifact',
    kind: 'purge_after',
    retention_days: 30,
    policy:
      'Aprovar os valores atuais: 7 dias local, 30 dias off-site. Dado eliminado pode persistir no backup cifrado por no máximo 30 dias, mas tombstones devem ser reconciliados antes da liberação de tráfego.',
    declared_basis:
      'segurança da informação e continuidade (LGPD art. 6º, VII); a janela de persistência é limitada e coberta pelo ledger anti-ressurreição',
    pending_homologation: Object.freeze([
      'o DPO confirma que 30 dias é a janela máxima aceitável de persistência de dado eliminado num artefato retido',
      'a fonte operacional continua sendo BACKUP_RETENTION_LOCAL_DAYS/BACKUP_RETENTION_CLOUD_DAYS; este número é o teto que a política declara',
    ]),
  },
  {
    data_class: 'privacy.export',
    kind: 'purge_after',
    retention_days: 7,
    policy:
      'Expira em 7 dias OU no primeiro download confirmado, o que ocorrer primeiro. Sempre cifrado, com link revogável.',
    declared_basis:
      'necessidade e segurança (LGPD art. 6º, III e VII): o pacote é uma cópia integral do titular e cada dia extra é exposição sem finalidade',
    pending_homologation: Object.freeze([
      'o DPO confirma 7 dias e a expiração no primeiro download',
      'PRÉ-REQUISITO TÉCNICO: a geração do export cifrado ainda não existe (#536, critério 2)',
    ]),
  },
  {
    data_class: 'privacy.tombstone',
    kind: 'minimum_floor',
    retention_days: null,
    policy:
      `DECISÃO TÉCNICA, não jurídica: mínimo de ${DEFAULT_TOMBSTONE_MIN_DAYS} dias com os backups atuais, mantendo a regra automática ` +
      '`tombstone > maior retenção de backup`. Na v1 continua NÃO purgável.',
    declared_basis:
      'não é retenção de dado pessoal — o ledger guarda pseudônimos. É o prazo mínimo para que a proteção anti-ressurreição sobreviva a todo artefato que ainda possa conter o dado apagado',
    pending_homologation: Object.freeze([
      'nada: esta é a única linha da matriz que NÃO depende do DPO. Está resolvida e é enforçada por `retention/tombstone-exceeds-backup` (escopo boot)',
    ]),
  },
]);

const ROW_BY_CLASS = new Map(PROPOSED_POLICY_ROWS.map((r) => [r.data_class, r]));

export function proposedRowFor(classId: string): ProposedClassPolicy | undefined {
  return ROW_BY_CLASS.get(classId);
}

/**
 * The proposal as `RETENTION_POLICY` expects it.
 *
 * Only rows that carry a day count appear — a class with `kind: 'minimum_floor'`
 * or `'undecided'` has nothing to purge after, and `parseRetentionPolicy` would
 * drop the non-purgeable ones anyway. `dry_run: true` on every entry is the
 * point: the policy is loadable today and arms nothing.
 */
export const PROPOSED_RETENTION_POLICY: RetentionPolicyInput = Object.freeze({
  version: PROPOSED_POLICY_VERSION,
  approved_by: PENDING_HOMOLOGATION_APPROVER,
  approved_at: PROPOSED_AT,
  classes: Object.freeze(
    Object.fromEntries(
      PROPOSED_POLICY_ROWS.filter(
        (r) => r.retention_days !== null && getDataClass(r.data_class).purge_mechanism !== 'not_purgeable',
      ).map((r) => [r.data_class, { retention_days: r.retention_days as number, dry_run: true }]),
    ),
  ),
});

/**
 * Serialised, byte-for-byte what ships as the contract `example` and in
 * `.env.example`. `tests/unit/ops/retention-proposed-policy.spec.ts` pins the
 * contract to this string, so the two cannot drift.
 */
export const PROPOSED_RETENTION_POLICY_JSON = JSON.stringify(PROPOSED_RETENTION_POLICY);
