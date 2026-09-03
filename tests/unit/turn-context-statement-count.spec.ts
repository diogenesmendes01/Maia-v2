import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Conversa, Mensagem, Pessoa } from '../../src/db/schema.js';

/**
 * Issue #525 — the round-trip ceiling counted in SQL STATEMENTS, not in
 * repository calls.
 *
 * ## Why this file exists next to `turn-context-round-trips.spec.ts`
 *
 * That spec is the budget's day-to-day guard: it mocks
 * `src/db/repositories.js` and counts how many repository METHODS the turn
 * calls. That is the right shape for asserting the read SET (which repo, how
 * many times, which one disappears when `core.ts` supplies the procedure), and
 * it runs anywhere.
 *
 * But it rests on an assumption it cannot itself check, and states so in its
 * own header: *"every repo method exercised here is exactly one statement, so
 * the two counts coincide"*. Nothing enforced that. A repository method that
 * grew a second statement — a lookup before the write, a count before the page,
 * an `IN (…)` chunked into batches — would leave that spec green at 13 while
 * production paid 14, 20 or 30. "≤ N round-trips" proved by counting something
 * that is not round-trips is exactly the failure mode a budget is supposed to
 * prevent.
 *
 * This spec closes that gap WITHOUT a live Postgres by mocking one layer lower.
 * Everything above the socket is production code:
 *
 *   - the real `buildPrompt` / `loadTurnContext` / `renderTurnPrompt`;
 *   - the real repositories in `src/db/repositories.js`;
 *   - the real drizzle query builders and the real SQL compilation;
 *   - the real `db` from `src/db/client.ts`, including the `instrumentQueries`
 *     Proxy that feeds `recordDbQuery()`.
 *
 * Only `pg` is faked, and it is faked at `client.query` — the exact seam the
 * production counter hooks. So the number below is the number of statements
 * that would have gone down a real socket.
 *
 * ## Two independent tallies, cross-checked
 *
 * The count is read twice per assertion, and the two must agree:
 *
 *   1. `runWithQueryCounter` — the PRODUCTION counter (`src/db/query-counter.ts`),
 *      the same one that publishes `maia_turn_context_db_queries{phase="loader"}`.
 *   2. the fake client's own statement log, which cannot be fooled by a
 *      mis-wired Proxy.
 *
 * If the instrumentation ever stops seeing a statement, (1) and (2) diverge and
 * this file goes red — the counter is under test here too, not just trusted.
 *
 * ## What is NOT claimed
 *
 * The fake returns empty result sets for every table except `permissoes` and
 * `permission_profiles` (which must be non-empty for `resolveScope` to produce
 * a scope at all). Empty rows exercise the loader's real control flow and its
 * real statement count, but they say nothing about SQL CORRECTNESS — whether
 * each statement returns the right rows is proved against a real Postgres in
 * `tests/integration/turn-context-batch-repos.spec.ts` and
 * `tests/integration/turn-context-scope-cardinality.spec.ts`. This spec proves
 * the COUNT, and only the count.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  const rows: Record<string, Row[]> = {};
  return { statements: [] as string[], rows };
});

vi.mock('pg', () => {
  /**
   * Drizzle asks node-postgres for `rowMode: 'array'`, so a canned row has to
   * come back positionally, in the order of the compiled select list. Parsing
   * that list out of the SQL text keeps the fixtures column-name-keyed (and
   * therefore readable) while staying correct if the schema column order
   * changes.
   */
  function project(text: string): unknown[][] {
    const fromAt = text.indexOf(' from ');
    if (fromAt < 0) return [];
    // O drizzle sempre qualifica: cada campo do select sai como
    // `"tabela"."coluna"`. Ler o PAR (e não só o identificador entre aspas) é
    // o que mantém o dublê alinhado quando a consulta tem mais de uma tabela —
    // um JOIN, que é a forma da leitura de escopo desde que `resolveScope`
    // deixou de fazer duas idas em série.
    const campos = [...text.slice(0, fromAt).matchAll(/"([a-z_]+)"\."([a-z_]+)"/g)].map((m) => ({
      tabela: m[1]!,
      coluna: m[2]!,
    }));
    if (campos.length === 0) return [];
    const principal = campos[0]!.tabela;
    const linhas = h.rows[principal];
    if (!linhas || linhas.length === 0) return [];
    return linhas.map((linha) =>
      campos.map((c) => {
        // Do lado JUNTADO o dublê pareia com a PRIMEIRA linha canned da tabela —
        // suficiente para o número de statements, que é a única coisa que este
        // arquivo afirma. Se o JOIN casa as linhas CERTAS é provado contra um
        // Postgres de verdade em `tests/integration/turn-context-escopo-real-db.spec.ts`.
        const fonte = c.tabela === principal ? linha : h.rows[c.tabela]?.[0];
        return fonte?.[c.coluna] ?? null;
      }),
    );
  }

  class FakePgClient {
    async query(...args: unknown[]): Promise<unknown> {
      const first = args[0] as { text?: string } | string;
      const text = typeof first === 'string' ? first : (first?.text ?? '<unknown>');
      h.statements.push(text);
      return { rows: project(text), rowCount: 0, fields: [], command: 'SELECT' };
    }
    release(): void {}
  }

  class FakePgPool extends FakePgClient {
    on(): this {
      return this;
    }
    async connect(): Promise<FakePgClient> {
      return new FakePgClient();
    }
    async end(): Promise<void> {}
  }

  return { default: { Pool: FakePgPool }, Pool: FakePgPool };
});

const TENANT = { tenant_id: 'i525-tenant', agent_id: 'i525-agent' };

function mkPessoa(): Pessoa {
  return {
    id: 'pessoa-1',
    tenant_id: TENANT.tenant_id,
    agent_id: TENANT.agent_id,
    nome: 'Owner',
    apelido: null,
    telefone_whatsapp: '+5511999999999',
    tipo: 'dono',
    status: 'ativa',
    profile_id: null,
    metadata: {},
    created_at: new Date('2026-01-01T00:00:00Z'),
  } as unknown as Pessoa;
}

function mkConversa(): Conversa {
  return { id: 'conv-1', pessoa_id: 'pessoa-1', metadata: {} } as Conversa;
}

function mkInbound(): Mensagem {
  return {
    id: 'msg-inbound',
    conversa_id: 'conv-1',
    direcao: 'in',
    tipo: 'texto',
    conteudo: 'oi',
    ferramentas_chamadas: [],
    created_at: new Date('2026-05-11T15:00:00Z'),
  } as Mensagem;
}

/** `n` entity grants, all on ONE profile — the shape that makes scope size vary. */
function seedScopeRows(n: number): void {
  h.rows.permissoes = Array.from({ length: n }, (_, i) => ({
    id: `perm-${i}`,
    tenant_id: TENANT.tenant_id,
    agent_id: TENANT.agent_id,
    pessoa_id: 'pessoa-1',
    entidade_id: `ent-${i}`,
    papel: 'dono',
    profile_id: 'profile-0',
    acoes_permitidas: [],
    limites: {},
    status: 'ativa',
    created_at: new Date('2026-01-01T00:00:00Z'),
  }));
  h.rows.permission_profiles = [
    {
      id: 'profile-0',
      tenant_id: TENANT.tenant_id,
      agent_id: TENANT.agent_id,
      nome: 'profile-0',
      acoes: ['*'],
      limite_default: '1000',
      descricao: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
    },
  ];
}

/**
 * As tabelas que cada statement lê, com o APELIDO de cada uma quando há um.
 *
 * Case-insensitive e com aspas opcionais porque nem toda leitura é um query
 * builder do drizzle: `factsRepo.listMentionableForScopes` é SQL escrito à mão
 * (`FROM agent_facts af`, e um `NOT EXISTS` sobre `memory_entry me`). Um parser
 * que só entendesse a saída minúscula e entre aspas do drizzle jogaria essas
 * leituras no balde de "não parseado" — que é exatamente como uma leitura crua
 * duplicada ou sem escopo passaria despercebida pela checagem abaixo.
 */
type FonteLida = { tabela: string; apelido: string | null };

const PALAVRAS_DE_SINTAXE = new Set([
  'where',
  'on',
  'left',
  'inner',
  'union',
  'order',
  'limit',
  'group',
  'having',
]);

function fontesDe(sql: string): FonteLida[] {
  const fontes: FonteLida[] = [];
  const re = /\b(?:from|join)\s+"?([a-z_]+)"?(?:\s+(?:as\s+)?"?([a-z_]+)"?)?/gi;
  for (const m of sql.matchAll(re)) {
    const seguinte = (m[2] ?? '').toLowerCase();
    fontes.push({
      tabela: m[1]!.toLowerCase(),
      apelido: seguinte && !PALAVRAS_DE_SINTAXE.has(seguinte) ? seguinte : null,
    });
  }
  return fontes;
}

/** A tabela que cada statement lê primeiro — a forma legível do log. */
function tablesRead(): string[] {
  return h.statements.map((s) => fontesDe(s)[0]?.tabela ?? '<unparsed>');
}

/**
 * Run one whole turn — `resolveScope` + `buildPrompt`, the same two steps
 * `src/agent/core.ts` performs — inside the production query counter, and
 * return both tallies.
 */
async function measureTurn(entities: number): Promise<{ counted: number; logged: number }> {
  const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
  const { runWithQueryCounter } = await import('../../src/db/query-counter.js');
  const { resolveScope } = await import('../../src/governance/permissions.js');
  const { buildPrompt } = await import('../../src/agent/prompt-builder.js');

  seedScopeRows(entities);
  h.statements.length = 0;

  const counted = await runWithTenantContext(TENANT, async () =>
    runWithQueryCounter(async (counter) => {
      const pessoa = mkPessoa();
      const scope = await resolveScope(pessoa);
      await buildPrompt({
        pessoa,
        conversa: mkConversa(),
        scope,
        inbound: mkInbound(),
      });
      return counter.count;
    }),
  );

  return { counted, logged: h.statements.length };
}

describe('#525 turn round-trips, counted as SQL statements', () => {
  beforeEach(() => {
    h.statements.length = 0;
    for (const k of Object.keys(h.rows)) delete h.rows[k];
  });

  it('the whole turn issues exactly TURN_ROUND_TRIP_BUDGET statements', async () => {
    const { TURN_ROUND_TRIP_BUDGET } = await import('../../src/agent/turn-context/types.js');
    const { counted, logged } = await measureTurn(1);

    // The ceiling, in the unit the ceiling is written in.
    expect(counted).toBe(TURN_ROUND_TRIP_BUDGET);
    // …and the production counter saw every one of them.
    expect(counted).toBe(logged);
  });

  it('agrees with the repository-call count in turn-context-round-trips.spec.ts', async () => {
    // A spec irmã afirma 1 (`resolveScope`) + 11 (`buildPrompt`) = 12 CHAMADAS
    // de repositório. If any repository method ever issues two statements for
    // one call, that spec stays green and this one goes red — which is the
    // whole reason this file exists. One statement per read, no chunking, no
    // hidden pre-flight query.
    const { counted } = await measureTurn(1);
    expect(counted).toBe(12);
    // Doze statements, doze tabelas DIRIGENTES distintas — nenhum statement se
    // repete. O JOIN do escopo TOCA duas tabelas, então o total de tabelas
    // lidas é maior que doze; o que este `Set` afirma é a ausência de leitura
    // repetida, não o número de tabelas.
    expect(new Set(tablesRead()).size).toBe(counted);
  });

  it('reads each table exactly once — no duplicated statement', async () => {
    await measureTurn(1);
    const tables = tablesRead();
    const duplicated = tables.filter((t, i) => tables.indexOf(t) !== i);
    // The two cuts #525 made (the double gap read, and entities + states as two
    // statements) both showed up as a repeated table. Neither may come back,
    // and neither may be reintroduced inside a repository where the
    // repository-call count would not see it.
    expect(duplicated).toEqual([]);
    expect(tables).not.toContain('<unparsed>');
  });

  it('never exceeds the budget, and stays flat as the scope grows', async () => {
    const { TURN_ROUND_TRIP_BUDGET } = await import('../../src/agent/turn-context/types.js');
    const measured: number[] = [];
    for (const n of [1, 10, 100]) {
      const { counted, logged } = await measureTurn(n);
      expect(counted).toBe(logged);
      expect(counted).toBeLessThanOrEqual(TURN_ROUND_TRIP_BUDGET);
      measured.push(counted);
    }
    // Zero slope measured in statements: an "elephant" tenant's turn costs the
    // same as anyone else's against the fixed 10-connection pool.
    expect(measured).toEqual([12, 12, 12]);
  });

  it('rendering is worth zero statements', async () => {
    const { runWithTenantContext } = await import('../../src/db/tenant-context.js');
    const { resolveScope } = await import('../../src/governance/permissions.js');
    const { renderTurnPrompt } = await import('../../src/agent/prompt-builder.js');
    const { loadTurnContext } = await import('../../src/agent/turn-context/loader.js');

    seedScopeRows(3);
    const pessoa = mkPessoa();
    const ctx = await runWithTenantContext(TENANT, async () => {
      const scope = await resolveScope(pessoa);
      const snapshot = await loadTurnContext({
        pessoa_id: pessoa.id,
        conversa_id: 'conv-1',
        entidade_ids: scope.entidades,
        activeExecution: null,
      });
      return { scope, snapshot };
    });

    h.statements.length = 0;
    const { system } = renderTurnPrompt(
      { pessoa, conversa: mkConversa(), scope: ctx.scope, inbound: mkInbound() },
      ctx.snapshot,
    );

    // Not "no repository was called" (the sibling spec proves that) but "no SQL
    // reached the driver" — the strongest form of the claim.
    expect(h.statements).toEqual([]);
    expect(system).toContain('## Escopo desta conversa');
  });

  /**
   * AGENTS.md §4.1/§4.2, checked in the compiled SQL rather than in a mock.
   *
   * `npm run test:leak` proves isolation by ASKING a repository for another
   * tenant's ids against a real Postgres — the right test, and it needs a
   * database, so it does not run in the unit lane. This is the complementary
   * cheap check: the turn's read set is fully materialised here as SQL text, so
   * a read that simply forgot its `tenant_id`/`agent_id` predicate is visible
   * without any database at all. It cannot replace the integration suite (it
   * says nothing about whether the predicate binds the RIGHT value), but it
   * fails in the unit lane, on every push, the moment a turn read is added
   * without scoping.
   */
  it('every table read by the turn is scoped by tenant_id AND agent_id', async () => {
    await measureTurn(1);
    expect(h.statements).toHaveLength(12);

    // POR TABELA, não por statement. Um statement que lê duas tabelas — o JOIN
    // do escopo, e o `NOT EXISTS` dos fatos — passaria com folga numa checagem
    // por statement: bastava UMA das metades carregar o predicado. Aqui cada
    // tabela que aparece num FROM/JOIN precisa do próprio par, pelo nome ou
    // pelo apelido com que a consulta a chama.
    const semEscopo: string[] = [];
    for (const sql of h.statements) {
      for (const { tabela, apelido } of fontesDe(sql)) {
        const nomes = [`"${tabela}"\\."`, apelido ? `\\b${apelido}\\.` : null].filter(
          (n): n is string => n !== null,
        );
        const tem = (coluna: string): boolean =>
          nomes.some((n) => new RegExp(`${n}${coluna}"?\\s*=`, 'i').test(sql));
        if (!tem('tenant_id') || !tem('agent_id')) semEscopo.push(tabela);
      }
    }

    expect(semEscopo).toEqual([]);
    expect(tablesRead()).not.toContain('<unparsed>');

    // …e o exame realmente alcança as tabelas que NÃO dirigem o statement. Sem
    // esta asserção, alguém poderia afrouxar `fontesDe` para achar só a
    // primeira tabela e o teste acima continuaria verde enquanto metade do
    // conjunto de leituras saía do exame.
    const tabelas = h.statements.flatMap((sql) => fontesDe(sql).map((f) => f.tabela));
    expect(tabelas.length).toBeGreaterThan(h.statements.length);
    expect(new Set(tabelas)).toContain('permission_profiles');
    expect(new Set(tabelas)).toContain('entity_states');
    expect(new Set(tabelas)).toContain('memory_entry');
  });

  it('the measured count IS the declared budget — the count survives as guardrail, not goal', async () => {
    const { TURN_ROUND_TRIP_BUDGET } = await import('../../src/agent/turn-context/types.js');
    const { counted } = await measureTurn(1);
    // Measured, not estimated: the turn really costs 12 statements (this
    // change fused the two scope reads into one). Since the
    // #525 owner decision (2026-09-02) this number is a GUARDRAIL against
    // silent growth (a new read must change the budget in the same diff), not
    // a distance to a ≤8 goal — that goal was retired; the acceptance
    // criterion is latency, judged by the gate (`npm run turn:bench`).
    expect(counted).toBe(TURN_ROUND_TRIP_BUDGET);
  });
});
