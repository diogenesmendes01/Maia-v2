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
 *     que sempre roda, e varredura de restos de execuções mortas — varredura
 *     essa ESCOPADA por `tenant_id + agent_id` em todas as etapas (AGENTS.md
 *     §4.1), porque `p.nome` é um literal sintético que outra spec pode
 *     repetir sob outro tenant e o banco de teste é compartilhado. O grupo
 *     `[escopo]` abaixo guarda isso com um canário.
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
 * A regra de leitura do vermelho, então:
 *   • `[infra]` vermelho  = ambiente (prazo, conexão, flag, trilha muda).
 *   • `[escopo]` vermelho = esta spec está apagando dado de outro tenant.
 *   • `[semântica]` vermelho = a race real; bug de idempotência em produção.
 *
 * Os grupos são independentes — um `[infra]` vermelho não afrouxa nenhuma
 * asserção semântica, e vice-versa.
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

/** Sufixo aleatório por processo, para o par tenant/agente do canário. */
const SUFIXO = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Base ALEATÓRIA por processo. `pessoas_tenant_agent_telefone_key` é único por
// (tenant, agent, telefone) e este spec sempre roda sob 'primary'/'primary';
// um literal fixo faz duas execuções (ou uma execução e o seu próprio retry)
// colidirem e o vermelho vira erro de fixture, mascarando a asserção que o
// teste existe para fazer. Mesma convenção de onboarding-review-541-round3.
const TELEFONE = `+55119${String(10_000_000 + Math.floor(Math.random() * 80_000_000)).slice(-8)}`;

/**
 * Tenant/agente do CANÁRIO de escopo: um par que esta spec cria só para provar
 * que a sua varredura de restos não atravessa a fronteira de tenant. Ele
 * carrega uma `pessoa` com o MESMO `NOME` sintético do fixture e idade dentro
 * da janela da varredura — exatamente a linha que um `DELETE` por nome+idade
 * apagaria em silêncio.
 */
const CANARY_CTX = {
  tenant_id: `pgc545-canary-${SUFIXO}`,
  agent_id: `pgc545-canary-${SUFIXO}-bot`,
};
const CANARY_TELEFONE = `+55118${String(10_000_000 + Math.floor(Math.random() * 80_000_000)).slice(-8)}`;

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
  /** Erro da varredura de restos (best-effort; nunca é veredito). */
  stale_purge_error: string | null;
  /** Linhas do canário de OUTRO tenant que sobreviveram à varredura. */
  canary_sobreviveu: { pessoas: number; conversas: number; audit_log: number };
  /** Falha ao montar o canário — invalida só o caso `[escopo]`. */
  canary_error: string | null;
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
      stale_purge_error: e.stale_purge_error,
      canary_sobreviveu: e.canary_sobreviveu,
      canary_error: e.canary_error,
      audit_by_acao: e.audit_by_acao,
      timings_ms: { import: e.import_ms, seed: e.seed_ms, race: e.race_ms },
      feature_flag: e.feature_flag,
      fixture: { ...ids, telefone: TELEFONE, ...PRIMARY_CTX },
      canary: CANARY_CTX,
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
      stale_purge_error: null,
      canary_sobreviveu: { pessoas: -1, conversas: -1, audit_log: -1 },
      canary_error: null,
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
      // ── 2. Canário de escopo, semeado ANTES da varredura ─────────────────
      // Uma `pessoa` com o MESMO `NOME` sintético, idade dentro da janela da
      // varredura, sob OUTRO tenant/agente — mais a `conversa` e a linha de
      // `audit_log` dela, para cobrir também as etapas que passam por join. É
      // a linha que a varredura por nome+idade apagaria calada. Falha aqui
      // invalida só o caso `[escopo]`, nunca o veredito da race.
      try {
        await c.query(
          `INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
          [CANARY_CTX.tenant_id],
        );
        await c.query(
          `INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1)
             ON CONFLICT (id) DO NOTHING`,
          [CANARY_CTX.agent_id, CANARY_CTX.tenant_id],
        );
        const cp = await c.query<{ id: string }>(
          `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, created_at)
           VALUES ($1, $2, $3, $4, 'funcionario', now() - interval '2 hours') RETURNING id`,
          [CANARY_CTX.tenant_id, CANARY_CTX.agent_id, NOME, CANARY_TELEFONE],
        );
        const cc = await c.query<{ id: string }>(
          `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, escopo_entidades, created_at)
           VALUES ($1, $2, $3, '{}', now() - interval '2 hours') RETURNING id`,
          [CANARY_CTX.tenant_id, CANARY_CTX.agent_id, cp.rows[0]!.id],
        );
        await c.query(
          `INSERT INTO audit_log(tenant_id, agent_id, acao, pessoa_id, conversa_id)
           VALUES ($1, $2, 'pgc545_canario_escopo', $3, $4)`,
          [CANARY_CTX.tenant_id, CANARY_CTX.agent_id, cp.rows[0]!.id, cc.rows[0]!.id],
        );
      } catch (err) {
        ev.canary_error = (err as Error).message;
      }

      // ── 3. Varre restos de execuções que morreram no meio ─────────────────
      // O corte de 1h evita brigar com uma execução concorrente deste mesmo
      // spec em outro worker; o telefone aleatório já garante que ela não
      // colidiria, isto é só higiene para o banco não acumular lixo.
      //
      // ESCOPO: `p.nome` é um literal sintético, não um identificador único —
      // outra spec (ou outro fixture herdado do mesmo molde) pode ter uma linha
      // com o mesmo nome sob OUTRO tenant/agente, e este banco é compartilhado.
      // Um DELETE por nome+idade apagaria a linha dela em silêncio. Por isso o
      // par `PRIMARY_CTX` entra em TODAS as etapas e nos dois lados de cada
      // join — `audit_log` e `conversas` também carregam o par, NOT NULL desde
      // a migração 012. AGENTS.md §4.1; guardado pelo caso `[escopo]`.
      //
      // Ordem obrigatória: `conversas_pessoa_id_fkey` é ON DELETE RESTRICT e
      // `audit_log` não cascateia nem de `conversas` nem de `pessoas`. Então
      // audit_log → conversas (que cascateia mensagens e pending_questions) →
      // pessoas. Best-effort: isto é higiene, não pré-condição — um erro aqui
      // não pode virar veredito sobre a race, então vira nota na evidência.
      const escopo = [NOME, PRIMARY_CTX.tenant_id, PRIMARY_CTX.agent_id];
      try {
        await c.query(
          `DELETE FROM audit_log a USING conversas cv, pessoas p
            WHERE a.conversa_id = cv.id AND cv.pessoa_id = p.id
              AND a.tenant_id = $2 AND a.agent_id = $3
              AND cv.tenant_id = $2 AND cv.agent_id = $3
              AND p.tenant_id = $2 AND p.agent_id = $3
              AND p.nome = $1 AND p.created_at < now() - interval '1 hour'`,
          escopo,
        );
        await c.query(
          `DELETE FROM audit_log a USING pessoas p
            WHERE a.pessoa_id = p.id
              AND a.tenant_id = $2 AND a.agent_id = $3
              AND p.tenant_id = $2 AND p.agent_id = $3
              AND p.nome = $1 AND p.created_at < now() - interval '1 hour'`,
          escopo,
        );
        await c.query(
          `DELETE FROM conversas cv USING pessoas p
            WHERE cv.pessoa_id = p.id
              AND cv.tenant_id = $2 AND cv.agent_id = $3
              AND p.tenant_id = $2 AND p.agent_id = $3
              AND p.nome = $1 AND p.created_at < now() - interval '1 hour'`,
          escopo,
        );
        await c.query(
          `DELETE FROM pessoas p
            WHERE p.tenant_id = $2 AND p.agent_id = $3
              AND p.nome = $1 AND p.created_at < now() - interval '1 hour'`,
          escopo,
        );
      } catch (err) {
        ev.stale_purge_error = (err as Error).message;
      }

      // Quanto do canário sobreviveu à varredura. Esperado: tudo (1/1/1).
      if (ev.canary_error === null) {
        const cnt = await c.query<{ pessoas: string; conversas: string; audit_log: string }>(
          `SELECT
             (SELECT count(*) FROM pessoas   WHERE tenant_id = $1 AND agent_id = $2 AND nome = $3)::text AS pessoas,
             (SELECT count(*) FROM conversas WHERE tenant_id = $1 AND agent_id = $2)::text               AS conversas,
             (SELECT count(*) FROM audit_log WHERE tenant_id = $1 AND agent_id = $2)::text               AS audit_log`,
          [CANARY_CTX.tenant_id, CANARY_CTX.agent_id, NOME],
        );
        ev.canary_sobreviveu = {
          pessoas: Number(cnt.rows[0]!.pessoas),
          conversas: Number(cnt.rows[0]!.conversas),
          audit_log: Number(cnt.rows[0]!.audit_log),
        };
      }

      // ── 4. Seed do fixture ───────────────────────────────────────────────
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

      // ── 5. A race ────────────────────────────────────────────────────────
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

      // ── 6. Evidência lida NO BANCO ───────────────────────────────────────
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
        // Canário: mesma ordem de FK. O par tenant/agente é criado por esta
        // spec, então some inteiro — `agents` → `tenants` é ON DELETE RESTRICT.
        const cctx = [CANARY_CTX.tenant_id, CANARY_CTX.agent_id];
        await c.query('DELETE FROM audit_log WHERE tenant_id = $1 AND agent_id = $2', cctx);
        await c.query('DELETE FROM conversas WHERE tenant_id = $1 AND agent_id = $2', cctx);
        await c.query('DELETE FROM pessoas WHERE tenant_id = $1 AND agent_id = $2', cctx);
        await c.query('DELETE FROM agents WHERE id = $1', [CANARY_CTX.agent_id]);
        await c.query('DELETE FROM tenants WHERE id = $1', [CANARY_CTX.tenant_id]);
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

  // ── Grupo [escopo]: a fronteira de tenant do fixture desta spec. Vermelho
  // aqui não é ambiente nem race — é esta spec apagando dado de outro tenant.

  it('[escopo] a varredura de restos não atravessa a fronteira de tenant/agente', () => {
    expect(
      ev.canary_error,
      `[escopo] o canário de outro tenant não pôde ser montado (${ev.canary_error}), ` +
        'então esta rodada não prova nada sobre o escopo da varredura. É falha de ' +
        `fixture, não veredito. Evidência: ${fmt(ev)}`,
    ).toBeNull();
    expect(
      ev.canary_sobreviveu,
      '[escopo] a varredura de restos apagou linhas de OUTRO tenant/agente. O ' +
        'canário tem o mesmo `nome` sintético do fixture e idade dentro da janela ' +
        'da varredura, mas vive sob outro par — um DELETE por nome+idade o leva ' +
        'junto. Isto viola o invariante de escopo (AGENTS.md §4.1) e, num banco de ' +
        'teste compartilhado, contamina a spec vizinha em silêncio: repare o par ' +
        `tenant_id/agent_id em TODAS as etapas do purge. Evidência: ${fmt(ev)}`,
    ).toEqual({ pessoas: 1, conversas: 1, audit_log: 1 });
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
