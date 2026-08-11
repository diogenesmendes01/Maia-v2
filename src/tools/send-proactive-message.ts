import { z } from 'zod';
import type { Tool } from './_registry.js';
import { pessoasRepo, mensagensRepo, conversasRepo, channelsRepo } from '@/db/repositories.js';
import { isOwnerType } from '@/governance/permissions.js';
import type { PlannedEffect } from '@/governance/idempotency-effects.js';

const inputSchema = z.object({
  pessoa_id_destino: z.string().uuid(),
  texto: z.string().min(1).max(2000),
  reason: z.string().min(1),
});

const outputSchema = z.object({
  mensagem_id: z.string(),
  // The WhatsApp provider message id is no longer known at handler time — the
  // physical send is deferred to the relayer (#316). Null here means "queued
  // for exactly-once relay"; the provider id lands on
  // idempotency_effect_outbox.provider_ref once dispatched.
  whatsapp_id: z.string().nullable(),
  // #316: the resolved JID + text the relayer will send. Carried in the result
  // so `extractEffect` can build the PlannedEffect as a PURE projection of the
  // result (no re-resolving the recipient, no reaching into args).
  jid: z.string(),
  texto: z.string(),
});

export const sendProactiveMessageTool: Tool<typeof inputSchema, typeof outputSchema> = {
  name: 'send_proactive_message',
  description:
    'Envia uma mensagem proativa para outra pessoa. Sempre exige dual approval, exceto quando o destinatário é dono/co_dono (auto-mensagem).',
  input_schema: inputSchema,
  output_schema: outputSchema,
  required_actions: ['send_proactive_message'],
  side_effect: 'communication',
  redis_required: false,
  operation_type: 'communicate',
  audit_action: 'proactive_message_sent' as never,
  handler: async (args) => {
    const target = await pessoasRepo.findById(args.pessoa_id_destino);
    if (!target) throw new Error('pessoa_destino_not_found');
    // Owner self-message exemption is enforced upstream by dispatcher (dual_approval not required if isOwnerType).
    void isOwnerType;
    const jid = target.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
    // #316: do NOT fire the WhatsApp send inline. A preempted-but-fenced owner
    // could have already sent it before being fenced → duplicate user-visible
    // message. Instead we PLAN the send (returned + extracted into the
    // transactional outbox, atomic with winning the reservation) and let the
    // single relayer dispatch it exactly once. We still persist the outbound
    // `mensagens` row so conversation history is consistent — whatsapp_id is
    // null until the relayer fills provider_ref on the outbox row.
    let conversa = await conversasRepo.findActive(target.id);
    if (!conversa) {
      // Fase 0 (spec roteamento v4 §1.6): conversa nova nasce COM canal quando
      // o agente tem canal único ativo; ambíguo fica NULL (legado) — o envio
      // físico no relayer falha fechado por conta própria nesse caso.
      const sole = await channelsRepo.findSoleActiveForCurrentAgent();
      conversa = await conversasRepo.create({
        pessoa_id: target.id,
        escopo_entidades: [],
        channel_id: sole.kind === 'one' ? sole.id : null,
      });
    }
    const m = await mensagensRepo.create({
      conversa_id: conversa.id,
      channel_id: conversa.channel_id,
      direcao: 'out',
      tipo: 'texto',
      conteudo: args.texto,
      midia_url: null,
      metadata: { whatsapp_id: null, proactive: true, reason: args.reason, pending_relay: true },
      processada_em: new Date(),
      ferramentas_chamadas: [],
      tokens_usados: null,
    });
    return { mensagem_id: m.id, whatsapp_id: null, jid, texto: args.texto };
  },
  // #316: project the handler result into the PlannedEffect the dispatcher
  // enqueues (atomic with the reservation completion). The relayer dispatches
  // this exactly once via the Baileys gateway.
  extractEffect: (result): PlannedEffect => ({
    kind: 'whatsapp_text',
    jid: result.jid,
    text: result.texto,
    mensagem_id: result.mensagem_id,
  }),
};
