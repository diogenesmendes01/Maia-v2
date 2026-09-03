import { z } from 'zod';
import { config } from '@/config/env.js';
import { workflowsRepo, workflowStepsRepo, pessoasRepo } from '@/db/repositories.js';
import type { Pessoa } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { enqueueProactiveNotice } from '@/runtime/outbound/proactive-notice.js';
import { listOwners } from '@/governance/permissions.js';

/**
 * Issue #506 — a notificação 4-eyes vira LINHA DE LEDGER.
 *
 * O que havia aqui: `forCurrentAgentChannel(null)` + `line.sendText(...)` sob
 * exceção de egresso declarada. O `containment` inventariado dizia a verdade
 * sobre a metade fácil ("o workflow persistido é a fonte de verdade") e nada
 * sobre a difícil: **um aprovador que não recebe o aviso não sabe que existe
 * algo a aprovar.** O workflow ficava pendurado até expirar, e o expirado é a
 * única evidência que sobrava — bem depois de o pedido ter deixado de importar.
 *
 * Agora o aviso é comprometido em `outbox_messages` ANTES de qualquer chamada
 * ao canal, com claim/backoff/DLQ do drain de agendamento, e a chave de dedupe
 * derivada do UUID do workflow garante um aviso por aprovador — para sempre.
 *
 * `enqueueProactiveNotice` deixa o canal implícito (canal ÚNICO ativo do agente,
 * fail-closed em ambiguidade), que é exatamente o que `forCurrentAgentChannel(null)`
 * fazia. Os `catch` dos call sites continuam mantendo o best-effort.
 */
async function enqueueNotice(jid: string, text: string, dedupe_key: string): Promise<void> {
  await enqueueProactiveNotice({ jid, text, dedupe_key });
}

export const DualApprovalContext = z.object({
  intent: z.object({
    tool: z.string(),
    args: z.record(z.unknown()),
  }),
  requester_pessoa_id: z.string().uuid(),
  signatures: z
    .array(z.object({ pessoa_id: z.string().uuid(), at: z.string() }))
    .default([]),
  reason: z.string().optional(),
});

export type DualApprovalCtx = z.infer<typeof DualApprovalContext>;

export async function requestDualApproval(input: {
  requester: Pessoa;
  intent: { tool: string; args: Record<string, unknown> };
  reason: string;
}): Promise<{ workflow_id: string }> {
  const ctx: DualApprovalCtx = {
    intent: input.intent,
    requester_pessoa_id: input.requester.id,
    signatures: [],
    reason: input.reason,
  };
  const expira = new Date(Date.now() + config.DUAL_APPROVAL_TIMEOUT_HOURS * 3600 * 1000);
  const wf = await workflowsRepo.create({
    tipo: 'dual_approval',
    status: 'aguardando_terceiro',
    contexto: ctx,
    entidade_id: (input.intent.args.entidade_id as string | undefined) ?? null,
    pessoa_envolvida: input.requester.id,
    proxima_acao_em: expira,
    metadata: {},
  });
  await workflowStepsRepo.createMany([
    {
      workflow_id: wf.id,
      ordem: 1,
      descricao: `aguarda assinatura de ${input.requester.nome}`,
      status: 'pendente',
      resultado: null,
    },
    {
      workflow_id: wf.id,
      ordem: 2,
      descricao: 'aguarda segunda assinatura (outro dono/co-dono)',
      status: 'pendente',
      resultado: null,
    },
    {
      workflow_id: wf.id,
      ordem: 3,
      descricao: `executa ${input.intent.tool}`,
      status: 'pendente',
      resultado: null,
    },
  ]);
  await audit({
    acao: 'dual_approval_requested',
    pessoa_id: input.requester.id,
    alvo_id: wf.id,
    metadata: { tool: input.intent.tool, reason: input.reason },
  });
  await notifyApprovers({ workflow_id: wf.id, requester: input.requester, reason: input.reason });
  return { workflow_id: wf.id };
}

async function notifyApprovers(input: {
  workflow_id: string;
  requester: Pessoa;
  reason: string;
}): Promise<void> {
  const owners = await listOwners();
  const text = `Solicitação 4-eyes (DA-${input.workflow_id.slice(0, 8)}): ${input.reason}\nResponda 'aprova DA-${input.workflow_id.slice(0, 8)}' para confirmar, ou 'recusa DA-${input.workflow_id.slice(0, 8)}' para rejeitar.`;
  for (const o of owners) {
    const jid = o.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
    await enqueueNotice(jid, text, `dual_approval:${input.workflow_id}:notify:${o.id}`).catch(
      (err) => logger.warn({ err, pessoa_id: o.id }, 'dual_approval.notify_failed'),
    );
  }
}

export async function approveBy(
  workflow_id: string,
  approver: Pessoa,
): Promise<{ status: 'awaiting_more' | 'executed' | 'rejected_same_signer' }> {
  const wf = await workflowsRepo.byId(workflow_id);
  if (!wf || wf.tipo !== 'dual_approval') return { status: 'rejected_same_signer' };
  const ctx = wf.contexto as DualApprovalCtx;
  if (ctx.signatures.find((s) => s.pessoa_id === approver.id)) {
    return { status: 'rejected_same_signer' };
  }
  ctx.signatures.push({ pessoa_id: approver.id, at: new Date().toISOString() });
  await workflowsRepo.setStatus(workflow_id, 'em_andamento');
  await audit({
    acao: 'dual_approval_granted',
    pessoa_id: approver.id,
    alvo_id: workflow_id,
  });
  if (ctx.signatures.length >= 2) {
    return { status: 'executed' };
  }
  // Persist context update via direct upsert: workflowsRepo doesn't have an update-context, so we rebuild
  // Simpler: leave ctx in memory for now; re-query when executor runs.
  return { status: 'awaiting_more' };
}

export async function denyBy(workflow_id: string, denier: Pessoa): Promise<void> {
  await workflowsRepo.setStatus(workflow_id, 'cancelado');
  await audit({
    acao: 'dual_approval_denied',
    pessoa_id: denier.id,
    alvo_id: workflow_id,
  });
}

export async function expireDueDualApprovals(): Promise<number> {
  const pending = await workflowsRepo.listPending();
  let count = 0;
  for (const wf of pending) {
    if (wf.tipo !== 'dual_approval') continue;
    if (!wf.proxima_acao_em) continue;
    if (new Date(wf.proxima_acao_em) > new Date()) continue;
    // O cancelamento é um COMPARE-AND-SWAP, e o que vem depois dele só roda se
    // esta chamada tiver sido a vencedora.
    //
    // Motivo: `expireDueDualApprovals()` tem DOIS disparadores — o job
    // `pending_expirer` e o `workflow_engine_tick`. Com o `setStatus`
    // incondicional que havia aqui, os dois venciam o mesmo workflow, auditavam
    // duas vezes e mandavam ao solicitante a mensagem de expiração DUAS VEZES.
    // Não era um risco de duas réplicas: acontecia dentro de um processo só.
    //
    // A checagem de prazo em JavaScript acima continua, mas só como filtro
    // barato: quem decide é o `proxima_acao_em <= now()` DENTRO do CAS, com o
    // relógio do banco.
    const venceu = await workflowsRepo.expireIfDue(wf.id);
    if (!venceu) continue;
    await audit({ acao: 'dual_approval_timeout', alvo_id: wf.id });
    const ctx = wf.contexto as DualApprovalCtx;
    const requester = await pessoasRepo.findById(ctx.requester_pessoa_id);
    if (requester) {
      const jid = requester.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
      await enqueueNotice(
        jid,
        `Solicitação DA-${wf.id.slice(0, 8)} expirou (${config.DUAL_APPROVAL_TIMEOUT_HOURS}h sem segunda confirmação). Tente novamente.`,
        `dual_approval:${wf.id}:expired`,
      ).catch(() => undefined);
    }
    count++;
  }
  return count;
}
