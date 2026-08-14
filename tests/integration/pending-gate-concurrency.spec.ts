/**
 * B0 concurrency proof: two parallel `checkPendingFirst` against the same
 * pending must dispatch the action EXACTLY ONCE. Skipped without TEST_DB_URL.
 *
 * Uses setClassifierForTesting to inject a deterministic resolver — no
 * Haiku round-trip, so the test is self-contained and doesn't need
 * ANTHROPIC_API_KEY in CI.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Issue #545 — por que este arquivo é estruturado assim
 * ─────────────────────────────────────────────────────────────────────────
 * A versão anterior era um único `it` que fazia TUDO dentro do `testTimeout`
 * padrão de 5s: seed do fixture, `await import()` do grafo de módulos de
 * produção (pending-gate → pending-resolver → tools/_dispatcher → governance
 * → scheduling → LLM gateway), a race e as asserções. Três defeitos de
 * diagnóstico saíam daí, e juntos tornavam o vermelho ILEGÍVEL:
 *
 *  1. **Custo de infraestrutura contado como prazo do teste.** O `import()`
 *     dinâmico paga a transformação ESM de todo o grafo, medido em ~6s nesta
 *     máquina — acima dos 5s. O vermelho era `Test timed out in 5000ms`, que
 *     não diz nada sobre despachar uma ou duas vezes. Hoje o import e o seed
 *     acontecem no `beforeAll` (orçamento de hook, explicitamente rotulado
 *     como infraestrutura) e a race tem orçamento próprio, medido e asserido
 *     num teste `[infra]` separado. As asserções semânticas rodam sobre
 *     evidência já coletada e não têm exposição a timeout nenhuma.
 *
 *  2. **Fixture com telefone fixo + cleanup fora do `finally`.** O cleanup
 *     ficava depois dos `expect`, então qualquer vermelho vazava a `pessoa`.
 *     Pior: o timeout do vitest NÃO aborta o corpo async — a tentativa que
 *     estourou continua rodando e colide com o próprio `retry: 1` no mesmo
 *     telefone `+5511900000099`, e a segunda tentativa morria com
 *     `duplicate key ... pessoas_tenant_agent_telefone_key`. Duas mensagens
 *     diferentes para uma causa só. Hoje: telefone com base aleatória por
 *     processo (mesma convenção de `onboarding-review-541-round3.spec.ts`,
 *     onde `channels_active_line_uq` global já mordeu), cleanup em `afterAll`
 *     que sempre roda, e varredura de restos de execuções mortas.
 *
 *  3. **O teste nunca observou um despacho.** O nome diz "dispatches action
 *     exactly once", mas as asserções eram sobre o valor de retorno de
 *     `checkPendingFirst`. Não dá para ver o despacho ali: `race_lost` e
 *     "não havia pendência" e "flag desligada" e "o SELECT de snapshot
 *     falhou" colapsam todos em `{ kind: 'no_pending' }`. E o `inbound.id`
 *     era a string `'m-test'`, que não é UUID: TODA linha de `audit_log`
 *     desta trilha era rejeitada pelo Postgres e engolida por `audit()` (que
 *     engole por desenho). Hoje o inbound é uma `mensagens` real, e a
 *     asserção de "exatamente uma vez" lê `audit_log` NO BANCO —
 *     `pending_action_dispatched` e `pending_race_lost` — que são as linhas
 *     que `pending-resolver.ts` escreve no caminho de produção.
 *
 * A regra de leitura do vermelho, então: teste `[infra]` vermelho = ambiente
 * (prazo, erro de conexão, flag, trilha de auditoria muda). Teste
 * `[semântica]` vermelho = a race real, e aí é bug de idempotência em
 * produção. Os dois grupos são independentes — um `[infra]` vermelho não
 * afrouxa nenhuma asserção semântica, e vice-versa.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const SHOULD_RUN = !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

// Precisa estar setado ANTES do primeiro import de `@/config/env.js` (que vem
// junto com o import dinâmico de pending-gate.js): o schema do contrato tem
// default `false` e o gate faz short-circuit com a flag desligada.
process.env.FEATURE_PENDING_GATE = 'true';

const NOME = 'pgc545-b0';

// Base ALEATÓRIA por processo. `pessoas_tenant_agent_telefone_key` é único por
// (tenant, agent, telefone) e este spec sempre roda sob 'primary'/'primary';
// um literal fixo faz duas execuções (ou uma execução e o seu próprio retry)
// colidirem e o vermelho vira erro de fixture, mascarando a asserção que o
// teste existe para fazer. Mesma convenção de onboarding-review-541-round3.
const TELEFONE = `+55119${String(10_000_000 + Math.floor(Math.random() * 80_000_000)).slice(-8)}`;

/**
 * Orçamento da race PROPRIAMENTE DITA — só as duas chamadas paralelas de
 * `checkPendingFirst`, com o grafo de módulos já carregado e o fixture já
 * semeado. Medido em 56ms nesta máquina (contra 6.525ms só de `import()` do
 * grafo, que é exatamente o custo que estourava o `testTimeout` de 5s antes);
 * 15s dá duas ordens de grandeza de folga para CI sob carga, o suficiente para
 * este orçamento nunca ser ele próprio uma fonte de flake, e apertado o
 * bastante para acusar um stall patológico (pool exaurido, espera de lock que
 * não resolve). Este número é de INFRAESTRUTURA: estourá-lo
 * reprova um teste `[infra]` e nenhuma asserção semântica — elas rodam sobre
 * evidência já coletada. Afrouxá-lo não afrouxa "exatamente uma vez".
 */
const RACE_BUDGET_MS = 15_000;

/** Orçamento do `beforeAll`: transformação ESM do grafo + seed. */
const SETUP_BUDGET_MS = 120_000;

type Evidence = {
  feature_flag: boolean;
  import_ms: number;
  seed_ms: number;
  race_ms: number;
  /** `kind` devolvido por cada uma das duas chamadas paralelas, em ordem. */
  kinds: string[];
  /** Erros lançados por cada chamada (vazio = nenhum). Infra, não semântica. */
  threw: string[];
  /** Estado final da pending question, lido no banco. */
  pending_status: string[];
  /** O `inbound.id` usado na race existe em `mensagens`? (FK do audit_log). */
  inbound_is_real_mensagem: boolean;
  /** `audit_log` desta conversa, agrupado por ação, lido NO BANCO. */
  audit_by_acao: Record<string, number>;
  audit_total: number;
};

let pool: pg.Pool;
let ev: Evidence;
const ids = {
  pessoa: '',
  conversa: '',
  mensagem: '',
};

/** Contexto de tenant do fixture — `'primary'` é a casa do runtime (#323). */
const PRIMARY_CTX = { tenant_id: 'primary', agent_id: 'primary' };

function fmt(e: Evidence): string {
  return JSON.stringify(
    {
      kinds: e.kinds,
      threw: e.threw,
      pending_status: e.pending_status,
      inbound_is_real_mensagem: e.inbound_is_real_mensagem,
      audit_by_acao: e.audit_by_acao,
      timings_ms: { import: e.import_ms, seed: e.seed_ms, race: e.race_ms },
      feature_flag: e.feature_flag,
      fixture: ids,
    },
    null,
    2,
  );
}

d('pending-gate concurrency', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });

    ev = {
      feature_flag: false,
      import_ms: -1,
      seed_ms: -1,
      race_ms: -1,
      kinds: [],
      threw: [],
      pending_status: [],
      inbound_is_real_mensagem: false,
      audit_by_acao: {},
      audit_total: 0,
    };

    // ── 1. Import do grafo de produção, medido FORA do prazo do caso ────────
    // Isto é custo de transformação ESM, não é o que o teste afere.
    const t0 = Date.now();
    const { checkPendingFirst, setClassifierForTesting } = await import(
      '../../src/agent/pending-gate.js'
    );
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
    const { config } = await import('../../src/config/env.js');
    ev.import_ms = Date.now() - t0;
    ev.feature_flag = config.FEATURE_PENDING_GATE;

    const c = await pool.connect();
    try {
      // ── 2. Varre restos de execuções que morreram no meio ────────────────
      // O corte de 1h evita brigar com uma execução concorrente deste mesmo
      // spec em outro worker; o telefone aleatório já garante que ela não
      // colidiria, isto é só higiene para o banco não acumular lixo.
      await c.query(
        `DELETE FROM audit_log a USING conversas cv, pessoas p
          WHERE a.conversa_id = cv.id AND cv.pessoa_id = p.id
            AND p.nome = $1 AND p.created_at < now() - interval '1 hour'`,
        [NOME],
      );
      await c.query(
        `DELETE FROM pessoas WHERE nome = $1 AND created_at < now() - interval '1 hour'`,
        [NOME],
      );

      // ── 3. Seed do fixture ───────────────────────────────────────────────
      const t1 = Date.now();
      try {
        const pessoa = await c.query<{ id: string }>(
          `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo)
           VALUES ('primary', 'primary', $1, $2, 'funcionario') RETURNING id`,
          [NOME, TELEFONE],
        );
        ids.pessoa = pessoa.rows[0]!.id;

        const conv = await c.query<{ id: string }>(
          `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, escopo_entidades)
           VALUES ('primary', 'primary', $1, '{}') RETURNING id`,
          [ids.pessoa],
        );
        ids.conversa = conv.rows[0]!.id;

        // A mensagem inbound precisa EXISTIR: `audit_log.mensagem_id` tem FK
        // para `mensagens`. Com o `'m-test'` anterior (nem UUID) o Postgres
        // rejeitava toda linha de auditoria desta trilha e `audit()` engolia
        // a falha — a evidência de despacho simplesmente não existia.
        const msg = await c.query<{ id: string }>(
          `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo)
           VALUES ('primary', 'primary', $1, 'in', 'texto', 'sim') RETURNING id`,
          [ids.conversa],
        );
        ids.mensagem = msg.rows[0]!.id;

        await c.query(
          `INSERT INTO pending_questions(tenant_id, agent_id, conversa_id, pessoa_id, tipo, pergunta, opcoes_validas, acao_proposta, expira_em, status, metadata)
           VALUES ('primary', 'primary', $1, $2, 'gate', 'Confirma?', $3::jsonb, $4::jsonb, now() + interval '10 min', 'aberta', '{}'::jsonb)`,
          [
            ids.conversa,
            ids.pessoa,
            JSON.stringify([
              { key: 'sim', label: 'Sim' },
              { key: 'nao', label: 'Não' },
            ]),
            JSON.stringify({ tool: 'register_transaction', args: { valor: 50 } }),
          ],
        );
      } catch (err) {
        throw new Error(
          `[fixture] seed do cenário B0 falhou (telefone=${TELEFONE}) — isto é ` +
            `falha de fixture/ambiente, NÃO veredito sobre a race: ${(err as Error).message}`,
          { cause: err },
        );
      }
      ev.seed_ms = Date.now() - t1;

      // ── 4. A race ────────────────────────────────────────────────────────
      setClassifierForTesting(async () => ({
        resolves_pending: true,
        option_chosen: 'sim',
        confidence: 0.95,
      }));

      const inbound = { id: ids.mensagem, conteudo: 'sim' };
      const conversa = { id: ids.conversa };
      const persona = { id: ids.pessoa };

      // #355 H2 (flip-readiness): as mutações de resolve/cancel sob
      // checkPendingFirst são tenant-scoped (leem tenant_id/agent_id do ALS),
      // então este caminho — como os callers de produção (baileys →
      // runWithTenantContext) — precisa rodar dentro de um contexto de tenant.
      const oneGate = async (): Promise<{ kind: string } | { threw: string }> => {
        try {
          const r = await runWithTenantContext(PRIMARY_CTX, () =>
            checkPendingFirst({
              pessoa: persona as never,
              conversa: conversa as never,
              inbound: inbound as never,
            }),
          );
          return { kind: r.kind };
        } catch (err) {
          // Capturado em vez de propagado: um throw de uma das pernas é sinal
          // de INFRA (conexão, pool, migração faltando) e tem teste próprio.
          // Deixá-lo escapar aqui reprovaria o `beforeAll` inteiro e apagaria
          // a evidência semântica que a outra perna já produziu.
          return { threw: (err as Error).message };
        }
      };

      const t2 = Date.now();
      const settled = await Promise.all([oneGate(), oneGate()]);
      ev.race_ms = Date.now() - t2;

      ev.kinds = settled.map((s) => ('kind' in s ? s.kind : 'THREW'));
      ev.threw = settled.flatMap((s) => ('threw' in s ? [s.threw] : []));

      setClassifierForTesting(null);

      // ── 5. Evidência lida NO BANCO ───────────────────────────────────────
      // `::text` no lado esquerdo para que um `inbound.id` não-UUID (o defeito
      // #3 da issue) devolva `false` em vez de estourar o cast do Postgres.
      const inb = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM mensagens WHERE id::text = $1`,
        [String(inbound.id)],
      );
      ev.inbound_is_real_mensagem = Number(inb.rows[0]!.n) === 1;

      const pend = await c.query<{ status: string }>(
        `SELECT status FROM pending_questions WHERE conversa_id = $1 ORDER BY created_at`,
        [ids.conversa],
      );
      ev.pending_status = pend.rows.map((r) => r.status);

      const aud = await c.query<{ acao: string; n: string }>(
        `SELECT acao, count(*)::text AS n FROM audit_log WHERE conversa_id = $1 GROUP BY acao`,
        [ids.conversa],
      );
      for (const row of aud.rows) ev.audit_by_acao[row.acao] = Number(row.n);
      ev.audit_total = aud.rows.reduce((s, r) => s + Number(r.n), 0);
    } finally {
      c.release();
    }
  }, SETUP_BUDGET_MS);

  afterAll(async () => {
    // Cleanup incondicional: o `beforeAll` pode ter morrido no meio, e o
    // fixture vazado é o que envenenava a execução seguinte.
    if (pool) {
      const c = await pool.connect();
      try {
        if (ids.conversa) {
          await c.query('DELETE FROM audit_log WHERE conversa_id = $1', [ids.conversa]);
          await c.query('DELETE FROM pending_questions WHERE conversa_id = $1', [ids.conversa]);
          await c.query('DELETE FROM mensagens WHERE conversa_id = $1', [ids.conversa]);
          await c.query('DELETE FROM conversas WHERE id = $1', [ids.conversa]);
        }
        if (ids.pessoa) {
          await c.query('DELETE FROM audit_log WHERE pessoa_id = $1', [ids.pessoa]);
          await c.query('DELETE FROM pessoas WHERE id = $1', [ids.pessoa]);
        }
      } finally {
        c.release();
      }
      await pool.end();
    }
  });

  // ── Grupo [infra]: condições de ambiente. Vermelho aqui NÃO é veredito
  // sobre a race — é ambiente, e as asserções semânticas abaixo continuam
  // valendo por conta própria.

  it('[infra] o gate roda com FEATURE_PENDING_GATE ligado', () => {
    expect(
      ev.feature_flag,
      '[infra] FEATURE_PENDING_GATE veio desligada, então checkPendingFirst faz ' +
        'short-circuit e devolve no_pending nas DUAS pernas — indistinguível de ' +
        '"as duas perderam a race". Nada abaixo é veredito semântico. ' +
        `Evidência: ${fmt(ev)}`,
    ).toBe(true);
  });

  it('[infra] nenhuma das duas pernas paralelas lançou erro', () => {
    expect(
      ev.threw,
      '[infra] uma das chamadas paralelas de checkPendingFirst LANÇOU — conexão, ' +
        'pool exaurido, schema desatualizado. Isto é ambiente, não race semântica. ' +
        `Evidência: ${fmt(ev)}`,
    ).toEqual([]);
  });

  it('[infra] a race paralela terminou dentro do orçamento', () => {
    expect(
      ev.race_ms,
      `[infra] as duas chamadas paralelas levaram ${ev.race_ms}ms (orçamento ` +
        `${RACE_BUDGET_MS}ms). Isto é prazo/carga, NÃO "despachou duas vezes" — o ` +
        'veredito de exatamente-uma-vez está nos testes [semântica], que rodam ' +
        `sobre evidência já coletada e não dependem deste prazo. Evidência: ${fmt(ev)}`,
    ).toBeLessThan(RACE_BUDGET_MS);
  });

  it('[infra] o inbound do fixture é uma mensagem real, gravável em audit_log', () => {
    // Guarda de regressão da causa #3 da issue #545: com `inbound.id = 'm-test'`
    // (nem UUID) a FK `audit_log_mensagem_id_fkey` rejeitava TODA linha desta
    // trilha e `audit()` engolia a falha — as contagens abaixo dariam 0 sem que
    // nada estivesse errado com a race. Aqui não há disjunção possível: ou o
    // fixture é gravável, ou não é.
    expect(
      ev.inbound_is_real_mensagem,
      '[infra] o inbound do fixture não corresponde a uma linha de `mensagens`. ' +
        '`audit_log.mensagem_id` tem FK para `mensagens`, então NENHUMA linha de ' +
        'auditoria desta trilha consegue ser gravada e as contagens [semântica] ' +
        `abaixo perdem valor probatório. Evidência: ${fmt(ev)}`,
    ).toBe(true);
  });

  it('[infra] a trilha de auditoria desta conversa não está muda', () => {
    // Duas leituras possíveis para zero linhas, e a evidência separa as duas:
    // se `kinds` mostra pernas que resolveram, o caminho de produção rodou e
    // não auditou (semântico/instrumentação de produção); se `kinds` é só
    // `no_pending`, nada chegou ao resolve. Este teste não escolhe entre elas —
    // ele só impede que "0 despachos" seja lido como veredito da race.
    expect(
      ev.audit_total,
      'nenhuma linha de audit_log para esta conversa. `audit()` engole falhas de ' +
        'escrita por desenho, então "0 despachos" abaixo NÃO é veredito sobre a ' +
        `race. Separe pelas \`kinds\` na evidência: ${JSON.stringify(ev.kinds)} — ` +
        'pernas `resolved` com trilha muda = o caminho de produção rodou sem ' +
        'auditar; só `no_pending` = nada chegou ao resolve (confira os outros ' +
        `[infra]). Evidência: ${fmt(ev)}`,
    ).toBeGreaterThan(0);
  });

  // ── Grupo [semântica]: o invariante que este arquivo existe para guardar.
  // Vermelho aqui é bug de idempotência em produção (src/agent/pending-gate.ts,
  // src/agent/pending-resolver.ts), não flake.

  it('[semântica] exatamente uma das pernas resolveu a pendência', () => {
    const resolved = ev.kinds.filter((k) => k === 'resolved').length;
    expect(
      resolved,
      `[semântica] ${resolved} das 2 chamadas paralelas devolveram kind='resolved' ` +
        '(esperado exatamente 1). >1 = a pendência foi resolvida em duplicidade; ' +
        '0 = nenhuma resolveu (confira antes os testes [infra] — com eles verdes, ' +
        'isto é o guard de FOR UPDATE em pending-resolver.ts rejeitando as duas). ' +
        `Evidência: ${fmt(ev)}`,
    ).toBe(1);
  });

  it('[semântica] a ação foi despachada exatamente uma vez (audit_log no banco)', () => {
    const n = ev.audit_by_acao['pending_action_dispatched'] ?? 0;
    expect(
      n,
      `[semântica] o audit_log registra ${n} 'pending_action_dispatched' para esta ` +
        'conversa (esperado exatamente 1). Esta é a asserção que dá nome ao arquivo: ' +
        '2 significa que a ação (register_transaction) foi despachada em duplicidade ' +
        'sob resolves paralelos — RACE SEMÂNTICA em src/agent/pending-resolver.ts, ' +
        'bug de idempotência em produção, não flake. 0 com [infra] verde significa ' +
        `que nenhuma perna chegou ao despacho. Evidência: ${fmt(ev)}`,
    ).toBe(1);
  });

  it('[semântica] a perna perdedora foi registrada como race_lost exatamente uma vez', () => {
    const n = ev.audit_by_acao['pending_race_lost'] ?? 0;
    expect(
      n,
      `[semântica] o audit_log registra ${n} 'pending_race_lost' (esperado exatamente ` +
        '1). É o outro lado do invariante: das duas pernas, uma vence e a outra PRECISA ' +
        'perder de forma auditada. 0 = as duas passaram pelo guard de FOR UPDATE. ' +
        `Evidência: ${fmt(ev)}`,
    ).toBe(1);
  });

  it('[semântica] a pending question terminou respondida, em linha única', () => {
    expect(
      ev.pending_status,
      "[semântica] estado final da pending question diferente de exatamente uma linha " +
        "'respondida'. 'aberta' = o despacho comitou sem fechar a pergunta (o próximo " +
        'inbound re-resolveria e despacharia de novo). Mais de uma linha = fixture ' +
        `contaminado. Evidência: ${fmt(ev)}`,
    ).toEqual(['respondida']);
  });
});
