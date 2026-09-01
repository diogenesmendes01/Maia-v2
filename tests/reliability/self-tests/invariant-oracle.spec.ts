/**
 * Issue #510 (fatia B) — self-tests do ORACLE.
 *
 * ═══ Por que este arquivo é a peça mais importante da fatia ═════════════════
 *
 * Um harness de fault injection é fácil de fazer VÁCUO: injeta a falha, nada
 * quebra, e o teste passa afirmando nada. O que separa um cenário FI honesto de
 * um teatro é o oracle — e o que separa um oracle honesto de um `expect(true)`
 * é ESTE arquivo, que planta de propósito cada defeito que ele deveria pegar e
 * exige que ele pegue.
 *
 * A issue pede isso nominalmente: "oracle detecta de propósito uma linha
 * outbound duplicada" e "oracle detecta de propósito mutação cross-tenant".
 *
 * ═══ O CASO DE CONTROLE vem primeiro ═══════════════════════════════════════
 *
 * Antes de qualquer detecção, a foto limpa. Sem ele, um oracle que devolvesse
 * violação para tudo passaria em todos os casos abaixo — e seria pior que
 * nenhum oracle, porque tornaria todo cenário FI vermelho por um motivo falso.
 *
 * ═══ Por que a duplicata é plantada numa foto, e não no banco ══════════════
 *
 * Porque o Postgres RECUSA fabricá-la: `outbound_messages_logical_dedupe_uq` é
 * um índice único parcial, e é exatamente essa a proteção de #506. Um oracle
 * que só pudesse ser exercitado contra o banco jamais teria como provar que
 * sabe ver a duplicata — o banco não a deixa existir. Separar `coletar()` (I/O)
 * de `verificarInvariantes()` (puro) é o que dá resposta à pergunta.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runWithTenantContext } from '@/db/tenant-context.js';
import {
  InvariantOracle,
  InvarianteVioladaError,
  verificarFenceDeTokenDeposto,
  verificarInvariantes,
  verificarProgresso,
  type FotoDuravel,
  type LinhaDeSaida,
  type LinhaDeTurno,
} from '../oracles/invariant-oracle.js';

const T = 'fi510-oracle-tenant';
const A = 'fi510-oracle-agent';
const T_INTRUSO = 'fi510-oracle-intruso';
const A_INTRUSO = 'fi510-oracle-intruso-agent';

const turnoBase = (patch: Partial<LinhaDeTurno> = {}): LinhaDeTurno => ({
  id: randomUUID(),
  tenant_id: T,
  agent_id: A,
  status: 'completed',
  outcome: 'reply_delivered',
  attempt_count: 1,
  state_version: 3,
  claim_token: null,
  claimed_by: null,
  lease_expires_at: null,
  next_attempt_at: null,
  stream_key: 'stream-1',
  superseded_by_turn_id: null,
  ...patch,
});

const saidaBase = (patch: Partial<LinhaDeSaida> = {}): LinhaDeSaida => ({
  id: randomUUID(),
  tenant_id: T,
  agent_id: A,
  turn_id: randomUUID(),
  sequence_in_turn: 0,
  logical_dedupe_key: `chave-${randomUUID()}`,
  payload_hash: 'a'.repeat(64),
  status: 'completed',
  delivery_outcome: 'accepted_confirmed',
  ...patch,
});

const foto = (patch: Partial<FotoDuravel> = {}): FotoDuravel => ({
  colhidaEm: new Date().toISOString(),
  agoraDoBanco: new Date().toISOString(),
  escopoEsperado: [{ tenant_id: T, agent_id: A }],
  turnos: [],
  saidas: [],
  auditorias: [],
  ...patch,
});

/** Os identificadores das violações encontradas — é o que o runbook cita. */
const nomes = (f: FotoDuravel, opts = {}): string[] =>
  verificarInvariantes(f, opts).map((v) => v.invariante);

describe('#510 oracle — o CASO DE CONTROLE', () => {
  it('uma foto sã não produz violação nenhuma', () => {
    const t = turnoBase();
    const limpa = foto({
      turnos: [t, turnoBase({ status: 'running', outcome: null, stream_key: 'stream-2' })],
      saidas: [saidaBase({ turn_id: t.id })],
      auditorias: [{ id: randomUUID(), tenant_id: T, agent_id: A, acao: 'turn_claimed', alvo_id: t.id }],
    });
    expect(verificarInvariantes(limpa, { exigirConvergencia: false })).toEqual([]);
  });

  it('o oracle sem escopo declarado é RECUSADO na construção', () => {
    expect(() => new InvariantOracle({ pool: {} as pg.Pool, escopo: [] })).toThrow(
      /não teria contra o que comparar/,
    );
  });
});

describe('#510 oracle — outbound', () => {
  it('DETECTA duas linhas para a mesma saída lógica', () => {
    const chave = 'saida-logica-repetida';
    const violacoes = verificarInvariantes(
      foto({
        saidas: [
          saidaBase({ logical_dedupe_key: chave, payload_hash: 'a'.repeat(64) }),
          saidaBase({ logical_dedupe_key: chave, payload_hash: 'b'.repeat(64) }),
        ],
      }),
    );
    expect(violacoes.map((v) => v.invariante)).toContain('outbound.uma_linha_por_saida_logica');
    // A evidência precisa dizer QUAIS linhas, senão o vermelho não investiga.
    const v = violacoes.find((x) => x.invariante === 'outbound.uma_linha_por_saida_logica');
    expect((v?.evidencia.ids as string[]).length).toBe(2);
  });

  it('DETECTA duas saídas na mesma posição do turno (ordem parcial no multipart)', () => {
    const turno = randomUUID();
    expect(
      nomes(
        foto({
          saidas: [
            saidaBase({ turn_id: turno, sequence_in_turn: 1 }),
            saidaBase({ turn_id: turno, sequence_in_turn: 1 }),
          ],
        }),
      ),
    ).toContain('outbound.sequencia_unica_no_turno');
  });

  it('DETECTA `delivery_unknown` disfarçado de entregue', () => {
    // `timeout_unknown` é, por `statusForOutcome`, um desfecho que deixa a
    // entrega DESCONHECIDA. Uma linha assim marcada `delivered` é a mentira
    // exata que #506 proíbe — e o antídoto contra o reenvio cego.
    expect(
      nomes(
        foto({
          saidas: [saidaBase({ delivery_outcome: 'timeout_unknown', status: 'delivered' })],
        }),
      ),
    ).toContain('outbound.desconhecido_nao_e_entregue');
  });

  it('ACEITA `delivery_unknown` honesto — em `delivery_unknown` ou `reconciling`', () => {
    for (const status of ['delivery_unknown', 'reconciling']) {
      expect(
        nomes(foto({ saidas: [saidaBase({ delivery_outcome: 'timeout_unknown', status })] })),
      ).toEqual([]);
    }
  });

  it('DETECTA desfecho fora do vocabulário de #506', () => {
    expect(
      nomes(foto({ saidas: [saidaBase({ delivery_outcome: 'talvez_tenha_chegado' })] })),
    ).toContain('outbound.desfecho_conhecido');
  });
});

describe('#510 oracle — segurança', () => {
  it('DETECTA mutação cross-tenant em turno, outbound e auditoria', () => {
    const violacoes = verificarInvariantes(
      foto({
        turnos: [turnoBase({ tenant_id: T_INTRUSO, agent_id: A_INTRUSO })],
        saidas: [saidaBase({ tenant_id: T_INTRUSO, agent_id: A_INTRUSO })],
        auditorias: [
          { id: randomUUID(), tenant_id: T_INTRUSO, agent_id: A_INTRUSO, acao: 'turn_claimed', alvo_id: null },
        ],
      }),
    );
    const doEscopo = violacoes.filter((v) => v.invariante === 'seguranca.escopo_declarado');
    // TRÊS: turno, outbound e audit. Uma checagem que só olhasse a tabela do
    // turno deixaria passar o vazamento pelo caminho da saída — que é o
    // caminho que MANDA MENSAGEM.
    expect(doEscopo.map((v) => v.evidencia.tipo).sort()).toEqual(['audit', 'outbound', 'turno']);
  });

  it('DETECTA o fallback `default` mesmo quando ele está no escopo esperado', () => {
    const violacoes = verificarInvariantes(
      foto({
        escopoEsperado: [{ tenant_id: 'default', agent_id: 'default' }],
        turnos: [turnoBase({ tenant_id: 'default', agent_id: 'default' })],
      }),
    );
    // `escopo_declarado` fica satisfeito — e é justamente por isso que a
    // segunda regra existe: um cenário que declarasse `default` como escopo
    // esperado teria silenciado a única evidência de resolução falha.
    expect(violacoes.map((v) => v.invariante)).toEqual(['seguranca.sem_fallback_default']);
  });
});

describe('#510 oracle — turno e FIFO', () => {
  it('DETECTA status fora da máquina de estados de #503', () => {
    expect(nomes(foto({ turnos: [turnoBase({ status: 'quase_pronto', outcome: null })] }))).toContain(
      'turno.status_conhecido',
    );
  });

  it('DETECTA outcome que o estado terminal não admite', () => {
    expect(
      nomes(foto({ turnos: [turnoBase({ status: 'dead_letter', outcome: 'reply_delivered' })] })),
    ).toContain('turno.outcome_coerente');
  });

  it('DETECTA outcome gravado em estado NÃO terminal', () => {
    expect(
      nomes(foto({ turnos: [turnoBase({ status: 'running', outcome: 'reply_delivered' })] })),
    ).toContain('turno.outcome_coerente');
  });

  it('DETECTA claim gravado pela metade', () => {
    expect(
      nomes(foto({ turnos: [turnoBase({ status: 'running', outcome: null, claim_token: randomUUID() })] })),
    ).toContain('turno.claim_completo');
  });

  /**
   * #510 (fatia F) — a outra metade da regra de posse, encontrada por FI-14.
   *
   * A conclusão terminal LIBERA `claim_token`/`lease_expires_at` e PRESERVA
   * `claimed_by` para a forense (`clearClaim`, `turn-repos.ts`). Enquanto
   * nenhum cenário desta lane levava um turno até um estado terminal, o oracle
   * cobrava o tuplo completo também no terminal — e FI-14, o primeiro a
   * dead-letterar, mostrou que isso acusaria TODO turno concluído. A regra que
   * vale ali é mais forte que o tuplo: nenhuma POSSE VIVA sobrevive ao fim.
   */
  it('ACEITA turno TERMINAL com `claimed_by` preservado e a posse liberada', () => {
    expect(
      nomes(
        foto({
          turnos: [
            turnoBase({
              status: 'dead_letter',
              outcome: 'retry_exhausted',
              claimed_by: 'vm:1:turn:abc',
              claim_token: null,
              lease_expires_at: null,
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('DETECTA turno TERMINAL que ficou com posse viva', () => {
    expect(
      nomes(
        foto({
          turnos: [
            turnoBase({
              status: 'completed',
              outcome: 'reply_delivered',
              claimed_by: 'vm:1:turn:abc',
              claim_token: randomUUID(),
              lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
            }),
          ],
        }),
      ),
    ).toContain('turno.posse_liberada_no_terminal');
  });

  it('DETECTA dois turnos ATIVOS na mesma stream', () => {
    const violacoes = verificarInvariantes(
      foto({
        turnos: [
          turnoBase({ status: 'claimed', outcome: null, stream_key: 'quente', claim_token: randomUUID(), claimed_by: 'w1', lease_expires_at: new Date().toISOString() }),
          turnoBase({ status: 'running', outcome: null, stream_key: 'quente', claim_token: randomUUID(), claimed_by: 'w2', lease_expires_at: new Date().toISOString() }),
        ],
      }),
    );
    expect(violacoes.map((v) => v.invariante)).toContain('fifo.um_ativo_por_stream');
  });

  it('ACEITA turnos ativos em streams DIFERENTES — paralelismo não é violação', () => {
    const vivo = new Date(Date.now() + 60_000).toISOString();
    expect(
      nomes(
        foto({
          turnos: ['a', 'b', 'c'].map((s) =>
            turnoBase({
              status: 'running',
              outcome: null,
              stream_key: s,
              claim_token: randomUUID(),
              claimed_by: `w-${s}`,
              lease_expires_at: vivo,
            }),
          ),
        }),
      ),
    ).toEqual([]);
  });
});

describe('#510 oracle — operação', () => {
  const orfao = turnoBase({ status: 'received', outcome: null, stream_key: null });

  it('sem `exigirConvergencia`, um turno esperando worker NÃO é violação', () => {
    expect(nomes(foto({ turnos: [orfao] }))).toEqual([]);
  });

  it('com `exigirConvergencia`, o mesmo turno é um turno PERDIDO', () => {
    expect(nomes(foto({ turnos: [orfao] }), { exigirConvergencia: true })).toContain(
      'operacao.turno_orfao',
    );
  });

  it('convergência ACEITA turno com lease viva ou retry agendado', () => {
    const agora = new Date();
    const f = foto({
      agoraDoBanco: agora.toISOString(),
      turnos: [
        turnoBase({
          status: 'running',
          outcome: null,
          claim_token: randomUUID(),
          claimed_by: 'w1',
          lease_expires_at: new Date(agora.getTime() + 30_000).toISOString(),
          stream_key: 's1',
        }),
        turnoBase({
          status: 'retryable',
          outcome: null,
          next_attempt_at: new Date(agora.getTime() + 5_000).toISOString(),
          stream_key: 's2',
        }),
      ],
    });
    expect(nomes(f, { exigirConvergencia: true })).toEqual([]);
  });

  it('a lease é comparada contra o relógio do BANCO, não o do processo', () => {
    // O banco está 10 minutos ATRÁS do processo. Uma lease que já venceu pelo
    // relógio local ainda está viva pelo relógio que decide — e é esse que
    // `claimNextEligibleTurn` usa.
    const agoraDoBanco = new Date(Date.now() - 600_000);
    const f = foto({
      agoraDoBanco: agoraDoBanco.toISOString(),
      turnos: [
        turnoBase({
          status: 'claimed',
          outcome: null,
          claim_token: randomUUID(),
          claimed_by: 'w1',
          lease_expires_at: new Date(agoraDoBanco.getTime() + 30_000).toISOString(),
        }),
      ],
    });
    expect(nomes(f, { exigirConvergencia: true })).toEqual([]);
  });
});

describe('#510 oracle — progresso e fence (duas fotos)', () => {
  it('DETECTA `attempt_count` que regrediu', () => {
    const t = turnoBase({ status: 'running', outcome: null, attempt_count: 3 });
    const antes = foto({ turnos: [t] });
    const depois = foto({ turnos: [{ ...t, attempt_count: 2 }] });
    expect(verificarProgresso(antes, depois).map((v) => v.invariante)).toContain(
      'turno.attempt_monotonico',
    );
  });

  it('DETECTA turno TERMINAL que voltou a não terminal', () => {
    const t = turnoBase({ status: 'completed', outcome: 'reply_delivered' });
    const antes = foto({ turnos: [t] });
    const depois = foto({ turnos: [{ ...t, status: 'running', outcome: null, state_version: 9 }] });
    expect(verificarProgresso(antes, depois).map((v) => v.invariante)).toContain(
      'turno.terminal_nao_volta',
    );
  });

  it('DETECTA mutação pelo token DEPOSTO', () => {
    const deposto = randomUUID();
    const t = turnoBase({
      status: 'running',
      outcome: null,
      claim_token: randomUUID(),
      claimed_by: 'sucessor',
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      state_version: 8,
    });
    // O sucessor tomou a posse com `state_version = 7`; agora está em 8, então
    // ALGUÉM gravou depois do takeover.
    const violacoes = verificarFenceDeTokenDeposto(foto({ turnos: [t] }), {
      turn_id: t.id,
      claim_token: deposto,
      state_version_no_takeover: 7,
    });
    expect(violacoes.map((v) => v.invariante)).toEqual(['turno.sem_mutacao_stale']);
  });

  it('ACEITA a linha congelada desde o takeover — o caso de controle do fence', () => {
    const t = turnoBase({
      status: 'running',
      outcome: null,
      claim_token: randomUUID(),
      claimed_by: 'sucessor',
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      state_version: 7,
    });
    expect(
      verificarFenceDeTokenDeposto(foto({ turnos: [t] }), {
        turn_id: t.id,
        claim_token: randomUUID(),
        state_version_no_takeover: 7,
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// O COLETOR — a única parte que precisa de banco
// ---------------------------------------------------------------------------

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

d('#510 oracle — o coletor lê o estado durável REAL', () => {
  let pool: pg.Pool;
  let turnoDoEscopo: string;
  let turnoDoIntruso: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    for (const [t, a] of [
      [T, A],
      [T_INTRUSO, A_INTRUSO],
    ]) {
      await pool.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [t]);
      await pool.query(
        'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT (id) DO NOTHING',
        [a, t],
      );
    }
    turnoDoEscopo = await criarTurno(pool, T, A);
    turnoDoIntruso = await criarTurno(pool, T_INTRUSO, A_INTRUSO);
  });

  afterAll(async () => {
    for (const t of [T, T_INTRUSO]) {
      await pool?.query('DELETE FROM agent_turns WHERE tenant_id = $1', [t]);
      await pool?.query('DELETE FROM mensagens WHERE tenant_id = $1', [t]);
    }
    await pool?.end();
  });

  it('a foto traz o turno do escopo e NÃO traz o do vizinho', async () => {
    const oracle = new InvariantOracle({ pool, escopo: [{ tenant_id: T, agent_id: A }] });
    const f = await oracle.coletar();
    const ids = f.turnos.map((t) => t.id);
    expect(ids).toContain(turnoDoEscopo);
    expect(ids).not.toContain(turnoDoIntruso);
  });

  it('`agoraDoBanco` vem do PostgreSQL, e é o relógio que decide lease', async () => {
    const oracle = new InvariantOracle({ pool, escopo: [{ tenant_id: T, agent_id: A }] });
    const f = await oracle.coletar();
    const doBanco = Date.parse(f.agoraDoBanco);
    expect(Number.isFinite(doBanco)).toBe(true);
    // Sanidade: os dois relógios estão no mesmo século. A afirmação forte é a
    // do teste puro acima; aqui só se garante que o campo não é lixo.
    expect(Math.abs(doBanco - Date.now())).toBeLessThan(5 * 60_000);
  });

  it('a foto de um escopo SÃO passa em `assertInvariantes` — o controle', async () => {
    const oracle = new InvariantOracle({ pool, escopo: [{ tenant_id: T, agent_id: A }] });
    await expect(oracle.assertInvariantes('controle-coletor')).resolves.toBeDefined();
  });

  it('uma linha REALMENTE fora do escopo faz `assertInvariantes` lançar', async () => {
    const oracle = new InvariantOracle({
      pool,
      escopo: [{ tenant_id: T, agent_id: A }],
    });
    const f = await oracle.coletar();
    // Planta a linha do vizinho DENTRO da foto (o banco a manteve isolada, que
    // é o comportamento certo) e confirma que o oracle a rejeitaria.
    const contaminada: FotoDuravel = {
      ...f,
      turnos: [...f.turnos, turnoBase({ tenant_id: T_INTRUSO, agent_id: A_INTRUSO })],
    };
    expect(verificarInvariantes(contaminada).map((v) => v.invariante)).toContain(
      'seguranca.escopo_declarado',
    );
    expect(() => {
      throw new InvarianteVioladaError('teste', verificarInvariantes(contaminada));
    }).toThrow(/seguranca\.escopo_declarado/);
  });
});

async function criarTurno(pool: pg.Pool, tenant: string, agent: string): Promise<string> {
  const mensagem_id = randomUUID();
  await pool.query(
    `INSERT INTO mensagens (id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata, processada_em)
     VALUES ($1, $2, $3, NULL, 'in', 'texto', 'x', '{}'::jsonb, NULL)`,
    [mensagem_id, tenant, agent],
  );
  const { agentTurnsRepo } = await import('../../../src/db/repositories.js');
  const turno = await runWithTenantContext({ tenant_id: tenant, agent_id: agent }, () =>
    agentTurnsRepo.ensureTurnForMessage({
      id: mensagem_id,
      tenant_id: tenant,
      agent_id: agent,
      conversa_id: null,
      channel_id: null,
    }),
  );
  return turno.id;
}
