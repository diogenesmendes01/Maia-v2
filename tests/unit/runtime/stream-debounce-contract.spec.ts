/**
 * Issue #628 (fatia E da #505) — o CONTRATO do debounce transacional.
 *
 * A issue faz quatro exigências que nenhum compilador cobra:
 *
 *   1. *"nenhum timer em memória é fonte de verdade"* — o prazo tem de ser
 *      comparado com o relógio do BANCO, e o único jeito de garantir isso por
 *      teste barato é provar que o SQL diz `now()` e que nenhum `Date.now()`
 *      decide fechamento;
 *   2. *"fechamento único do batch"* — o UPDATE tem de carregar
 *      `debounce_closed_at IS NULL`;
 *   3. *"lock transacional, `FOR UPDATE SKIP LOCKED` onde couber"* — e o "onde
 *      couber" é a parte perigosa: `SKIP LOCKED` na ELEIÇÃO DO HEAD elegeria o
 *      segundo turno da fila como se fosse o primeiro;
 *   4. *"a borda escolhida está escrita"* — e escrita como CÓDIGO, não como
 *      prosa.
 *
 * Puro: compila o SQL com `PgDialect` (sem banco), lê a migration como TEXTO e
 * os módulos de produção como TEXTO-FONTE. Nada aqui precisa de Postgres — que
 * é o ponto: um teste de integração que não roda não prova nada.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { TERMINAL_TURN_STATUSES, TURN_TRANSITIONS } from '@/runtime/turns/contract.js';
import { STREAM_DEBOUNCE_CLOSE_RESULTS, METRIC } from '@/observability/taxonomy.js';
import { AUDIT_ACTIONS } from '@/governance/audit-actions.js';
import {
  debounceBatchPrefix,
  debounceDeadlineExpression,
  debounceWindowDue,
  lockStreamForDebounce,
  openDebounceWindowMembers,
} from '@/db/repositories/stream-debounce-sql.js';

const raiz = resolve(__dirname, '../../..');
const migracao = readFileSync(
  resolve(raiz, 'migrations/130_agent_turns_debounce_window.sql'),
  'utf8',
);
const migracaoDown = readFileSync(
  resolve(raiz, 'migrations/130_agent_turns_debounce_window_down.sql'),
  'utf8',
);
const repoFonte = readFileSync(resolve(raiz, 'src/db/repositories/turn-repos.ts'), 'utf8');
const runtimeFonte = readFileSync(resolve(raiz, 'src/runtime/turns/stream-debounce.ts'), 'utf8');
const workerFonte = readFileSync(resolve(raiz, 'src/workers/stream-debounce-closer.ts'), 'utf8');
const puroFonte = readFileSync(
  resolve(raiz, 'src/db/repositories/stream-debounce-sql.ts'),
  'utf8',
);

const dialeto = new PgDialect();
const compilar = (fragmento: ReturnType<typeof sql>): string =>
  dialeto.sqlToQuery(fragmento).sql;

const escopo = {
  tenant: sql`${'t-1'}`,
  agent: sql`${'a-1'}`,
  stream_key: sql`${'v1:abc'}`,
};

/** O código do repositório sem comentários — o que EXECUTA, não o que explica. */
const codigoDoRepo = repoFonte
  .split('\n')
  .filter((l) => !/^\s*(\*|\/\/)/.test(l))
  .join('\n');

/**
 * As DUAS funções da fatia, recortadas do repositório: `armDebounceWindowTx` e
 * `closeDueDebounceBatchTx`. As asserções sobre relógio precisam falar delas, e
 * não do arquivo inteiro — `findRecoverableTurns` usa `Date.now()` para o
 * cutoff de staleness do recovery desde a #503, e isso não decide batch nenhum.
 */
const codigoDoDebounce = (() => {
  const inicio = codigoDoRepo.indexOf('async function armDebounceWindowTx');
  const fim = codigoDoRepo.indexOf('function recoveryReasonFor');
  return codigoDoRepo.slice(inicio, fim > inicio ? fim : undefined);
})();

describe('#628 — contrato do debounce transacional', () => {
  // ─── O RELÓGIO PERSISTENTE ───────────────────────────────────────────────

  it('a autorização de fechar compara com `now()` do BANCO, nunca com um timestamp de parâmetro', () => {
    const texto = compilar(debounceWindowDue(sql`p`));
    expect(texto).toMatch(/p\.debounce_deadline_at\s*<=\s*now\(\)/);
    // Um `$1` aqui significaria que quem decidiu o vencimento foi o relógio do
    // PROCESSO, e o skew entre réplicas passaria a decidir qual delas fecha.
    expect(texto).not.toMatch(/debounce_deadline_at\s*<=\s*\$\d/);
  });

  it('o prazo é LEAST(agora + janela, abertura + teto) — o teto vence, e é ancorado no PERSISTIDO', () => {
    const texto = compilar(
      debounceDeadlineExpression({
        opened_at: sql`abertura.at`,
        delay_ms: 5_000,
        max_hold_ms: 30_000,
      }),
    );
    expect(texto).toContain('LEAST');
    expect(texto).toContain('now() + make_interval');
    expect(texto).toContain('abertura.at + make_interval');
    // `GREATEST` inverteria o teto: um usuário que digitasse sem parar adiaria
    // a resposta para sempre, que é exatamente o que `MESSAGE_DEBOUNCE_MAX_MS`
    // existe para impedir.
    expect(texto).not.toContain('GREATEST');
    // Os intervalos entram PARAMETRIZADOS: interpolar milissegundos no texto do
    // SQL faria de uma variável de configuração um pedaço de sintaxe.
    expect(texto).not.toContain('5');
    expect(texto).toMatch(/\$\d+::double precision/);
  });

  it('nenhum `Date.now()` decide fechamento no repositório nem no varredor', () => {
    // A frase da issue é "nenhum timer em memória é fonte de verdade". O
    // varredor PODE usar `Date.now()` para o próprio orçamento de drenagem —
    // isso não decide nada sobre nenhum batch — mas nunca para comparar prazo.
    expect(codigoDoDebounce.length).toBeGreaterThan(1000);
    expect(codigoDoDebounce).not.toContain('Date.now()');
    const decisoes = workerFonte
      .split('\n')
      .filter((l) => l.includes('Date.now()') && !/^\s*(\*|\/\/)/.test(l));
    for (const linha of decisoes) {
      expect(linha).toMatch(/deadline|Date\.now\(\) \+ DRAIN_BUDGET_MS/);
      expect(linha).not.toMatch(/debounce_deadline|due/);
    }
  });

  // ─── O FECHAMENTO ÚNICO ──────────────────────────────────────────────────

  it('o UPDATE que fecha exige `debounce_closed_at IS NULL` — o CAS, não a convenção', () => {
    // Sem esta condição, duas réplicas que passassem pelo mutex em sequência
    // fechariam o mesmo batch duas vezes: a segunda reabriria o head já
    // enfileirado e reabsorveria irmãos já `superseded`.
    expect(codigoDoDebounce).toMatch(
      /debounce_batch_size = \$\{[\s\S]{0,900}debounce_closed_at IS NULL/,
    );
  });

  it('o fechamento também exige a `state_version` lida — CAS contra o executor do próprio turno', () => {
    expect(codigoDoDebounce).toMatch(/u\.state_version = \$\{Number\(head\.state_version\)\}/);
  });

  // ─── O LOCK, e ONDE ele pode ser SKIP LOCKED ─────────────────────────────

  it('o mutex da stream é a linha de `agent_stream_sequences`, com SKIP LOCKED', () => {
    // A MESMA linha que `allocateIngressSeq` tranca para alocar `ingress_seq`.
    // É daí que sai a impossibilidade de lacuna: enquanto um ingresso está em
    // voo, o fechador não enxerga a stream pela metade — ele nem começa.
    const texto = compilar(lockStreamForDebounce(escopo));
    expect(texto).toContain('agent_stream_sequences');
    expect(texto).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('a eleição do batch NÃO usa SKIP LOCKED — pular a linha trancada elegeria o segundo como head', () => {
    // ESTA é a asserção que mais importa do arquivo. Com
    // `ORDER BY first_ingress_seq`, um `SKIP LOCKED` na CTE de lock faria o
    // batch fechar por cima do head — respondendo M2 antes de M1, que é a
    // falha nº 1 da issue-mãe produzida pela própria agregação.
    const texto = compilar(debounceBatchPrefix(escopo));
    expect(texto).toContain('FOR UPDATE OF t');
    expect(texto).not.toContain('SKIP LOCKED');
  });

  it('a CTE de lock vem SEPARADA da numeração — o PostgreSQL recusa FOR UPDATE com função de janela', () => {
    const texto = compilar(debounceBatchPrefix(escopo));
    const posLock = texto.indexOf('FOR UPDATE OF t');
    const posJanela = texto.indexOf('ROW_NUMBER');
    expect(posLock).toBeGreaterThan(-1);
    expect(posJanela).toBeGreaterThan(-1);
    // O lock acontece ANTES (CTE `travados`); a numeração roda sobre o conjunto
    // já trancado. Se alguém as fundir, o Postgres devolve
    // "FOR UPDATE is not allowed with window functions" — em produção, na
    // primeira rajada.
    expect(posLock).toBeLessThan(posJanela);
    expect(texto).toContain('travados');
  });

  it('a ordem de AQUISIÇÃO do lock é por `id`, para que duas transações não fechem ciclo', () => {
    const texto = compilar(debounceBatchPrefix(escopo));
    expect(texto).toMatch(/ORDER BY t\.id\s+FOR UPDATE OF t/);
  });

  // ─── A BORDA: o prefixo contíguo ─────────────────────────────────────────

  it('o batch é um PREFIXO CONTÍGUO: a quebra é detectada por LAG e corta o resto', () => {
    const texto = compilar(debounceBatchPrefix(escopo));
    expect(texto).toContain('LAG');
    expect(texto).toMatch(/first_ingress_seq <> c\.anterior_last \+ 1/);
    // `MIN(rn)` + `rn <` é o que faz a quebra cortar o PREFIXO, e não só a
    // linha: filtrar linha a linha devolveria um conjunto ESPARSO, absorvendo
    // o candidato 4 mesmo com a quebra no 2 — exatamente a lacuna que a issue
    // proíbe absorver silenciosamente.
    expect(texto).toContain('MIN(c.rn)');
    expect(texto).toMatch(/c\.rn < COALESCE/);
  });

  it('a ordem do batch é `first_ingress_seq`, nunca `created_at`', () => {
    const texto = compilar(debounceBatchPrefix(escopo));
    expect(texto).toMatch(/ORDER BY t\.first_ingress_seq/);
    expect(texto).not.toContain('created_at');
  });

  it('mídia nunca é membro: o conjunto exige `debounce_window_opened_at` carimbado', () => {
    // O ingresso só carimba a janela para `tipo = 'texto'` (ver
    // `createReceivedTurnTx`). Um turno de áudio no meio da rajada fica de FORA
    // do conjunto e portanto ABRE UMA LACUNA numérica — que o corte de
    // contiguidade transforma em "o batch fecha aqui".
    const texto = compilar(openDebounceWindowMembers({ ...escopo, alvo: sql`t` }));
    expect(texto).toContain('t.debounce_window_opened_at IS NOT NULL');
    expect(texto).toContain('t.debounce_closed_at IS NULL');
    expect(repoFonte).toMatch(/tipo === 'texto'/);
  });

  it('o conjunto é ESCOPADO por tenant_id e agent_id — não só pela stream_key', () => {
    // A `stream_key` embute tenant e agent no material canônico, mas embutir
    // não é escopar: uma colisão de hash faria o batch de um tenant absorver a
    // rajada de outro. A issue-mãe trata colisão de stream como risco de
    // SEGURANÇA, não de qualidade.
    const texto = compilar(openDebounceWindowMembers({ ...escopo, alvo: sql`t` }));
    expect(texto).toMatch(/t\.tenant_id\s*=\s*\$\d/);
    expect(texto).toMatch(/t\.agent_id\s*=\s*\$\d/);
  });

  it('os terminais entram como LITERAIS, não como parâmetros', () => {
    // Mesma razão de `stream-head-sql.ts`: o PostgreSQL só usa um índice
    // PARCIAL quando PROVA que a cláusula implica o predicado, e a prova é
    // sobre `Const`.
    const texto = compilar(openDebounceWindowMembers({ ...escopo, alvo: sql`t` }));
    for (const terminal of TERMINAL_TURN_STATUSES) {
      expect(texto).toContain(`'${terminal}'`);
    }
  });

  it('o conjunto de membros tem UMA definição — o armador e o fechador chamam a mesma função', () => {
    // Duas cópias fariam o armador e o fechador discordarem sobre quem está na
    // janela, e a discordância se manifesta como um turno com prazo que ninguém
    // fecha. As DUAS chamadas do repositório (arm + prefix) mais a de dentro do
    // próprio módulo puro.
    // No repositório a função aparece UMA vez — em `armDebounceWindowTx`. O
    // fechador não a chama direto: ele chama `debounceBatchPrefix`, que a usa
    // por dentro. É por isso que o armador e o fechador não podem divergir.
    const chamadasNoRepo = codigoDoRepo.match(/openDebounceWindowMembers\(/g) ?? [];
    expect(chamadasNoRepo.length).toBe(1);
    expect(codigoDoDebounce).toContain('debounceBatchPrefix(');
    const chamadasNoPuro = puroFonte
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join('\n')
      .match(/openDebounceWindowMembers\(/g) ?? [];
    // A definição + os dois usos internos (a CTE de lock e a de candidatos).
    expect(chamadasNoPuro.length).toBe(3);
  });

  it('o repositório NÃO tem uma segunda cópia do predicado de contiguidade', () => {
    // A forma que a divergência tomaria: alguém escreve o `LAG`/`ROW_NUMBER`
    // inline "só desta vez". A borda inteira vive em `stream-debounce-sql.ts`.
    expect(codigoDoRepo).not.toContain('LAG(');
    expect(codigoDoRepo).not.toContain('anterior_last');
    expect(codigoDoRepo).not.toContain('ROW_NUMBER() OVER (ORDER BY t.first_ingress_seq)');
  });

  // ─── As transições que a absorção usa ────────────────────────────────────

  it('`received -> superseded` e `queued -> superseded` continuam sendo arestas do contrato', () => {
    // O fechamento marca os irmãos `superseded` sem passar por
    // `transitionTurn` (o conjunto só é conhecido dentro da transação), mas o
    // par (from, to) continua sendo do contrato. Removê-las tornaria o
    // fechamento uma transição ilegal escrita à mão.
    expect(TURN_TRANSITIONS.received).toContain('superseded');
    expect(TURN_TRANSITIONS.queued).toContain('superseded');
  });

  it('o irmão absorvido recebe `merged_into_turn` e aponta para o head', () => {
    expect(codigoDoDebounce).toMatch(/status\s*=\s*'superseded'/);
    expect(codigoDoDebounce).toMatch(/outcome\s*=\s*'merged_into_turn'/);
    expect(codigoDoDebounce).toMatch(/superseded_by_turn_id = \$\{headFechado\.id\}::uuid/);
  });

  it('o head fechado carimba `promoted_at` — a reconciliação reusa o caminho da #627', () => {
    // Fechar o batch É eleger quem avança, e o sinal sai DEPOIS do commit.
    // Sem `promoted_at`, um crash entre os dois deixaria o batch fechado e
    // ninguém acordado, e o varredor não teria como distinguir isso de um turno
    // `queued` de rotina.
    expect(codigoDoDebounce).toMatch(
      /promoted_at\s*=\s*now\(\)[\s\S]{0,900}debounce_closed_at IS NULL/,
    );
  });

  // ─── Vocabulário e observabilidade ───────────────────────────────────────

  it('os cinco desfechos do fechamento são fechados e espelham o tipo do repositório', () => {
    expect([...STREAM_DEBOUNCE_CLOSE_RESULTS].sort()).toEqual(
      ['closed', 'lost_race', 'no_window', 'not_due', 'stream_locked'].sort(),
    );
    expect(new Set(STREAM_DEBOUNCE_CLOSE_RESULTS).size).toBe(STREAM_DEBOUNCE_CLOSE_RESULTS.length);
    for (const reason of ['stream_locked', 'no_window', 'not_due', 'lost_race']) {
      expect(repoFonte).toContain(`'${reason}'`);
    }
  });

  it('a métrica que a issue nomeia existe com o nome EXATO', () => {
    expect(METRIC.STREAM_DEBOUNCE_BATCH_SIZE).toBe('maia_stream_debounce_batch_size');
  });

  it('a auditoria `stream_batch_closed` está no vocabulário fechado', () => {
    expect(AUDIT_ACTIONS).toContain('stream_batch_closed');
  });

  it('nenhum label de métrica carrega stream_key, turn_id ou telefone', () => {
    // A issue-mãe proíbe explicitamente, e são justamente as dimensões cuja
    // cardinalidade cresce com o TRÁFEGO.
    const emitidas = runtimeFonte
      .split('\n')
      .filter((l) => l.includes('incCounter(') || l.includes('observeHistogram('));
    for (const linha of emitidas) {
      expect(linha).not.toMatch(/stream_key|turn_id|telefone|remote_jid/);
    }
  });

  // ─── A conjunção das flags, nos DOIS lugares onde ela existe ─────────────

  it('o repositório e o runtime exigem as MESMAS três flags', () => {
    // A duplicação é deliberada (o repositório não pode importar o runtime —
    // fronteira do console, #596), então o que impede a divergência é esta
    // asserção. Uma flag a menos de um lado significaria, por exemplo, o
    // ingresso abrindo janela que o varredor nunca fecha.
    for (const fonte of [repoFonte, runtimeFonte]) {
      expect(fonte).toContain('FEATURE_TURN_STREAM_DEBOUNCE');
      expect(fonte).toContain('FEATURE_MESSAGE_DEBOUNCE');
    }
    // No repositório o head-of-line entra pelo helper `headOfLineEnabled()`.
    expect(repoFonte).toMatch(/debouncePersistidoAtivo[\s\S]{0,600}headOfLineEnabled\(\)/);
    expect(runtimeFonte).toContain('FEATURE_TURN_HEAD_OF_LINE');
  });

  // ─── A migration ─────────────────────────────────────────────────────────

  it('a migration cria as quatro colunas e o índice parcial cross-tenant', () => {
    for (const coluna of [
      'debounce_window_opened_at',
      'debounce_deadline_at',
      'debounce_closed_at',
      'debounce_batch_size',
    ]) {
      expect(migracao).toContain(coluna);
      expect(migracaoDown).toContain(coluna);
    }
    expect(migracao).toMatch(
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS agent_turns_debounce_due_idx\s+ON agent_turns \(debounce_deadline_at\)/,
    );
    // O predicado tira do índice tudo que não é janela ABERTA — é o que faz o
    // índice ENCOLHER quando o batch fecha, em vez de crescer com o tráfego.
    expect(migracao).toMatch(
      /WHERE debounce_deadline_at IS NOT NULL AND debounce_closed_at IS NULL/,
    );
  });

  it('é CONCURRENTLY nos dois sentidos e os dois arquivos carregam o marcador no-transaction', () => {
    expect(migracao).toMatch(/^--\s*maia:no-transaction/m);
    expect(migracaoDown).toMatch(/^--\s*maia:no-transaction/m);
    expect(migracaoDown).toContain('DROP INDEX CONCURRENTLY');
  });

  it('o `_down` derruba o ÍNDICE antes das COLUNAS', () => {
    // Sem envelope de transação (CONCURRENTLY o proíbe), a ordem é a única
    // proteção: morrer entre os dois deixa "colunas sem índice", que é
    // funcional e que reexecutar conserta.
    expect(migracaoDown.indexOf('DROP INDEX')).toBeLessThan(
      migracaoDown.indexOf('DROP COLUMN'),
    );
  });

  it('nenhum literal dos arquivos no-transaction contém `;` (o runner quebra por `;`)', () => {
    for (const arquivo of [migracao, migracaoDown]) {
      const semComentarios = arquivo
        .split('\n')
        .map((l) => l.replace(/--.*$/, ''))
        .join('\n');
      for (const literal of semComentarios.match(/'[^']*'/g) ?? []) {
        expect(literal).not.toContain(';');
      }
    }
  });
});
