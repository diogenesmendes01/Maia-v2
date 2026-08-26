/**
 * Issue #627 (fatia D da #505) — o CONTRATO da promoção do sucessor.
 *
 * O que este arquivo cobra, e que nenhum compilador cobra:
 *
 *   1. `promoted` — o código que a #626 reservou SEM produtor — é produzido, e
 *      é produzido pelo mesmo nome nos dois vocabulários (escalonamento e
 *      promoção). Um segundo nome para o mesmo fato é a divergência que a
 *      fatia C fechou na dimensão da ordem, repetida na dimensão da promoção;
 *   2. as arestas que a promoção usa (`received -> queued`,
 *      `retryable -> queued`) EXISTEM na tabela de transições. A promoção
 *      escreve `status` sem passar pelo CAS genérico (como o claim e a
 *      recuperação de #625), então o contrato precisa ser afirmado de fora —
 *      senão alguém remove a aresta, a promoção continua funcionando, e o
 *      estado da máquina passa a ter um caminho que o contrato nega;
 *   3. a eleição do sucessor mora em `stream-head-sql.ts` (o dono da ordem) e
 *      compila para o SQL esperado — `ORDER BY first_ingress_seq LIMIT 1` com
 *      `FOR UPDATE`, escopado por tenant e agent;
 *   4. a migration 127 declara as duas colunas e o `_down` as derruba DENTRO de
 *      um envelope de transação (o runner é autocommit por statement: sem
 *      envelope, um `_down` que falha no segundo statement deixa o primeiro
 *      comitado — rollback pela metade).
 *
 * Puro: compila SQL com `PgDialect` (sem banco) e lê a migration como TEXTO.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  STREAM_PROMOTION_RESULTS,
  STREAM_SCHEDULING_RESULTS,
} from '@/runtime/turns/claim.js';
import {
  TERMINAL_TURN_STATUSES,
  TURN_TRANSITIONS,
  type TurnStatus,
} from '@/runtime/turns/contract.js';
import { streamSuccessorCandidate } from '@/db/repositories/stream-head-sql.js';

const raiz = resolve(__dirname, '../../..');
const migracao = readFileSync(
  resolve(raiz, 'migrations/127_agent_turns_stream_promotion.sql'),
  'utf8',
);
const migracaoDown = readFileSync(
  resolve(raiz, 'migrations/127_agent_turns_stream_promotion_down.sql'),
  'utf8',
);
const repoFonte = readFileSync(resolve(raiz, 'src/db/repositories/turn-repos.ts'), 'utf8');

/** O SQL de verdade: sem os comentários, que aqui falam sobre o que NÃO se faz. */
const semComentarios = (arquivo: string): string =>
  arquivo
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

const dialeto = new PgDialect();
const compilar = (fragmento: ReturnType<typeof sql>): string => dialeto.sqlToQuery(fragmento).sql;

const eleicao = compilar(
  streamSuccessorCandidate({
    tenant: sql`${'t-1'}`,
    agent: sql`${'a-1'}`,
    predecessor_turn_id: 'pred-1',
  }),
);

describe('#627 — contrato da promoção do sucessor', () => {
  // ─── 1. O vocabulário, e o código que a fatia C reservou ─────────────────

  it('`promoted` deixou de ser um código sem produtor', () => {
    // A #626 pôs `promoted` em `STREAM_SCHEDULING_RESULTS` deliberadamente sem
    // produtor, para não mudar o domínio de um label depois que ele estivesse
    // num dashboard. Esta fatia é quem o produz — e o produz com o MESMO nome.
    expect(STREAM_SCHEDULING_RESULTS).toContain('promoted');
    expect(STREAM_PROMOTION_RESULTS).toContain('promoted');
    // A tabela de produtores do vocabulário deixou de dizer "ninguém ainda".
    const claimFonte = readFileSync(resolve(raiz, 'src/runtime/turns/claim.ts'), 'utf8');
    expect(claimFonte).not.toMatch(/\|\s*`promoted`\s*\|\s*\*\*ninguém ainda\*\*/);
    expect(claimFonte).toMatch(/\|\s*`promoted`\s*\|\s*`promoteStreamSuccessor`/);
  });

  it('os desfechos da promoção são fechados, únicos e cobrem o que a issue pede', () => {
    // A issue: "`maia_stream_promotion_total{result}` cobre promoção, rejeição
    // por fence e recuperação". Os outros dois existem porque, sem eles, os
    // três primeiros são ilegíveis — ver o comentário da constante.
    expect([...STREAM_PROMOTION_RESULTS].sort()).toEqual(
      ['enqueue_failed', 'fence_rejected', 'no_successor', 'promoted', 'recovered'].sort(),
    );
    expect(new Set(STREAM_PROMOTION_RESULTS).size).toBe(STREAM_PROMOTION_RESULTS.length);
  });

  it('`promoted` é o ÚNICO código compartilhado entre os dois vocabulários', () => {
    // Se `fence_rejected` (ou qualquer outro) vazasse para o vocabulário de
    // escalonamento, `maia_stream_blocked_total` e `maia_turn_claim_total`
    // passariam a poder carregar um label que não é recusa de claim — e o
    // domínio dos dois deixaria de ser afirmável.
    const compartilhados = STREAM_PROMOTION_RESULTS.filter((r) =>
      (STREAM_SCHEDULING_RESULTS as readonly string[]).includes(r),
    );
    expect(compartilhados).toEqual(['promoted']);
  });

  // ─── 2. As arestas que a promoção percorre ──────────────────────────────

  it('as arestas da promoção existem na tabela de transições', () => {
    // A promoção escreve `status = queued` fora do CAS genérico, pela mesma
    // razão do claim e da recuperação de #625: não se sabe QUEM é o sucessor
    // antes de olhar. O par (from, to) continua sendo do contrato, e é aqui que
    // isso é cobrado — remover a aresta deixaria a promoção escrevendo uma
    // transição que a máquina de estados nega.
    const destinos = (from: TurnStatus): readonly string[] =>
      (TURN_TRANSITIONS[from] ?? []).map((t) => (typeof t === 'string' ? t : t.to));
    expect(destinos('received')).toContain('queued');
    expect(destinos('retryable')).toContain('queued');
  });

  it('a promoção nunca elege um turno TERMINAL', () => {
    // O `NOT IN` da eleição é escrito com os terminais do contrato como
    // literais (mesma razão da #626: o índice parcial só é usado quando o
    // planejador PROVA a implicação, e a prova é sobre `Const`).
    for (const terminal of TERMINAL_TURN_STATUSES) {
      expect(eleicao).toContain(`'${terminal}'`);
    }
    expect(eleicao).toMatch(/s\.status NOT IN \(/);
  });

  // ─── 3. A eleição ───────────────────────────────────────────────────────

  it('elege o MENOR first_ingress_seq da stream, e só um', () => {
    // `ORDER BY ... LIMIT 1` não é otimização: é a definição de "próximo". Sem
    // o `ORDER BY`, o PostgreSQL devolveria qualquer um dos vivos — e a
    // promoção furaria a fila que a fatia C acabou de impor.
    expect(eleicao).toMatch(/ORDER BY s\.first_ingress_seq\s+LIMIT 1/);
  });

  it('tranca a linha eleita (FOR UPDATE) — "exatamente um sucessor" é do banco', () => {
    // Duas conclusões simultâneas da mesma stream elegeriam o mesmo sucessor.
    // O lock serializa: a segunda espera e re-avalia o `WHERE` do UPDATE contra
    // a linha nova (EvalPlanQual), e não casa mais.
    expect(eleicao).toMatch(/FOR UPDATE OF s/);
  });

  it('a eleição é ESCOPADA por tenant_id e agent_id, dos dois lados', () => {
    // A `stream_key` embute tenant e agent no material canônico, mas embutir
    // não é escopar: numa colisão de hash, o turno de uma tenant seria promovido
    // pela conclusão de outra. A issue-mãe trata colisão de stream como risco de
    // SEGURANÇA.
    expect(eleicao).toMatch(/s\.tenant_id\s*=\s*\$\d/);
    expect(eleicao).toMatch(/s\.agent_id\s*=\s*\$\d/);
    expect(eleicao).toMatch(/pred\.tenant_id\s*=\s*\$\d/);
    expect(eleicao).toMatch(/pred\.agent_id\s*=\s*\$\d/);
  });

  it('a eleição NÃO restringe o sucessor a sequências MAIORES que a do predecessor', () => {
    // A tentação é "o próximo depois de mim", e ela é um bug silencioso: um
    // turno não terminal com sequência MENOR (backfill, replay, irmão absorvido
    // fora de ordem) ficaria invisível para sempre e a stream avançaria por
    // cima dele. A eleição é ABSOLUTA — o menor vivo da stream.
    expect(eleicao).not.toMatch(/s\.first_ingress_seq\s*>\s*pred\.first_ingress_seq/);
  });

  it('o repositório NÃO tem uma segunda cópia da regra de posição', () => {
    // Mesma guarda da #626, aplicada à fatia nova: a comparação entre a
    // sequência de DOIS turnos só pode existir em `stream-head-sql.ts`.
    const codigo = repoFonte
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join('\n');
    expect(codigo).not.toMatch(/first_ingress_seq\s*[<>]\s*\S*\.?first_ingress_seq/);
  });

  // ─── 4. A migration ─────────────────────────────────────────────────────

  it('a 127 declara as duas colunas da decisão persistida', () => {
    expect(migracao).toMatch(/ADD COLUMN IF NOT EXISTS promoted_at timestamptz/);
    expect(migracao).toMatch(/ADD COLUMN IF NOT EXISTS promoted_by_turn_id uuid/);
  });

  it('a 127 NÃO usa CONCURRENTLY — e por isso não herda a armadilha da #658', () => {
    // Um `CREATE INDEX CONCURRENTLY` que falha deixa o índice
    // `indisvalid = false`, e reaplicar o arquivo devolve exit 0: o runner marca
    // a migration como aplicada SEM o índice. Esta migration não cria índice
    // nenhum, então o modo de falha não existe aqui — e afirmar isso impede que
    // alguém acrescente um índice CONCURRENTLY neste arquivo sem o marcador
    // `maia:no-transaction` (que brigaria com o envelope BEGIN/COMMIT abaixo).
    expect(semComentarios(migracao)).not.toContain('CONCURRENTLY');
    expect(migracao).not.toMatch(/^--\s*maia:no-transaction/m);
  });

  it('as DUAS pontas têm envelope BEGIN/COMMIT explícito', () => {
    // O runner aplica com `psql -v ON_ERROR_STOP=1 -f`, que é AUTOCOMMIT POR
    // STATEMENT. Sem envelope, um arquivo de dois statements que falha no
    // segundo deixa o primeiro comitado — e num `_down` isso é um rollback pela
    // metade, a forma mais cara de fail-open que existe.
    for (const arquivo of [migracao, migracaoDown]) {
      expect(arquivo).toMatch(/^BEGIN;$/m);
      expect(arquivo).toMatch(/^COMMIT;$/m);
    }
  });

  it('o `_down` derruba as duas colunas, e é idempotente', () => {
    expect(migracaoDown).toMatch(/DROP COLUMN IF EXISTS promoted_by_turn_id/);
    expect(migracaoDown).toMatch(/DROP COLUMN IF EXISTS promoted_at/);
  });
});
