/**
 * Issue #504 §Fencing — a recusa `turn_ownership_lost` tem de ENCERRAR o ReAct,
 * não virar mais um erro de tool.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * O dispatcher recusa DEVOLVENDO `{ error: 'turn_ownership_lost' }` — é o
 * contrato daquela fronteira, e está certo (um throw seria lido pelo caller
 * como quebra de plataforma). Só que o ReAct tratava a recusa como erro comum:
 * seguia acumulando `toolSummaries`, auditava a chamada, e no fim do laço
 * tentava `flushUnconfirmedToolSummaries()` (`src/agent/react-loop.ts:29-51`).
 *
 * Como a recusa é retorno e não `TurnOwnershipLostError`, o catch dedicado do
 * core (`src/agent/core.ts:1496`) nunca era acionado — e o `core` então
 * decidia o desfecho (concluir ou reenfileirar) de um turno que o banco já
 * tinha entregue a outro worker. O oposto de "perda de lease cancela o
 * restante da tentativa e impede gravações posteriores".
 *
 * ─── Uma correção ao achado: a row do flush NÃO nasce hoje ─────────────────
 *
 * O achado cita `flushUnconfirmedToolSummaries()` criando uma row nova em
 * `mensagens`. Contra o schema atual isso NÃO acontece — e não porque alguém
 * tenha consertado: `mensagens_tipo_check` só admite
 * ('texto','audio','imagem','documento','sistema'), e o flush insere
 * `tipo:'evento'`. O INSERT viola a constraint, o `catch` do helper engole o
 * erro e loga `agent.tool_summaries_flush_failed`. Ou seja, o flush é código
 * morto desde sempre, um bug pré-existente FORA do escopo desta rodada.
 *
 * A asserção sobre `mensagens` fica no teste assim mesmo, marcada como
 * VAZIA hoje: se alguém adicionar 'evento' ao CHECK, ela vira carga real sem
 * ninguém precisar lembrar. O que a barreira de fato observa são as gravações
 * que ATERRISSAM: o `audit_log` da chamada recusada e — a maior delas — o
 * RETORNO normal do laço, que faz `core.ts` decidir o desfecho (concluir ou
 * reenfileirar) de um turno que já não é dele.
 *
 * ─── Por que o caso precisa das CINCO iterações ─────────────────────────────
 *
 * O guard do topo da iteração (`assertTurnOwnership('react_iteration')`) já
 * lança na iteração SEGUINTE. Para observar o que acontece DEPOIS da recusa —
 * e não o que o guard vizinho já cobria — a recusa tem de cair na ÚLTIMA
 * iteração: o laço termina por `iteration_cap`, ninguém lança, e todo o rastro
 * pós-recusa fica visível.
 *
 * ─── O que é real e o que é dublê ───────────────────────────────────────────
 *
 * REAL: `runReActLoop` de produção, `dispatchTool` de produção, o REGISTRY, a
 * governança, o Postgres, e a perda de posse pelo caminho de sempre (claim SQL
 * → lease vencida → takeover → heartbeat do dono descobre → `AbortSignal`).
 *
 * DUBLÊ: só `callLLM`. É uma chamada paga a um provedor externo; além disso é
 * o ÚNICO ponto onde se pode escolher o instante da perda sem inventar um
 * harness — a perda acontece durante o round-trip do LLM da última iteração,
 * que é exatamente quando ela acontece na vida real (o reasoner é o trecho
 * mais longo do turno).
 *
 * ─── O CONTROLE ────────────────────────────────────────────────────────────
 *
 * "Nenhum audit de recusa" também passaria se aquele caminho de erro nunca
 * fosse alcançado (teto errado, tool inexistente tratada antes, laço saindo
 * cedo). O controle roda as MESMAS cinco iterações, com a lease VIVA, e faz a
 * última tool falhar por um motivo ORDINÁRIO (`unknown_tool`): exige a row de
 * audit PRESENTE e o laço terminando normalmente. É ele que prova que só
 * `turn_ownership_lost` encerra a tentativa — e não qualquer erro de tool.
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
 * TTL da lease do DONO legitimo. 30s, e o numero importa.
 *
 * Era 1_500ms, e isso quebrava os casos de CONTROLE -- os que provam que, com
 * a lease VIVA, o efeito acontece normalmente. Medido no CI: o controle do
 * react-loop leva ~3.9s de corpo. Com TTL de 1.5s e heartbeat de 400ms, a
 * lease precisa ser renovada ~9 vezes DURANTE o caso, e basta UMA renovacao
 * chegar atrasada para ela morrer.
 *
 * O mecanismo e o CAS, nao falha de heartbeat -- e a primeira versao deste
 * comentario errava nisso, atribuindo a perda a `MAX_HEARTBEAT_FAILURES`.
 * Esse caminho exige o BANCO NAO RESPONDER, o que nao estava acontecendo. O
 * que acontece e: o `UPDATE` de renovacao tem `AND lease_expires_at > now()`
 * no `WHERE` (`turn-repos.ts`), entao um atraso de agendamento no Node ou de
 * round-trip no banco maior que o TTL restante faz a lease vencer ANTES de a
 * renovacao chegar; o CAS devolve zero linhas e a lease se marca perdida com
 * `token_mismatch` -- sem sucessor nenhum e com o banco saudavel. Bate com o
 * `lostReason` observado nos logs do CI.
 *
 * Sob contencao ela morre, o guard recusa o efeito, e o CONTROLE reprova com
 * `turn_ownership_lost` -- exatamente o que ele existe para provar que NAO
 * acontece. O `retry: 1` absorvia, e o vermelho so apareceu porque o bloco
 * RECUPERADOS PELA SEGUNDA TENTATIVA do reporter (#545/#566) o denunciou.
 *
 * Que a renovacao de fato escreve no banco e coberto separadamente, em
 * `tests/integration/turn-lease-heartbeat-renew-real-db.spec.ts` -- com TTL
 * curto de proposito, porque com 30s aqui os controles passariam ate se o
 * timer parasse de disparar.
 *
 * Subir NAO enfraquece as BARREIRAS, e vale registrar por que: elas nao perdem
 * a posse por expiracao. `loseOwnershipForReal()` forca o vencimento por SQL
 * (`lease_expires_at = now() - interval '1 second'`) e entao um SUCESSOR
 * reivindica -- e o proprio helper afirma `lostReason === 'token_mismatch'`,
 * isto e, takeover. Verificado por sonda: com o TTL longo tambem nas
 * barreiras, elas continuam passando. O TTL curto nao era load-bearing para
 * nada; era so um cronometro competindo com o corpo do teste.
 */
const TTL_MS = 30_000;
const HEARTBEAT_MS = 400;

/**
 * Roteiro do reasoner dublê. `vi.hoisted` porque a fábrica de `vi.mock` é içada
 * acima dos imports.
 */
const llm = vi.hoisted(() => ({
  calls: 0,
  /** Roda ANTES de cada resposta. É o gancho que escolhe o instante da perda. */
  before: async (_call: number): Promise<void> => {},
  /** Qual tool o reasoner pede na chamada N. */
  toolFor: (_call: number): string => 'remember_safe_fact',
}));

vi.mock('@/lib/claude.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/claude.js')>();
  return {
    ...actual,
    callLLM: async () => {
      llm.calls += 1;
      await llm.before(llm.calls);
      return {
        content: null,
        // SEMPRE uma tool use: assim o laço nunca sai pelo ramo de texto final
        // e vai até o teto de iterações, que é onde o rastro pós-recusa fica
        // visível.
        tool_uses: [
          { id: `tu-${llm.calls}`, tool: llm.toolFor(llm.calls), args: currentArgs() },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'dublê',
      } satisfies LLMResponse;
    },
  };
});

/** Args da tool na rodada corrente — setado por cada caso antes de rodar. */
let toolArgs: { chave: string; valor: string } = { chave: 'x', valor: 'y' };
function currentArgs(): { chave: string; valor: string } {
  return toolArgs;
}

let pool: pg.Pool;
let pessoa: Pessoa;
let conversa: Conversa;
let entidade_id: string;
let resolvedPermission: ResolvedPermission;

const createdMensagens: string[] = [];
const createdFacts: string[] = [];

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

/** Rows que o ReAct grava DEPOIS da recusa — o que a issue proíbe. */
async function countFlushRows(mensagem_id: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM mensagens
      WHERE tenant_id=$1 AND agent_id=$2 AND direcao='out' AND tipo='evento'
        AND metadata->>'in_reply_to' = $3`,
    [T, A, mensagem_id],
  );
  return Number(r.rows[0]!.n);
}

/** O audit que o laço escreve por tool-use — inclusive pela chamada recusada. */
async function countRefusalAudits(mensagem_id: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log
      WHERE tenant_id=$1 AND agent_id=$2 AND mensagem_id=$3
        AND acao='unauthorized_access_attempt'`,
    [T, A, mensagem_id],
  );
  return Number(r.rows[0]!.n);
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

d('#504 — a recusa turn_ownership_lost encerra o ReAct sem gravar mais nada', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });

    const p = await pool.query(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1,$2,'ll504-react', $3, 'dono', 'ativa') RETURNING *`,
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
       VALUES ($1,$2,'PF-ll504-react','pf','ativa') RETURNING id`,
      [T, A],
    );
    entidade_id = ent.rows[0]!.id;

    const prof = await pool.query(
      `INSERT INTO permission_profiles(tenant_id, agent_id, id, nome, acoes, limite_default)
       VALUES ($1,$2,$3,'ll504-react owner', ARRAY['*']::text[], 100000) RETURNING *`,
      [T, A, `prof-llr504-${randomUUID().slice(0, 8)}`],
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
    if (createdFacts.length > 0) {
      await pool.query(`DELETE FROM agent_facts WHERE chave = ANY($1::text[])`, [createdFacts]);
    }
    if (createdMensagens.length > 0) {
      await pool.query(`DELETE FROM audit_log WHERE mensagem_id = ANY($1::uuid[])`, [
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
    await pool.query(`DELETE FROM permission_profiles WHERE nome = 'll504-react owner'`);
    await pool.query(`DELETE FROM conversas WHERE id = $1`, [conversa.id]);
    await pool.query(`DELETE FROM idempotency_keys WHERE entity_id = $1`, [entidade_id]);
    await pool.query(`DELETE FROM entidades WHERE id = $1`, [entidade_id]);
    await pool.query(`DELETE FROM pessoas WHERE id = $1`, [pessoa.id]);
    await pool.end();
  });

  it('CONTROLE: com a lease VIVA, um erro ORDINÁRIO de tool não encerra o laço', async () => {
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');
    const inbound = await mkInbound();
    const chave = `llr504-controle-${randomUUID().slice(0, 8)}`;
    createdFacts.push(chave);
    toolArgs = { chave, valor: 'dono vivo' };
    llm.calls = 0;
    llm.before = async () => {};
    // Última iteração: erro de tool que NÃO é perda de posse. É o mesmo
    // formato de recusa (`{ error }`), pelo mesmo caminho, com a lease viva.
    llm.toolFor = (call) => (call === 5 ? 'tool_que_nao_existe' : 'remember_safe_fact');

    let result: unknown = null;
    await inT(async () => {
      const { lease } = await claimWithLease(inbound.id);
      await runWithTurnExecution(lease.context(), async () => {
        result = await runLoop(inbound);
      });
      lease.stop();
    });

    // Se qualquer um destes quebrar, o caminho pós-recusa não foi alcançado e
    // o zero do caso da barreira não significaria nada.
    expect(llm.calls, 'o laço deveria ter ido até o teto de iterações').toBe(5);
    expect(
      await countRefusalAudits(inbound.id),
      'um erro ordinário de tool DEIXA o audit da chamada',
    ).toBe(1);
    expect(result, 'e o laço termina normalmente, devolvendo o resultado ao core').not.toBeNull();
    expect((result as { delivery: { exitReason: string } }).delivery.exitReason).toBe(
      'iteration_cap',
    );
  }, 60_000);

  it('BARREIRA: perdida a posse na última iteração, nenhuma gravação posterior', async () => {
    const { runWithTurnExecution, TurnOwnershipLostError } = await import(
      '@/runtime/turns/execution-context.js'
    );
    const inbound = await mkInbound();
    const chave = `llr504-barreira-${randomUUID().slice(0, 8)}`;
    createdFacts.push(chave);
    toolArgs = { chave, valor: 'zumbi' };
    llm.calls = 0;
    llm.toolFor = () => 'remember_safe_fact';

    let thrown: unknown = null;
    await inT(async () => {
      const { turn_id, lease } = await claimWithLease(inbound.id);
      // A perda acontece DURANTE o round-trip do reasoner da ÚLTIMA iteração:
      // o guard do topo daquela iteração já passou, e o laço terminaria
      // normalmente por `iteration_cap` — que é onde todo o rastro pós-recusa
      // fica visível.
      llm.before = async (call: number) => {
        if (call === 5) await loseOwnershipForReal(turn_id, lease);
      };
      await runWithTurnExecution(lease.context(), async () => {
        thrown = await runLoop(inbound).then(
          () => null,
          (e: unknown) => e,
        );
      });
    });

    // EFEITO primeiro. O audit da chamada recusada é a gravação que ATERRISSA
    // depois da recusa — o controle acima provou que ela existe quando o erro
    // é ordinário.
    expect(
      await countRefusalAudits(inbound.id),
      'o laço tem de parar ANTES do audit da chamada recusada',
    ).toBe(0);
    // VAZIA hoje (ver cabeçalho): `mensagens_tipo_check` rejeita
    // `tipo='evento'`, então o flush nunca grava. Fica aqui para virar carga
    // real no dia em que o CHECK admitir 'evento'.
    expect(
      await countFlushRows(inbound.id),
      'o flush não pode criar row em mensagens depois da perda',
    ).toBe(0);

    // A MAIOR gravação evitada é indireta: enquanto o laço retornava normal,
    // `core.ts` recebia um `ReActLoopResult` e decidia o desfecho (concluir ou
    // reenfileirar) de um turno que já não é dele. Com o erro tipado, o catch
    // dedicado de `core.ts:1496` sai sem concluir, sem retry e sem carimbar
    // `processada_em`.
    expect(thrown, 'o laço deveria ter encerrado a tentativa').toBeInstanceOf(
      TurnOwnershipLostError,
    );
    // Issue #507 — A BARREIRA SUBIU UM DEGRAU, e é por isso que este valor
    // mudou de `react_tool_refused` para `react_reasoner`.
    //
    // Quando este caso foi escrito, o `callLLM` do reasoner era chamado SEM
    // `signal`: a perda encenada aqui — durante o round-trip da última
    // iteração — não era percebida por ninguém até a tool seguinte bater no
    // guard do dispatcher. A #507 levou o `AbortSignal` da tentativa até o
    // `callLLM`, então a MESMA perda, no MESMO instante, agora encerra o laço no
    // próprio reasoner: a chamada paga é abortada em voo, e o laço nem chega a
    // considerar a tool.
    //
    // O que este caso PROVA continua idêntico — nenhuma gravação aterrissa
    // depois da perda, e o core não decide o desfecho de um turno que não é
    // dele. O que mudou é que agora ele para mais cedo, que é o ganho da #507.
    //
    // A TRADUÇÃO da recusa do dispatcher (`{ error: 'turn_ownership_lost' }` →
    // `TurnOwnershipLostError('react_tool_refused')`, react-loop.ts:405) segue
    // no código e segue certa: ela cobre a janela em que a posse se perde
    // DENTRO de `dispatchTool` (entre o guard de entrada e o handler), que é o
    // cenário de `turn-lease-lost-tool-handler-real-db.spec.ts`. O que este
    // arquivo deixou de alcançar foi o instante "durante o reasoner", porque
    // ele agora é interceptado antes — e interceptar antes era o objetivo.
    expect((thrown as { boundary: string }).boundary).toBe('react_reasoner');
  }, 60_000);
});
