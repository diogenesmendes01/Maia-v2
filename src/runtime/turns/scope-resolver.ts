/**
 * Issue #504 §Contrato do job — a FRONTEIRA DE CONFIANÇA do payload V2.
 *
 * ─── O problema que este módulo existe para resolver ────────────────────────
 *
 * Um job V2 carrega `{version: 2, turn_id}` e mais nada. O consumidor da fila
 * entra pelo `runAgentForMensagem(mensagem_id)`, e o tenant só é resolvido lá
 * dentro. Alguém, portanto, tem de traduzir `turn_id -> (tenant, agent,
 * mensagem representativa)` ANTES de qualquer trabalho de domínio — e essa
 * tradução é, por construção, CROSS-TENANT: quem descobre o dono não pode já
 * estar escopado pelo dono.
 *
 * É a mesma exceção sancionada de `channelsRepo.findByExternalCrossTenant` e de
 * `mensagensRepo.findOwnerByIdCrossTenant` (AGENTS.md §4.1 + o padrão de
 * entry-point em `docs/architecture/concerns/tenant-isolation.md` §4.1/§4.2).
 * O que a torna aceitável não é a intenção: são os predicados abaixo.
 *
 * ─── O que impede um payload FORJADO de ser explorado ───────────────────────
 *
 *  1. **O payload não pode carregar escopo.** `AgentTurnJobV2Schema` é
 *     `.strict()` (`src/runtime/turns/job.ts`): um payload com `tenant_id`,
 *     `agent_id` ou qualquer chave extra NÃO parseia como V2, e como não tem
 *     `mensagem_id` também não parseia como V1 — vira `invalid`, vira métrica,
 *     e nunca chega aqui. Não existe caminho pelo qual um tenant venha do
 *     payload; ele vem SEMPRE da linha persistida.
 *
 *  2. **O escopo é lido da linha, numa única declaração, com projeção mínima.**
 *     `findJobScopeByIdCrossTenant` devolve só colunas de escopo/identidade e
 *     dois timestamps. Um id forjado que por acaso exista não entrega conteúdo
 *     de ninguém — entrega o escopo do dono, que é exatamente o escopo sob o
 *     qual o trabalho vai (legitimamente) rodar.
 *
 *  3. **A ligação turno -> mensagem é RECONCILIADA, não presumida.**
 *     `agent_turns.representative_message_id` não tem foreign key (só uma
 *     unique — `migrations/097_agent_turns.sql`), então um turno do tenant A
 *     apontando para uma mensagem do tenant B é fisicamente representável: por
 *     corrupção, por backfill mal parametrizado, ou por escrita direta. Este
 *     resolvedor RECUSA essa combinação (`scope_mismatch`) em vez de
 *     atravessá-la. É o único ponto do sistema que faz essa pergunta, porque é
 *     o único ponto em que os dois escopos são lidos juntos.
 *
 *  4. **Fail-closed em TODOS os desfechos que não sejam "resolvi com certeza".**
 *     Id malformado, turno inexistente, mensagem inexistente, escopo em branco
 *     e os sentinelas `'default'`/`'system'` recusam. Nenhum deles cai em
 *     default, nem em "tenta assim mesmo": recusar devolve o job à política de
 *     retry/DLQ da BullMQ, que é onde um payload irreconhecível pertence.
 *
 *  5. **Toda recusa é AUDITADA e medida**, com `reason` de cardinalidade
 *     fechada — nunca texto derivado do payload.
 *
 * ─── O que este módulo deliberadamente NÃO faz ──────────────────────────────
 *
 * Não decide se o turno DEVE executar. Elegibilidade, posse e exclusão mútua
 * são do claim (`src/runtime/turns/claim.ts` + `lifecycle.ts`). Um turno já
 * terminal resolve normalmente aqui e é barrado adiante, pelo claim — misturar
 * as duas perguntas faria o resolvedor virar uma segunda máquina de estados,
 * com o drift que isso implica.
 */
import { agentTurnsRepo } from '@/db/repositories/turn-repos.js';
import { audit } from '@/governance/audit.js';
import { logger } from '@/lib/logger.js';
import { counter } from '@/observability/metrics.js';
import {
  METRIC,
  TURN_SCOPE_REJECTION_VALUES,
  closedVocabulary,
} from '@/observability/taxonomy.js';

/** Motivo da recusa. Vocabulário FECHADO — ver `TURN_SCOPE_REJECTION_VALUES`. */
export type TurnScopeRejection =
  | 'malformed_turn_id'
  | 'turn_not_found'
  | 'scope_unusable'
  | 'representative_missing'
  | 'scope_mismatch';

/**
 * Escopo SELADO de um job V2: o par (tenant, agent) dono do turno e a mensagem
 * representativa que o consumidor vai processar. Os três campos vieram da MESMA
 * row, no MESMO SELECT.
 */
export type TurnJobScope = {
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly turn_id: string;
  readonly mensagem_id: string;
  /** `mensagens.created_at` em epoch ms — o relógio do SLI ponta-a-ponta. */
  readonly received_at_ms: number | null;
  /** `agent_turns.queued_at` em epoch ms — o relógio da espera na fila. */
  readonly queued_at_ms: number | null;
};

/**
 * O resolvedor recusou. É um erro TIPADO e não um `null` porque o chamador não
 * tem desfecho alternativo legítimo: sem escopo não há turno a executar, e
 * seguir sem ele é precisamente o fail-open que a invariante proíbe.
 */
export class TurnScopeUnresolvedError extends Error {
  readonly code = 'TURN_SCOPE_UNRESOLVED';
  readonly reason: TurnScopeRejection;
  readonly turn_id: string;

  constructor(reason: TurnScopeRejection, turn_id: string) {
    super(
      `resolveTurnJobScope: escopo do turno não pôde ser resolvido (reason=${reason}); ` +
        `o job V2 não autoriza execução sem um par (tenant, agent) reconciliado com a linha persistida`,
    );
    this.name = 'TurnScopeUnresolvedError';
    this.reason = reason;
    this.turn_id = turn_id;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Um par (tenant, agent) só é utilizável se for string não-vazia, já aparada, e
 * não for um dos dois sentinelas reservados.
 *
 * `'default'` é recusado AQUI, e não só na leitura do ALS: entrar em
 * `runWithTenantContext({tenant_id: 'default'})` só falha se
 * `MAIA_REJECT_DEFAULT_LITERAL` estiver ligada, e esta é uma fronteira que não
 * pode depender de uma flag de rollout para ser fail-closed (AGENTS.md §4.8).
 * Nenhuma row legítima de `agent_turns` pode estar sob ele: a tabela nasceu na
 * migration 097, depois da 082 (`rehome_default_to_primary`) — o baseline
 * single-tenant é `primary/primary`.
 *
 * `'system'` também não passa: é o bucket RESERVADO para trabalho global SEM
 * dono (`src/db/tenant-context.ts`), e um turno inbound tem dono por definição.
 * Um turno gravado sob `system` é dado corrompido, não trabalho de plataforma.
 */
function usableScopeField(value: string | null | undefined): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0 || v !== value) return false;
  return v !== 'default' && v !== 'system';
}

function toEpochMs(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function refuse(reason: TurnScopeRejection, turn_id: string): Promise<never> {
  const shaped = UUID_RE.test(turn_id);
  counter(METRIC.TURN_SCOPE_REJECTED, {
    reason: closedVocabulary(reason, TURN_SCOPE_REJECTION_VALUES),
  });
  logger.error(
    {
      // `turn_id` em LOG (nunca em label — a taxonomia proíbe id de correlação
      // como dimensão de série). É o que o operador usa para investigar.
      turn_id,
      reason,
      ops_alert: true,
    },
    'turn.job_scope_rejected',
  );
  // Sem contexto de tenant ativo, `audit()` embrulha em `system` — que é a
  // atribuição HONESTA de uma recusa cujo tema é justamente não saber o dono.
  // Nenhum campo do payload entra na row: só o id (quando é UUID) e o motivo
  // fechado.
  await audit({
    acao: 'turn_job_scope_rejected',
    ...(shaped ? { alvo_id: turn_id } : {}),
    metadata: { reason, turn_id_shape: shaped ? 'uuid' : 'malformed' },
  });
  throw new TurnScopeUnresolvedError(reason, turn_id);
}

/**
 * Traduz o `turn_id` de um job V2 no escopo SELADO sob o qual o turno pode
 * rodar. Lança `TurnScopeUnresolvedError` em qualquer desfecho que não seja uma
 * resolução inequívoca.
 */
export async function resolveTurnJobScope(turn_id: string): Promise<TurnJobScope> {
  // Antes do banco: um id fora de forma nunca vira consulta. Não é otimização —
  // é a recusa mais barata possível a um payload forjado, e mantém a tabela
  // fora do alcance de um probe de existência com entrada arbitrária.
  if (typeof turn_id !== 'string' || !UUID_RE.test(turn_id)) {
    return refuse('malformed_turn_id', String(turn_id));
  }
  const normalized = turn_id.toLowerCase();

  const row = await agentTurnsRepo.findJobScopeByIdCrossTenant(normalized);
  if (!row) return refuse('turn_not_found', normalized);

  if (!usableScopeField(row.turn_tenant_id) || !usableScopeField(row.turn_agent_id)) {
    return refuse('scope_unusable', normalized);
  }
  // LEFT JOIN sem par: o turno aponta para uma mensagem que não existe.
  if (row.message_tenant_id === null && row.message_agent_id === null) {
    return refuse('representative_missing', normalized);
  }
  // O PREDICADO CENTRAL. Ver o bloco 3 no topo do arquivo: a coluna não tem FK,
  // então esta igualdade é a única coisa entre um ponteiro cruzado e um turno
  // executado sob o escopo errado.
  if (
    row.message_tenant_id !== row.turn_tenant_id ||
    row.message_agent_id !== row.turn_agent_id
  ) {
    return refuse('scope_mismatch', normalized);
  }

  logger.debug(
    {
      turn_id: normalized,
      tenant_id: row.turn_tenant_id,
      agent_id: row.turn_agent_id,
      turn_status: row.turn_status,
    },
    'turn.job_scope_resolved',
  );

  return Object.freeze({
    tenant_id: row.turn_tenant_id,
    agent_id: row.turn_agent_id,
    turn_id: normalized,
    mensagem_id: row.representative_message_id,
    received_at_ms: toEpochMs(row.message_created_at),
    queued_at_ms: toEpochMs(row.queued_at),
  });
}
