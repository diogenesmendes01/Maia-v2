/**
 * K-15 (spec §4.1) — leitura e escrita CAS de `agent_engine_policies` (145).
 *
 * Regras que este módulo segura:
 *
 *  1. **Escopo vem do ALS.** `tenant_id + agent_id` saem de `scope()`, como em
 *     `engine-repos.ts`. O chamador só escolhe o canal, e a FK composta da 145
 *     recusa canal de outro tenant ou agente.
 *  2. **Ausência ≠ falha.** Consulta que funcionou e não achou linha devolve
 *     `null` (o seletor lê como `maia_react`). Consulta que FALHOU lança
 *     `EnginePolicyLookupError`: falha de lookup fecha — recusa, nunca amplia —
 *     e virar `maia_react` em silêncio esconderia um banco quebrado.
 *  3. **Escrita é CAS.** Só aplica se `row_version` bate (insert quando
 *     `expected_row_version` é `null`). Perder a corrida devolve
 *     `stale_row_version` tipado e a linha não muda.
 *
 * Auditoria NÃO acontece aqui, como nos irmãos puro-DB: quem escreve política
 * (console, ainda inexistente) audita. Não há chamador de produção ainda.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { EngineKind } from '@/runtime/engines/contracts.js';
import { ENGINE_KINDS } from '@/runtime/engines/schemas.js';
import type { EnginePolicyBindingFactV1 } from '@/onboarding/readiness.js';
import { db } from '../client.js';
import { agent_engine_policies } from '../schema.js';
import { getCurrentAgent, getCurrentTenant } from '../tenant-context.js';

function scope(): { tenant_id: string; agent_id: string } {
  return { tenant_id: getCurrentTenant(), agent_id: getCurrentAgent() };
}

export type EnginePolicyScope = { tenant_id: string; agent_id: string; channel_id: string };

export type EnginePolicy = {
  engine: EngineKind;
  row_version: number;
  updated_by: string;
  updated_at: Date;
};

export type EnginePolicyWriteResult =
  | { ok: true; row_version: number }
  | { ok: false; reason: 'stale_row_version'; current_row_version: number | null };

/** Lookup que não conseguiu responder. Nunca significa "sem linha". */
export class EnginePolicyLookupError extends Error {
  readonly code = 'ENGINE_POLICY_LOOKUP_FAILED';

  constructor(
    readonly reason: 'query_failed' | 'invalid_row' | 'scope_mismatch',
    options?: { cause?: unknown },
  ) {
    super(`lookup de agent_engine_policies falhou: ${reason}`, options);
    this.name = 'EnginePolicyLookupError';
  }
}

function isEngineKind(v: string): v is EngineKind {
  return (ENGINE_KINDS as readonly string[]).includes(v);
}

const t = agent_engine_policies;

export const enginePoliciesRepo = {
  /** A política do canal no escopo do ALS; `null` quando não há linha. */
  async find(channel_id: string): Promise<EnginePolicy | null> {
    const { tenant_id, agent_id } = scope();
    let rows: Array<{ engine: string; row_version: number; updated_by: string; updated_at: Date }>;
    try {
      rows = await db
        .select({
          engine: t.engine,
          row_version: t.row_version,
          updated_by: t.updated_by,
          updated_at: t.updated_at,
        })
        .from(t)
        .where(
          and(eq(t.tenant_id, tenant_id), eq(t.agent_id, agent_id), eq(t.channel_id, channel_id)),
        );
    } catch (err) {
      throw new EnginePolicyLookupError('query_failed', { cause: err });
    }
    const row = rows[0];
    if (!row) return null;
    // O CHECK da 145 já impede; conferir aqui evita que um valor fora do enum
    // chegue ao seletor com cara de política válida.
    if (!isEngineKind(row.engine)) throw new EnginePolicyLookupError('invalid_row');
    return {
      engine: row.engine,
      row_version: Number(row.row_version),
      updated_by: row.updated_by,
      updated_at: row.updated_at,
    };
  },

  /**
   * Escrita CAS. `expected_row_version: null` = "não existe linha": insere com
   * versão 1. Número = "a linha está nesta versão": atualiza e sobe 1.
   */
  async write(input: {
    channel_id: string;
    engine: EngineKind;
    expected_row_version: number | null;
    updated_by: string;
  }): Promise<EnginePolicyWriteResult> {
    const { tenant_id, agent_id } = scope();
    const { channel_id, engine, expected_row_version, updated_by } = input;
    const doEscopo = and(
      eq(t.tenant_id, tenant_id),
      eq(t.agent_id, agent_id),
      eq(t.channel_id, channel_id),
    );

    const aplicada =
      expected_row_version === null
        ? await db
            .insert(t)
            .values({ tenant_id, agent_id, channel_id, engine, updated_by })
            .onConflictDoNothing({ target: [t.tenant_id, t.agent_id, t.channel_id] })
            .returning({ row_version: t.row_version })
        : await db
            .update(t)
            .set({
              engine,
              updated_by,
              row_version: sql`${t.row_version} + 1`,
              updated_at: sql`now()`,
            })
            .where(and(doEscopo, eq(t.row_version, expected_row_version)))
            .returning({ row_version: t.row_version });

    if (aplicada[0]) return { ok: true, row_version: Number(aplicada[0].row_version) };

    const atual = await db.select({ row_version: t.row_version }).from(t).where(doEscopo);
    return {
      ok: false,
      reason: 'stale_row_version',
      current_row_version: atual[0] ? Number(atual[0].row_version) : null,
    };
  },
};

/**
 * Porta de leitura do seletor (`lookupEngineForNewTurn`). O escopo pedido tem
 * de ser o do ALS: um chamador com tenant/agente trocado recusa, em vez de ler
 * a política de outro escopo ou de devolver "sem linha".
 */
export async function readEnginePolicyForScope(s: EnginePolicyScope): Promise<EnginePolicy | null> {
  const atual = scope();
  if (s.tenant_id !== atual.tenant_id || s.agent_id !== atual.agent_id) {
    throw new EnginePolicyLookupError('scope_mismatch');
  }
  return enginePoliciesRepo.find(s.channel_id);
}

// ─── SC03: leitura por ESCOPO EXPLÍCITO (readiness e sua revalidação) ─────────

/**
 * Executor de leitura: o handle global `db` OU o `tx` do passo de ativação.
 *
 * A ativação precisa reler as linhas de política DENTRO da transação que faz as
 * escritas; caso contrário a revalidação de CAS compararia o retrato com um
 * banco que não é o do commit, que é a forma mais fácil de um check verde
 * autorizar uma escrita que a configuração já não sustenta.
 */
export type EnginePolicyReadExecutor = Pick<typeof db, 'select'>;

/**
 * Executor capaz de tomar lock — só o `tx` de um passo, nunca o `db` global
 * (mesmo tipo de `LockingExecutor` em `readiness-facts.ts`).
 */
export type EnginePolicyLockExecutor = Pick<typeof db, 'execute'>;

/**
 * As linhas de `agent_engine_policies` do escopo pedido — TODAS elas, incluindo
 * as de outros canais do mesmo agente, porque é a POLÍTICA do agente que decide
 * se o motor remoto é pedido.
 *
 * Escopo EXPLÍCITO (`tenant_id AND agent_id` no `WHERE`), e não o par do ALS:
 * diferente de `readEnginePolicyForScope`, aqui o alvo é arbitrário (a run de
 * ativação, o doctor, o console), e exigir ALS obrigaria o chamador a mentir
 * sobre quem está rodando. A checagem de escopo do avaliador puro continua
 * existindo por cima (`owns`), porque um `WHERE` esquecido é o modo de falha
 * que o readiness existe para pegar.
 *
 * Falha de consulta SOBE como `EnginePolicyLookupError`: nunca devolve `[]`,
 * que significaria "este agente não pede o motor remoto".
 */
export async function loadEnginePolicyBindingsWith(
  executor: EnginePolicyReadExecutor,
  s: { tenant_id: string; agent_id: string },
): Promise<readonly EnginePolicyBindingFactV1[]> {
  let rows: Array<{ tenant_id: string; agent_id: string; channel_id: string; engine: string; row_version: number }>;
  try {
    rows = await executor
      .select({
        tenant_id: t.tenant_id,
        agent_id: t.agent_id,
        channel_id: t.channel_id,
        engine: t.engine,
        row_version: t.row_version,
      })
      .from(t)
      .where(and(eq(t.tenant_id, s.tenant_id), eq(t.agent_id, s.agent_id)));
  } catch (err) {
    throw new EnginePolicyLookupError('query_failed', { cause: err });
  }
  return rows.map((r) => ({
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    channel_id: r.channel_id,
    // O valor é validado pelo avaliador puro contra o vocabulário fechado; o
    // CHECK da 145 é a segunda barreira.
    engine: r.engine,
    row_version: Number(r.row_version),
  }));
}

/** O caminho default do readiness: leitura pelo handle global. */
export async function loadEnginePolicyBindingsFromDb(s: {
  tenant_id: string;
  agent_id: string;
}): Promise<readonly EnginePolicyBindingFactV1[]> {
  return loadEnginePolicyBindingsWith(db, s);
}

/**
 * SC03-AC01 (correção pós-QA239/240) — TRAVA as linhas de política do escopo
 * na transação da ativação.
 *
 * O achado: a revalidação CAS relia as linhas pelo `tx` da ativação, mas
 * `FOR SHARE` não é predicate lock e nada travava `agent_engine_policies`.
 * MEDIDO pelo QA em Postgres real: um `UPDATE` concorrente de uma linha
 * existente (hermes → maia_react, `row_version` 1 → 2) era aplicado em ~1ms
 * DEPOIS da releitura, então `applyActivate` committava sobre um retrato que já
 * não valia. `INSERT` de linha nova já era bloqueado pela FK composta para
 * `channels` (a ativação trava `channels` com `FOR UPDATE`); o buraco era
 * `UPDATE`/`DELETE` de linha EXISTENTE.
 *
 * Por que `FOR SHARE` (e não `FOR UPDATE`): a ativação só LÊ estas linhas — ela
 * não troca motor nem liga Hermes. `FOR SHARE` permite leituras concorrentes
 * (o seletor de turno, o doctor, outra ativação de outro agente) e bloqueia
 * `UPDATE`/`DELETE` concorrentes até o commit, que é exatamente o que o CAS
 * precisa para comparar o retrato contra o banco que vai commitar. Mesma
 * escolha e mesmo raciocínio de `lockReadinessSnapshot`
 * (`readiness-facts.ts`), da qual esta função é a linha que faltava.
 *
 * Ordem: chamada IMEDIATAMENTE depois de `lockReadinessSnapshot` e ANTES da
 * reavaliação/da releitura do CAS, para que todas as leituras do retrato
 * aconteçam sob a mesma trava.
 *
 * O que continua NÃO prometido: uma linha NOVA inserida concorrentemente (canal
 * criado no meio da ativação) não é travada por nada — vale o mesmo resíduo
 * documentado em `lockReadinessSnapshot`, mitigado pela reconferência que
 * `applyActivate` faz das próprias escritas e pelo CAS da avaliação seguinte.
 *
 * Falha de consulta SOBE (`EnginePolicyLookupError`): uma ativação que não
 * conseguiu travar as linhas NÃO pode seguir achando que o retrato está
 * protegido.
 */
export async function lockEnginePolicyBindings(
  executor: EnginePolicyLockExecutor,
  s: { tenant_id: string; agent_id: string },
): Promise<void> {
  try {
    await executor.execute(
      sql`SELECT 1 FROM agent_engine_policies
           WHERE tenant_id = ${s.tenant_id} AND agent_id = ${s.agent_id} FOR SHARE`,
    );
  } catch (err) {
    throw new EnginePolicyLookupError('query_failed', { cause: err });
  }
}
