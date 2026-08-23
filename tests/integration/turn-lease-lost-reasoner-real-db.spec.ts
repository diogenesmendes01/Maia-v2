/**
 * Issue #507 — a chamada de LLM EM VOO também é um limite, e a auditoria dela
 * não pode mentir.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * A #504 (PR #567) fechou os limites de EFEITO: topo da próxima iteração do
 * ReAct, dispatcher de tools, outbound e o retorno ao core. O que ela deixou de
 * fora — de propósito, porque colide com o campo desta issue — foi o
 * `callLLM()` do reasoner (`src/agent/react-loop.ts`), que era chamado SEM
 * `signal`.
 *
 * Consequência, com a lease perdida DURANTE o round-trip do reasoner (o trecho
 * mais longo do turno, logo o instante mais provável):
 *
 *   1. a requisição HTTP continuava viva e sendo cobrada até o fim — o guard do
 *      topo da iteração só recusa a iteração SEGUINTE, e o `Promise.race` de
 *      `runCognitiveModule` só escolhe quem responde ao caller;
 *   2. e — o achado do dono — depois que o LLM retornava, `runCognitiveModule`
 *      ainda gravava uma row em `cognitive_module_log`, **possivelmente como
 *      `success`**. Não é efeito de negócio, mas é auditoria semanticamente
 *      errada: um turno que já não era nosso registrando sucesso.
 *
 * Havia ainda um terceiro, mais sutil: `runCognitiveModule` não tinha `cancelled`
 * no vocabulário. Passar o sinal isoladamente teria trocado a mentira `success`
 * por outra, `status='error'` + `fallback_triggered=true` — e o ReAct traduziria
 * o `output: null` em `reasoner_failed`, que `core.ts` lê como RETRY. Ou seja:
 * um cancelamento deliberado agendaria de novo um turno cuja lease pertence a
 * outro worker, que é exatamente a gravação que a #504 proíbe.
 *
 * ─── O que é real e o que é dublê ───────────────────────────────────────────
 *
 * REAL: `runReActLoop` de produção, `runCognitiveModule` de produção, o
 * Postgres, o `cognitive_module_log`, e a perda de posse pelo caminho de sempre
 * (claim SQL → lease vencida → takeover → heartbeat do dono descobre →
 * `AbortSignal`).
 *
 * DUBLÊ: só `callLLM`. É chamada paga a provedor externo, e é o único ponto em
 * que se escolhe o instante da perda sem inventar um harness. O dublê é o
 * INSTRUMENTO deste teste: ele registra se recebeu `signal` e, nos dois casos de
 * barreira, encena os dois comportamentos possíveis de uma dependência —
 * cooperativa (aborta) e NÃO cooperativa (entrega assim mesmo).
 *
 * O call site sondado é o de PRODUÇÃO: nada aqui reconstrói o par
 * `runCognitiveModule` + `callLLM`. Remover `signal:` de
 * `src/agent/react-loop.ts` reprova os dois casos de barreira.
 *
 * ─── O CONTROLE ────────────────────────────────────────────────────────────
 *
 * "Nenhuma row `success` depois da perda" também passaria se o reasoner nunca
 * fosse alcançado, ou se `cognitive_module_log` simplesmente não estivesse
 * sendo escrito neste caminho. O controle roda o MESMO laço com a lease VIVA e
 * exige as rows `success` PRESENTES, uma por iteração. É ele que prova que o
 * zero das barreiras significa alguma coisa.
 *
 * Skipped sem TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import type { Pessoa, Conversa, Mensagem, PermissionProfile, Permissao } from '@/db/schema.js';
import type { ResolvedPermission } from '@/governance/permissions.js';
import type { LLMResponse } from '@/lib/llm/types.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'primary';
const A = 'primary';

/**
 * TTL longo pelo mesmo motivo documentado em
 * `turn-lease-lost-react-loop-real-db.spec.ts`: as BARREIRAS não perdem a posse
 * por expiração (o helper força o vencimento por SQL e um SUCESSOR reivindica —
 * takeover, `token_mismatch`), então um TTL curto só criaria um cronômetro
 * competindo com o corpo do teste e faria o CONTROLE falhar sob contenção.
 */
const TTL_MS = 30_000;
const HEARTBEAT_MS = 400;

/** Iteração em que a perda de posse acontece — durante o round-trip do reasoner. */
const PERDA_NA_CHAMADA = 3;

/**
 * Roteiro do reasoner dublê. `vi.hoisted` porque a fábrica de `vi.mock` é içada
 * acima dos imports.
 */
const llm = vi.hoisted(() => ({
  calls: 0,
  /** O `signal` recebido em cada chamada — `undefined` denuncia falta de propagação. */
  signals: [] as Array<AbortSignal | undefined>,
  /** Chamadas em que o dublê de fato observou o abort (parou de verdade). */
  abortadas: [] as number[],
  /** Roda ANTES de cada resposta. É o gancho que escolhe o instante da perda. */
  before: async (_call: number): Promise<void> => {},
  /**
   * A chamada N deve COOPERAR com o sinal (rejeitar ao abortar) ou ignorá-lo e
   * entregar assim mesmo? `false` encena a dependência não cooperativa — o caso
   * em que o LLM RETORNA depois da perda, que é onde nascia a row `success`.
   */
  cooperativa: (_call: number): boolean => true,
}));

vi.mock('@/lib/claude.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/claude.js')>();
  return {
    ...actual,
    callLLM: async (params: { signal?: AbortSignal }): Promise<LLMResponse> => {
      llm.calls += 1;
      const call = llm.calls;
      llm.signals.push(params.signal);
      const signal = params.signal;
      const resposta = (): LLMResponse => ({
        content: null,
        // SEMPRE uma tool use: assim o laço nunca sai pelo ramo de texto final
        // e vai até o teto de iterações, que é onde o rastro fica visível.
        // A tool não existe no REGISTRY de propósito — o objeto deste teste é o
        // reasoner, não o dispatcher, e uma tool inexistente não deixa efeito.
        tool_uses: [{ id: `tu-${call}`, tool: 'tool_que_nao_existe', args: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'dublê',
      });

      if (llm.cooperativa(call)) {
        // Dependência COOPERATIVA: corre o gancho e o abort em paralelo, e
        // quem chegar primeiro decide. É o comportamento real do gateway
        // (`src/lib/llm/gateway.ts`), que cancela provider, retry e backoff.
        return new Promise<LLMResponse>((resolve, reject) => {
          const onAbort = (): void => {
            llm.abortadas.push(call);
            const e = new Error('llm_call_aborted');
            e.name = 'AbortError';
            reject(e);
          };
          if (signal?.aborted) return onAbort();
          signal?.addEventListener('abort', onAbort, { once: true });
          void llm.before(call).then(() => {
            if (signal?.aborted) return;
            signal?.removeEventListener('abort', onAbort);
            resolve(resposta());
          }, reject);
        });
      }

      // Dependência NÃO COOPERATIVA: ignora o sinal e entrega. O trabalho foi
      // feito e pago; o que não pode acontecer é a row dizer `success`.
      await llm.before(call);
      return resposta();
    },
  };
});

let pool: pg.Pool;
let pessoa: Pessoa;
let conversa: Conversa;
let entidade_id: string;
let resolvedPermission: ResolvedPermission;

const createdMensagens: string[] = [];

const inT = <R>(fn: () => Promise<R>): Promise<R> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

async function mkInbound(): Promise<Mensagem> {
  const r = await pool.query(
    `INSERT INTO mensagens (tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
     VALUES ($1, $2, $3, 'in', 'texto', 'oi', '{}'::jsonb)
     RETURNING *`,
    [T, A, conversa.id],
  );
  const row = r.rows[0] as Mensagem;
  createdMensagens.push(row.id);
  return row;
}

async function claimWithLease(mensagem_id: string) {
  const { agentTurnsRepo } = await import('@/db/repositories.js');
  const { TurnLease } = await import('@/runtime/turns/lease.js');
  const turn = await agentTurnsRepo.ensureTurnForMessage({
    id: mensagem_id,
    tenant_id: T,
    agent_id: A,
    conversa_id: conversa.id,
    channel_id: null,
  });
  const claimed = await agentTurnsRepo.tryClaimTurn({
    turn_id: turn.id,
    worker_id: `dono-${randomUUID().slice(0, 8)}`,
    lease_ms: TTL_MS,
  });
  expect(claimed.ok, 'o dono legítimo deveria ter conseguido o claim').toBe(true);
  if (!claimed.ok) throw new Error('claim não concedido');
  return {
    turn_id: turn.id,
    lease: new TurnLease(claimed.claim, { ttl_ms: TTL_MS, heartbeat_ms: HEARTBEAT_MS }),
  };
}

async function loseOwnershipForReal(
  turn_id: string,
  lease: { alive: boolean; lostReason: string | null },
): Promise<void> {
  const { agentTurnsRepo } = await import('@/db/repositories.js');
  await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [turn_id],
  );
  const successor = await agentTurnsRepo.tryClaimTurn({
    turn_id,
    worker_id: `sucessor-${randomUUID().slice(0, 8)}`,
    lease_ms: 60_000,
  });
  expect(successor.ok, 'o sucessor deveria assumir a lease vencida').toBe(true);
  const deadline = Date.now() + 10_000;
  while (lease.alive && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(lease.alive, 'o heartbeat real deveria ter detectado a perda').toBe(false);
  expect(lease.lostReason, 'a perda tem de vir do TAKEOVER, não de erro de banco').toBe(
    'token_mismatch',
  );
}

type ReasonerRow = {
  status: string;
  fallback_triggered: boolean;
  fallback_reason: string | null;
  metadata: Record<string, unknown>;
};

/** As rows que `runCognitiveModule` gravou para o reasoner DESTE turno. */
async function reasonerRows(mensagem_id: string): Promise<ReasonerRow[]> {
  const r = await pool.query<ReasonerRow>(
    `SELECT status, fallback_triggered, fallback_reason, metadata
       FROM cognitive_module_log
      WHERE tenant_id=$1 AND agent_id=$2 AND turno_id=$3 AND module_name='reasoner'
      ORDER BY started_at ASC`,
    [T, A, mensagem_id],
  );
  return r.rows;
}

async function runLoop(inbound: Mensagem): Promise<unknown> {
  const { runReActLoop } = await import('@/agent/react-loop.js');
  return runReActLoop({
    pessoa,
    conversa,
    inbound,
    scope: {
      entidades: [entidade_id],
      byEntity: new Map<string, ResolvedPermission>([[entidade_id, resolvedPermission]]),
    },
    jid: '5511000000000@s.whatsapp.net',
    system: 'sistema de teste',
    messages: [{ role: 'user', content: 'oi' }],
    tools: [],
  });
}

function resetRoteiro(): void {
  llm.calls = 0;
  llm.signals = [];
  llm.abortadas = [];
  llm.before = async () => {};
  llm.cooperativa = () => true;
}

d('#507 — perda de lease durante o reasoner: a chamada aborta e a auditoria não mente', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });

    const p = await pool.query(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1,$2,'ll507-reasoner', $3, 'dono', 'ativa') RETURNING *`,
      [T, A, `+5511${Math.floor(Math.random() * 1e9)}`],
    );
    pessoa = p.rows[0] as Pessoa;

    const conv = await pool.query(
      `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, escopo_entidades)
       VALUES ($1,$2,$3,'{}') RETURNING *`,
      [T, A, pessoa.id],
    );
    conversa = conv.rows[0] as Conversa;

    const ent = await pool.query<{ id: string }>(
      `INSERT INTO entidades(tenant_id, agent_id, nome, tipo, status)
       VALUES ($1,$2,'PF-ll507-reasoner','pf','ativa') RETURNING id`,
      [T, A],
    );
    entidade_id = ent.rows[0]!.id;

    const prof = await pool.query(
      `INSERT INTO permission_profiles(tenant_id, agent_id, id, nome, acoes, limite_default)
       VALUES ($1,$2,$3,'ll507-reasoner owner', ARRAY['*']::text[], 100000) RETURNING *`,
      [T, A, `prof-ll507-${randomUUID().slice(0, 8)}`],
    );
    const perm = await pool.query(
      `INSERT INTO permissoes(tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, status)
       VALUES ($1,$2,$3,$4,'dono',$5,'ativa') RETURNING *`,
      [T, A, pessoa.id, entidade_id, (prof.rows[0] as PermissionProfile).id],
    );
    resolvedPermission = {
      permissao: perm.rows[0] as Permissao,
      profile: prof.rows[0] as PermissionProfile,
      effective_limits: { valor_max: 100000 },
    };
  }, 60_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (createdMensagens.length > 0) {
      await pool.query(`DELETE FROM audit_log WHERE mensagem_id = ANY($1::uuid[])`, [
        createdMensagens,
      ]);
      await pool.query(`DELETE FROM cognitive_module_log WHERE turno_id = ANY($1::uuid[])`, [
        createdMensagens,
      ]);
      await pool.query(`DELETE FROM agent_turn_inputs WHERE mensagem_id = ANY($1::uuid[])`, [
        createdMensagens,
      ]);
      await pool.query(
        `DELETE FROM agent_turns WHERE representative_message_id = ANY($1::uuid[])`,
        [createdMensagens],
      );
    }
    await pool.query(`DELETE FROM audit_log WHERE pessoa_id = $1`, [pessoa.id]);
    await pool.query(`DELETE FROM cognitive_module_log WHERE conversa_id = $1`, [conversa.id]);
    await pool.query(`DELETE FROM mensagens WHERE conversa_id = $1`, [conversa.id]);
    await pool.query(`DELETE FROM permissoes WHERE pessoa_id = $1`, [pessoa.id]);
    await pool.query(`DELETE FROM permission_profiles WHERE nome = 'll507-reasoner owner'`);
    await pool.query(`DELETE FROM conversas WHERE id = $1`, [conversa.id]);
    await pool.query(`DELETE FROM idempotency_keys WHERE entity_id = $1`, [entidade_id]);
    await pool.query(`DELETE FROM entidades WHERE id = $1`, [entidade_id]);
    await pool.query(`DELETE FROM pessoas WHERE id = $1`, [pessoa.id]);
    await pool.end();
  });

  it('CONTROLE: com a lease VIVA, cada iteração deixa uma row `success` do reasoner', async () => {
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');
    const inbound = await mkInbound();
    resetRoteiro();

    let result: unknown = null;
    await inT(async () => {
      const { lease } = await claimWithLease(inbound.id);
      await runWithTurnExecution(lease.context(), async () => {
        result = await runLoop(inbound);
      });
      lease.stop();
    });

    expect(llm.calls, 'o laço deveria ter ido até o teto de iterações').toBe(5);
    // A PROPAGAÇÃO, medida na entrada: dentro de um turno reivindicado o
    // reasoner tem de receber o sinal da tentativa em TODAS as chamadas. Este
    // é o caso que reprova sozinho se alguém apagar `signal:` do call site.
    expect(
      llm.signals.filter((s) => s instanceof AbortSignal).length,
      'todas as chamadas ao LLM têm de receber o AbortSignal da tentativa',
    ).toBe(5);
    expect(llm.abortadas, 'com a lease viva nada é abortado').toEqual([]);

    const rows = await reasonerRows(inbound.id);
    expect(rows.map((r) => r.status), 'cinco iterações, cinco rows de sucesso').toEqual([
      'success',
      'success',
      'success',
      'success',
      'success',
    ]);
    expect(result, 'e o laço termina normalmente, devolvendo o resultado ao core').not.toBeNull();
    expect((result as { delivery: { exitReason: string } }).delivery.exitReason).toBe(
      'iteration_cap',
    );
  }, 60_000);

  it('BARREIRA (dependência cooperativa): a chamada em voo ABORTA e a row diz cancelled', async () => {
    const { runWithTurnExecution, TurnOwnershipLostError } = await import(
      '@/runtime/turns/execution-context.js'
    );
    const inbound = await mkInbound();
    resetRoteiro();

    let thrown: unknown = null;
    await inT(async () => {
      const { turn_id, lease } = await claimWithLease(inbound.id);
      // A perda acontece DURANTE o round-trip do reasoner: o guard do topo
      // daquela iteração já passou, e sem o sinal a requisição seguiria viva.
      llm.before = async (call: number) => {
        if (call === PERDA_NA_CHAMADA) await loseOwnershipForReal(turn_id, lease);
      };
      await runWithTurnExecution(lease.context(), async () => {
        thrown = await runLoop(inbound).then(
          () => null,
          (e: unknown) => e,
        );
      });
    });

    // 1. A CHAMADA PAROU. Sem `signal` no call site, `llm.abortadas` fica vazio:
    //    o dublê nunca vê abort e entrega normalmente, como o provedor real.
    expect(
      llm.abortadas,
      'a chamada em voo tem de receber o abort e parar — não apenas perder o race',
    ).toEqual([PERDA_NA_CHAMADA]);
    expect(llm.calls, 'e nenhuma iteração nova pode começar depois disso').toBe(
      PERDA_NA_CHAMADA,
    );

    // 2. A AUDITORIA NÃO MENTE. Duas rows legítimas (a lease estava viva) e uma
    //    terceira que diz `cancelled` — nem `success` (a mentira original) nem
    //    `error` + fallback (a mentira que passar o sinal sozinho criaria).
    const rows = await reasonerRows(inbound.id);
    expect(rows.map((r) => r.status)).toEqual(['success', 'success', 'cancelled']);
    const cancelada = rows[2]!;
    expect(
      cancelada.fallback_triggered,
      'cancelamento não é degradação de produto: fallback fica false',
    ).toBe(false);
    expect(cancelada.fallback_reason).toBeNull();
    expect(cancelada.metadata).toEqual({ cancel_cause: 'signal_aborted' });

    // 3. QUEM TEM A LEASE DECIDE O DESFECHO. Sem o erro tipado, `output: null`
    //    viraria `reasoner_failed`, e `core.ts` agendaria RETRY de um turno que
    //    já pertence a outro worker.
    expect(thrown, 'o laço deveria ter encerrado a tentativa').toBeInstanceOf(
      TurnOwnershipLostError,
    );
    expect((thrown as { boundary: string }).boundary).toBe('react_reasoner');
  }, 60_000);

  it('BARREIRA (dependência NÃO cooperativa): o LLM responde depois da perda e a row AINDA diz cancelled', async () => {
    const { runWithTurnExecution, TurnOwnershipLostError } = await import(
      '@/runtime/turns/execution-context.js'
    );
    const inbound = await mkInbound();
    resetRoteiro();
    // O caso literal do achado do dono: "depois que o LLM retorna,
    // `runCognitiveModule` ainda pode escrever uma row, possivelmente como
    // `success`, mesmo após a perda da lease". Aqui o dublê IGNORA o sinal —
    // como faria qualquer dependência que não oferece cancelamento — e entrega
    // uma resposta completa. Nenhum abort salva este caminho; o que salva é o
    // runner conferir o sinal DEPOIS do resultado e descartá-lo.
    llm.cooperativa = () => false;

    let thrown: unknown = null;
    await inT(async () => {
      const { turn_id, lease } = await claimWithLease(inbound.id);
      llm.before = async (call: number) => {
        if (call === PERDA_NA_CHAMADA) await loseOwnershipForReal(turn_id, lease);
      };
      await runWithTurnExecution(lease.context(), async () => {
        thrown = await runLoop(inbound).then(
          () => null,
          (e: unknown) => e,
        );
      });
    });

    expect(llm.abortadas, 'esta dependência ignora o sinal, por construção').toEqual([]);
    expect(llm.calls).toBe(PERDA_NA_CHAMADA);

    const rows = await reasonerRows(inbound.id);
    expect(
      rows.map((r) => r.status),
      'a resposta chegou, mas o turno já não era nosso: a row NÃO pode dizer success',
    ).toEqual(['success', 'success', 'cancelled']);
    expect(rows[2]!.metadata).toEqual({ cancel_cause: 'late_result_discarded' });
    expect(rows[2]!.fallback_triggered).toBe(false);

    // E o resultado tardio foi DESCARTADO: não virou mais uma volta de
    // raciocínio nem chegou ao dispatcher.
    expect(thrown).toBeInstanceOf(TurnOwnershipLostError);
    expect((thrown as { boundary: string }).boundary).toBe('react_reasoner');
  }, 60_000);
});
