/**
 * Issue #504 (decisão do dono, rodada de revisão) — os PREDICADOS de uma
 * gravação de turno, isolados num módulo PURO.
 *
 * Por que isto não mora dentro de `turn-repos.ts`: aquele módulo importa
 * `../client.js`, que constrói o `pg.Pool` no import e exige `DATABASE_URL`.
 * Enquanto o `WHERE` do compare-and-swap morava lá dentro, a única prova
 * possível de que o fence existe era um teste de integração — e um teste de
 * integração que não roda (Postgres fora do ar, CI vermelho por outro motivo)
 * não prova nada. Aqui o `WHERE` é construído por uma função pura, então
 * `new PgDialect().sqlToQuery(...)` compila o SQL REAL, sem banco, e um teste
 * unitário pode afirmar que a condição de lease do absorvedor está lá.
 *
 * A regra que torna isso honesto: `runTransition` NÃO monta predicado nenhum
 * por conta própria — ele chama `turnWriteConditions()`. Se alguém apagar a
 * linha da lease daqui, a produção fica insegura E o teste fica vermelho, que é
 * a única relação que faz um teste valer alguma coisa.
 *
 * ─── As DUAS formas de fence, e por que são diferentes ──────────────────────
 *
 * `self` — a gravação pertence à tentativa DO PRÓPRIO turno que está mudando.
 *   Fence: `claim_token` da linha que muda + lease viva. É o caso de
 *   `completeTurnTx`, `markRetryable`, `markRunning`, `markSupersededSelf`.
 *
 * `absorber` — a gravação muda a linha do turno ABSORVIDO, mas a AUTORIDADE
 *   para fazê-la é de OUTRO turno, o absorvedor. Fence: `claim_token` + lease
 *   do ABSORVEDOR, verificados na MESMA declaração, mais o compare-and-swap na
 *   linha do irmão.
 *
 *   Exigir claim do IRMÃO seria o erro simétrico e mais fácil de cometer: o
 *   turno absorvido normalmente NUNCA foi reivindicado (ele existe porque o
 *   ingresso cria um turno por mensagem, e a rajada do debounce faz com que só
 *   um deles seja executado), então `claim_token IS NULL` é o estado NORMAL
 *   dele. Um fence sobre o irmão tornaria a absorção legítima impossível
 *   justamente no caso comum. Afrouxar os dois lados é o erro oposto: sem o
 *   fence do absorvedor, um worker zumbi — que já perdeu a lease e cuja
 *   tentativa foi sucedida por outra — continuaria absorvendo turnos e
 *   apagando trabalho que pertence ao sucessor.
 *
 *   O FENCE PERTENCE A QUEM ABSORVE.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { agent_turns } from '../schema.js';
import { FENCED_WRITE_STATUSES } from '@/runtime/turns/claim.js';
import type { TurnStatus } from '@/runtime/turns/contract.js';

/**
 * Lista de estados como argumentos de um `IN (...)`, cada um parametrizado.
 *
 * Interpolar um array JS direto num template `sql` do Drizzle NÃO produz um
 * array do Postgres: ele vira uma lista de placeholders `($1, $2, $3)`, e
 * `($1,$2,$3)::text[]` é um RECORD, que o Postgres recusa converter
 * (`cannot cast type record to text[]`). O erro só aparece em tempo de
 * execução, contra banco real — este helper existe para que a forma correta
 * seja a única disponível.
 */
export function statusList(statuses: readonly string[]) {
  return sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  );
}

/** O fence de uma gravação: sobre a própria linha, ou sobre o absorvedor. */
export type TurnWriteFence =
  /** Sem posse a exigir — regime de #503 (`FEATURE_TURN_CLAIM` OFF). */
  | { kind: 'none' }
  /** A tentativa é do próprio turno que está mudando. */
  | { kind: 'self'; claim_token: string }
  /**
   * A autoridade é de OUTRO turno (o absorvedor do debounce). O turno que muda
   * NÃO precisa — e normalmente não tem — claim próprio.
   */
  | { kind: 'absorber'; absorber_turn_id: string; claim_token: string };

/**
 * Fence do ABSORVEDOR: existe, é dele, e a lease está viva AGORA.
 *
 * As três condições são necessárias e nenhuma é decorativa:
 *
 *  - `id = <absorvedor>` + escopo: a autoridade tem de ser um turno DESTE
 *    tenant/agente. Sem isso, um `turn_id` vindo de fora do escopo poderia
 *    autorizar uma absorção — vazamento entre tenants por um caminho que
 *    ninguém olha.
 *  - `claim_token = <o meu>`: só o dono corrente da tentativa absorvedora
 *    manda. Um token velho é de uma encarnação que já foi sucedida.
 *  - `lease_expires_at > now()`: só o token não basta. Entre a perda da lease e
 *    o takeover existe uma janela em que o token antigo AINDA é o vigente na
 *    linha; nela, um zumbi com token que casa absorveria turnos sem ter posse.
 *    `now()` é o relógio do PostgreSQL — o único comparável entre réplicas.
 *  - `status IN (claimed|running|outbound_pending)`: um turno terminal não
 *    absorve ninguém.
 */
export function absorberFenceCondition(input: {
  tenant_id: string;
  agent_id: string;
  absorber_turn_id: string;
  claim_token: string;
}): SQL {
  return sql`EXISTS (
    SELECT 1
      FROM ${agent_turns} AS absorvedor
     WHERE absorvedor.tenant_id        = ${input.tenant_id}
       AND absorvedor.agent_id         = ${input.agent_id}
       AND absorvedor.id               = ${input.absorber_turn_id}::uuid
       AND absorvedor.claim_token      = ${input.claim_token}::uuid
       AND absorvedor.lease_expires_at > now()
       AND absorvedor.status IN (${statusList(FENCED_WRITE_STATUSES)})
  )`;
}

/**
 * O `WHERE` COMPLETO de uma transição de turno. Fonte ÚNICA — `runTransition`
 * não acrescenta nem remove nada depois desta chamada.
 *
 * Ordem das condições: escopo, identidade, compare-and-swap de estado,
 * compare-and-swap de versão, fence. É a ordem em que um revisor procura, e
 * também a ordem em que elas falham na prática.
 */
export function turnWriteConditions(input: {
  tenant_id: string;
  agent_id: string;
  turn_id: string;
  sources: readonly TurnStatus[];
  expected_version?: number;
  fence: TurnWriteFence;
}): SQL[] {
  const conditions: SQL[] = [
    eq(agent_turns.tenant_id, input.tenant_id),
    eq(agent_turns.agent_id, input.agent_id),
    eq(agent_turns.id, input.turn_id),
    inArray(agent_turns.status, [...input.sources]),
  ];
  if (input.expected_version !== undefined) {
    conditions.push(eq(agent_turns.state_version, input.expected_version));
  }
  if (input.fence.kind === 'self') {
    // Token vigente E lease viva. Só o token deixaria escrever quem perdeu a
    // lease e ainda não foi sucedido; só a lease deixaria passar o zumbi
    // enquanto o sucessor renova a dele.
    conditions.push(eq(agent_turns.claim_token, input.fence.claim_token));
    conditions.push(sql`${agent_turns.lease_expires_at} > now()`);
  }
  if (input.fence.kind === 'absorber') {
    // NENHUMA condição sobre `agent_turns.claim_token` da linha que muda: o
    // irmão absorvido não tem claim, e exigi-lo tornaria a absorção legítima
    // impossível no caso normal. O fence inteiro está no EXISTS.
    conditions.push(
      absorberFenceCondition({
        tenant_id: input.tenant_id,
        agent_id: input.agent_id,
        absorber_turn_id: input.fence.absorber_turn_id,
        claim_token: input.fence.claim_token,
      }),
    );
  }
  return conditions;
}

/** Conveniência: o `and(...)` já montado, para quem só quer a condição única. */
export function turnWriteWhere(input: Parameters<typeof turnWriteConditions>[0]): SQL {
  return and(...turnWriteConditions(input)) as SQL;
}
