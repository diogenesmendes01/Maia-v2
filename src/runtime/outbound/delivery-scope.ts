/**
 * Issue #633 (fatia D da épica #506) — a FRONTEIRA DE CONFIANÇA do job de
 * entrega.
 *
 * Irmão exato de `src/runtime/turns/scope-resolver.ts` (#504), e pela mesma
 * razão: o job carrega `{version: 1, outbound_id}` e mais nada, então alguém
 * tem de traduzir `outbound_id -> (tenant, agent, destinatário)` ANTES de
 * qualquer trabalho de domínio. Essa tradução é, por construção, CROSS-TENANT:
 * quem descobre o dono não pode já estar escopado pelo dono.
 *
 * É a exceção sancionada de `docs/architecture/concerns/tenant-isolation.md`
 * §4.1/§4.2 (padrão de entry-point). O que a torna aceitável não é a intenção;
 * são os predicados:
 *
 *  1. **O payload não pode carregar escopo.** `OutboundDeliveryJobSchema` é
 *     `.strict()` (#632): um payload com `tenant_id` NÃO parseia. Não existe
 *     caminho pelo qual um tenant venha do job; ele vem SEMPRE da linha.
 *
 *  2. **O escopo é lido da linha, numa declaração, com projeção mínima.** Um id
 *     forjado que por acaso exista não entrega conteúdo de ninguém — entrega o
 *     escopo do dono, que é o escopo sob o qual o trabalho vai (legitimamente)
 *     rodar. `payload_json` NÃO é projetado aqui: quem o lê é `deliverOutbound`,
 *     já dentro do escopo.
 *
 *  3. **A ligação outbound -> conversa -> pessoa é RECONCILIADA, não
 *     presumida.** A FK de `conversa_id` na 063 é simples (não composta por
 *     tenant), então uma linha do tenant A apontando para a conversa do tenant B
 *     é fisicamente representável. Este resolvedor RECUSA (`scope_mismatch`) em
 *     vez de atravessar. É o único ponto em que os dois escopos são lidos
 *     juntos.
 *
 *  4. **Fail-closed em todo desfecho que não seja "resolvi com certeza"** — id
 *     malformado, linha inexistente, escopo em branco, sentinelas
 *     `default`/`system`, conversa sem pessoa, pessoa sem telefone.
 *
 * ─── O DESTINATÁRIO, e por que ele não está no outbox ───────────────────────
 *
 * #630 manteve telefone e JID FORA de `payload_json` de propósito: é PII, e o
 * payload é persistido, hasheado e logado. O worker, portanto, resolve o
 * destinatário na hora — e resolve pelo MESMO caminho que o dispatcher síncrono
 * (`resolveOutboundJid` em `src/agent/output-dispatch.ts`): o `remote_jid` da
 * mensagem inbound original, com fallback para o telefone da pessoa.
 *
 * Resolver pelo inbound e não pelo telefone é o que mantém a resposta na MESMA
 * thread em que o usuário falou — inclusive quando ela é um `@lid` de
 * privacidade, que não é derivável do telefone.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { conversas, mensagens, outbound_messages, pessoas } from '@/db/schema.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { counter } from '@/observability/metrics.js';
import { METRIC } from '@/observability/taxonomy.js';

/** Motivo da recusa. Vocabulário FECHADO. */
export const OUTBOUND_SCOPE_REJECTIONS = [
  'malformed_outbound_id',
  'outbound_not_found',
  'scope_unusable',
  'scope_mismatch',
  'recipient_unresolvable',
] as const;

export type OutboundScopeRejection = (typeof OUTBOUND_SCOPE_REJECTIONS)[number];

/**
 * Escopo SELADO de um job de entrega. Todos os campos vieram da MESMA row, no
 * MESMO SELECT.
 */
export type OutboundDeliveryScope = {
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly outbound_id: string;
  readonly conversa_id: string;
  readonly channel_id: string | null;
  readonly in_reply_to: string;
  /** O JID de destino, já reconciliado (thread original > telefone). */
  readonly jid: string;
};

/**
 * Erro TIPADO e não `null` porque o chamador não tem desfecho alternativo
 * legítimo: sem escopo não há entrega, e seguir sem ele é o fail-open que a
 * invariante proíbe.
 */
export class OutboundScopeUnresolvedError extends Error {
  readonly code = 'OUTBOUND_SCOPE_UNRESOLVED';
  readonly reason: OutboundScopeRejection;
  readonly outbound_id: string;

  constructor(reason: OutboundScopeRejection, outbound_id: string) {
    super(
      `resolveOutboundDeliveryScope: escopo da linha do outbox não pôde ser resolvido ` +
        `(reason=${reason}); o job não autoriza entrega sem um par (tenant, agent) ` +
        `reconciliado com a linha persistida`,
    );
    this.name = 'OutboundScopeUnresolvedError';
    this.reason = reason;
    this.outbound_id = outbound_id;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mesma regra de `usableScopeField` em #504: string não-vazia, já aparada, e
 * nenhum dos dois sentinelas reservados. `'default'` é recusado AQUI e não só
 * na leitura do ALS, porque uma fronteira não pode depender de
 * `MAIA_REJECT_DEFAULT_LITERAL` para ser fail-closed.
 */
function usableScopeField(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0 || v !== value) return false;
  return v !== 'default' && v !== 'system';
}

type ScopeRow = {
  outbound_tenant_id: string | null;
  outbound_agent_id: string | null;
  conversa_id: string;
  channel_id: string | null;
  in_reply_to: string;
  conversa_tenant_id: string | null;
  conversa_agent_id: string | null;
  inbound_remote_jid: string | null;
  pessoa_telefone: string | null;
};

async function refuse(
  reason: OutboundScopeRejection,
  outbound_id: string,
): Promise<never> {
  const shaped = UUID_RE.test(outbound_id);
  counter(METRIC.OUTBOUND_DELIVERY_CLAIM, { result: 'not_found' });
  logger.error(
    // `outbound_id` em LOG, nunca em label: a taxonomia proíbe id de correlação
    // como dimensão de série.
    { outbound_id, reason, ops_alert: true },
    'outbound.delivery_scope_rejected',
  );
  // Sem contexto de tenant ativo, `audit()` embrulha em `system` — a atribuição
  // HONESTA de uma recusa cujo tema é justamente não saber o dono.
  await audit({
    acao: 'outbound_dispatch_failed',
    ...(shaped ? { alvo_id: outbound_id } : {}),
    metadata: { reason, stage: 'scope_resolution', outbound_id_shape: shaped ? 'uuid' : 'malformed' },
  });
  throw new OutboundScopeUnresolvedError(reason, outbound_id);
}

/**
 * Traduz o `outbound_id` de um job no escopo SELADO sob o qual a entrega pode
 * rodar. Lança `OutboundScopeUnresolvedError` em qualquer desfecho que não seja
 * uma resolução inequívoca.
 *
 * NÃO decide se a linha DEVE ser entregue: elegibilidade, posse e exclusão
 * mútua são do claim atômico (#632). Uma linha já terminal resolve normalmente
 * aqui e é barrada adiante — misturar as duas perguntas faria o resolvedor
 * virar uma segunda máquina de estados.
 */
export async function resolveOutboundDeliveryScope(
  outbound_id: string,
): Promise<OutboundDeliveryScope> {
  // Antes do banco: um id fora de forma nunca vira consulta. É a recusa mais
  // barata a um payload forjado, e mantém a tabela fora do alcance de um probe
  // de existência com entrada arbitrária.
  if (typeof outbound_id !== 'string' || !UUID_RE.test(outbound_id)) {
    return refuse('malformed_outbound_id', String(outbound_id));
  }
  const normalized = outbound_id.toLowerCase();

  const result = await db.execute<ScopeRow>(sql`
    SELECT
      o.tenant_id   AS outbound_tenant_id,
      o.agent_id    AS outbound_agent_id,
      o.conversa_id AS conversa_id,
      -- channel_id vem da CONVERSA e não da linha do outbox: a 090 pôs a
      -- coluna em conversas/mensagens/outbox_messages (a fila de
      -- agendamento), NUNCA em outbound_messages. Ler daqui é o mesmo que o
      -- dispatcher síncrono faz, e null (conversa anterior ao roteamento
      -- multi-linha) cai no forCurrentAgentChannel(null) de deliverOutbound,
      -- que é fail-closed: sem canal único ativo, não há envio.
      c.channel_id  AS channel_id,
      o.in_reply_to AS in_reply_to,
      c.tenant_id   AS conversa_tenant_id,
      c.agent_id    AS conversa_agent_id,
      m.metadata->>'remote_jid' AS inbound_remote_jid,
      p.telefone_whatsapp       AS pessoa_telefone
    FROM ${outbound_messages} o
    LEFT JOIN ${conversas} c ON c.id = o.conversa_id
    LEFT JOIN ${mensagens} m ON m.id = o.in_reply_to
    LEFT JOIN ${pessoas}   p ON p.id = c.pessoa_id
    WHERE o.id = ${normalized}
    LIMIT 1
  `);
  const row = (result.rows as unknown as ScopeRow[])[0];
  if (!row) return refuse('outbound_not_found', normalized);

  if (!usableScopeField(row.outbound_tenant_id) || !usableScopeField(row.outbound_agent_id)) {
    return refuse('scope_unusable', normalized);
  }
  // LEFT JOIN sem par, ou par de OUTRO escopo. A FK de `conversa_id` (063) não
  // é composta por tenant, então esta igualdade é a única coisa entre um
  // ponteiro cruzado e uma mensagem entregue ao destinatário errado.
  if (
    row.conversa_tenant_id !== row.outbound_tenant_id ||
    row.conversa_agent_id !== row.outbound_agent_id
  ) {
    return refuse('scope_mismatch', normalized);
  }

  // O destinatário, pelo MESMO caminho do dispatcher síncrono: a thread em que
  // o usuário falou vence o telefone derivado. Um `@lid` de privacidade só
  // existe por aqui — reconstruí-lo do telefone é impossível.
  const jid =
    typeof row.inbound_remote_jid === 'string' && row.inbound_remote_jid.length > 0
      ? row.inbound_remote_jid
      : typeof row.pessoa_telefone === 'string' && row.pessoa_telefone.length > 0
        ? `${row.pessoa_telefone.replace('+', '')}@s.whatsapp.net`
        : null;
  if (jid === null) return refuse('recipient_unresolvable', normalized);

  return {
    tenant_id: row.outbound_tenant_id,
    agent_id: row.outbound_agent_id,
    outbound_id: normalized,
    conversa_id: row.conversa_id,
    channel_id: row.channel_id,
    in_reply_to: row.in_reply_to,
    jid,
  };
}
