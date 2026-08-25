/**
 * Issue #626 (fatia C da #505) — o CONTRATO do head-of-line, nos quatro lugares
 * onde ele existe ao mesmo tempo, e a prova de que a regra tem UMA definição.
 *
 * A issue faz duas exigências que nenhum compilador cobra:
 *
 *   1. "**Uma única função de repositório** — `claimNextEligibleTurn` — em vez
 *      de lógica duplicada entre worker e recovery. Duas cópias da regra de
 *      elegibilidade divergem, e a divergência só aparece durante um recovery."
 *   2. "**Códigos de resultado centralizados**: `not_head`, `stream_busy`,
 *      `eligible`, `stream_blocked`, `promoted`."
 *
 * Divergir não produz erro de compilação nem falha óbvia de integração: produz
 * uma conversa que responde fora de ordem, meses depois, num caminho que
 * ninguém relaciona à edição. Este arquivo é barato e é o que faz a divergência
 * doer no minuto em que ela é escrita.
 *
 * Puro: compila o SQL com `PgDialect` (sem banco), lê a migration como TEXTO e
 * o repositório como TEXTO-FONTE. Nada aqui precisa de Postgres.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  CLAIM_REJECTIONS,
  STREAM_BLOCKED_REASONS,
  STREAM_FIFO_VIOLATION_STAGES,
  STREAM_HEAD_OF_LINE_INDEX,
  STREAM_SCHEDULING_RESULTS,
} from '@/runtime/turns/claim.js';
import { TERMINAL_TURN_STATUSES } from '@/runtime/turns/contract.js';
import {
  earlierLiveTurnCount,
  earlierLiveTurnProbe,
  streamHeadOfLineNotExists,
} from '@/db/repositories/stream-head-sql.js';

const raiz = resolve(__dirname, '../../..');
const migracao = readFileSync(
  resolve(raiz, 'migrations/126_agent_turns_stream_head_live.sql'),
  'utf8',
);
const migracaoDown = readFileSync(
  resolve(raiz, 'migrations/126_agent_turns_stream_head_live_down.sql'),
  'utf8',
);
const repoFonte = readFileSync(resolve(raiz, 'src/db/repositories/turn-repos.ts'), 'utf8');

const dialeto = new PgDialect();
const compilar = (fragmento: ReturnType<typeof sql>): string =>
  dialeto.sqlToQuery(fragmento).sql;

const escopo = {
  tenant: sql`${'t-1'}`,
  agent: sql`${'a-1'}`,
  alvo: sql`"agent_turns"`,
};

describe('#626 — contrato do head-of-line', () => {
  // ─── A regra, compilada ──────────────────────────────────────────────────

  it('a regra compila para um NOT EXISTS sobre turnos ANTERIORES não terminais', () => {
    const texto = compilar(streamHeadOfLineNotExists(escopo));
    expect(texto).toContain('NOT EXISTS');
    // A comparação é ESTRITA: um turno nunca é anterior a si mesmo, e dois
    // turnos com a mesma sequência (backfill, replay) não se bloqueiam
    // mutuamente — se bloqueassem, a stream travaria sem ninguém poder
    // desempatar.
    expect(texto).toMatch(/anterior\.first_ingress_seq\s*<\s*"agent_turns"\.first_ingress_seq/);
    expect(texto).toMatch(/anterior\.stream_key\s*=\s*"agent_turns"\.stream_key/);
  });

  it('a regra é ESCOPADA por tenant_id e agent_id — não só pela stream_key', () => {
    // A `stream_key` embute tenant e agent no material canônico, mas embutir
    // não é escopar. Sem estas duas linhas, uma colisão de hash faria o turno
    // da tenant A bloquear a conversa da tenant B — e o bloqueio seria
    // invisível, porque nada na linha de B apontaria para A. A issue-mãe trata
    // colisão de stream como risco de SEGURANÇA, não de qualidade.
    const texto = compilar(streamHeadOfLineNotExists(escopo));
    expect(texto).toMatch(/anterior\.tenant_id\s*=\s*\$\d/);
    expect(texto).toMatch(/anterior\.agent_id\s*=\s*\$\d/);
  });

  it('turno SEM stream (ou sem sequência) continua claimável — e isso não é fail-open', () => {
    // `NULL = turno anterior ao protocolo` (migration 120, sem backfill).
    // Recusá-lo tornaria INCLAIMÁVEL todo turno histórico e todo turno gravado
    // com FEATURE_TURN_STREAM_KEY=false — uma parada total do ingresso causada
    // pela própria proteção. O fail-closed de verdade acontece no INGRESSO
    // (`requireStreamIdentity`, fatia A), não aqui.
    const texto = compilar(streamHeadOfLineNotExists(escopo));
    expect(texto).toContain('"agent_turns".stream_key IS NULL');
    expect(texto).toContain('"agent_turns".first_ingress_seq IS NULL');
  });

  it('os estados terminais entram como LITERAIS, não como parâmetros', () => {
    // O PostgreSQL só usa um índice PARCIAL quando PROVA que a cláusula da
    // consulta implica o predicado do índice, e a prova é sobre `Const`. Com
    // `$1..$4` ela depende de o planejador ter substituído os parâmetros — o
    // que ele faz no plano CUSTOM e deixa de fazer se cachear um plano
    // GENÉRICO. O sintoma seria uma degradação que só aparece depois da sexta
    // execução da mesma sessão: o pior formato possível de regressão.
    const texto = compilar(streamHeadOfLineNotExists(escopo));
    for (const terminal of TERMINAL_TURN_STATUSES) {
      expect(texto).toContain(`'${terminal}'`);
    }
  });

  it('o canário e a sonda de diagnóstico usam o MESMO núcleo da regra', () => {
    // Não são cópias "independentes" de propósito: uma segunda cópia do
    // predicado reintroduziria exatamente a divergência que esta fatia existe
    // para eliminar. O que o canário protege é a regra não ter sido APLICADA —
    // e para isso ele precisa ser o mesmo predicado, num lugar diferente.
    const nucleo = /anterior\.first_ingress_seq\s*<\s*"agent_turns"\.first_ingress_seq/;
    expect(compilar(earlierLiveTurnCount(escopo))).toMatch(nucleo);
    expect(compilar(earlierLiveTurnCount(escopo))).toContain('count(*)');
    const sonda = compilar(
      earlierLiveTurnProbe({ tenant: escopo.tenant, agent: escopo.agent, turn_id: 'x' }),
    );
    expect(sonda).toMatch(/anterior\.first_ingress_seq\s*<\s*alvo\.first_ingress_seq/);
    // ORDER BY + LIMIT 1: quem bloqueia é o MAIS ANTIGO. Devolver qualquer um
    // faria o diagnóstico apontar para um turno do meio da fila, e a
    // remediação seguiria a pista errada.
    expect(sonda).toMatch(/ORDER BY anterior\.first_ingress_seq\s+LIMIT 1/);
  });

  // ─── "Uma única função": a estrutura, não a intenção ─────────────────────

  it('todos os consumidores da regra no repositório chamam a MESMA função', () => {
    // Os CINCO: o `WHERE` do claim, o filtro do recovery, o dispatcher
    // cross-tenant, o canário do recovery e — desde #627 — a eleição do
    // sucessor em `promoteStreamSuccessor`. O número é afirmado para que
    // acrescentar um consumidor NOVO sem passar pela função obrigue a mexer
    // aqui — que é o momento de perguntar por quê.
    //
    // Por que a promoção conta: ela é a resposta à MESMA pergunta ("quem é o
    // head desta stream?") num terceiro momento do ciclo. Se ela tivesse
    // predicado próprio, o claim e a promoção poderiam eleger turnos
    // DIFERENTES — e o sintoma seria um turno promovido que o claim recusa
    // com `not_head`, isto é, uma conversa que recebe wake-up e não anda.
    const codigo = repoFonte
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join('\n');
    const chamadas = codigo.match(/streamHeadOfLineNotExists\(/g) ?? [];
    expect(chamadas.length).toBe(5);
  });

  it('o repositório NÃO tem uma segunda cópia do predicado escrita à mão', () => {
    // A forma que a divergência tomaria: alguém escreve o `NOT EXISTS` inline
    // "só desta vez". O predicado inteiro vive em
    // `src/db/repositories/stream-head-sql.ts`; `first_ingress_seq` só pode
    // aparecer no repositório como COLUNA a gravar/ler, nunca comparada com a
    // de outro turno.
    const codigo = repoFonte
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
      .join('\n');
    // A comparação entre a sequência de DOIS turnos é a assinatura do
    // predicado. Ela só pode existir em `stream-head-sql.ts`.
    expect(codigo).not.toMatch(/first_ingress_seq\s*<\s*\S*\.?first_ingress_seq/);
    // E nenhum `NOT EXISTS` do repositório pode falar de `agent_turns` como
    // "anterior" — os que existem ali são do backfill, sobre `agent_turn_inputs`.
    expect(codigo).not.toMatch(/NOT EXISTS[\s\S]{0,200}anterior/i);
  });

  // ─── Vocabulário centralizado ────────────────────────────────────────────

  it('os cinco códigos da issue existem, mais o `stream_poisoned` da #629', () => {
    // A #629 (fatia F) ACRESCENTOU um sexto: `stream_poisoned`. Acrescentar não
    // é o mesmo que redefinir — nenhuma série existente mudou de significado, e
    // a nova é semeada em zero como as outras. O que continua proibido é grafar
    // um dos códigos de outro jeito, ou ter dois nomes para o mesmo fato.
    expect([...STREAM_SCHEDULING_RESULTS].sort()).toEqual(
      [
        'eligible',
        'not_head',
        'promoted',
        'stream_blocked',
        'stream_busy',
        'stream_poisoned',
      ].sort(),
    );
    expect(new Set(STREAM_SCHEDULING_RESULTS).size).toBe(STREAM_SCHEDULING_RESULTS.length);
  });

  it('as recusas do claim por STREAM são um subconjunto do vocabulário central', () => {
    // Se `CLAIM_REJECTIONS` puder carregar um código que não está no
    // vocabulário, o label de métrica e o motivo tipado voltam a poder divergir
    // — que é a duplicação que a issue manda eliminar, na outra dimensão.
    for (const reason of ['not_head', 'stream_blocked', 'stream_busy', 'stream_poisoned'] as const) {
      expect(CLAIM_REJECTIONS).toContain(reason);
      expect(STREAM_SCHEDULING_RESULTS).toContain(reason);
    }
    expect(new Set(CLAIM_REJECTIONS).size).toBe(CLAIM_REJECTIONS.length);
  });

  it('os motivos de bloqueio são os do vocabulário, menos os que não são bloqueio', () => {
    for (const reason of STREAM_BLOCKED_REASONS) {
      expect(STREAM_SCHEDULING_RESULTS).toContain(reason);
    }
    expect(STREAM_BLOCKED_REASONS).not.toContain('eligible');
    expect(STREAM_BLOCKED_REASONS).not.toContain('promoted');
  });

  // ─── A migration ─────────────────────────────────────────────────────────

  it('o índice se chama exatamente como a constante do vocabulário', () => {
    expect(migracao).toContain(STREAM_HEAD_OF_LINE_INDEX);
    expect(migracaoDown).toContain(STREAM_HEAD_OF_LINE_INDEX);
  });

  it('o predicado do índice lista EXATAMENTE os terminais do contrato', () => {
    // Este é o teste que transforma "acrescentar um estado terminal exige uma
    // migration nova" de lembrete em obrigação. Sem ele, um sexto terminal no
    // contrato deixaria o índice desalinhado da consulta, o Postgres não
    // conseguiria provar a implicação, e o `NOT EXISTS` voltaria a varrer o
    // histórico — sem nenhum sintoma até a primeira conversa quente.
    const predicado = /AND status NOT IN \(([^)]*)\)/.exec(migracao);
    expect(predicado).not.toBeNull();
    const noSql = predicado![1]!
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort();
    expect(noSql).toEqual([...TERMINAL_TURN_STATUSES].sort());
  });

  it('o índice começa por (tenant_id, agent_id, stream_key), como a issue prescreve', () => {
    expect(migracao).toMatch(
      /ON agent_turns \(\s*tenant_id\s*,\s*agent_id\s*,\s*stream_key\s*,\s*first_ingress_seq\s*\)/,
    );
  });

  it('é CONCURRENTLY e o arquivo carrega o marcador no-transaction', () => {
    expect(migracao).toMatch(/^--\s*maia:no-transaction/m);
    expect(migracao).toContain('CREATE INDEX CONCURRENTLY');
    expect(migracaoDown).toContain('DROP INDEX CONCURRENTLY');
  });

  it('nenhum literal do arquivo no-transaction contém `;` (o runner quebra por `;`)', () => {
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

  // ─── Estágios do canário ─────────────────────────────────────────────────

  it('os estágios de violação são fechados e nomeiam detectores REAIS', () => {
    expect([...STREAM_FIFO_VIOLATION_STAGES].sort()).toEqual(['claim', 'recovery']);
  });
});
