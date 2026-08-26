/**
 * Issue #504 — perder a lease NO MEIO da execução cancela os LIMITES DE EFEITO.
 *
 * ─── O que esta suíte prova, e o que as outras não provavam ─────────────────
 *
 * `turn-claim-core-barrier-real-db.spec.ts` prova que o core PARA na ENTRADA
 * quando o turno já tem dono. `turn-claim-lifecycle-real-db.spec.ts` prova que
 * a conclusão do zumbi é recusada NO FIM.
 *
 * Entre os dois havia um vão, e era o risco residual que a review recusou: um
 * worker que perde a posse DEPOIS de ter entrado — heartbeat morto, ou takeover
 * depois do vencimento da lease — seguia chamando LLM, executando tools e
 * enviando resposta até chegar à transição final. O fence do banco protege
 * `agent_turns`; ele não desfaz um boleto emitido nem despacha de volta uma
 * mensagem entregue. "Recusado no fim" é tarde demais para o EFEITO.
 *
 * ─── Por que isto não é espelho ─────────────────────────────────────────────
 *
 * Nada aqui mocka `dispatchTool`, `sendOutbound` nem a `TurnLease`. Um teste
 * que forçasse `lease.markLost()` à mão provaria só que o guard lê um booleano.
 * Aqui a perda é PRODUZIDA pelo mecanismo real:
 *
 *   1. o dono legítimo reivindica com `agentTurnsRepo.claimNextEligibleTurn` (SQL real);
 *   2. a lease vence no banco (é a única condição de takeover — ver
 *      `LEASE_TAKEOVER_STATUSES`);
 *   3. OUTRO worker reivindica de verdade, pela mesma porta;
 *   4. o heartbeat REAL do primeiro bate, `renewTurnLease` devolve
 *      `token_mismatch`, e é ISSO que dispara o `AbortSignal`.
 *
 * Só então o pipeline chama o dispatcher e o outbound REAIS, dentro do
 * `runWithTurnExecution` que `src/agent/core.ts` abre em produção.
 *
 * ─── Qual efeito é observado ────────────────────────────────────────────────
 *
 * Efeito no banco, nos dois limites, e nunca o valor de retorno sozinho:
 *
 *   tool     → `agent_facts`: a tool `remember_safe_fact` é `side_effect:
 *              'write'` e persiste uma linha. Existe linha ou não existe.
 *   outbound → `outbound_messages`: o ledger de #227 é reivindicado ANTES do
 *              envio, então uma tentativa que passou do guard deixa linha
 *              mesmo quando o envio físico falha depois (sem canal no teste).
 *              Nenhuma linha = o guard cancelou antes de qualquer trabalho.
 *
 * ─── O caso de CONTROLE ─────────────────────────────────────────────────────
 *
 * Sem ele "nada aconteceu" também passaria se a tool não estivesse no grant, se
 * a permissão negasse, se o tenant fosse o errado ou se a mensagem não
 * existisse. O controle roda o MESMO harness com a lease VIVA e exige os dois
 * efeitos presentes. É ele que dá significado à ausência.
 *
 * Skipped sem TEST_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { config } from '@/config/env.js';
import type { Pessoa, Conversa, PermissionProfile, Permissao } from '@/db/schema.js';
import type { ResolvedPermission } from '@/governance/permissions.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// `primary/primary`: o mesmo par baseline das outras suítes de #504. Um tenant
// sintético exigiria semear grants/perfis próprios e o caso de controle
// falharia por configuração, não por posse.
const T = 'primary';
const A = 'primary';

// TTL curto o bastante para o heartbeat bater DENTRO do teste, respeitando a
// razão de 1/3 que `assertLeaseTiming` impõe (senão o construtor recusa).
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

let pool: pg.Pool;
let pessoa: Pessoa;
let conversa: Conversa;
let entidade_id: string;
let resolvedPermission: ResolvedPermission;

const createdMensagens: string[] = [];
const createdFacts: string[] = [];

const inT = <R>(fn: () => Promise<R>): Promise<R> =>
  runWithTenantContext({ tenant_id: T, agent_id: A }, fn);

/** O `ToolContext` que `react-loop.ts` monta a cada tool use. */
function toolCtx(mensagem_id: string) {
  return {
    pessoa,
    scope: {
      entidades: [entidade_id],
      byEntity: new Map<string, ResolvedPermission>([[entidade_id, resolvedPermission]]),
    },
    conversa,
    mensagem_id,
    request_id: randomUUID(),
  };
}

async function mkInbound(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO mensagens (tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
     VALUES ($1, $2, $3, 'in', 'texto', 'oi', '{}'::jsonb)
     RETURNING id`,
    [T, A, conversa.id],
  );
  const id = r.rows[0]!.id;
  createdMensagens.push(id);
  return id;
}

/**
 * Turno + posse REAIS. Devolve a `TurnLease` viva do dono legítimo, com o
 * heartbeat já correndo.
 *
 * DEVE ser chamada de DENTRO de `inT()`. Não é preciosismo: o timer do
 * heartbeat herda o AsyncLocalStorage do escopo onde `setInterval` é criado, e
 * `renewTurnLease` é uma query escopada por tenant. Construída fora do escopo,
 * a lease morre de `heartbeat_failed` (contexto ausente) em vez de descobrir o
 * takeover — o teste ficaria verde provando outra coisa. Em produção a
 * construção acontece em `beginClaimedExecution`, já dentro do escopo aberto
 * por `runAgentForMensagem`.
 */
async function claimWithLease(mensagem_id: string) {
  const { agentTurnsRepo } = await import('../../src/db/repositories.js');
  const { TurnLease } = await import('@/runtime/turns/lease.js');
  const turn = await agentTurnsRepo.ensureTurnForMessage({
    id: mensagem_id,
    tenant_id: T,
    agent_id: A,
    conversa_id: conversa.id,
    channel_id: null,
  });
  const claimed = await agentTurnsRepo.claimNextEligibleTurn({
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

/**
 * Faz a posse ser perdida PELO CAMINHO REAL: a lease vence, outro worker
 * assume, e o heartbeat do primeiro descobre sozinho.
 *
 * Não chamamos `markLost()`: forçá-lo transformaria o teste num espelho do
 * guard. O que se quer provar é que a cadeia inteira — SQL de takeover →
 * `renewTurnLease` → `#lose` → `AbortSignal` → guards — está ligada.
 */
async function loseOwnershipForReal(
  turn_id: string,
  lease: { alive: boolean; lostReason: string | null },
): Promise<void> {
  const { agentTurnsRepo } = await import('../../src/db/repositories.js');
  await pool.query(
    `UPDATE agent_turns SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [turn_id],
  );
  const successor = await agentTurnsRepo.claimNextEligibleTurn({
    turn_id,
    worker_id: `sucessor-${randomUUID().slice(0, 8)}`,
    lease_ms: 60_000,
  });
  expect(successor.ok, 'o sucessor deveria assumir a lease vencida').toBe(true);

  // Espera o heartbeat REAL descobrir. Sem polling arbitrário: o critério é o
  // estado do próprio objeto.
  const deadline = Date.now() + 10_000;
  while (lease.alive && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(lease.alive, 'o heartbeat real deveria ter detectado a perda da posse').toBe(false);
  // A RAZÃO importa: `token_mismatch` é o heartbeat encontrando o turno com o
  // token do sucessor — o takeover. `heartbeat_failed` seria o banco fora do ar
  // (ou, num teste mal montado, o escopo de tenant ausente), e passaria dando a
  // impressão de que o takeover foi observado quando não foi.
  expect(lease.lostReason, 'a perda tem de vir do TAKEOVER, não de erro de banco').toBe(
    'token_mismatch',
  );
}

async function countFacts(chave: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM agent_facts WHERE tenant_id=$1 AND agent_id=$2 AND chave=$3`,
    [T, A, chave],
  );
  return Number(r.rows[0]!.n);
}

async function countOutboundLedger(mensagem_id: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM outbound_messages
      WHERE tenant_id=$1 AND agent_id=$2 AND in_reply_to=$3`,
    [T, A, mensagem_id],
  );
  return Number(r.rows[0]!.n);
}

d('#504 — lease perdida DURANTE a execução: nenhuma tool, nenhum outbound', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });

    // O ledger de #227 é o efeito observável do limite de outbound. Com a flag
    // OFF ele é no-op e o caso de controle não teria o que provar.
    vi.spyOn(config, 'FEATURE_OUTBOUND_DEDUP', 'get').mockReturnValue(true);

    const p = await pool.query(
      `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
       VALUES ($1,$2,'lease-lost-504', $3, 'dono', 'ativa') RETURNING *`,
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
       VALUES ($1,$2,'PF-lease-lost-504','pf','ativa') RETURNING id`,
      [T, A],
    );
    entidade_id = ent.rows[0]!.id;

    // Perfil e permissão REAIS, com a mesma forma que `resolveScope` devolve ao
    // core. O escopo é entrada do dispatcher (o core o resolve antes), então
    // montá-lo aqui é o contrato, não um atalho.
    const prof = await pool.query(
      `INSERT INTO permission_profiles(tenant_id, agent_id, id, nome, acoes, limite_default)
       VALUES ($1,$2,$3,'lease-lost-504 owner', ARRAY['*']::text[], 100000) RETURNING *`,
      [T, A, `prof-ll504-${randomUUID().slice(0, 8)}`],
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
      await pool.query(`DELETE FROM outbound_messages WHERE in_reply_to = ANY($1::uuid[])`, [
        createdMensagens,
      ]);
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
      await pool.query(`DELETE FROM mensagens WHERE conversa_id = $1`, [conversa.id]);
    }
    await pool.query(`DELETE FROM audit_log WHERE pessoa_id = $1`, [pessoa.id]);
    await pool.query(`DELETE FROM permissoes WHERE pessoa_id = $1`, [pessoa.id]);
    await pool.query(`DELETE FROM permission_profiles WHERE nome = 'lease-lost-504 owner'`);
    await pool.query(`DELETE FROM conversas WHERE id = $1`, [conversa.id]);
    // O dispatcher reserva a chave de idempotência ANTES do handler, e a linha
    // referencia a entidade por FK — sai primeiro, senão o DELETE abaixo viola
    // a constraint e a suíte deixa lixo compartilhado com 45 worktrees.
    await pool.query(`DELETE FROM idempotency_keys WHERE entity_id = $1`, [entidade_id]);
    await pool.query(`DELETE FROM entidades WHERE id = $1`, [entidade_id]);
    await pool.query(`DELETE FROM pessoas WHERE id = $1`, [pessoa.id]);
    await pool.end();
  });

  it('CONTROLE: com a lease VIVA, a tool grava e o outbound reivindica o ledger', async () => {
    const { dispatchTool } = await import('@/tools/_dispatcher.js');
    const { sendOutbound } = await import('@/agent/output-dispatch.js');
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');

    const mensagem_id = await mkInbound();
    const chave = `ll504-controle-${randomUUID().slice(0, 8)}`;
    createdFacts.push(chave);

    await inT(async () => {
      const { lease } = await claimWithLease(mensagem_id);
      await runWithTurnExecution(lease.context(), async () => {
        const out = await dispatchTool({
          tool: 'remember_safe_fact',
          args: { chave, valor: 'dono vivo' },
          ctx: toolCtx(mensagem_id),
        });
        // Se este expect quebrar, o harness está errado (grant/permissão/escopo)
        // e o caso da barreira abaixo passaria por motivo nenhum.
        expect(out, 'a tool deveria ter EXECUTADO com a posse viva').not.toHaveProperty('error');

        // O envio físico não tem canal neste ambiente e falha pre-send DEPOIS
        // do ledger — que é justamente o efeito que queremos ver registrado.
        await sendOutbound(pessoa.id, conversa.id, 'resposta', mensagem_id, {
          channel_id: null,
        }).catch(() => null);
      });
      lease.stop();
    });

    expect(await countFacts(chave), 'a tool deveria ter deixado a linha em agent_facts').toBe(1);
    expect(
      await countOutboundLedger(mensagem_id),
      'o outbound deveria ter reivindicado o ledger de #227',
    ).toBe(1);
  }, 60_000);

  it('BARREIRA: perdida a lease no meio, nenhuma tool executa e nenhum outbound sai', async () => {
    const { dispatchTool } = await import('@/tools/_dispatcher.js');
    const { sendOutbound } = await import('@/agent/output-dispatch.js');
    const { runWithTurnExecution } = await import('@/runtime/turns/execution-context.js');

    const mensagem_id = await mkInbound();
    const chave = `ll504-barreira-${randomUUID().slice(0, 8)}`;
    createdFacts.push(chave);

    let toolOut: unknown;
    let sendErr: (Error & { delivered?: boolean }) | null = null;
    await inT(async () => {
      const { turn_id, lease } = await claimWithLease(mensagem_id);
      await runWithTurnExecution(lease.context(), async () => {
        // A execução JÁ COMEÇOU dentro do contexto — e só então a posse é
        // perdida, pelo caminho real (takeover + heartbeat).
        await loseOwnershipForReal(turn_id, lease);

        toolOut = await dispatchTool({
          tool: 'remember_safe_fact',
          args: { chave, valor: 'zumbi' },
          ctx: toolCtx(mensagem_id),
        });
        sendErr = await sendOutbound(pessoa.id, conversa.id, 'resposta', mensagem_id, {
          channel_id: null,
        }).then(
          () => null,
          (e: unknown) => e as Error & { delivered?: boolean },
        );
      });
    });

    // O SINAL vem PRIMEIRO e é o EFEITO NO BANCO, não o valor de retorno. A
    // ordem importa: um `expect` sobre o retorno colocado antes abortaria o
    // teste e a saída vermelha mostraria um código de erro em vez do efeito
    // que a issue existe para impedir.
    expect(await countFacts(chave), 'nenhuma tool pode ter rodado sem posse').toBe(0);
    expect(
      await countOutboundLedger(mensagem_id),
      'nenhum outbound pode ter sido sequer reivindicado sem posse',
    ).toBe(0);

    // O vocabulário da recusa, em cada fronteira.
    expect(toolOut).toEqual({
      error: 'turn_ownership_lost',
      details: { tool: 'remember_safe_fact' },
    });
    expect(sendErr, 'o outbound deveria ter sido recusado').not.toBeNull();
    // PRE-SEND: nada chegou ao usuário, e o caller que inspeciona `delivered`
    // sabe que não deve tratar como entregue.
    expect(sendErr!.delivered).toBe(false);
    expect(sendErr!.message).toContain('turn_ownership_lost');
  }, 60_000);
});
