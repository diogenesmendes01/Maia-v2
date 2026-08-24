/**
 * Issue #536 §2 — o workflow LGPD, parte pura.
 *
 * A migration 102 já persiste `privacy_requests` com os invariantes de banco
 * (identidade verificada é pré-requisito para sair de `received`/
 * `identity_pending`; um export sem expiração é recusado; um titular não tem
 * dois pedidos destrutivos abertos ao mesmo tempo). O que faltava era o
 * MECANISMO: resolução do sujeito, export cifrado e execução da exclusão.
 *
 * Este arquivo é a metade que não toca em IO — a máquina de estados e a
 * resolução do sujeito. Ele é a fonte da verdade do vocabulário, e o CHECK da
 * migration é a segunda linha de defesa, não a primeira: um pedido que só
 * fosse barrado pelo banco chegaria lá tendo já executado o trabalho.
 *
 * PSEUDONIMIZAÇÃO. Nenhuma estrutura aqui carrega telefone, e-mail ou nome. O
 * sujeito circula como `subject_ref`, o HMAC de `src/ops/retention/
 * tombstones.ts`. É a mesma função que assina os tombstones, de propósito: o
 * ledger anti-ressurreição só consegue reconhecer "este dado restaurado é do
 * titular que pediu exclusão" se os dois lados derivarem o mesmo `subject_ref`
 * do mesmo identificador com o mesmo segredo.
 */
import { TypedError } from '@/lib/utils.js';
import { pseudonymize } from '@/ops/retention/tombstones.js';

export type PrivacyRequestType =
  | 'access_export'
  | 'rectification'
  | 'anonymization'
  | 'deletion';

export type PrivacyRequestStatus =
  | 'received'
  | 'identity_pending'
  | 'identity_verified'
  | 'approved'
  | 'in_progress'
  | 'completed'
  | 'denied'
  | 'failed';

/**
 * As transições legais, espelhando o CHECK de `privacy_requests`.
 *
 * `denied` e `failed` são alcançáveis de qualquer estado não terminal: uma
 * recusa jurídica (hold ativo) e uma falha técnica podem acontecer em qualquer
 * ponto, e um workflow que só soubesse falhar no fim ficaria preso em
 * `in_progress` para sempre.
 */
const TRANSITIONS: Readonly<Record<PrivacyRequestStatus, readonly PrivacyRequestStatus[]>> =
  Object.freeze({
    received: ['identity_pending', 'denied', 'failed'],
    identity_pending: ['identity_verified', 'denied', 'failed'],
    identity_verified: ['approved', 'denied', 'failed'],
    approved: ['in_progress', 'denied', 'failed'],
    in_progress: ['completed', 'denied', 'failed'],
    completed: [],
    denied: [],
    failed: [],
  });

const TERMINAL: ReadonlySet<PrivacyRequestStatus> = new Set<PrivacyRequestStatus>([
  'completed',
  'denied',
  'failed',
]);

export function isTerminalPrivacyStatus(s: PrivacyRequestStatus): boolean {
  return TERMINAL.has(s);
}

/**
 * O portão de transição.
 *
 * Lança em vez de devolver booleano pelo mesmo motivo de
 * `assertPurgeAllowed`: um chamador não pode ignorar por acidente. O atalho que
 * este portão existe para proibir é `approved → completed` — pular
 * `in_progress` faria o pedido nunca ter uma janela em que se sabe que ele
 * está executando, e é justamente nessa janela que uma execução interrompida
 * precisa ser encontrada.
 */
export function assertPrivacyTransition(
  from: PrivacyRequestStatus,
  to: PrivacyRequestStatus,
): void {
  const allowed = TRANSITIONS[from];
  if (!allowed) {
    throw new TypedError('privacy_unknown_status', 'unknown privacy request status', { from });
  }
  if (!allowed.includes(to)) {
    throw new TypedError(
      'privacy_illegal_transition',
      `privacy request cannot go from ${from} to ${to}`,
      { from, to },
    );
  }
}

/**
 * Um identificador que o titular apresentou, ANTES de virar `subject_ref`.
 *
 * `kind` é fechado porque cada forma tem uma canonicalização própria, e duas
 * canonicalizações diferentes do mesmo telefone produzem dois `subject_ref`
 * diferentes — o que significaria excluir metade dos dados do titular e deixar
 * a outra metade viva, sem ninguém perceber.
 */
export interface SubjectIdentifier {
  kind: 'phone_e164' | 'person_id';
  value: string;
}

export interface SubjectResolution {
  subject_ref: string;
  /** A forma canônica, só para o chamador auditar o KIND — nunca o valor. */
  kind: SubjectIdentifier['kind'];
}

const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Canonicaliza e pseudonimiza o identificador do titular.
 *
 * FALHA FECHADO em toda dúvida. Um `subject_ref` derivado de um identificador
 * que não pôde ser canonicalizado com certeza é pior que nenhum: ele parece um
 * sujeito válido, não bate com nada, e o pedido de exclusão "completa" sem ter
 * apagado uma linha — a pior falha possível para este módulo, porque produz
 * evidência de conformidade sem a conformidade.
 *
 * O escopo entra na derivação. Sem ele, o mesmo telefone em dois tenants
 * produziria o mesmo `subject_ref`, e um hold do tenant A apareceria como
 * proteção do tenant B (ou, pior, uma exclusão pedida em A casaria com dado de
 * B). É a invariante nº 1 do `AGENTS.md` aplicada ao ledger.
 */
export function resolveSubjectRef(
  scope: { tenant_id: string; agent_id: string },
  identifier: SubjectIdentifier,
  secret: string,
): SubjectResolution {
  for (const [field, value] of [
    ['tenant_id', scope.tenant_id],
    ['agent_id', scope.agent_id],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
      throw new TypedError(
        'privacy_subject_unscoped',
        `subject resolution requires a non-empty, trimmed ${field}`,
        { field },
      );
    }
  }
  if (scope.tenant_id === 'default' || scope.agent_id === 'default') {
    throw new TypedError(
      'privacy_subject_default_literal',
      'subject resolution refuses the legacy `default` sentinel — the caller is on an unmigrated path',
      {},
    );
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypedError(
      'privacy_subject_secret_missing',
      'subject resolution requires the tombstone secret — without it the ledger cannot recognise this subject later',
      {},
    );
  }

  const raw = typeof identifier?.value === 'string' ? identifier.value.trim() : '';
  let canonical: string;
  switch (identifier?.kind) {
    case 'phone_e164': {
      // Sem normalização "gentil": um telefone que não chega em E.164 é um
      // telefone que o resolvedor não sabe qual é. `src/gateway` já normaliza
      // na borda (migration 091), então quem chega aqui torto veio de um
      // caminho não migrado.
      if (!E164.test(raw)) {
        throw new TypedError(
          'privacy_subject_unresolvable',
          'phone identifier is not in E.164 form',
          { kind: identifier.kind },
        );
      }
      canonical = raw;
      break;
    }
    case 'person_id': {
      if (raw.length === 0) {
        throw new TypedError('privacy_subject_unresolvable', 'empty person identifier', {
          kind: identifier.kind,
        });
      }
      canonical = raw.toLowerCase();
      break;
    }
    default:
      throw new TypedError('privacy_subject_unresolvable', 'unknown subject identifier kind', {
        kind: String((identifier as { kind?: unknown } | undefined)?.kind ?? ''),
      });
  }

  return {
    subject_ref: pseudonymize(
      `${scope.tenant_id}|${scope.agent_id}|${identifier.kind}|${canonical}`,
      secret,
    ),
    kind: identifier.kind,
  };
}
