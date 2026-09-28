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
  type ApprovalClaimJournal,
} from '@/db/repositories.js';
import type { ApprovalRequest, Pessoa } from '@/db/schema.js';
import { audit } from './audit.js';
import { isOwnerType, listOwners } from './permissions.js';
import { classifyApprovalClaimRecovery } from '@/runtime/engines/recovery.js';
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
 * §5.5.1 / SPEC-L1406 (SC05) — `'reuse'` quando a evidência pode ser servida,
 * `'recreate'` quando ela foi ENCERRADA como vencida por este chamador.
 *
 * A regra é: nenhuma evidência VENCIDA pode ser oferecida como se valesse, e
 * isso precisa acontecer ANTES da decisão de reutilizar — não no próximo tick do
 * sweeper. `claimed` nunca é tocado: um claim vivo pertence a um executor, e
 * encerrá-lo por relógio liberaria uma execução em andamento (o §5.5.1 diz
 * exatamente que TTL não libera efeito).
 *
 * A comparação de relógio aqui é só um FILTRO BARATO para não ir ao banco em
 * toda chamada: quem decide é o CAS (`expireIfDue`), pelo relógio do banco, e
 * o resultado dele é que conta.
 */
async function descartarEvidenciaVencida(
  request: ApprovalRequest,
): Promise<'reuse' | 'recreate'> {
  if (request.status === 'claimed') return 'reuse';
  if (new Date(request.expires_at).getTime() > Date.now()) return 'reuse';
  const vencida = await approvalRequestsRepo.expireIfDue({ id: request.id });
  if (!vencida) return 'reuse';
  await audit({
    acao: 'approval_expired',
    pessoa_id: request.requester_pessoa_id,
    alvo_id: request.id,
    metadata: { tool: request.tool, approval_class: request.approval_class, via: 'lazy' },
  });
  return 'recreate';
}

/**
 * Como este módulo pede que um aviso de aprovação seja emitido.
 *
 * Issue #506 — a assinatura era `(jid, text) => Promise<unknown>` e passou a
 * carregar `dedupe_key` porque o emissor deixou de ser uma chamada ao canal e
 * passou a ser uma linha de ledger durável
 * (`src/runtime/outbound/proactive-notice.ts`). A chave NÃO podia ser derivada
 * dentro do emissor: só AQUI se conhece a row que justifica o aviso
 * (`approval_requests.id`) e quem é o destinatário — e é o par dos dois que
 * define "este aviso já foi comprometido". Um emissor que inventasse a chave a
 * partir do texto reenviaria o mesmo aviso a cada mudança de redação e deixaria
 * de reenviar quando duas pessoas diferentes recebessem o mesmo texto.
 *
 * O contrato continua sendo uma FUNÇÃO e não uma importação direta do
 * emissor: `_dispatcher.ts` injeta a implementação por import dinâmico para não
 * arrastar o grafo do gateway, e os testes injetam um duplo.
 */
export type ApprovalNotify = (input: {
  jid: string;
  text: string;
  dedupe_key: string;
}) => Promise<unknown>;

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
  notify: ApprovalNotify;
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
    /**
     * §5.5.1 (SC05) — `open` por status não quer dizer VÁLIDO. Uma evidência
     * vencida que o sweeper ainda não alcançou seria devolvida como se valesse,
     * e a operação ficaria presa atrás de uma aprovação que já não pode ser
     * executada (`claim` exige `expires_at > now()`). Aqui ela é encerrada e o
     * caminho segue para criar um pedido NOVO com o mesmo fingerprint.
     */
    if ((await descartarEvidenciaVencida(existing)) === 'reuse') {
      return { request: existing, created: false, ref: approvalRef(existing) };
    }
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
  notify: ApprovalNotify;
}): Promise<void> {
  const ref = approvalRef(input.request);
  if (input.request.approval_class === 'single_confirmation') {
    const text =
      `Confirmação necessária (${ref}): ${input.reason}\n` +
      `Responda 'aprova ${ref}' para confirmar, ou 'recusa ${ref}' para cancelar.`;
    await input.notify({
      jid: jidOf(input.requester),
      text,
      dedupe_key: `approval_request:${input.request.id}:notify:${input.requester.id}`,
    });
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
    await input
      .notify({
        jid: jidOf(o),
        text,
        dedupe_key: `approval_request:${input.request.id}:notify:${o.id}`,
      })
      .catch((err) =>
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
  /**
   * `let` porque a RECUPERAÇÃO pode devolver a evidência ao estado executável
   * durante esta mesma chamada (§5.5.1): o que era um claim órfão volta a ser
   * 'approved' e o fluxo continua daqui — sem segundo claim de fora do caminho.
   */
  let open = await approvalRequestsRepo.findOpenByFingerprint(input.intent_hash);
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
    /**
     * §5.5.1 / SPEC-L1406 (SC05) — 'pending' por status não quer dizer VÁLIDO.
     * Um pedido pendente que já passou do prazo não é autorização em falta que
     * valha esperar: ele é terminal (`expired`) e o caminho honesto é um pedido
     * NOVO — é isso que impede a operação de ficar presa atrás de um pedido que
     * ninguém pode mais aprovar (`markApproved` exige `expires_at > now()`).
     */
    if ((await descartarEvidenciaVencida(open)) === 'recreate') return { outcome: 'none' };
    return { outcome: 'pending', request: open, ref: approvalRef(open) };
  }

  if (open.status === 'claimed') {
    /**
     * §5.5.1 / SPEC-L1406 (SC05) — O CLAIM ÓRFÃO NÃO PRENDE A INTENÇÃO.
     *
     * Um processo morto entre o claim e o `consume` deixa o pedido `claimed`
     * para sempre, e `claimed` está em `OPEN_STATUSES`: todo turno novo com a
     * mesma intenção cairia no `return 'pending'` abaixo, apontando para um
     * pedido que nenhum humano consegue decidir — a operação travada por um
     * efeito que NUNCA começou, ou por um que ninguém reconciliou.
     *
     * A recuperação pergunta ao JOURNAL (nunca ao relógio) se o handler chegou
     * a começar:
     *
     *  * `release_claim` — prova de não início: a evidência volta a `approved`,
     *    é relida AQUI e o fluxo continua para o claim normal. Quem executa
     *    depois passa pelo mesmo CAS e pelo mesmo `consume`: devolver não é
     *    executar;
     *  * `execution_failed` — início, incerteza ou classe com efeito: a
     *    evidência fica TERMINAL e a resposta é 'none', para que um pedido NOVO
     *    nasça com o mesmo fingerprint (o antigo sai da partial unique);
     *  * `held` — o CAS de recovery não passou (o pedido mudou de estado, ou já
     *    não é daquele claim): não inventa desfecho e a resposta é 'pending'.
     *
     * ─── O que a devolução NÃO consegue distinguir, e por quê ────────────────
     *
     * Um claim SEM carimbo pode ser um processo morto ou um executor VIVO entre
     * o claim e o marcador. A plataforma não tem sinal de vida para o claim
     * (§5.5.1: «o claim de approval atual não é `TurnLease` e não herda
     * heartbeat»), então o journal é a ÚNICA prova disponível — e é ela que a
     * spec manda usar. Na corrida, quem garante UM efeito não é esta máquina: é
     * a reserva de idempotência (§5.5.1/SC04), que devolve o resultado já
     * comprometido ao perdedor sem rodar handler. Devolver a evidência aqui não
     * cria segundo efeito; o que ela não pode fazer é escolher "pending" por
     * relógio, que é exatamente o defeito que o AC04 proíbe.
     */
    const recuperacao = await recoverClaimedApproval({ request: open });
    if (recuperacao === 'execution_failed') return { outcome: 'none' };
    if (recuperacao === 'held') {
      return { outcome: 'pending', request: open, ref: approvalRef(open) };
    }
    const devolvida = await approvalRequestsRepo.byId(open.id);
    if (!devolvida) return { outcome: 'none' };
    open = devolvida;
  }

  if (open.status !== 'approved') {
    // A devolução pode ter perdido para uma decisão humana em corrida (negada,
    // ou já consumida por outro turno): não há evidência executável aqui.
    return { outcome: 'pending', request: open, ref: approvalRef(open) };
  }

  // Uma evidência 'approved' mas VENCIDA não é executável: `claim` exige
  // `expires_at > now()`. Encerrar aqui evita gastar o CAS para descobrir isso e
  // evita que a operação fique presa na partial unique do fingerprint.
  if ((await descartarEvidenciaVencida(open)) === 'recreate') {
    return { outcome: 'none' };
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
  if (!claimed) {
    /**
     * §5.5.1 (SC05) — o CAS pode ter perdido por dois motivos MUITO diferentes,
     * e tratá-los como um só era o defeito: (a) outro executor levou o claim —
     * aí 'pending' é a resposta honesta; (b) a evidência VENCEU entre a leitura e
     * o CAS — aí não há execução em paralelo nenhuma e 'pending' manda o chamador
     * esperar por uma aprovação que nunca vai vir. Reler distingue os dois.
     */
    const atual = await approvalRequestsRepo.byId(open.id);
    if (!atual) return { outcome: 'none' };
    if (atual.status === 'claimed') {
      return { outcome: 'pending', request: atual, ref: approvalRef(atual) };
    }
    if (atual.status !== 'approved') {
      await descartarEvidenciaVencida(atual);
      return { outcome: 'none' };
    }
    return { outcome: 'pending', request: atual, ref: approvalRef(atual) };
  }
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
 *
 * §5.5.1 (SC05) — devolve `true` SÓ quando a evidência voltou de fato. `false`
 * significa que o banco RECUSOU a devolução: ou o claim já não era deste
 * executor, ou o journal prova que o handler começou (e aí devolver apagaria a
 * prova de que o efeito pode ter acontecido). Não é erro do chamador, e por isso
 * não lança — mas é silêncio que não pode ser confundido com sucesso, então
 * fica registrado.
 */
export async function releaseClaimedApproval(input: {
  request: ApprovalRequest;
  claim_token: string;
}): Promise<boolean> {
  const devolvida = await approvalRequestsRepo.releaseClaim({
    id: input.request.id,
    claim_token: input.claim_token,
  });
  if (!devolvida) {
    logger.warn(
      { request_id: input.request.id, tool: input.request.tool },
      'approval.release_claim_refused',
    );
    return false;
  }
  return true;
}

/**
 * Execução falhou após o claim: terminal, exige NOVA aprovação (fail-closed).
 *
 * §5.5.1 (SC05) — devolve `true` SÓ quando o banco aceitou a transição. Quem
 * reconcilia precisa dessa resposta: um `false` significa que o pedido já não
 * era daquele claim (outro executor, outra decisão humana, TTL já aplicado) e
 * concluir "terminal" a partir daí seria afirmar um efeito de journal que o
 * banco não confirmou.
 */
export async function failClaimedApproval(input: {
  request: ApprovalRequest;
  claim_token: string;
  cause: string;
}): Promise<boolean> {
  const falhou = await approvalRequestsRepo.markExecutionFailed({
    id: input.request.id,
    claim_token: input.claim_token,
  });
  if (!falhou) {
    logger.warn(
      { request_id: input.request.id, tool: input.request.tool },
      'approval.mark_execution_failed_refused',
    );
    return false;
  }
  await audit({
    acao: 'approval_execution_failed',
    pessoa_id: input.request.requester_pessoa_id,
    alvo_id: input.request.id,
    metadata: { tool: input.request.tool, cause: input.cause.slice(0, 200) },
  });
  return true;
}

/**
 * §5.5.1 / SPEC-L1406 (SC05) — RECONCILIA um claim de aprovação que chegou
 * ÓRFÃO ao caminho de execução, e é o único consumidor de produção de
 * `classifyApprovalClaimRecovery`.
 *
 * ─── O estado que esta função existe para desfazer ──────────────────────────
 *
 * Um processo que morre entre o claim e o `consume` (SIGKILL, OOM, deploy)
 * deixa o banco assim: `approval_requests.status = 'claimed'` para sempre e a
 * call do pedido com o carimbo de início. O pedido está em `OPEN_STATUSES`,
 * então ele segue bloqueando a partial unique do fingerprint: TODO novo turno
 * com a mesma intenção recebe `approval_required` apontando para um pedido que
 * nenhum humano consegue decidir (`markApproved` exige `pending` e
 * `expires_at > now()`). A operação fica presa — e não existe relógio que a
 * solte, porque TTL não libera efeito (§5.5.1).
 *
 * ─── A decisão vem do JOURNAL, nunca do relógio ─────────────────────────────
 *
 * `classifyApprovalClaimRecovery` recebe o instantâneo lido de
 * `approvalRequestsRepo.claimJournal` (carimbo de início + classe declarada) e
 * responde uma de três coisas:
 *
 *   * `release_claim` — PROVA de não início: a evidência volta a `approved` e o
 *     dono legítimo pode executá-la. Devolver aqui não "libera efeito": libera
 *     uma evidência cujo efeito comprovadamente não começou, e quem executa
 *     depois passa pelo MESMO claim e pelo mesmo `consume`;
 *   * `execution_failed` — início comprovado, classe com efeito, ou journal
 *     ILEGÍVEL (`start_uncertain`: "não consegui ler" não é prova de não
 *     início). Terminal: exige aprovação NOVA, como manda o INV-09;
 *   * `hold` — não há claim vivo a resolver, ou o CAS perdeu. Não inventa
 *     desfecho.
 *
 * ─── Por que não é auto-resume ──────────────────────────────────────────────
 *
 * A função não executa nada, não cria run nem turno, e não "continua" execução
 * interrompida: ela só fecha (ou devolve) a evidência humana. Quem executa é o
 * turno que veio depois e passou de novo por claim e por journal.
 */
export type ClaimRecoveryOutcome = 'released' | 'execution_failed' | 'held';

export async function recoverClaimedApproval(input: {
  request: ApprovalRequest;
}): Promise<ClaimRecoveryOutcome> {
  const request = input.request;
  // Só um claim VIVO tem o que resolver. A row de `claimed` carrega sempre o
  // token (CHECK da migration 095), e é ele que o CAS exige.
  if (request.status !== 'claimed' || request.claim_token === null) return 'held';

  let journal: ApprovalClaimJournal = { handler_started: false, effect_class: null };
  let start_uncertain = false;
  try {
    journal = await approvalRequestsRepo.claimJournal({ approval_request_id: request.id });
  } catch (err) {
    /**
     * Journal ilegível é INCERTEZA, e incerteza não devolve evidência: a
     * política a trata como início comprovado. Se o banco está fora, o CAS
     * abaixo também não passa — a transição só acontece quando o mesmo banco
     * que não pôde ser lido aceita a escrita.
     */
    start_uncertain = true;
    logger.error(
      { err: (err as Error).message, request_id: request.id, ops_alert: true },
      'approval.claim_recovery_journal_unreadable',
    );
  }

  const disposicao = classifyApprovalClaimRecovery({
    approval_status: request.status,
    handler_started: journal.handler_started,
    effect_class: journal.effect_class,
    start_uncertain,
  });

  if (disposicao === 'release_claim') {
    const devolvida = await releaseClaimedApproval({
      request,
      claim_token: request.claim_token,
    });
    if (!devolvida) return 'held';
    logger.info(
      { request_id: request.id, tool: request.tool },
      'approval.claim_released_by_recovery',
    );
    return 'released';
  }

  if (disposicao === 'execution_failed') {
    const falhou = await failClaimedApproval({
      request,
      claim_token: request.claim_token,
      cause: start_uncertain ? 'claim_recovery_journal_unreadable' : 'claim_recovery_handler_started',
    });
    if (!falhou) return 'held';
    return 'execution_failed';
  }

  return 'held';
}

/**
 * Varredura de expiração (chamada pelo engine tick sob ALS). Audita cada
 * request expirado e notifica o requester best-effort.
 */
export async function expireDueApprovals(notify: ApprovalNotify): Promise<number> {
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
      await notify({
        jid: jidOf(requester),
        text: `Solicitação ${approvalRef(request)} expirou (${config.DUAL_APPROVAL_TIMEOUT_HOURS}h sem aprovação). Repita a operação se ainda for necessária.`,
        dedupe_key: `approval_request:${request.id}:expired`,
      }).catch(() => undefined);
    }
  }
  return expired.length;
}
