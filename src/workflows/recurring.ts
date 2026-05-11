/**
 * Spec 18 §6.2 + §6.3 — handlers for the two recurring workflow types.
 * These run inside `tickEngine` and advance one workflow per call.
 *
 * Design contract:
 *  - Idempotent: each step transition is gated on the current step status
 *    so a tick that fires twice on the same workflow does not double-act.
 *  - Engine never blocks on send failure — a failed Baileys send leaves
 *    the workflow in `aguardando_terceiro` / `aguardando_humano` and the
 *    operator sees the failure in audit + DLQ.
 *  - Money never moves here: `payment_due` only creates pending_questions;
 *    the actual `register_transaction` is dispatched on owner confirmation
 *    through the normal pending-resolver path.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { workflow_steps } from '@/db/schema.js';
import type { Workflow, WorkflowStep } from '@/db/schema.js';
import {
  workflowsRepo,
  workflowStepsRepo,
  pessoasRepo,
  conversasRepo,
  pendingQuestionsRepo,
} from '@/db/repositories.js';
import { sendOutboundText } from '@/gateway/baileys.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { sendAlert } from '@/lib/alerts.js';
import { computeNext, parseRRule } from './rrule.js';
import { fmtBR } from '@/lib/brazilian.js';

type Step = WorkflowStep;

async function getStep(workflow_id: string, ordem: number): Promise<Step | null> {
  const all = await workflowStepsRepo.byWorkflow(workflow_id);
  return all.find((s) => s.ordem === ordem) ?? null;
}

async function setStepStatus(
  step_id: string,
  status: 'em_andamento' | 'concluido' | 'falhou' | 'pulado',
  resultado_patch?: Record<string, unknown>,
): Promise<void> {
  const update: Record<string, unknown> = { status };
  if (status === 'em_andamento') update.iniciado_em = new Date();
  if (status === 'concluido' || status === 'falhou' || status === 'pulado') {
    update.concluido_em = new Date();
  }
  if (resultado_patch) {
    const cur = await db
      .select()
      .from(workflow_steps)
      .where(eq(workflow_steps.id, step_id))
      .limit(1);
    const prev = (cur[0]?.resultado as Record<string, unknown> | null) ?? {};
    update.resultado = { ...prev, ...resultado_patch };
  }
  await db.update(workflow_steps).set(update).where(eq(workflow_steps.id, step_id));
}

function jidFromPhone(tel: string): string {
  return tel.replace('+', '') + '@s.whatsapp.net';
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

function previousMonthLabel(now: Date): string {
  const prev = new Date(now);
  prev.setMonth(prev.getMonth() - 1);
  return `${String(prev.getMonth() + 1).padStart(2, '0')}/${prev.getFullYear()}`;
}

/**
 * Advances an `outreach_recorrente` workflow by exactly one step where
 * possible. Returns true if a transition happened (caller increments
 * processed counter).
 */
export async function advanceOutreach(wf: Workflow): Promise<boolean> {
  const ctxData = wf.contexto as {
    rrule: string;
    destinatario_pessoa_id: string;
    forward_to_pessoa_id?: string;
    message_template: string;
    forward_template?: string;
    wait_response_hours?: number;
    owner_pessoa_id: string;
  };

  // Stage 1 — initial fire: send_outreach.
  if (wf.status === 'pendente') {
    const proxima = wf.proxima_acao_em;
    if (!proxima || proxima.getTime() > Date.now()) return false;
    const step1 = await getStep(wf.id, 1);
    if (!step1 || step1.status === 'concluido') return false;

    const destinatario = await pessoasRepo.findById(ctxData.destinatario_pessoa_id);
    if (!destinatario || destinatario.status !== 'ativa') {
      logger.warn({ workflow_id: wf.id }, 'outreach.destinatario_unavailable');
      await workflowsRepo.setStatus(wf.id, 'falhou');
      return true;
    }

    const message = renderTemplate(ctxData.message_template, {
      mes_anterior: previousMonthLabel(new Date()),
      nome: destinatario.nome,
    });
    const jid = jidFromPhone(destinatario.telefone_whatsapp);
    try {
      const wid = await sendOutboundText(jid, message);
      await setStepStatus(step1.id, 'concluido', { whatsapp_id: wid, sent_to: destinatario.id });
      await workflowsRepo.setStatus(wf.id, 'aguardando_terceiro');
      // Mark step 2 in_progress so timeout detection can use iniciado_em.
      const step2 = await getStep(wf.id, 2);
      if (step2) await setStepStatus(step2.id, 'em_andamento');
      await audit({
        acao: 'outreach_sent',
        pessoa_id: ctxData.owner_pessoa_id,
        alvo_id: wf.id,
        metadata: { destinatario_id: destinatario.id, whatsapp_id: wid },
      });
      return true;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, workflow_id: wf.id },
        'outreach.send_failed',
      );
      return false;
    }
  }

  // Stage 2 — waiting for the third party to reply; check timeout.
  if (wf.status === 'aguardando_terceiro') {
    const step2 = await getStep(wf.id, 2);
    if (!step2 || step2.status !== 'em_andamento') return false;
    const wait_hours = ctxData.wait_response_hours ?? 48;
    const startedAt = step2.iniciado_em?.getTime() ?? Date.now();
    const expiresAt = startedAt + wait_hours * 3600_000;
    if (Date.now() < expiresAt) return false;

    await audit({
      acao: 'outreach_no_response',
      pessoa_id: ctxData.owner_pessoa_id,
      alvo_id: wf.id,
      metadata: { wait_response_hours: wait_hours },
    });
    // Notify owner so they can chase the third party themselves.
    const owner = await pessoasRepo.findById(ctxData.owner_pessoa_id);
    if (owner) {
      const destinatario = await pessoasRepo.findById(ctxData.destinatario_pessoa_id);
      await sendOutboundText(
        jidFromPhone(owner.telefone_whatsapp),
        `Heads-up: ${destinatario?.nome ?? 'o contato'} não respondeu o pedido recorrente desde ${fmtBR(step2.iniciado_em ?? new Date())}. Workflow ficou em espera.`,
      ).catch(() => null);
    }
    // Hand off to manual: owner can cancel via cancel_workflow.
    await workflowsRepo.setStatus(wf.id, 'aguardando_humano');
    return true;
  }

  // Stage 3 — third party answered (status flipped back to em_andamento
  // by the inbound hook in agent/core.ts — to be implemented in §6.5).
  if (wf.status === 'em_andamento') {
    const step3 = await getStep(wf.id, 3);
    if (!step3 || step3.status === 'concluido') return false;
    const step2 = await getStep(wf.id, 2);
    const resposta = (step2?.resultado as Record<string, unknown> | null)?.['response_text'] as
      | string
      | undefined;

    if (ctxData.forward_to_pessoa_id && ctxData.forward_template && resposta) {
      const forwardTo = await pessoasRepo.findById(ctxData.forward_to_pessoa_id);
      if (forwardTo && forwardTo.status === 'ativa') {
        const fwdMsg = renderTemplate(ctxData.forward_template, {
          resposta,
          nome: forwardTo.nome,
          mes_anterior: previousMonthLabel(new Date()),
        });
        try {
          const wid = await sendOutboundText(jidFromPhone(forwardTo.telefone_whatsapp), fwdMsg);
          await setStepStatus(step3.id, 'concluido', { forwarded_to: forwardTo.id, whatsapp_id: wid });
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, workflow_id: wf.id },
            'outreach.forward_failed',
          );
          return false;
        }
      } else {
        await setStepStatus(step3.id, 'pulado', { reason: 'forward_to_inactive' });
      }
    } else {
      await setStepStatus(step3.id, 'pulado', { reason: 'nothing_to_forward' });
    }

    // Stage 4 — schedule the next cycle as a new workflow row (preserves
    // audit trail of each cycle). Cancel chain stops future spawns.
    const step4 = await getStep(wf.id, 4);
    if (step4 && step4.status !== 'concluido') {
      const next_at = computeNext(parseRRule(ctxData.rrule), new Date());
      const cloned = await workflowsRepo.create({
        tipo: 'outreach_recorrente',
        status: 'pendente',
        contexto: wf.contexto,
        entidade_id: wf.entidade_id,
        pessoa_envolvida: wf.pessoa_envolvida,
        proxima_acao_em: next_at,
        metadata: wf.metadata,
        chain_id: wf.chain_id,
      });
      // Clone steps blueprint for the new cycle.
      await workflowStepsRepo.createMany([
        { workflow_id: cloned.id, ordem: 1, descricao: 'send_outreach', status: 'pendente', resultado: { type: 'send_outreach' } },
        { workflow_id: cloned.id, ordem: 2, descricao: 'await_response', status: 'pendente', resultado: { type: 'await_response' } },
        { workflow_id: cloned.id, ordem: 3, descricao: 'forward_or_close', status: 'pendente', resultado: { type: 'forward_or_close' } },
        { workflow_id: cloned.id, ordem: 4, descricao: 'reschedule', status: 'pendente', resultado: { type: 'reschedule' } },
      ]);
      await setStepStatus(step4.id, 'concluido', { next_workflow_id: cloned.id, next_at: next_at.toISOString() });
      await workflowsRepo.setStatus(wf.id, 'concluido');
      await audit({
        acao: 'outreach_completed_and_rescheduled',
        pessoa_id: ctxData.owner_pessoa_id,
        alvo_id: wf.id,
        metadata: { next_workflow_id: cloned.id, next_at: next_at.toISOString() },
      });
      return true;
    }
  }

  return false;
}

/**
 * Advances a `payment_due` workflow. Stage 1 posts a confirmation pending
 * question. Subsequent stages are driven by the pending-resolver:
 * `resolvePaymentDue(workflow_id, decision)` (exported below) is called
 * when the owner answers.
 */
export async function advancePaymentDue(wf: Workflow): Promise<boolean> {
  const ctxData = wf.contexto as {
    rrule: string;
    conta_id: string;
    valor: number;
    descricao: string;
    categoria_id?: string;
    contraparte_id?: string;
    escalate_after_hours?: number;
    entidade_id: string;
    requester_pessoa_id: string;
  };

  if (wf.status === 'pendente') {
    const proxima = wf.proxima_acao_em;
    if (!proxima || proxima.getTime() > Date.now()) return false;
    const step1 = await getStep(wf.id, 1);
    if (!step1 || step1.status === 'concluido') return false;

    const owner = await pessoasRepo.findById(ctxData.requester_pessoa_id);
    if (!owner || owner.status !== 'ativa') {
      logger.warn({ workflow_id: wf.id }, 'payment_due.owner_unavailable');
      await workflowsRepo.setStatus(wf.id, 'falhou');
      return true;
    }
    const ownerConv = await conversasRepo.findActive(owner.id);
    if (!ownerConv) {
      // Without a conversa we can't anchor the pending_question — defer to
      // next tick rather than fail; conversa is auto-created on next inbound.
      return false;
    }
    const escalate_after_hours = ctxData.escalate_after_hours ?? 4;
    const valorFmt = ctxData.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const pergunta = `Pagamento ${ctxData.descricao} de ${valorFmt} hoje? Responda *sim*, *não* ou *adiar*.`;
    await pendingQuestionsRepo.create({
      conversa_id: ownerConv.id,
      pessoa_id: owner.id,
      tipo: 'payment_confirmation',
      pergunta,
      opcoes_validas: [
        { key: 'sim', label: 'Pagar agora' },
        { key: 'nao', label: 'Pular este mês' },
        { key: 'adiar', label: 'Adiar 2 dias' },
      ],
      acao_proposta: {
        tool: 'register_transaction',
        args: {
          entidade_id: ctxData.entidade_id,
          conta_id: ctxData.conta_id,
          natureza: 'despesa',
          valor: ctxData.valor,
          data_competencia: new Date().toISOString().slice(0, 10),
          data_pagamento: new Date().toISOString().slice(0, 10),
          status: 'paga',
          descricao: ctxData.descricao,
          categoria_id: ctxData.categoria_id,
          contraparte_id: ctxData.contraparte_id,
          origem: 'whatsapp',
        },
      },
      expira_em: new Date(Date.now() + escalate_after_hours * 3600_000),
      status: 'aberta',
      metadata: { workflow_id: wf.id },
    });
    try {
      await sendOutboundText(jidFromPhone(owner.telefone_whatsapp), pergunta);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, workflow_id: wf.id },
        'payment_due.send_failed',
      );
    }
    await setStepStatus(step1.id, 'concluido', { pergunta });
    await workflowsRepo.setStatus(wf.id, 'aguardando_humano');
    await audit({
      acao: 'payment_due_proposed',
      pessoa_id: owner.id,
      alvo_id: wf.id,
      metadata: { valor: ctxData.valor, descricao: ctxData.descricao },
    });
    return true;
  }

  // Expiration: if the workflow stayed `aguardando_humano` past the escalate
  // window, alert and halt — see spec 18 §6.3 "Why expire-without-action is
  // `falhou` not auto-skip".
  if (wf.status === 'aguardando_humano') {
    const step1 = await getStep(wf.id, 1);
    if (!step1 || !step1.concluido_em) return false;
    const escalate_after_hours = ctxData.escalate_after_hours ?? 4;
    const expiresAt = step1.concluido_em.getTime() + escalate_after_hours * 3600_000;
    if (Date.now() < expiresAt) return false;

    await audit({
      acao: 'payment_due_unanswered',
      pessoa_id: ctxData.requester_pessoa_id,
      alvo_id: wf.id,
      metadata: { valor: ctxData.valor, descricao: ctxData.descricao },
    });
    await sendAlert({
      subject: `Pagamento agendado sem resposta — ${ctxData.descricao}`,
      body: `Workflow ${wf.id}: pergunta de confirmação enviada em ${fmtBR(step1.concluido_em)} expirou sem resposta. Valor: ${ctxData.valor}. Próximas execuções permanecem suspensas até intervenção manual.`,
    }).catch(() => null);
    await workflowsRepo.setStatus(wf.id, 'falhou');
    return true;
  }

  return false;
}

/**
 * Called from the pending-resolver (existing infra) when an owner answers
 * a `payment_confirmation` pending question. The pending row carries
 * `metadata.workflow_id`, which is how the resolver finds this fn.
 */
export async function resolvePaymentDue(
  workflow_id: string,
  decision: 'sim' | 'nao' | 'adiar',
): Promise<void> {
  const wf = await workflowsRepo.byId(workflow_id);
  if (!wf || wf.status !== 'aguardando_humano') return;
  const ctxData = wf.contexto as {
    rrule: string;
    requester_pessoa_id: string;
    valor: number;
    descricao: string;
  };
  const step3 = await getStep(workflow_id, 3);

  if (decision === 'sim') {
    // The pending-resolver already dispatched register_transaction with
    // the constitutional checks running normally. We just record the
    // confirmation and reschedule.
    if (step3) await setStepStatus(step3.id, 'concluido', { decision: 'sim' });
    await audit({
      acao: 'payment_due_confirmed',
      pessoa_id: ctxData.requester_pessoa_id,
      alvo_id: workflow_id,
      metadata: { valor: ctxData.valor },
    });
    await rescheduleNextCycle(wf);
    await workflowsRepo.setStatus(workflow_id, 'concluido');
    return;
  }

  if (decision === 'nao') {
    if (step3) await setStepStatus(step3.id, 'pulado', { decision: 'nao' });
    await audit({
      acao: 'payment_due_skipped',
      pessoa_id: ctxData.requester_pessoa_id,
      alvo_id: workflow_id,
    });
    await rescheduleNextCycle(wf);
    await workflowsRepo.setStatus(workflow_id, 'concluido');
    return;
  }

  if (decision === 'adiar') {
    // Push this same workflow forward 2 days; clear step state so the
    // engine re-fires the confirmation flow.
    const newProxima = new Date(Date.now() + 2 * 86400_000);
    await workflowsRepo.setProximaAcaoEm(workflow_id, newProxima);
    if (step3) await setStepStatus(step3.id, 'pulado', { decision: 'adiar' });
    // Reset step 1 so engine re-fires.
    const step1 = await getStep(workflow_id, 1);
    if (step1) {
      await db
        .update(workflow_steps)
        .set({ status: 'pendente', resultado: { type: 'propose_payment' }, concluido_em: null, iniciado_em: null })
        .where(eq(workflow_steps.id, step1.id));
    }
    await workflowsRepo.setStatus(workflow_id, 'pendente');
    await audit({
      acao: 'payment_due_postponed',
      pessoa_id: ctxData.requester_pessoa_id,
      alvo_id: workflow_id,
      metadata: { new_proxima_acao_em: newProxima.toISOString() },
    });
  }
}

async function rescheduleNextCycle(wf: Workflow): Promise<void> {
  const ctxData = wf.contexto as { rrule: string };
  const next_at = computeNext(parseRRule(ctxData.rrule), new Date());
  const cloned = await workflowsRepo.create({
    tipo: wf.tipo,
    status: 'pendente',
    contexto: wf.contexto,
    entidade_id: wf.entidade_id,
    pessoa_envolvida: wf.pessoa_envolvida,
    proxima_acao_em: next_at,
    metadata: wf.metadata,
    chain_id: wf.chain_id,
  });
  await workflowStepsRepo.createMany([
    { workflow_id: cloned.id, ordem: 1, descricao: 'propose_payment', status: 'pendente', resultado: { type: 'propose_payment' } },
    { workflow_id: cloned.id, ordem: 2, descricao: 'await_owner_decision', status: 'pendente', resultado: { type: 'await_owner_decision' } },
    { workflow_id: cloned.id, ordem: 3, descricao: 'execute_or_skip', status: 'pendente', resultado: { type: 'execute_or_skip' } },
    { workflow_id: cloned.id, ordem: 4, descricao: 'reschedule', status: 'pendente', resultado: { type: 'reschedule' } },
  ]);
}
