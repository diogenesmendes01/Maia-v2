/**
 * Issue #629 (fatia F da #505) — o CONTRATO da política de poison/DLQ.
 *
 * O que este arquivo cobra, e que nenhum compilador cobra:
 *
 *   1. a CLASSIFICAÇÃO é total e o `outcome` domina o código — `unsafe_to_retry`
 *      é evidência de primeira ordem (a plataforma SABE que uma tool
 *      irreversível rodou), e o código que a acompanha é sintoma;
 *   2. a leitura da configuração falha FECHADA numa categoria desconhecida. É a
 *      diferença entre "o operador ligou o bloqueio" e "o operador acredita ter
 *      ligado o bloqueio", e a segunda é indistinguível de sucesso;
 *   3. o contrato de env (`TURN_POISON_BLOCK_CATEGORIES`) e o vocabulário do
 *      módulo puro listam as MESMAS categorias. `src/config/contract.ts` não
 *      pode importar o módulo (regra de pureza: só `zod` e `metadata`), então a
 *      lista está escrita duas vezes por necessidade — e é aqui que as duas
 *      cópias são amarradas;
 *   4. o predicado do bloqueio existe em `stream-head-sql.ts` (o dono da
 *      ordem), tem os consumidores esperados no repositório, e não há uma
 *      segunda cópia escrita à mão;
 *   5. o predicado casa TEXTUALMENTE com o índice único parcial da migration
 *      133 (`unblocked_at IS NULL`), que é o que permite ao planejador provar a
 *      implicação;
 *   6. a migration 133 e o `_down` têm envelope `BEGIN`/`COMMIT` (o runner é
 *      autocommit por statement) e o `_down` não usa `CONCURRENTLY`.
 *
 * Puro: compila SQL com `PgDialect` (sem banco) e lê migration e fontes como
 * TEXTO.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  DEFAULT_POISON_BLOCK_CATEGORIES,
  POISON_CATEGORIES,
  POISON_DISPOSITIONS,
  STREAM_BLOCK_REASONS,
  classifyPoison,
  parsePoisonBlockCategories,
  poisonDisposition,
  type PoisonCategory,
} from '@/runtime/turns/poison-policy.js';
import { CLAIM_REJECTIONS, STREAM_BLOCKED_REASONS } from '@/runtime/turns/claim.js';
import { streamNotPoisoned, streamPoisonProbe } from '@/db/repositories/stream-head-sql.js';
import { ENV_CONTRACT } from '@/config/contract.js';

const raiz = resolve(__dirname, '../../..');
const migracao = readFileSync(resolve(raiz, 'migrations/133_agent_stream_blocks.sql'), 'utf8');
const migracaoDown = readFileSync(
  resolve(raiz, 'migrations/133_agent_stream_blocks_down.sql'),
  'utf8',
);
const repoFonte = readFileSync(resolve(raiz, 'src/db/repositories/turn-repos.ts'), 'utf8');

/** O SQL de verdade: sem comentários, que aqui falam sobre o que NÃO se faz. */
const semComentarios = (arquivo: string): string =>
  arquivo
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

/** O código de verdade: sem comentários de bloco nem de linha. */
const semDoc = (arquivo: string): string =>
  arquivo
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join('\n');

const dialeto = new PgDialect();
const compilar = (fragmento: ReturnType<typeof sql>): string => dialeto.sqlToQuery(fragmento).sql;

const predicado = compilar(
  streamNotPoisoned({ tenant: sql`${'t-1'}`, agent: sql`${'a-1'}`, alvo: sql`agent_turns` }),
);

describe('#629 — classificação do erro envenenado', () => {
  it('é uma função TOTAL: todo código cai em exatamente uma categoria', () => {
    const amostras = [
      'reasoner_failed',
      'outbound_failure',
      'db_timeout',
      'redis_conn_refused',
      'operator_cancelled',
      'coisa_que_ninguem_previu',
      '',
      'x'.repeat(64),
    ];
    for (const code of amostras) {
      const categoria = classifyPoison({ error_code: code });
      expect(POISON_CATEGORIES).toContain(categoria);
    }
  });

  it('`unsafe_to_retry` DOMINA o código de erro', () => {
    // A razão é a que decide a fatia: `unsafe_to_retry` é produzido por
    // `decideTurnAction` exatamente quando `delivery.sideEffectsCommitted` é
    // verdade — isto é, a plataforma SABE, por um fato durável, que uma tool
    // irreversível rodou. O código que acompanha é o motivo da SAÍDA do ReAct
    // (`reasoner_failed`, `outbound_failure`), que classificaria como `model` ou
    // `transport` e apagaria a única informação que importa para a decisão.
    expect(classifyPoison({ error_code: 'reasoner_failed' })).toBe('model');
    expect(classifyPoison({ error_code: 'reasoner_failed', outcome: 'unsafe_to_retry' })).toBe(
      'effect_committed',
    );
    expect(classifyPoison({ error_code: 'outbound_failure' })).toBe('transport');
    expect(classifyPoison({ error_code: 'outbound_failure', outcome: 'unsafe_to_retry' })).toBe(
      'effect_committed',
    );
  });

  it('`operator_cancelled` DOMINA pelo motivo oposto: um humano já decidiu', () => {
    expect(classifyPoison({ error_code: 'db_timeout', outcome: 'operator_cancelled' })).toBe(
      'operator',
    );
  });

  it('código não previsto vira `unknown`, e `unknown` não é apelido de nada', () => {
    expect(classifyPoison({ error_code: 'tool_do_futuro_falhou' })).toBe('unknown');
    expect(classifyPoison({ error_code: null })).toBe('unknown');
    // `unknown` é categoria PRÓPRIA, e a diferença é operacional: colapsá-la em
    // `infrastructure` (a "benigna") tiraria do operador a escolha de parar
    // diante de um erro que ninguém analisou.
    expect(POISON_CATEGORIES).toContain('unknown');
    expect(classifyPoison({ error_code: 'db_timeout' })).toBe('infrastructure');
  });
});

describe('#629 — a DECISÃO, e a configuração que a governa', () => {
  it('bloqueia SÓ o que está declarado — nunca por inferência de gravidade', () => {
    const so_efeito = new Set<PoisonCategory>(['effect_committed']);
    expect(poisonDisposition('effect_committed', so_efeito)).toBe('block_stream');
    for (const c of POISON_CATEGORIES) {
      if (c === 'effect_committed') continue;
      expect(poisonDisposition(c, so_efeito)).toBe('release');
    }
  });

  it('lista VAZIA é o KILL SWITCH: nada bloqueia', () => {
    const vazio = parsePoisonBlockCategories('');
    expect(vazio.size).toBe(0);
    for (const c of POISON_CATEGORIES) {
      expect(poisonDisposition(c, vazio)).toBe('release');
    }
    // E é indistinguível de `undefined`, porque as duas dizem a mesma coisa.
    expect(parsePoisonBlockCategories(undefined).size).toBe(0);
  });

  it('categoria DESCONHECIDA lança em vez de ser silenciosamente ignorada', () => {
    // A falha que isto impede: `effect_commited` (com um `t`) silenciado
    // produziria um dashboard sem bloqueio nenhum porque não HÁ bloqueio
    // nenhum — e a conclusão natural seria "não aconteceu nenhum caso" em vez
    // de "a política está desligada". Indistinguível de sucesso.
    expect(() => parsePoisonBlockCategories('effect_commited')).toThrow(/effect_commited/);
    expect(() => parsePoisonBlockCategories('governance')).toThrow(
      /categorias? .*(não existe|válidas)/i,
    );
    // Uma válida ao lado de uma inválida NÃO passa pela metade.
    expect(() => parsePoisonBlockCategories('effect_committed,typo')).toThrow();
  });

  it('espaços, caixa e vírgulas soltas são tolerados; o vocabulário não', () => {
    const set = parsePoisonBlockCategories(' Effect_Committed , , MODEL ');
    expect([...set].sort()).toEqual(['effect_committed', 'model']);
  });

  it('o default bloqueia `effect_committed` e SÓ ele', () => {
    // A decisão mais contestável do arquivo, e ela está documentada lá: as
    // outras categorias têm causa COMPARTILHADA e transitória, então um
    // incidente de LLM ou de rede que bloqueasse pararia milhares de conversas
    // de uma vez, com desbloqueio manual uma a uma.
    expect([...DEFAULT_POISON_BLOCK_CATEGORIES]).toEqual(['effect_committed']);
  });
});

describe('#629 — o contrato de env e o vocabulário do módulo puro não divergem', () => {
  it('`TURN_POISON_BLOCK_CATEGORIES` aceita exatamente as categorias do módulo', () => {
    const spec = ENV_CONTRACT.TURN_POISON_BLOCK_CATEGORIES;
    expect(spec).toBeDefined();
    // `src/config/contract.ts` NÃO pode importar `poison-policy.ts` (regra de
    // pureza: só `zod` e `@/config/metadata.js`), então a lista está escrita
    // duas vezes por necessidade. Esta é a amarra: cada categoria do módulo
    // passa no schema, e uma inventada não passa.
    for (const c of POISON_CATEGORIES) {
      expect(spec!.schema.safeParse(c).success).toBe(true);
    }
    expect(spec!.schema.safeParse('governance').success).toBe(false);
    expect(spec!.schema.safeParse('effect_commited').success).toBe(false);
    // A lista inteira passa junta, e a vazia também (kill switch).
    expect(spec!.schema.safeParse([...POISON_CATEGORIES].join(',')).success).toBe(true);
    expect(spec!.schema.safeParse('').success).toBe(true);
  });

  it('o DEFAULT do contrato é o mesmo default do módulo', () => {
    const spec = ENV_CONTRACT.TURN_POISON_BLOCK_CATEGORIES;
    const aplicado = spec!.schema.parse(undefined) as string;
    expect([...parsePoisonBlockCategories(aplicado)].sort()).toEqual(
      [...DEFAULT_POISON_BLOCK_CATEGORIES].sort(),
    );
  });
});

describe('#629 — o vocabulário do escalonamento ganhou `stream_poisoned`', () => {
  it('é recusa de claim E motivo de bloqueio, com o MESMO nome', () => {
    expect(CLAIM_REJECTIONS).toContain('stream_poisoned');
    expect(STREAM_BLOCKED_REASONS).toContain('stream_poisoned');
  });

  it('as duas saídas e o motivo de bloqueio são conjuntos fechados e sem repetição', () => {
    expect([...POISON_DISPOSITIONS].sort()).toEqual(['block_stream', 'release']);
    expect([...STREAM_BLOCK_REASONS]).toEqual(['poison']);
    expect(new Set(POISON_CATEGORIES).size).toBe(POISON_CATEGORIES.length);
  });
});

describe('#629 — o predicado do bloqueio, e a ausência de uma segunda cópia', () => {
  it('casa TEXTUALMENTE com o índice único parcial da migration 133', () => {
    // A mesma razão dos literais de status da #626: o planejador só prova que a
    // cláusula da consulta implica o predicado do índice quando os dois lados
    // coincidem. Se um dia o índice virar `WHERE unblocked_at IS NULL AND
    // reason = 'poison'` e o predicado não acompanhar, a consulta continua
    // CORRETA e passa a não usar o índice — degradação silenciosa.
    expect(predicado.toLowerCase()).toContain('unblocked_at is null');
    expect(semComentarios(migracao)).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*agent_stream_blocks_active_uq[\s\S]*WHERE unblocked_at IS NULL/,
    );
  });

  it('escopa por tenant E agent — a `stream_key` sozinha não basta', () => {
    // `stream_key` já embute tenant e agent no material canônico, mas embutir
    // não é escopar: sem o par no predicado, uma `stream_key` forjada ou
    // colidida endereçaria a interdição de outro tenant.
    expect(predicado).toContain('bloqueio.tenant_id');
    expect(predicado).toContain('bloqueio.agent_id');
    expect(semComentarios(migracao)).toMatch(
      /agent_stream_blocks_active_uq[\s\S]*\(tenant_id, agent_id, stream_key\)/,
    );
  });

  it('o escape de `stream_key IS NULL` existe, e não é fail-open', () => {
    // Um turno sem identidade de stream não pertence a conversa nenhuma, então
    // não há interdição de conversa que possa alcançá-lo — e um bloqueio só
    // nasce a partir de um turno que TEM `stream_key`.
    expect(predicado).toMatch(/agent_turns\.stream_key is null/i);
  });

  it('os consumidores do predicado no repositório chamam a MESMA função', () => {
    // Os QUATRO: o `WHERE` do claim, o filtro do recovery, o dispatcher
    // cross-tenant e a eleição da promoção. O número é afirmado para que
    // acrescentar um consumidor NOVO sem passar pela função obrigue a mexer
    // aqui — que é o momento de perguntar por quê.
    //
    // Por que a promoção conta: sem o predicado nela, o `dead_letter` que
    // BLOQUEIA a stream ainda assim acordaria o sucessor. O defeito seria
    // invisível — o job acordaria, o claim recusaria com `stream_poisoned`, e o
    // único sintoma seria um `promoted` que não corresponde a fila nenhuma.
    const codigo = semDoc(repoFonte);
    const chamadas = codigo.match(/streamNotPoisoned\(/g) ?? [];
    expect(chamadas.length).toBe(4);
  });

  it('o repositório NÃO tem uma segunda cópia do predicado escrita à mão', () => {
    // A forma que a divergência tomaria: alguém escreve o `NOT EXISTS` (ou o
    // JOIN da sonda) inline "só desta vez". O predicado E a sonda vivem em
    // `stream-head-sql.ts`; no repositório, `unblocked_at` não pode aparecer.
    const codigo = semDoc(repoFonte);
    // A ÚNICA ocorrência tolerada é a de `countBlockedStreams`, que conta
    // interdições ativas — uma agregação sobre a própria tabela de bloqueios,
    // não uma segunda cópia da regra de elegibilidade da stream. Duas ou mais
    // significam que alguém reescreveu o predicado inline.
    const ocorrencias = codigo.match(/unblocked_at/g) ?? [];
    expect(ocorrencias.length).toBe(1);
    // E a sonda de diagnóstico é a função, não SQL solto.
    expect(codigo).toContain('streamPoisonProbe(');
  });

  it('a sonda de diagnóstico devolve o turno envenenado, nunca a `stream_key`', () => {
    const sonda = compilar(
      streamPoisonProbe({ tenant: sql`${'t-1'}`, agent: sql`${'a-1'}`, turn_id: 'turn-1' }),
    );
    expect(sonda).toContain('blocked_by_turn_id');
    // O `SELECT` não projeta `stream_key`. (Ela aparece no JOIN, que é onde a
    // comparação acontece — o que não pode é SAIR da consulta.)
    const projecao = sonda.slice(0, sonda.toLowerCase().indexOf('from'));
    expect(projecao).not.toContain('stream_key');
  });
});

describe('#629 — a migration 133', () => {
  it('cria a tabela e o índice DENTRO de um envelope de transação', () => {
    // O runner aplica com `psql -v ON_ERROR_STOP=1 -f`, que é AUTOCOMMIT POR
    // STATEMENT. Sem envelope, uma falha no `CREATE INDEX` deixaria a TABELA
    // comitada sem o único índice — e nesse estado o bloqueio deixa de ser
    // idempotente, duas linhas ativas passam a ser possíveis e o desbloqueio
    // de um operador ficaria parcial.
    expect(migracao).toMatch(/^BEGIN;/m);
    expect(migracao).toMatch(/^COMMIT;/m);
    expect(migracaoDown).toMatch(/^BEGIN;/m);
    expect(migracaoDown).toMatch(/^COMMIT;/m);
  });

  it('NÃO usa `CONCURRENTLY` — e por isso não está exposta à armadilha da #658', () => {
    // Um `CREATE INDEX CONCURRENTLY` que falha deixa `pg_index.indisvalid =
    // false`, e reaplicar a migration DEVOLVE SUCESSO (o `IF NOT EXISTS`
    // encontra o índice inválido). Aqui a tabela nasce vazia, então não há
    // leitura concorrente a proteger, e o envelope é possível.
    expect(semComentarios(migracao)).not.toMatch(/CONCURRENTLY/i);
    expect(semComentarios(migracaoDown)).not.toMatch(/CONCURRENTLY/i);
  });

  it('é idempotente nos dois sentidos', () => {
    expect(semComentarios(migracao)).toMatch(/CREATE TABLE IF NOT EXISTS agent_stream_blocks/);
    expect(semComentarios(migracaoDown)).toMatch(/DROP TABLE IF EXISTS agent_stream_blocks/);
  });

  it('recusa no BANCO o literal `default` como escopo', () => {
    // Invariante MUST nº 8: uma stream bloqueada sob `default` seria um
    // bloqueio GLOBAL disfarçado. O código de aplicação já recusa; o banco
    // recusa também porque um backfill ou um `psql` de incidente não passa
    // pelo código de aplicação.
    const sqlLimpo = semComentarios(migracao);
    expect(sqlLimpo).toMatch(/tenant_id <> 'default'/);
    expect(sqlLimpo).toMatch(/agent_id <> 'default'/);
  });

  it('recusa um desbloqueio sem autor e sem justificativa', () => {
    // Um `unblocked_at` sem autor é indistinguível de um bug de escrita, e o
    // histórico perderia exatamente a informação pela qual ele existe.
    const sqlLimpo = semComentarios(migracao);
    expect(sqlLimpo).toMatch(/agent_stream_blocks_unblock_chk/);
    expect(sqlLimpo).toMatch(/unblocked_by IS NOT NULL/);
    expect(sqlLimpo).toMatch(/unblock_reason IS NOT NULL/);
  });
});
