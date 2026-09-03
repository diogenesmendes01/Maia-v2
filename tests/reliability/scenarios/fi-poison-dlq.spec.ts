/**
 * Issue #510 (fatia F) — FI-14: M1 esgota as tentativas e a POLÍTICA DE POISON
 * decide, EXPLICITAMENTE, entre liberar a conversa e interditá-la.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * O que este cenário prova, e por que ele não é vácuo
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A matriz da #510 pede, para FI-14, que "a política libere ou bloqueie
 * EXPLICITAMENTE, com audit". As duas saídas são defensáveis e incompatíveis, e
 * a falha nº 5 da issue-mãe da #505 é justamente deixar a escolha implícita.
 * Um cenário que só afirmasse "o turno virou `dead_letter`" não distinguiria as
 * duas — `dead_letter` é o estado dos DOIS caminhos.
 *
 * Por isso o cenário roda as duas pontas no MESMO `it`, com o MESMO binário de
 * réplica, variando só o CÓDIGO do erro:
 *
 *   ponta que BLOQUEIA — `side_effect_committed` ⇒ categoria `effect_committed`
 *     ⇒ (default de `TURN_POISON_BLOCK_CATEGORIES`) `block_stream`.
 *     reação provada: linha ATIVA em `agent_stream_blocks` com a categoria que
 *     decidiu, `audit_log` de `stream_poisoned` com `disposition:
 *     'block_stream'`, e — o que importa de verdade — um turno NOVO da mesma
 *     conversa passa a ser RECUSADO com `stream_poisoned`, por uma réplica de
 *     processo que tenta o claim de produção.
 *
 *   ponta que LIBERA (o CONTROLE) — `llm_timeout` ⇒ categoria `model` ⇒
 *     `release`. Mesma conclusão terminal, mesma auditoria de dead letter,
 *     NENHUM bloqueio, NENHUMA auditoria de `stream_poisoned` — e o turno
 *     seguinte da conversa é REIVINDICADO normalmente.
 *
 * Sem a segunda ponta, "a conversa ficou bloqueada" também passaria num sistema
 * que bloqueia SEMPRE; sem a primeira, "a conversa andou" passaria num sistema
 * que nunca bloqueia. É o par que torna a palavra "explicitamente" verificável.
 *
 * ═══ Por que réplicas de PROCESSO ══════════════════════════════════════════
 *
 * A recusa que interessa é a do CLAIM, e o claim é uma declaração SQL atômica
 * com o predicado de interdição dentro. Uma simulação in-process do worker
 * mediria o `if` do teste; aqui quem responde "esta conversa está interditada"
 * é o PostgreSQL, para um processo que importou o grafo de produção e chamou
 * `acquireTurnLease` — o mesmo binário que FI-04/05/06/07 usam.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ArtifactCollector } from '../harness/artifacts.js';
import { estavelDurante } from '../harness/eventually.js';
import { FailpointServer } from '../harness/failpoint-transport.js';
import { ProcessSupervisor, type SupervisedChild } from '../harness/process-supervisor.js';
import { ReliabilityEnvironment } from '../harness/environment.js';
import { InvariantOracle } from '../oracles/invariant-oracle.js';
import { linhasDe, prontidaoDe, CARREGADOR_TSX } from './_util-cenario.js';
// Da PRODUÇÃO: a derivação da `stream_key` e o teto de tentativas. Uma chave
// inventada aqui não casaria com o predicado de interdição, e um teto copiado
// deixaria o cenário verde depois de a política mudar.
import { deriveStreamKey, STREAM_KEY_VERSION } from '@/runtime/turns/stream-key.js';
import { MAX_TURN_ATTEMPTS } from '@/runtime/turns/lifecycle.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..', '..');
const FIXTURE_VENENO = resolve(AQUI, '..', 'fixtures', 'replica-de-veneno.ts');
const FIXTURE_TURNO = resolve(AQUI, '..', 'fixtures', 'replica-de-turno.ts');

const TTL_MS = 6_000;
const BATIDA_MS = 1_500;

let env: ReliabilityEnvironment;
let pool: pg.Pool;
let sup: ProcessSupervisor;
let servidor: FailpointServer;
let artefatos: ArtifactCollector;
let TENANT = '';
let AGENTE = '';

interface Conversa {
  conversa_id: string;
  stream_key: string;
  /** M1 — o turno que vai esgotar as tentativas. */
  m1: string;
  /** M2 — a mensagem seguinte da MESMA conversa. */
  m2: string;
}

/**
 * Uma conversa REAL com dois turnos na MESMA stream.
 *
 * `first_ingress_seq` fica NULL de propósito: o head-of-line
 * (`streamHeadOfLineNotExists`) é trivialmente satisfeito quando ela é nula, e
 * o que este cenário quer isolar é o predicado de INTERDIÇÃO — não a ordem da
 * fila, que é a família FI-10..FI-13.
 */
async function conversaComDoisTurnos(sufixo: string): Promise<Conversa> {
  const telefone = `+5511${String(Date.now()).slice(-8)}${sufixo}`;
  const p = await pool.query<{ id: string }>(
    `INSERT INTO pessoas (tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
     VALUES ($1, $2, 'Sonda 510F', $3, 'dono', 'ativa') RETURNING id::text AS id`,
    [TENANT, AGENTE, telefone],
  );
  const c = await pool.query<{ id: string }>(
    `INSERT INTO conversas (tenant_id, agent_id, pessoa_id, status)
     VALUES ($1, $2, $3, 'ativa') RETURNING id::text AS id`,
    [TENANT, AGENTE, p.rows[0]!.id],
  );
  const conversa_id = c.rows[0]!.id;

  const derivada = deriveStreamKey({
    tenant_id: TENANT,
    agent_id: AGENTE,
    channel_kind: 'whatsapp',
    channel_id: `fi14-linha-${sufixo}`,
    remote_identity: telefone,
  });
  if (!derivada.ok) throw new Error(`stream_key não derivou: ${derivada.reason}`);

  const turno = async (attempt_count: number): Promise<string> => {
    const m = await pool.query<{ id: string }>(
      `INSERT INTO mensagens (tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
       VALUES ($1, $2, $3, 'in', 'texto', 'x', '{}'::jsonb) RETURNING id::text AS id`,
      [TENANT, AGENTE, conversa_id],
    );
    const t = await pool.query<{ id: string }>(
      `INSERT INTO agent_turns
         (tenant_id, agent_id, representative_message_id, conversa_id, status,
          attempt_count, stream_key, stream_key_version)
       VALUES ($1, $2, $3, $4, 'received', $5, $6, $7) RETURNING id::text AS id`,
      [
        TENANT,
        AGENTE,
        m.rows[0]!.id,
        conversa_id,
        attempt_count,
        derivada.stream_key,
        STREAM_KEY_VERSION,
      ],
    );
    return t.rows[0]!.id;
  };

  // M1 nasce com o teto quase estourado: o claim incrementa a tentativa
  // canônica, e a tentativa seguinte é a que esgota. É a forma honesta de
  // chegar ao dead letter — pelo contador de PRODUÇÃO, não por um UPDATE que
  // finge o histórico.
  const m1 = await turno(MAX_TURN_ATTEMPTS - 1);
  const m2 = await turno(0);
  return { conversa_id, stream_key: derivada.stream_key, m1, m2 };
}

async function turnoDoBanco(
  turn_id: string,
): Promise<{ status: string; outcome: string | null; last_error_code: string | null }> {
  const r = await pool.query<{ status: string; outcome: string | null; last_error_code: string | null }>(
    'SELECT status, outcome, last_error_code FROM agent_turns WHERE id = $1',
    [turn_id],
  );
  const linha = r.rows[0];
  if (!linha) throw new Error(`turno ${turn_id} sumiu do banco`);
  return linha;
}

async function auditorias(
  acao: string,
  alvo_id: string,
): Promise<Array<{ metadata: Record<string, unknown> }>> {
  const r = await pool.query<{ metadata: Record<string, unknown> }>(
    'SELECT metadata FROM audit_log WHERE acao = $1 AND alvo_id = $2 ORDER BY created_at',
    [acao, alvo_id],
  );
  return r.rows;
}

async function bloqueiosAtivos(
  stream_key: string,
): Promise<Array<{ category: string; reason: string; blocked_by_turn_id: string }>> {
  const r = await pool.query<{ category: string; reason: string; blocked_by_turn_id: string }>(
    `SELECT category, reason, blocked_by_turn_id::text AS blocked_by_turn_id
       FROM agent_stream_blocks
      WHERE tenant_id = $1 AND agent_id = $2 AND stream_key = $3 AND unblocked_at IS NULL`,
    [TENANT, AGENTE, stream_key],
  );
  return r.rows;
}

function envComum(): Record<string, string | undefined> {
  return {
    ...env.envDoFilho(),
    ...servidor.envDoFilho(),
    NODE_OPTIONS: [process.env.NODE_OPTIONS, CARREGADOR_TSX].filter(Boolean).join(' '),
    TURN_LEASE_TTL_MS: String(TTL_MS),
    TURN_LEASE_HEARTBEAT_MS: String(BATIDA_MS),
    // A POLÍTICA, declarada pelo cenário em vez de herdada do default. O
    // default do contrato é o mesmo valor — dizê-lo aqui é o que impede o
    // cenário de virar verde por acidente no dia em que ele mudar.
    TURN_POISON_BLOCK_CATEGORIES: 'effect_committed',
    TEST_FI_TENANT_ID: TENANT,
    TEST_FI_AGENT_ID: AGENTE,
  };
}

function subirVeneno(label: string, conversa: Conversa, erro: string): SupervisedChild {
  return sup.spawn({
    label,
    script: FIXTURE_VENENO,
    cwd: RAIZ,
    env: {
      ...envComum(),
      TEST_FI_TURN_ID: conversa.m1,
      TEST_FI_CONVERSA_ID: conversa.conversa_id,
      TEST_FI_ERRO: erro,
    },
    readyTimeoutMs: 45_000,
  });
}

/** O MESMO binário de FI-04..07 — um worker tentando reivindicar um turno. */
function subirClaim(label: string, turn_id: string): SupervisedChild {
  return sup.spawn({
    label,
    script: FIXTURE_TURNO,
    cwd: RAIZ,
    env: {
      ...envComum(),
      TEST_FI_TURN_ID: turn_id,
      TEST_FI_TENTATIVAS: '3',
      TEST_FI_INTERVALO_MS: '200',
    },
    readyTimeoutMs: 45_000,
  });
}

d('#510 FI-14 — poison/DLQ: a política libera ou bloqueia, e as duas são auditadas', () => {
  beforeAll(async () => {
    env = await ReliabilityEnvironment.criar({ suite: 'fi-poison-dlq' });
    TENANT = env.estado.tenants[0]!.tenantId;
    AGENTE = env.estado.tenants[0]!.agentId;
    pool = new pg.Pool({ connectionString: env.estado.databaseUrl });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await env?.derrubar();
  });

  beforeEach(async () => {
    artefatos = new ArtifactCollector('fi-poison-dlq', 'sem-seed');
    sup = new ProcessSupervisor(artefatos);
    servidor = await FailpointServer.iniciar({ artefatos });
  });

  afterEach(async (ctx) => {
    await sup.dispose();
    await servidor.fechar();
    if (ctx.task.result?.state === 'fail') {
      console.error(`[#510] artefato do cenário: ${artefatos.escrever()}`);
    }
  });

  it(
    'FI-14 — M1 excede as tentativas: efeito irreversível INTERDITA a conversa; falha de modelo a LIBERA',
    async () => {
      const interditada = await conversaComDoisTurnos('1');
      const liberada = await conversaComDoisTurnos('2');
      const oracle = new InvariantOracle({
        pool,
        escopo: [{ tenant_id: TENANT, agent_id: AGENTE }],
        turnIds: [interditada.m1, interditada.m2, liberada.m1, liberada.m2],
      });

      // ── AS DUAS PONTAS, mesmo binário, códigos de erro diferentes.
      const veneno = subirVeneno('veneno-efeito', interditada, 'side_effect_committed');
      const modelo = subirVeneno('veneno-modelo', liberada, 'llm_timeout');
      const [pv, pm] = await Promise.all([prontidaoDe(veneno), prontidaoDe(modelo)]);
      expect(pv.acquired, `a réplica não reivindicou M1: ${JSON.stringify(pv)}`).toBe(true);
      expect(pm.acquired).toBe(true);

      // A premissa é COBRADA: as duas esgotaram o teto de PRODUÇÃO. Sem isso,
      // "foi para dead letter" poderia ser qualquer outro caminho terminal.
      for (const filho of [veneno, modelo]) {
        expect(linhasDe(filho, '##fi-veneno##').at(-1)).toMatchObject({
          esgotou: true,
          teto: MAX_TURN_ATTEMPTS,
          status_apos: 'dead_letter',
        });
      }

      // ── O QUE É IGUAL NOS DOIS: o turno acabou, e a trilha registra.
      for (const alvo of [interditada.m1, liberada.m1]) {
        const t = await turnoDoBanco(alvo);
        expect(t.status).toBe('dead_letter');
        expect(t.outcome).toBe('retry_exhausted');
        const trilha = await auditorias('turn_dead_lettered', alvo);
        expect(trilha, 'o dead letter não foi auditado exatamente uma vez').toHaveLength(1);
        expect(trilha[0]!.metadata).toMatchObject({ to_status: 'dead_letter' });
      }

      // ── O QUE É DIFERENTE, e é a decisão: a conversa do efeito irreversível
      //    está INTERDITADA, com a categoria que decidiu registrada.
      const bloqueios = await bloqueiosAtivos(interditada.stream_key);
      expect(bloqueios, 'a conversa do efeito irreversível NÃO foi interditada').toHaveLength(1);
      expect(bloqueios[0]).toMatchObject({
        category: 'effect_committed',
        reason: 'poison',
        blocked_by_turn_id: interditada.m1,
      });
      const poisonAudit = await auditorias('stream_poisoned', interditada.m1);
      expect(poisonAudit, 'a interdição não foi auditada').toHaveLength(1);
      expect(poisonAudit[0]!.metadata).toMatchObject({
        disposition: 'block_stream',
        category: 'effect_committed',
        reason: 'poison',
      });

      // ── O CONTROLE: a conversa da falha de modelo NÃO foi interditada.
      expect(
        await bloqueiosAtivos(liberada.stream_key),
        'uma falha de modelo interditou a conversa — a política bloqueia SEMPRE',
      ).toHaveLength(0);
      expect(await auditorias('stream_poisoned', liberada.m1)).toHaveLength(0);

      // ── A CONSEQUÊNCIA OPERACIONAL, que é o que a decisão significa. Duas
      //    réplicas do MESMO binário tentam reivindicar M2 de cada conversa.
      const bloqueado = subirClaim('claim-m2-interditada', interditada.m2);
      const livre = subirClaim('claim-m2-liberada', liberada.m2);
      const [pb, pl] = await Promise.all([prontidaoDe(bloqueado), prontidaoDe(livre)]);

      expect(
        pb.acquired,
        `M2 da conversa INTERDITADA foi reivindicado: ${JSON.stringify(pb)}`,
      ).toBe(false);
      expect(pb.motivo).toBe('stream_poisoned');
      // Todas as tentativas foram recusadas pelo MESMO motivo — não é uma
      // recusa transitória que some sozinha.
      for (const t of linhasDe(bloqueado, '##fi-claim##')) {
        expect(t.result).toBe('stream_poisoned');
      }

      expect(
        pl.acquired,
        `M2 da conversa LIBERADA não foi reivindicado: ${JSON.stringify(pl)} — ` +
          'sem este controle, "a conversa parou" também passaria num sistema que para sempre',
      ).toBe(true);

      // E nada destrava a conversa interditada sozinho: nem o tempo, nem o
      // varredor, nem a promoção. Só `npm run dlq -- unblock`.
      await estavelDurante(
        async () => ({
          m2: (await turnoDoBanco(interditada.m2)).status,
          bloqueios: (await bloqueiosAtivos(interditada.stream_key)).length,
        }),
        {
          label: 'a conversa interditada continua interditada',
          janelaMs: 2_000,
          intervalMs: 100,
          justificativa:
            'a invariante é NEGATIVA ("nada a destrava sozinha"); não existe evento de ' +
            'desbloqueio que não aconteceu, e o valor da interdição está justamente em ela ' +
            'não expirar.',
        },
      );

      await oracle.assertInvariantes('FI-14');
    },
    240_000,
  );
});
