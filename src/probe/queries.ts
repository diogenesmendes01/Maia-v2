/**
 * Sonda sintética — leituras de correlação/asserção por EFEITO COLATERAL
 * (spec §1.4). Todas escopadas EXPLICITAMENTE ao tenant da sonda (sem ALS): a
 * sonda roda sob `runWithSystemContext` e correlaciona por `whatsapp_id` (o
 * handle do run) → `mensagens.id` da entrada → efeitos.
 */
import { and, eq, ne, sql, desc } from 'drizzle-orm';
import { db } from '../db/client.js';
import { mensagens, transacoes } from '../db/schema.js';
import { PROBE_TENANT_ID, PROBE_AGENT_ID } from './constants.js';

/**
 * Resolve a `mensagens.id` da ENTRADA sintética a partir do whatsapp_id estável
 * injetado (metadata.whatsapp_id). É o passo que liga o run injetado à row real
 * criada por `handleIncoming` — daí correlacionamos os efeitos.
 */
export async function findInboundMensagemIdByWid(wid: string): Promise<string | null> {
  const rows = await db
    .select({ id: mensagens.id })
    .from(mensagens)
    .where(
      and(
        eq(mensagens.tenant_id, PROBE_TENANT_ID),
        eq(mensagens.agent_id, PROBE_AGENT_ID),
        eq(mensagens.direcao, 'in'),
        sql`${mensagens.metadata} ->> 'whatsapp_id' = ${wid}`,
      ),
    )
    .orderBy(desc(mensagens.created_at))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Asserção PRIMÁRIA (§1.4a): existe a `transacoes` esperada, correlacionada por
 * `mensagem_id`, com `status='pendente'` (sem mutação de saldo), a entidade/
 * valor/natureza do cenário? Escopada ao tenant da sonda.
 */
export async function findPendingTransacao(input: {
  mensagem_id: string;
  entidade_id: string;
  valor: number;
  natureza: 'receita' | 'despesa' | 'movimentacao';
}): Promise<{ id: string; conta_id: string } | null> {
  const rows = await db
    .select({ id: transacoes.id, conta_id: transacoes.conta_id })
    .from(transacoes)
    .where(
      and(
        eq(transacoes.tenant_id, PROBE_TENANT_ID),
        eq(transacoes.agent_id, PROBE_AGENT_ID),
        eq(transacoes.mensagem_id, input.mensagem_id),
        eq(transacoes.entidade_id, input.entidade_id),
        eq(transacoes.natureza, input.natureza),
        eq(transacoes.status, 'pendente'),
        sql`${transacoes.valor} = ${input.valor}`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Issue #577 — RESPOSTA DE VERDADE, não placeholder.
 *
 * As duas consultas abaixo procuram a resposta do agente por
 * `direcao='out' AND metadata->>'in_reply_to'`, sem olhar `tipo`. Isso bastava
 * enquanto o único `out` com `in_reply_to` era um outbound real: a row
 * placeholder de `flushUnconfirmedToolSummaries()` (`src/agent/react-loop.ts`)
 * tem os dois campos, mas nunca chegava a nascer — `mensagens_tipo_check`
 * rejeitava `tipo='evento'`. Com a `116_mensagens_tipo_evento.sql` ela nasce, e
 * ela é exatamente o oposto do que a sonda quer afirmar: existe PORQUE o turno
 * terminou SEM outbound. Sem este filtro, um turno que estourou o teto de
 * iterações e não respondeu nada passaria no LIVENESS, e o LLM-judge receberia
 * `''` como "texto da resposta".
 */
const isRealOutbound = (mensagem_id: string) =>
  and(
    eq(mensagens.tenant_id, PROBE_TENANT_ID),
    eq(mensagens.agent_id, PROBE_AGENT_ID),
    eq(mensagens.direcao, 'out'),
    ne(mensagens.tipo, 'evento'),
    sql`${mensagens.metadata} ->> 'in_reply_to' = ${mensagem_id}`,
  );

/**
 * Asserção de LIVENESS (§1.4b): existe uma `mensagens direcao='out'` que
 * responde à entrada do run (metadata.in_reply_to = mensagem_id)? Prova que a
 * cadeia chegou à fronteira de saída (a row é persistida mesmo com o sink — a
 * entrega física é o Nível 3).
 */
export async function hasOutboundReply(mensagem_id: string): Promise<boolean> {
  const rows = await db
    .select({ id: mensagens.id })
    .from(mensagens)
    .where(isRealOutbound(mensagem_id))
    .limit(1);
  return rows.length > 0;
}

/** Texto da resposta (para o LLM-judge, §1.4c). */
export async function latestOutboundText(mensagem_id: string): Promise<string | null> {
  const rows = await db
    .select({ conteudo: mensagens.conteudo })
    .from(mensagens)
    .where(isRealOutbound(mensagem_id))
    .orderBy(desc(mensagens.created_at))
    .limit(1);
  return rows[0]?.conteudo ?? null;
}
