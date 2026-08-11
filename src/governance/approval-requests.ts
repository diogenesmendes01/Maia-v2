/**
 * Fase 0 cap. 2 — serviço de evidência backend de aprovação (migration 095).
 *
 * Fonte de verdade de TODA aprovação humana (confirmação simples e 4-eyes):
 *
 *   intent → request persistido (payload imutável + hash canônico versionado)
 *          → decisões humanas individuais (elegibilidade + distinção)
 *          → approved → claim (CAS, um vencedor) → execução → consumed
 *
 * O LLM nunca cria, assina, valida ou consome evidência: os únicos pontos de
 * entrada são o dispatcher (criação/claim/consume, server-side) e o
 * interceptador de respostas "aprova AP-xxxxxxxx" no pipeline inbound, que
 * identifica o humano pela LINHA WhatsApp autenticada — nunca por args.
 *
 * Elegibilidade por classe:
 *   - single_confirmation      — 1 decisão, exclusivamente do REQUESTER
 *                                (é a confirmação explícita dele, fora do LLM);
 *   - requester_plus_one_owner — requester (dono/co-dono) assina na criação;
 *                                falta 1 owner DISTINTO;
 *   - two_distinct_owners      — requester não qualificado não conta; 2 owners
 *                                distintos e ativos.
 */
import { createHash, randomUUID } from 'node:crypto';
import { config } from '@/config/env.js';
import {
  approvalRequestsRepo,
  approvalDecisionsRepo,
  pessoasRepo,
  type ApprovalClass,
} from '@/db/repositories.js';
import type { ApprovalRequest, Pessoa } from '@/db/schema.js';
import { audit } from './audit.js';
import { isOwnerType, listOwners } from './permissions.js';
import { logger } from '@/lib/logger.js';

export const INTENT_HASH_VERSION = 1;

/** Referência curta e pública (a única coisa que o LLM/usuário vê). */
export function approvalRef(request: Pick<ApprovalRequest, 'id'>): string {
  return `AP-${request.id.slice(0, 8)}`;
}

/**
 * JSON canônico: chaves ordenadas recursivamente, sem espaços. `undefined`
 * em objetos é omitido (semântica JSON); arrays preservam ordem.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/**
 * Hash canônico versionado do intent. Inclui tudo que precisa ser IMUTÁVEL
 * entre a aprovação e a execução: requester, entidade, tool, operation e os
 * args de negócio. Mudar qualquer campo relevante muda o hash — a evidência
 * não se transfere para outro payload.
 */
export function computeIntentHash(input: {
  tenant_id: string;
  agent_id: string;
  requester_pessoa_id: string;
  entidade_id: string | null;
  tool: string;
  operation_type: string;
  args: unknown;
  approval_class: ApprovalClass;
}): string {
  const canonical = canonicalJson({
    v: INTENT_HASH_VERSION,
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    requester_pessoa_id: input.requester_pessoa_id,
    entidade_id: input.entidade_id,
    tool: input.tool,
    operation_type: input.operation_type,
    approval_class: input.approval_class,
    args: input.args,
  });
  return `v${INTENT_HASH_VERSION}:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

export function requiredApprovalsFor(cls: ApprovalClass): number {
  return cls === 'single_confirmation' ? 1 : 2;
}

/** Classe para um requisito dual: dono/co-dono assina na criação e falta 1. */
export function dualClassFor(requester: Pessoa): ApprovalClass {
  return isOwnerType(requester) ? 'requester_plus_one_owner' : 'two_distinct_owners';
}

export type EnsureApprovalResult = {
  request: ApprovalRequest;
  created: boolean;
  ref: string;
};

/**
 * Garante um request aberto para o intent (idempotente por fingerprint).
 * Quando cria: audita, auto-registra a assinatura do requester quando a
 * classe conta com ela, e notifica os aprovadores fora da fronteira LLM.
 */
export async function ensureApprovalRequest(input: {
  tenant_id: string;
  agent_id: string;
  requester: Pessoa;
  entidade_id: string | null;
  conversa_id: string | null;
  mensagem_id: string | null;
  request_id: string | null;
  tool: string;
  operation_type: string;
  args: unknown;
  approval_class: ApprovalClass;
  reason: string;
  notify: (jid: string, text: string) => Promise<unknown>;
}): Promise<EnsureApprovalResult> {
  const intent_hash = computeIntentHash({
    tenant_id: input.tenant_id,
    agent_id: input.agent_id,
    requester_pessoa_id: input.requester.id,
    entidade_id: input.entidade_id,
    tool: input.tool,
    operation_type: input.operation_type,
    args: input.args,
    approval_class: input.approval_class,
  });

  const existing = await approvalRequestsRepo.findOpenByFingerprint(intent_hash);
  if (existing) {
    return { request: existing, created: false, ref: approvalRef(existing) };
  }

  const expires_at = new Date(Date.now() + config.DUAL_APPROVAL_TIMEOUT_HOURS * 3600 * 1000);
  const created = await approvalRequestsRepo.create({
    requester_pessoa_id: input.requester.id,
    entidade_id: input.entidade_id,
    conversa_id: input.conversa_id,
    mensagem_id: input.mensagem_id,
    request_id: input.request_id,
    tool: input.tool,
    operation_type: input.operation_type,
    intent_payload: input.args,
    intent_hash,
    intent_hash_version: INTENT_HASH_VERSION,
    approval_class: input.approval_class,
    required_approvals: requiredApprovalsFor(input.approval_class),
    fingerprint: intent_hash,
    expires_at,
  });
  if (!created) {
    // Perdeu a corrida da partial unique — o vencedor é o request aberto.
    const winner = await approvalRequestsRepo.findOpenByFingerprint(intent_hash);
    if (winner) return { request: winner, created: false, ref: approvalRef(winner) };
    throw new Error('approval_request_create_race_unresolved');
  }

  await audit({
    acao: 'approval_requested',
    pessoa_id: input.requester.id,
    conversa_id: input.conversa_id,
    mensagem_id: input.mensagem_id,
    entidade_alvo: input.entidade_id,
    alvo_id: created.id,
    metadata: {
      tool: input.tool,
      approval_class: input.approval_class,
      intent_hash_version: INTENT_HASH_VERSION,
      intent_hash_prefix: intent_hash.slice(0, 15),
      reason: input.reason,
    },
  });

  // Requester assina na criação SOMENTE quando a classe conta com ele.
  if (input.approval_class === 'requester_plus_one_owner') {
    await approvalDecisionsRepo.record({
      request_id: created.id,
      principal_pessoa_id: input.requester.id,
      principal_tipo: input.requester.tipo,
      decision: 'approve',
      channel: 'whatsapp',
      reason: 'requester_initiation',
    });
    await audit({
      acao: 'approval_decision_recorded',
      pessoa_id: input.requester.id,
      alvo_id: created.id,
      metadata: { decision: 'approve', role: 'requester', channel: 'whatsapp' },
    });
  }

  await notifyForRequest({
    request: created,
    requester: input.requester,
    reason: input.reason,
    notify: input.notify,
  }).catch((err) =>
    logger.warn({ err: (err as Error).message, request_id: created.id }, 'approval.notify_failed'),
  );

  return { request: created, created: true, ref: approvalRef(created) };
}

function jidOf(p: Pessoa): string {
  return p.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
}

async function notifyForRequest(input: {
  request: ApprovalRequest;
  requester: Pessoa;
  reason: string;
  notify: (jid: string, text: string) => Promise<unknown>;
}): Promise<void> {
  const ref = approvalRef(input.request);
  if (input.request.approval_class === 'single_confirmation') {
    const text =
      `Confirmação necessária (${ref}): ${input.reason}\n` +
      `Responda 'aprova ${ref}' para confirmar, ou 'recusa ${ref}' para cancelar.`;
    await input.notify(jidOf(input.requester), text);
    return;
  }
  const owners = await listOwners();
  const text =
    `Solicitação 4-eyes (${ref}) de ${input.requester.nome}: ${input.reason}\n` +
    `Responda 'aprova ${ref}' para aprovar, ou 'recusa ${ref}' para rejeitar.`;
  for (const o of owners) {
    if (
      input.request.approval_class === 'requester_plus_one_owner' &&
      o.id === input.requester.id
    ) {
      continue; // já assinou na criação — notificar só quem falta decidir
    }
    await input.notify(jidOf(o), text).catch((err) =>
      logger.warn({ err: (err as Error).message, pessoa_id: o.id }, 'approval.notify_failed'),
    );
  }
}

/**
 * Parser determinístico das respostas de aprovação no inbound ("aprova
 * AP-xxxxxxxx" / "recusa AP-xxxxxxxx"). Roda ANTES do LLM no pipeline — a
 * decisão humana nunca passa pelo modelo. Aceita o prefixo legado DA- para
 * mensagens antigas ainda em circulação.
 */
export function parseApprovalReply(
  text: string,
): { refPrefix: string; decision: 'approve' | 'deny' } | null {
  const m = /^\s*(aprova|aprovo|recusa|recuso|nego|nega)\s+(?:AP|DA)-([0-9a-fA-F]{8})\s*$/i.exec(
    text,
  );
  if (!m || !m[1] || !m[2]) return null;
  const verb = m[1].toLowerCase();
  return {
    refPrefix: m[2].toLowerCase(),
    decision: verb.startsWith('aprov') ? 'approve' : 'deny',
  };
}

/** Texto de resposta ao humano para cada desfecho da decisão. */
export function formatDecisionOutcome(outcome: DecisionOutcome): string {
  switch (outcome.outcome) {
    case 'approved':
      return `${outcome.ref} aprovada. Para executar, repita a operação original — ela será executada uma única vez com esta aprovação.`;
    case 'awaiting_more':
      return `${outcome.ref}: decisão registrada. Falta${outcome.missing > 1 ? 'm' : ''} ${outcome.missing} aprovação${outcome.missing > 1 ? 'ões' : ''}.`;
    case 'denied':
      return `${outcome.ref} recusada. A operação não será executada.`;
    case 'duplicate':
      return `${outcome.ref}: sua decisão já estava registrada (não conta duas vezes).`;
    case 'expired':
      return `${outcome.ref} expirou. Se ainda for necessária, peça a operação novamente.`;
    case 'not_eligible':
      return `${outcome.ref}: você não pode decidir esta solicitação (${outcome.reason}).`;
    case 'not_found':
      return 'Não encontrei uma solicitação de aprovação aberta com essa referência.';
  }
}

export type DecisionOutcome =
  | { outcome: 'approved'; request: ApprovalRequest; ref: string }
  | { outcome: 'awaiting_more'; request: ApprovalRequest; ref: string; missing: number }
  | { outcome: 'denied'; request: ApprovalRequest; ref: string }
  | { outcome: 'not_eligible'; ref: string; reason: string }
  | { outcome: 'duplicate'; ref: string }
  | { outcome: 'expired'; ref: string }
  | { outcome: 'not_found' };

/**
 * Registra a decisão de um humano identificado pela linha autenticada.
 * Revalida status/elegibilidade NO MOMENTO da decisão (não no da criação).
 */
export async function recordApprovalDecision(input: {
  refPrefix: string;
  approver: Pessoa;
  decision: 'approve' | 'deny';
  channel?: string;
}): Promise<DecisionOutcome> {
  const request = await approvalRequestsRepo.findOpenByRefPrefix(input.refPrefix);
  if (!request) return { outcome: 'not_found' };
  const ref = approvalRef(request);

  // Expiração lazy pelo relógio do banco (o worker também varre).
  if (request.status === 'pending' && new Date(request.expires_at) <= new Date()) {
    const expired = await approvalRequestsRepo.expireDue();
    if (expired.some((r) => r.id === request.id)) {
      await audit({ acao: 'approval_expired', alvo_id: request.id, metadata: {} });
    }
    return { outcome: 'expired', ref };
  }
  if (request.status !== 'pending') {
    return { outcome: 'not_eligible', ref, reason: `status='${request.status}'` };
  }
  if (input.approver.status !== 'ativa') {
    return { outcome: 'not_eligible', ref, reason: 'approver_inactive' };
  }

  const cls = request.approval_class as ApprovalClass;
  if (cls === 'single_confirmation') {
    if (input.approver.id !== request.requester_pessoa_id) {
      return { outcome: 'not_eligible', ref, reason: 'only_requester_confirms' };
    }
  } else {
    // Classes duais: quem decide precisa ser dono/co-dono ativo. O requester
    // (já contado na criação quando a classe permite) não conta duas vezes —
    // a unique (request, principal) bloqueia o duplicate.
    if (!isOwnerType(input.approver)) {
      return { outcome: 'not_eligible', ref, reason: 'approver_not_owner' };
    }
  }

  if (input.decision === 'deny') {
    const denied = await approvalRequestsRepo.markDenied(request.id);
    if (!denied) return { outcome: 'not_eligible', ref, reason: 'already_terminal' };
    await approvalDecisionsRepo.record({
      request_id: request.id,
      principal_pessoa_id: input.approver.id,
      principal_tipo: input.approver.tipo,
      decision: 'deny',
      channel: input.channel ?? 'whatsapp',
      reason: null,
    });
    await audit({
      acao: 'approval_denied',
      pessoa_id: input.approver.id,
      alvo_id: request.id,
      metadata: { tool: request.tool, approval_class: cls },
    });
    return { outcome: 'denied', request: denied, ref };
  }

  const recorded = await approvalDecisionsRepo.record({
    request_id: request.id,
    principal_pessoa_id: input.approver.id,
    principal_tipo: input.approver.tipo,
    decision: 'approve',
    channel: input.channel ?? 'whatsapp',
    reason: null,
  });
  if (!recorded) return { outcome: 'duplicate', ref };
  await audit({
    acao: 'approval_decision_recorded',
    pessoa_id: input.approver.id,
    alvo_id: request.id,
    metadata: { decision: 'approve', approval_class: cls, channel: input.channel ?? 'whatsapp' },
  });

  const decisions = await approvalDecisionsRepo.byRequest(request.id);
  const approvals = decisions.filter((d) => d.decision === 'approve');
  if (approvals.length >= request.required_approvals) {
    const approved = await approvalRequestsRepo.markApproved(request.id);
    if (approved) {
      await audit({
        acao: 'approval_granted',
        pessoa_id: input.approver.id,
        alvo_id: request.id,
        metadata: { tool: request.tool, approval_class: cls, approvals: approvals.length },
      });
      return { outcome: 'approved', request: approved, ref };
    }
    // CAS perdido (expirou/negado em corrida) — trate como não elegível.
    return { outcome: 'not_eligible', ref, reason: 'transition_lost' };
  }
  return {
    outcome: 'awaiting_more',
    request,
    ref,
    missing: request.required_approvals - approvals.length,
  };
}

export type ClaimOutcome =
  | { outcome: 'claimed'; request: ApprovalRequest; claim_token: string }
  | { outcome: 'pending'; request: ApprovalRequest; ref: string }
  | { outcome: 'none' };

/**
 * Procura evidência EXECUTÁVEL para o intent (mesmo fingerprint/hash) e a
 * reivindica atomicamente. Corrida entre dois executores tem um vencedor; o
 * perdedor vê 'pending'/'none' e NÃO executa.
 */
export async function claimExecutableApproval(input: {
  intent_hash: string;
  requester: Pessoa;
}): Promise<ClaimOutcome> {
  const open = await approvalRequestsRepo.findOpenByFingerprint(input.intent_hash);
  if (!open) return { outcome: 'none' };

  // A evidência pertence ao requester do intent — outra pessoa repetindo o
  // mesmo payload não herda a aprovação.
  if (open.requester_pessoa_id !== input.requester.id) {
    await audit({
      acao: 'approval_replay_blocked',
      pessoa_id: input.requester.id,
      alvo_id: open.id,
      metadata: { reason: 'requester_mismatch' },
    });
    return { outcome: 'none' };
  }

  if (open.status === 'pending') {
    return { outcome: 'pending', request: open, ref: approvalRef(open) };
  }
  if (open.status !== 'approved') {
    // 'claimed' — outro executor está com o claim; não execute em paralelo.
    return { outcome: 'pending', request: open, ref: approvalRef(open) };
  }

  // Revalida que o payload aprovado continua idêntico (imutabilidade).
  if (open.intent_hash !== input.intent_hash) {
    await audit({
      acao: 'approval_payload_mismatch',
      pessoa_id: input.requester.id,
      alvo_id: open.id,
      metadata: { stored_prefix: open.intent_hash.slice(0, 15) },
    });
    return { outcome: 'none' };
  }

  const claim_token = randomUUID();
  const claimed = await approvalRequestsRepo.claim({
    id: open.id,
    claim_token,
    intent_hash: input.intent_hash,
  });
  if (!claimed) return { outcome: 'pending', request: open, ref: approvalRef(open) };
  await audit({
    acao: 'approval_claimed',
    pessoa_id: input.requester.id,
    alvo_id: claimed.id,
    metadata: { tool: claimed.tool },
  });
  return { outcome: 'claimed', request: claimed, claim_token };
}

/** Consumo one-time após execução REAL (audit reflete o efeito verdadeiro). */
export async function consumeApproval(input: {
  request: ApprovalRequest;
  claim_token: string;
  result_ref: string | null;
}): Promise<boolean> {
  const consumed = await approvalRequestsRepo.consume({
    id: input.request.id,
    claim_token: input.claim_token,
    result_ref: input.result_ref,
  });
  if (!consumed) return false;
  await audit({
    acao: 'approval_consumed',
    pessoa_id: input.request.requester_pessoa_id,
    alvo_id: input.request.id,
    metadata: { tool: input.request.tool, result_ref: input.result_ref },
  });
  return true;
}

/**
 * Devolve um claim quando o handler NÃO chegou a rodar (ex.: perdeu a corrida
 * de idempotência). A evidência volta a 'approved' e continua utilizável.
 */
export async function releaseClaimedApproval(input: {
  request: ApprovalRequest;
  claim_token: string;
}): Promise<void> {
  await approvalRequestsRepo.releaseClaim({
    id: input.request.id,
    claim_token: input.claim_token,
  });
}

/** Execução falhou após o claim: terminal, exige NOVA aprovação (fail-closed). */
export async function failClaimedApproval(input: {
  request: ApprovalRequest;
  claim_token: string;
  cause: string;
}): Promise<void> {
  await approvalRequestsRepo.markExecutionFailed({
    id: input.request.id,
    claim_token: input.claim_token,
  });
  await audit({
    acao: 'approval_execution_failed',
    pessoa_id: input.request.requester_pessoa_id,
    alvo_id: input.request.id,
    metadata: { tool: input.request.tool, cause: input.cause.slice(0, 200) },
  });
}

/**
 * Varredura de expiração (chamada pelo engine tick sob ALS). Audita cada
 * request expirado e notifica o requester best-effort.
 */
export async function expireDueApprovals(
  notify: (jid: string, text: string) => Promise<unknown>,
): Promise<number> {
  const expired = await approvalRequestsRepo.expireDue();
  for (const request of expired) {
    await audit({
      acao: 'approval_expired',
      pessoa_id: request.requester_pessoa_id,
      alvo_id: request.id,
      metadata: { tool: request.tool, approval_class: request.approval_class },
    });
    const requester = await pessoasRepo.findById(request.requester_pessoa_id);
    if (requester) {
      await notify(
        jidOf(requester),
        `Solicitação ${approvalRef(request)} expirou (${config.DUAL_APPROVAL_TIMEOUT_HOURS}h sem aprovação). Repita a operação se ainda for necessária.`,
      ).catch(() => undefined);
    }
  }
  return expired.length;
}
