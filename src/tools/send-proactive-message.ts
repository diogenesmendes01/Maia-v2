import { z } from 'zod';
import type { Tool } from './_registry.js';
import { pessoasRepo, mensagensRepo, conversasRepo } from '@/db/repositories.js';
import { sendOutboundText } from '@/gateway/baileys.js';
import { isOwnerType } from '@/governance/permissions.js';

const inputSchema = z.object({
  pessoa_id_destino: z.string().uuid(),
  texto: z.string().min(1).max(2000),
  reason: z.string().min(1),
});

const outputSchema = z.object({
  mensagem_id: z.string(),
  whatsapp_id: z.string().nullable(),
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
    const wid = await sendOutboundText(jid, args.texto);
    let conversa = await conversasRepo.findActive(target.id);
    if (!conversa) {
      conversa = await conversasRepo.create({ pessoa_id: target.id, escopo_entidades: [] });
    }
    const m = await mensagensRepo.create({
      conversa_id: conversa.id,
      direcao: 'out',
      tipo: 'texto',
      conteudo: args.texto,
      midia_url: null,
      metadata: { whatsapp_id: wid, proactive: true, reason: args.reason },
      processada_em: new Date(),
      ferramentas_chamadas: [],
      tokens_usados: null,
    });
    return { mensagem_id: m.id, whatsapp_id: wid };
  },
};
