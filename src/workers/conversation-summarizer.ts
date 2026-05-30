import { db } from '@/db/client.js';
import { conversas } from '@/db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { mensagensRepo, conversasRepo } from '@/db/repositories.js';
import { callLLM } from '@/lib/claude.js';
import { logger } from '@/lib/logger.js';
import { config } from '@/config/env.js';
import { runWithTenantContext, getCurrentTenant, getCurrentAgent } from '@/db/tenant-context.js';
import { reflect } from '@/cognition/reflector.js';
import { classify } from '@/cognition/classifier.js';
import { persistCandidate } from '@/cognition/persister.js';
import { runCognitiveModule } from '@/cognition/runner.js';
import { CognitiveEventType } from '@/types/enums.js';

/**
 * Issue #345 (Phase 4 of #323) — per-tenant fan-out.
 *
 * BEFORE: `runConversationSummarizer` opened a HARDCODED
 * `runWithTenantContext({ tenant_id: 'default', agent_id: 'default' })` and ran
 * the inner once. The inner's `conversas` SELECT is scoped to the ALS
 * tenant/agent (via the tenant predicate the dispatcher establishes), so under
 * multi-tenant only the `default` agent's stale conversations were ever
 * summarized — real tenants' conversations never got summaries or
 * CONVERSATION_CLOSED reflections.
 *
 * AFTER: the worker is a DISPATCHER. It enumerates — OUTSIDE any tenant context
 * — the DISTINCT (tenant_id, agent_id) tuples that own at least one stale
 * conversation (`conversasRepo.listTenantAgentPairsWithStaleConversations`, a
 * read over `conversas` with the SAME staleness filter as the inner), then runs
 * the existing inner once PER tuple under `runWithTenantContext`. The inner is
 * unchanged.
 *
 * Behavior-preserving in single-tenant mode: when the only data lives under
 * `('default','default')`, the enumeration yields exactly that one tuple, so the
 * inner still runs once under default. Fail-isolated per tuple (mirrors
 * reflection-batch #251 / outbound-messages-sweeper #292 / gap-escalation #337).
 */
export async function runConversationSummarizer(): Promise<void> {
  const tuples = await conversasRepo.listTenantAgentPairsWithStaleConversations();

  if (tuples.length === 0) {
    logger.debug('conversation_summarizer.idle');
    return;
  }

  let agents_processed = 0;
  let agents_failed = 0;

  for (const { tenant_id, agent_id } of tuples) {
    try {
      await runWithTenantContext({ tenant_id, agent_id }, runConversationSummarizerInner);
      agents_processed++;
    } catch (err) {
      // Fail-isolated per (tenant, agent).
      agents_failed++;
      logger.warn(
        {
          tenant_id,
          agent_id,
          err: (err as Error).message,
          stack: (err as Error).stack,
        },
        'conversation_summarizer.agent_failed',
      );
    }
  }

  logger.info(
    { tuples: tuples.length, agents_processed, agents_failed },
    'conversation_summarizer.done',
  );
}

async function runConversationSummarizerInner(): Promise<void> {
  // Issue #345 (Phase 4 review): this inner runs ONCE PER enumerated
  // (tenant_id, agent_id) tuple. The SELECT below is a RAW `db.select()` that
  // does NOT pass through the tenant guard, so it must carry an EXPLICIT
  // (tenant_id, agent_id) predicate — otherwise a per-tuple run would read
  // EVERY tenant's stale conversations and then `conversasRepo.close()` rows
  // belonging to other tenants, violating the inviolable cross-tenant
  // isolation invariant. Bind the same pair the dispatcher partitions on.
  const tenant_id = getCurrentTenant();
  const agent_id = getCurrentAgent();
  const stale = await db
    .select()
    .from(conversas)
    .where(
      and(
        eq(conversas.tenant_id, tenant_id),
        eq(conversas.agent_id, agent_id),
        eq(conversas.status, 'ativa'),
        sql`${conversas.ultima_atividade_em} < now() - interval '7 days'`,
      ),
    )
    .limit(10);
  for (const c of stale) {
    const msgs = await mensagensRepo.recentInConversation(c.id, 50);
    if (msgs.length === 0) {
      await conversasRepo.close(c.id, '');
      try {
        const event = {
          type: CognitiveEventType.CONVERSATION_CLOSED,
          conversa_id: c.id,
          transcript: '',
          summary: '',
          duration_minutes: 0,
        } as const;
        const reflected = await reflect(event);
        if (reflected) {
          const classified = await classify(reflected.insight);
          if (classified) {
            await persistCandidate(classified, event, 'worker');
          }
        }
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, conversa_id: c.id },
          'conversation_closed.reflection.failed'
        );
      }
      continue;
    }
    const transcript = [...msgs]
      .reverse()
      .map((m) => `${m.direcao === 'in' ? 'Usuário' : 'Maia'}: ${m.conteudo ?? '[mídia]'}`)
      .join('\n');
    try {
      const summarizerResult = await runCognitiveModule(
        {
          name: 'conversation-summarizer',
          triggered_by: 'async_event',
          timeoutMs: 30000,
          conversa_id: c.id,
        },
        () =>
          callLLM({
            system:
              'Você é a Maia. Resuma a conversa abaixo em até 500 caracteres em português, focando em decisões, fatos e pendências. Não invente.',
            messages: [{ role: 'user', content: transcript }],
            max_tokens: 500,
            temperature: 0.0,
          }),
      );
      const res = summarizerResult.output;
      if (!res) {
        logger.warn(
          { conversa_id: c.id, status: summarizerResult.status },
          'summarizer.llm_failed_skipping',
        );
        continue;
      }
      const summary = (res.content ?? '').slice(0, 500);
      await conversasRepo.close(c.id, summary);
      logger.info({ conversa_id: c.id, len: summary.length }, 'conversation_summarized');
      try {
        const event = {
          type: CognitiveEventType.CONVERSATION_CLOSED,
          conversa_id: c.id,
          transcript,
          summary,
          duration_minutes: 0,
        } as const;
        const reflected = await reflect(event);
        if (reflected) {
          const classified = await classify(reflected.insight);
          if (classified) {
            await persistCandidate(classified, event, 'worker');
          }
        }
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, conversa_id: c.id },
          'conversation_closed.reflection.failed'
        );
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message, conversa_id: c.id }, 'summarizer.failed');
    }
  }
  void config;
}
