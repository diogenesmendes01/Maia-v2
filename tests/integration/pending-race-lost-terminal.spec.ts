/**
 * A perna PERDEDORA de uma race de pendência não roda o turno normal do agente.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que este arquivo guarda, e por que ele existe separado da #562
 * ─────────────────────────────────────────────────────────────────────────
 * `tests/integration/pending-gate-concurrency.spec.ts` (issue #545 / PR #562)
 * prova o lado da IDEMPOTÊNCIA: sob duas resoluções paralelas, a ação é
 * despachada exatamente uma vez e a perna perdedora vira uma linha
 * `pending_race_lost` no `audit_log`. Esse invariante está intacto.
 *
 * O que ninguém guardava era o DESTINO da perna perdedora. O gate colapsava
 * esse desfecho em `{ kind: 'no_pending' }`, e `src/agent/core.ts` lê
 * `no_pending` como "não havia pendência nenhuma" e roda o turno normal do
 * agente (ReAct). A mensagem já tinha sido CLASSIFICADA como resposta à
 * pergunta pendente — um "sim" que significava "opção sim da pergunta X" era
 * entregue ao LLM como comando novo e livre. Mudança de significado, num
 * caminho que por definição só acontece sob concorrência.
 *
 * A asserção deste arquivo é sobre o TURNO, lida no banco: a perna perdedora
 * termina em `agent_turns.status = 'ignored'` com
 * `outcome = 'pending_race_lost'`, sem resposta produzida.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que exercitar `runAgentForMensagem` de verdade, e não montar um core
 * ─────────────────────────────────────────────────────────────────────────
 * A armadilha óbvia aqui é o ESPELHO: montar um core de mentira, mockar a
 * react-loop e asserir "não foi chamada". Um teste desses continua verde
 * mesmo se produção mudar — ele afere o próprio mock. Por isso aqui roda o
 * entry point REAL do turno (`src/agent/core.ts` → `runAgentForMensagem`),
 * sobre um fixture REAL, e a evidência sai do BANCO: `agent_turns`,
 * `audit_log` e `mensagens`. É a mesma escolha que sobreviveu ao escrutínio da
 * #545 (contar linha de auditoria no banco em vez de chamada de função).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que a race é DETERMINÍSTICA aqui (e não duas chamadas paralelas)
 * ─────────────────────────────────────────────────────────────────────────
 * `checkPendingFirst` lê um snapshot SEM lock, classifica FORA da transação e
 * só então re-lê sob `SELECT … FOR UPDATE`. A perna perdedora é, exatamente, a
 * que encontra a pendência já resolvida nessa releitura.
 *
 * O classificador é injetável (`setClassifierForTesting`), e é chamado
 * justamente na janela entre as duas leituras. Então a perna vencedora é
 * simulada DE DENTRO do classificador, com um UPDATE direto: quando o gate
 * volta para pegar o lock, a pendência já não está `aberta`. Isso reproduz a
 * race sem depender de escalonamento — nenhum `Promise.all`, nenhuma janela de
 * milissegundos, nenhuma chance de flake. A #562 já guarda o lado concorrente
 * de verdade; aqui o que se afere é o DESFECHO, e ele não precisa de sorte.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { TestContext } from 'vitest';
import pg from 'pg';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// Precisa estar setado ANTES do primeiro import de `@/config/env.js`: o schema
// do contrato tem default `false` e o gate faz short-circuit com a flag
// desligada — as duas pernas devolveriam `no_pending` e o teste ficaria verde
// pela razão errada. Guardado pelo caso [infra] da flag.
process.env.FEATURE_PENDING_GATE = 'true';

const NOME = 'race-lost-terminal';

/** Base ALEATÓRIA por processo — `pessoas_tenant_agent_telefone_key` é único. */
const TELEFONE = `+55117${String(10_000_000 + Math.floor(Math.random() * 80_000_000)).slice(-8)}`;

/** Tenant/agente do fixture — `'primary'` é a casa do runtime (#323). */
const PRIMARY_CTX = { tenant_id: 'primary', agent_id: 'primary' };

/** Orçamento do `beforeAll`: transformação ESM do grafo do core + seed + turno. */
const SETUP_BUDGET_MS = 180_000;

type Evidence = {
  feature_pending_gate: boolean;
  feature_turn_state_machine: boolean;
  /** Fase + mensagem da falha que abortou o `beforeAll` (null = completou). */
  setup_error: { fase: string; message: string } | null;
  /** O classificador injetado chegou a rodar? Se não, não houve race nenhuma. */
  classificador_rodou: boolean;
  /** A perna vencedora (UPDATE dentro do classificador) fechou a pendência? */
  vencedora_fechou_pendencia: boolean;
  /** `runAgentForMensagem` lançou? (vazio = não) */
  core_threw: string[];
  /** Estado terminal do turno da perna perdedora, lido no banco. */
  turn: { status: string | null; outcome: string | null };
  /** `audit_log` desta conversa, agrupado por ação, lido NO BANCO. */
  audit_by_acao: Record<string, number>;
  /** Mensagens de saída gravadas nesta conversa (resposta do ReAct). */
  outbound_count: number;
  /** O inbound foi carimbado como processado? */
  inbound_processado: boolean;
  /** Estado final das pending questions desta conversa. */
  pending_status: string[];
};

let pool: pg.Pool;
let ev: Evidence;
const ids = { pessoa: '', conversa: '', mensagem: '', pending: '' };

function fmt(e: Evidence): string {
  return JSON.stringify(
    {
      setup_error: e.setup_error,
      classificador_rodou: e.classificador_rodou,
      vencedora_fechou_pendencia: e.vencedora_fechou_pendencia,
      core_threw: e.core_threw,
      turn: e.turn,
      audit_by_acao: e.audit_by_acao,
      outbound_count: e.outbound_count,
      inbound_processado: e.inbound_processado,
      pending_status: e.pending_status,
      flags: {
        FEATURE_PENDING_GATE: e.feature_pending_gate,
        FEATURE_TURN_STATE_MACHINE: e.feature_turn_state_machine,
      },
      fixture: { ...ids, telefone: TELEFONE, ...PRIMARY_CTX },
    },
    null,
    2,
  );
}

// ── Nomes dos casos [infra] ────────────────────────────────────────────────
const T_SETUP = '[infra] o setup completou (import do core, seed, turno, leitura de evidência)';
const T_FLAGS = '[infra] o gate e a máquina de estados do turno estão ligados';
const T_THREW = '[infra] runAgentForMensagem não lançou';
const T_RACE = '[infra] a race foi de fato encenada (classificador rodou e a pendência fechou)';

type Precondicao = {
  nome: string;
  testeInfra: string;
  satisfeita: (e: Evidence) => boolean;
  porque: string;
};

const P_SETUP: Precondicao = {
  nome: 'setup completou',
  testeInfra: T_SETUP,
  satisfeita: (e) => e.setup_error === null,
  porque:
    'o beforeAll abortou antes de colher a evidência (import do grafo do core, conexão, ' +
    'seed ou leitura no banco). Não há evidência sobre o destino do turno.',
};

const P_FLAGS: Precondicao = {
  nome: 'flags ligadas',
  testeInfra: T_FLAGS,
  satisfeita: (e) => e.feature_pending_gate && e.feature_turn_state_machine,
  porque:
    'com FEATURE_PENDING_GATE desligada o gate faz short-circuit e devolve no_pending sem ' +
    'olhar pendência nenhuma; com FEATURE_TURN_STATE_MACHINE desligada `concludeTurn` é ' +
    'no-op e não existe linha de `agent_turns` para ler. Nos dois casos é configuração, ' +
    'não semântica.',
};

const P_SEM_THROW: Precondicao = {
  nome: 'o core não lançou',
  testeInfra: T_THREW,
  satisfeita: (e) => e.core_threw.length === 0,
  porque:
    '`runAgentForMensagem` propagou exceção (Redis fora, resolver de canal, pool). O turno ' +
    'não chegou ao desfecho que este arquivo afere.',
};

const P_RACE_ENCENADA: Precondicao = {
  nome: 'a race foi encenada',
  testeInfra: T_RACE,
  satisfeita: (e) => e.classificador_rodou && e.vencedora_fechou_pendencia,
  porque:
    'o classificador injetado não rodou, ou o UPDATE que simula a perna vencedora não ' +
    'fechou a pendência. Sem isso não houve race: o gate teria resolvido normalmente e ' +
    'qualquer veredito sobre "perna perdedora" seria sobre um cenário que não aconteceu.',
};

const PRE: readonly Precondicao[] = [P_SETUP, P_FLAGS, P_SEM_THROW, P_RACE_ENCENADA];

/** Marca o caso como INCONCLUSIVO — nem verde nem vermelho — com a causa nomeada. */
function exigirInfra(ctx: TestContext, exigidas: readonly Precondicao[]): void {
  const faltando = exigidas.filter((p) => !p.satisfeita(ev));
  if (faltando.length === 0) return;
  const nota =
    'INCONCLUSIVO, nenhum veredito semântico emitido — pré-condição de infraestrutura ' +
    `não satisfeita: ${faltando.map((p) => p.nome).join(' + ')}. ` +
    `Causa no(s) caso(s) VERMELHO(S) ${faltando.map((p) => `"${p.testeInfra}"`).join(', ')}. ` +
    'Detalhe e evidência em stderr.';
  console.error(
    `\n${ctx.task.name}\nINCONCLUSIVO — nenhum veredito semântico foi emitido.\n` +
      faltando.map((p) => `  • ${p.nome} — ${p.porque}`).join('\n') +
      `\nEvidência: ${fmt(ev)}\n`,
  );
  ctx.skip(nota);
}

d('perna perdedora de race de pendência — desfecho terminal', () => {
  beforeAll(async () => {
    ev = {
      feature_pending_gate: false,
      feature_turn_state_machine: false,
      setup_error: null,
      classificador_rodou: false,
      vencedora_fechou_pendencia: false,
      core_threw: [],
      turn: { status: null, outcome: null },
      audit_by_acao: {},
      outbound_count: -1,
      inbound_processado: false,
      pending_status: [],
    };

    // Toda falha vira `ev.setup_error` em vez de derrubar o hook: um `beforeAll`
    // que lança reprova TODOS os casos, inclusive os semânticos — que é o falso
    // vermelho que a #545 existe para eliminar.
    let fase = 'pool';
    let c: pg.PoolClient | null = null;
    try {
      pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });

      fase = 'import';
      const { runAgentForMensagem } = await import('../../src/agent/core.js');
      const { setClassifierForTesting } = await import('../../src/agent/pending-gate.js');
      const { config } = await import('../../src/config/env.js');
      ev.feature_pending_gate = config.FEATURE_PENDING_GATE;
      ev.feature_turn_state_machine = config.FEATURE_TURN_STATE_MACHINE;

      fase = 'conexão';
      c = await pool.connect();

      // `tipo = 'dono'` NÃO é decoração: `checkRateLimit` roda ANTES do gate e
      // é fail-closed — com o Redis ainda não conectado neste processo,
      // `isRedisConnected()` devolve false e um não-dono é silenciado com
      // `rate_limited_silent`, que é um desfecho terminal LEGÍTIMO e faria o
      // teste "passar" sem nunca chegar ao gate (a primeira rodada deste
      // arquivo caiu exatamente nisso). Dono é isento do rate limit em
      // qualquer estado do Redis, então o turno chega ao gate de forma
      // determinística. Nada no caminho do gate depende do `tipo`.
      fase = 'seed';
      const pessoa = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo)
         VALUES ($1, $2, $3, $4, 'dono') RETURNING id`,
        [PRIMARY_CTX.tenant_id, PRIMARY_CTX.agent_id, NOME, TELEFONE],
      );
      ids.pessoa = pessoa.rows[0]!.id;

      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, escopo_entidades)
         VALUES ($1, $2, $3, '{}') RETURNING id`,
        [PRIMARY_CTX.tenant_id, PRIMARY_CTX.agent_id, ids.pessoa],
      );
      ids.conversa = conv.rows[0]!.id;

      // Sem `metadata.telefone`: `probeMessageForChannel` devolve null, o
      // resolver de canal não é acionado e o turno roda sob primary/primary —
      // o caminho single-tenant do runtime.
      const msg = await c.query<{ id: string }>(
        `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo)
         VALUES ($1, $2, $3, 'in', 'texto', 'sim') RETURNING id`,
        [PRIMARY_CTX.tenant_id, PRIMARY_CTX.agent_id, ids.conversa],
      );
      ids.mensagem = msg.rows[0]!.id;

      const pq = await c.query<{ id: string }>(
        `INSERT INTO pending_questions(tenant_id, agent_id, conversa_id, pessoa_id, tipo, pergunta,
                                       opcoes_validas, acao_proposta, expira_em, status, metadata)
         VALUES ($1, $2, $3, $4, 'gate', 'Confirma?', $5::jsonb, $6::jsonb,
                 now() + interval '10 min', 'aberta', '{}'::jsonb) RETURNING id`,
        [
          PRIMARY_CTX.tenant_id,
          PRIMARY_CTX.agent_id,
          ids.conversa,
          ids.pessoa,
          JSON.stringify([
            { key: 'sim', label: 'Sim' },
            { key: 'nao', label: 'Não' },
          ]),
          JSON.stringify({ tool: 'register_transaction', args: { valor: 50 } }),
        ],
      );
      ids.pending = pq.rows[0]!.id;

      // ── A race, encenada de dentro do classificador ──────────────────────
      // O classificador roda na janela entre o snapshot sem lock e o
      // `SELECT … FOR UPDATE`. Fechar a pendência aqui é EXATAMENTE o que a
      // perna vencedora faz — quando o gate volta para pegar o lock, não acha
      // mais nada ativo. `status='respondida'` é o mesmo valor que
      // `pendingQuestionsRepo.resolveTx` grava.
      fase = 'race';
      setClassifierForTesting(async () => {
        ev.classificador_rodou = true;
        const upd = await pool.query(
          `UPDATE pending_questions SET status = 'respondida', resolvida_em = now(), resposta = $4::jsonb
            WHERE id = $1 AND tenant_id = $2 AND agent_id = $3 AND status = 'aberta'`,
          [
            ids.pending,
            PRIMARY_CTX.tenant_id,
            PRIMARY_CTX.agent_id,
            JSON.stringify({ option_chosen: 'sim', confidence: 0.95, source: 'gate' }),
          ],
        );
        ev.vencedora_fechou_pendencia = upd.rowCount === 1;
        return { resolves_pending: true, option_chosen: 'sim', confidence: 0.95 };
      });

      // ── O turno REAL da perna perdedora ─────────────────────────────────
      // `runAgentForMensagem` abre o próprio `runWithTenantContext` a partir do
      // canal resolvido (aqui: primary/primary), então não se envolve o
      // contexto por fora — é o mesmo caminho do worker de produção.
      fase = 'turno';
      try {
        await runAgentForMensagem(ids.mensagem);
      } catch (err) {
        ev.core_threw.push((err as Error).message);
      } finally {
        setClassifierForTesting(null);
      }

      // ── Evidência lida NO BANCO ─────────────────────────────────────────
      fase = 'evidência';
      const turn = await c.query<{ status: string; outcome: string | null }>(
        `SELECT status, outcome FROM agent_turns
          WHERE representative_message_id = $1 AND tenant_id = $2 AND agent_id = $3`,
        [ids.mensagem, PRIMARY_CTX.tenant_id, PRIMARY_CTX.agent_id],
      );
      if (turn.rows[0]) {
        ev.turn = { status: turn.rows[0].status, outcome: turn.rows[0].outcome };
      }

      const aud = await c.query<{ acao: string; n: string }>(
        `SELECT acao, count(*)::text AS n FROM audit_log
          WHERE conversa_id = $1 AND tenant_id = $2 AND agent_id = $3
          GROUP BY acao`,
        [ids.conversa, PRIMARY_CTX.tenant_id, PRIMARY_CTX.agent_id],
      );
      for (const row of aud.rows) ev.audit_by_acao[row.acao] = Number(row.n);

      const out = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM mensagens
          WHERE conversa_id = $1 AND tenant_id = $2 AND agent_id = $3 AND direcao = 'out'`,
        [ids.conversa, PRIMARY_CTX.tenant_id, PRIMARY_CTX.agent_id],
      );
      ev.outbound_count = Number(out.rows[0]!.n);

      const inb = await c.query<{ processada_em: Date | null }>(
        `SELECT processada_em FROM mensagens WHERE id = $1`,
        [ids.mensagem],
      );
      ev.inbound_processado = inb.rows[0]?.processada_em != null;

      const pend = await c.query<{ status: string }>(
        `SELECT status FROM pending_questions
          WHERE conversa_id = $1 AND tenant_id = $2 AND agent_id = $3 ORDER BY created_at`,
        [ids.conversa, PRIMARY_CTX.tenant_id, PRIMARY_CTX.agent_id],
      );
      ev.pending_status = pend.rows.map((r) => r.status);
    } catch (err) {
      ev.setup_error = { fase, message: (err as Error).message };
    } finally {
      c?.release();
    }
  }, SETUP_BUDGET_MS);

  afterAll(async () => {
    if (!pool) return;
    const c = await pool.connect();
    try {
      if (ids.conversa) {
        await c.query('DELETE FROM audit_log WHERE conversa_id = $1', [ids.conversa]);
        await c.query('DELETE FROM agent_turn_inputs WHERE turn_id IN (SELECT id FROM agent_turns WHERE conversa_id = $1)', [ids.conversa]);
        await c.query('DELETE FROM agent_turns WHERE conversa_id = $1', [ids.conversa]);
        await c.query('DELETE FROM pending_questions WHERE conversa_id = $1', [ids.conversa]);
        await c.query('DELETE FROM agent_turns WHERE representative_message_id IN (SELECT id FROM mensagens WHERE conversa_id = $1)', [ids.conversa]);
        await c.query('DELETE FROM mensagens WHERE conversa_id = $1', [ids.conversa]);
        await c.query('DELETE FROM conversas WHERE id = $1', [ids.conversa]);
      }
      if (ids.pessoa) {
        await c.query('DELETE FROM audit_log WHERE pessoa_id = $1', [ids.pessoa]);
        await c.query('DELETE FROM pessoas WHERE id = $1', [ids.pessoa]);
      }
    } finally {
      c.release();
      await pool.end();
    }
  });

  // ── [infra] ───────────────────────────────────────────────────────────────

  it(T_SETUP, () => {
    expect(ev.setup_error, `[infra] o beforeAll abortou. Evidência: ${fmt(ev)}`).toBeNull();
  });

  it(T_FLAGS, () => {
    expect(
      {
        FEATURE_PENDING_GATE: ev.feature_pending_gate,
        FEATURE_TURN_STATE_MACHINE: ev.feature_turn_state_machine,
      },
      `[infra] flag desligada torna o cenário inobservável. Evidência: ${fmt(ev)}`,
    ).toEqual({ FEATURE_PENDING_GATE: true, FEATURE_TURN_STATE_MACHINE: true });
  });

  it(T_THREW, () => {
    expect(
      ev.core_threw,
      `[infra] runAgentForMensagem propagou exceção. Evidência: ${fmt(ev)}`,
    ).toEqual([]);
  });

  it(T_RACE, () => {
    expect(
      {
        classificador_rodou: ev.classificador_rodou,
        vencedora_fechou_pendencia: ev.vencedora_fechou_pendencia,
      },
      '[infra] a race não foi encenada: sem o classificador rodando e sem a pendência ' +
        `fechada pela perna vencedora, não existe perna perdedora. Evidência: ${fmt(ev)}`,
    ).toEqual({ classificador_rodou: true, vencedora_fechou_pendencia: true });
  });

  // ── [semântica] ───────────────────────────────────────────────────────────

  it('[semântica] o turno da perna perdedora termina em ignored/pending_race_lost', (ctx) => {
    exigirInfra(ctx, PRE);
    expect(
      ev.turn,
      '[semântica] a perna perdedora NÃO foi concluída como race perdida. Este é o ' +
        'defeito que o arquivo guarda: o gate colapsava `race_lost` em ' +
        "`{ kind: 'no_pending' }` e o core rodava o turno NORMAL do agente (ReAct) " +
        'sobre uma mensagem que já tinha sido classificada como resposta à pendência — ' +
        'ou seja, reinterpretava um "sim" preso a uma pergunta como comando novo e livre ' +
        'para o LLM. Um turno que caiu no caminho normal aparece aqui como `running`, ' +
        '`retryable`, `completed`/`reply_delivered` ou `completed`/`no_reply_produced`; ' +
        `nunca como ignored/pending_race_lost. Evidência: ${fmt(ev)}`,
    ).toEqual({ status: 'ignored', outcome: 'pending_race_lost' });
  });

  it('[semântica] a race perdida e o descarte do turno ficaram auditados', (ctx) => {
    exigirInfra(ctx, PRE);
    // Duas linhas, dois fatos independentes: `pending_race_lost` (o resolver,
    // dentro da transação que segurava o lock) diz que a corrida foi perdida;
    // `turn_ignored_by_policy` (`concludeTurn`) diz que o turno foi descartado
    // por causa disso. Sem a segunda, o desfecho terminal seria invisível para
    // quem audita — invariante #4 do ARCHITECTURE.md.
    expect(
      {
        pending_race_lost: ev.audit_by_acao['pending_race_lost'] ?? 0,
        turn_ignored_by_policy: ev.audit_by_acao['turn_ignored_by_policy'] ?? 0,
      },
      `[semântica] trilha incompleta do desfecho terminal. Evidência: ${fmt(ev)}`,
    ).toEqual({ pending_race_lost: 1, turn_ignored_by_policy: 1 });
  });

  it('[semântica] a perna perdedora não despachou ação nem produziu resposta', (ctx) => {
    exigirInfra(ctx, PRE);
    // `pending_action_dispatched` = 0 porque a perna vencedora aqui é um UPDATE
    // direto (a #562 é quem guarda o "exatamente uma vez" do despacho). O que
    // importa neste arquivo é que a PERDEDORA não despachou nada e não falou
    // com o usuário: uma resposta gravada seria o ReAct tendo rodado.
    expect(
      {
        pending_action_dispatched: ev.audit_by_acao['pending_action_dispatched'] ?? 0,
        outbound: ev.outbound_count,
      },
      `[semântica] a perna perdedora produziu efeito. Evidência: ${fmt(ev)}`,
    ).toEqual({ pending_action_dispatched: 0, outbound: 0 });
  });

  it('[semântica] o inbound foi carimbado como processado (o turno não fica órfão)', (ctx) => {
    exigirInfra(ctx, PRE);
    // Enquanto FEATURE_TURN_STATE_AUTHORITATIVE estiver OFF, `processada_em` é
    // quem decide se o recovery reenfileira. Um desfecho terminal que esquecesse
    // o carimbo faria a mensagem voltar para sempre.
    expect(
      ev.inbound_processado,
      `[semântica] o inbound ficou sem `+ '`processada_em`' + `: o worker de recovery ` +
        `reenfileiraria a mensagem em laço. Evidência: ${fmt(ev)}`,
    ).toBe(true);
  });
});
