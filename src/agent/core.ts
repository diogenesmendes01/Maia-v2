import { mensagensRepo, conversasRepo, pessoasRepo } from '@/db/repositories.js';
import { resolveScope } from '@/governance/permissions.js';
import { buildPrompt } from './prompt-builder.js';
import { callLLM, type LLMMessage } from '@/lib/claude.js';
import { logger } from '@/lib/logger.js';
import { sendOutboundText } from '@/gateway/baileys.js';
import { audit } from '@/governance/audit.js';
import { dispatchTool } from '@/tools/_dispatcher.js';
import { getToolSchemas } from '@/tools/_registry.js';
import { uuid } from '@/lib/utils.js';
import {
  detectCorrection,
  reflectOnCorrection,
  findPreviousAssistantMessage,
} from './reflection.js';

const MAX_REACT_ITERATIONS = 5;

export async function runAgentForMensagem(mensagem_id: string): Promise<void> {
  const inbound = await mensagensRepo.findById(mensagem_id);
  if (!inbound) {
    logger.warn({ mensagem_id }, 'agent.message_not_found');
    return;
  }
  if (inbound.processada_em) {
    logger.debug({ mensagem_id }, 'agent.already_processed');
    return;
  }
  if (!inbound.conversa_id) {
    // Resolve identity inline
    const tel = (inbound.metadata as Record<string, unknown>)?.['telefone'] as string | undefined;
    if (!tel) return;
    const pessoa = await pessoasRepo.findByPhone(tel);
    if (!pessoa) {
      logger.info({ tel: '[REDACTED]' }, 'agent.unknown_pessoa');
      return;
    }
    if (pessoa.status !== 'ativa') {
      logger.info({ pessoa_id: pessoa.id, status: pessoa.status }, 'agent.pessoa_not_active');
      return;
    }
    let conversa = await conversasRepo.findActive(pessoa.id);
    if (!conversa) {
      const scope = await resolveScope(pessoa);
      conversa = await conversasRepo.create({
        pessoa_id: pessoa.id,
        escopo_entidades: scope.entidades,
      });
    }
    await mensagensRepo.setConversaId(inbound.id, conversa.id);
    inbound.conversa_id = conversa.id;
  }

  const conversa = await (async () => {
    const all = await conversasRepo.findActive((await pessoasRepo.findById('00000000-0000-0000-0000-000000000000'))?.id ?? '');
    return all;
  })();

  // Re-fetch conversa & pessoa (we have conversa_id now)
  const fullConversa = await conversasRepo.findActive(inbound.id); // not ideal; we re-resolve
  // Simpler: fetch by mensagens.conversa_id via a small query
  const conv = await loadConversaWithPessoa(inbound.conversa_id!);
  if (!conv) {
    logger.warn({ mensagem_id }, 'agent.conversa_missing');
    return;
  }
  const { conversa: c, pessoa } = conv;
  const scope = await resolveScope(pessoa);

  const { system, messages } = await buildPrompt({
    pessoa,
    conversa: c,
    scope,
    inbound,
  });

  const tools = getToolSchemas(scope.byEntity);
  let totalTokens = 0;
  const conversation: LLMMessage[] = messages;

  for (let i = 0; i < MAX_REACT_ITERATIONS; i++) {
    const res = await callLLM({ system, messages: conversation, tools, max_tokens: 1024 });
    totalTokens += res.usage.input_tokens + res.usage.output_tokens;

    if (res.tool_uses.length === 0) {
      const text = res.content?.trim() ?? '';
      if (text) {
        await sendOutbound(pessoa.id, c.id, text, inbound.id);
      }
      break;
    }

    // Append assistant turn with tool uses
    conversation.push({
      role: 'assistant',
      content: res.tool_uses.map((tu) => ({
        type: 'tool_use' as const,
        id: tu.id,
        name: tu.tool,
        input: tu.args,
      })),
    });

    // Execute tools and add results
    const results = [];
    for (const tu of res.tool_uses) {
      const out = await dispatchTool({
        tool: tu.tool,
        args: tu.args,
        ctx: {
          pessoa,
          scope,
          conversa: c,
          mensagem_id: inbound.id,
          request_id: uuid(),
        },
      });
      results.push({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: JSON.stringify(out),
        is_error: 'error' in out,
      });
      await audit({
        acao: ('error' in out ? 'unauthorized_access_attempt' : 'classification_suggested') as never,
        pessoa_id: pessoa.id,
        conversa_id: c.id,
        mensagem_id: inbound.id,
        metadata: { tool: tu.tool },
      });
    }
    conversation.push({ role: 'user', content: results });
  }

  await mensagensRepo.markProcessed(inbound.id, totalTokens);
  await conversasRepo.touch(c.id);

  // Reflection trigger: correction detection (real-time)
  if (inbound.conteudo && detectCorrection(inbound.conteudo)) {
    const prev = await findPreviousAssistantMessage(c.id, inbound.id);
    if (prev) {
      await reflectOnCorrection({
        pessoa,
        conversa: c,
        inbound,
        previousAssistant: prev,
      });
    }
  }
}

async function sendOutbound(
  pessoa_id: string,
  conversa_id: string,
  text: string,
  in_reply_to: string,
): Promise<void> {
  const pessoa = await pessoasRepo.findById(pessoa_id);
  if (!pessoa) return;
  const jid = pessoa.telefone_whatsapp.replace('+', '') + '@s.whatsapp.net';
  const wid = await sendOutboundText(jid, text);
  await mensagensRepo.create({
    conversa_id,
    direcao: 'out',
    tipo: 'texto',
    conteudo: text,
    midia_url: null,
    metadata: { whatsapp_id: wid, in_reply_to },
    processada_em: new Date(),
    ferramentas_chamadas: [],
    tokens_usados: null,
  });
}

async function loadConversaWithPessoa(conversa_id: string) {
  const all = await import('@/db/client.js').then((m) => m.db);
  const { conversas, pessoas } = await import('@/db/schema.js');
  const { eq } = await import('drizzle-orm');
  const rows = await all
    .select()
    .from(conversas)
    .innerJoin(pessoas, eq(conversas.pessoa_id, pessoas.id))
    .where(eq(conversas.id, conversa_id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { conversa: r.conversas, pessoa: r.pessoas };
}
