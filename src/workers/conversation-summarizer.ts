import { db } from '@/db/client.js';
import { conversas } from '@/db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { mensagensRepo, conversasRepo } from '@/db/repositories.js';
import { callLLM } from '@/lib/claude.js';
import { logger } from '@/lib/logger.js';
import { config } from '@/config/env.js';

export async function runConversationSummarizer(): Promise<void> {
  const stale = await db
    .select()
    .from(conversas)
    .where(
      and(
        eq(conversas.status, 'ativa'),
        sql`${conversas.ultima_atividade_em} < now() - interval '7 days'`,
      ),
    )
    .limit(10);
  for (const c of stale) {
    const msgs = await mensagensRepo.recentInConversation(c.id, 50);
    if (msgs.length === 0) {
      await conversasRepo.close(c.id, '');
      continue;
    }
    const transcript = [...msgs]
      .reverse()
      .map((m) => `${m.direcao === 'in' ? 'Usuário' : 'Maia'}: ${m.conteudo ?? '[mídia]'}`)
      .join('\n');
    try {
      const res = await callLLM({
        system:
          'Você é a Maia. Resuma a conversa abaixo em até 500 caracteres em português, focando em decisões, fatos e pendências. Não invente.',
        messages: [{ role: 'user', content: transcript }],
        max_tokens: 500,
        temperature: 0.0,
      });
      const summary = (res.content ?? '').slice(0, 500);
      await conversasRepo.close(c.id, summary);
      logger.info({ conversa_id: c.id, len: summary.length }, 'conversation_summarized');
    } catch (err) {
      logger.warn({ err: (err as Error).message, conversa_id: c.id }, 'summarizer.failed');
    }
  }
  void config;
}
