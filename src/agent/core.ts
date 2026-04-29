import { mensagensRepo, conversasRepo, pessoasRepo } from '@/db/repositories.js';
import { resolveScope } from '@/governance/permissions.js';
import { checkRateLimit, formatPoliteReply } from '@/gateway/rate-limit.js';
import { resolveIdentity } from '@/identity/resolver.js';
import { handleQuarantineFirstContact, handleOwnerIdentityReply } from '@/identity/quarantine.js';
import { config } from '@/config/env.js';
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
    const tel = (inbound.metadata as Record<string, unknown>)?.['telefone'] as string | undefined;
    if (!tel) return;
    const resolved = await resolveIdentity({ telefone_whatsapp: tel });
    if (resolved.kind === 'unknown') {
      // Mark processed so the recovery worker doesn't requeue forever.
      await mensagensRepo.markProcessed(inbound.id, 0);
      return;
    }
    if (resolved.kind === 'blocked') {
      logger.info({ pessoa_id: resolved.pessoa.id, reason: resolved.reason }, 'agent.blocked_drop');
      await mensagensRepo.markProcessed(inbound.id, 0);
      return;
    }
    if (resolved.kind === 'quarantined') {
      await handleQuarantineFirstContact({ pessoa: resolved.pessoa, inbound });
      await mensagensRepo.markProcessed(inbound.id, 0);
      return;
    }
    // Owner reply on a pending identity_confirmation? handled before the LLM
    // ever sees the message — deterministic confirmation flow per spec 05 §6.
    if (
      resolved.pessoa.telefone_whatsapp === config.OWNER_TELEFONE_WHATSAPP &&
      typeof inbound.conteudo === 'string'
    ) {
      const consumed = await handleOwnerIdentityReply({
        ownerPessoa: resolved.pessoa,
        reply: inbound.conteudo,
      });
      if (consumed) {
        await mensagensRepo.setConversaId(inbound.id, resolved.conversa.id);
        await mensagensRepo.markProcessed(inbound.id, 0);
        return;
      }
    }
    await mensagensRepo.setConversaId(inbound.id, resolved.conversa.id);
    inbound.conversa_id = resolved.conversa.id;
  }

  const conv = await loadConversaWithPessoa(inbound.conversa_id!);
  if (!conv) {
    logger.warn({ mensagem_id }, 'agent.conversa_missing');
    return;
  }
  const { conversa: c, pessoa } = conv;

  // Spec 03 §9 — sliding-hour rate limit. Owners exempt; others get one
  // polite reply per hour, then 60s of silence after each warning.
  const decision = await checkRateLimit(pessoa);
  if (decision.kind !== 'allow') {
    if (decision.kind === 'warn') {
      await audit({
        acao: 'rate_limit_exceeded',
        pessoa_id: pessoa.id,
        conversa_id: c.id,
        mensagem_id: inbound.id,
        metadata: { count: decision.count, threshold: decision.threshold },
      });
      const reply = formatPoliteReply(decision.threshold);
      await sendOutbound(pessoa.id, c.id, reply, inbound.id).catch((err) =>
        logger.warn({ err: (err as Error).message }, 'agent.rate_limit_reply_failed'),
      );
    }
    await mensagensRepo.markProcessed(inbound.id, 0);
    await conversasRepo.touch(c.id);
    return;
  }

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
      const isError = typeof out === 'object' && out !== null && 'error' in out;
      results.push({
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: JSON.stringify(out),
        is_error: isError,
      });
      await audit({
        acao: (isError ? 'unauthorized_access_attempt' : 'classification_suggested') as never,
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
