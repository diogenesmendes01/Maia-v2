/**
 * Issue #625 (fatia B da #505) — o CONTRATO da exclusão por stream, amarrado
 * nos três lugares onde ele existe ao mesmo tempo.
 *
 * A invariante "no máximo um turno ativo por stream" é escrita em três textos
 * independentes que precisam concordar:
 *
 *   1. o predicado do índice `agent_turns_stream_active_uq`
 *      (`migrations/124_agent_turns_stream_exclusion.sql`);
 *   2. a lista `STREAM_OCCUPYING_STATUSES` (`src/runtime/turns/claim.ts`), que
 *      o `FOR UPDATE` da recuperação usa para saber o que trancar;
 *   3. a tabela de transições (`src/runtime/turns/contract.ts`), que precisa
 *      admitir a aresta que a recuperação percorre.
 *
 * Divergir qualquer um dos três não produz erro de compilação nem falha de
 * integração óbvia — produz uma STREAM TRAVADA em produção, meses depois, num
 * caminho que ninguém relaciona à edição. Este arquivo é barato e é a única
 * coisa que faz a divergência doer no minuto em que ela é escrita.
 *
 * Puro: lê o SQL como TEXTO e as constantes como valores. Sem banco.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CLAIM_REJECTIONS,
  LEASE_TAKEOVER_STATUSES,
  STREAM_EXCLUSION_CONSTRAINT,
  STREAM_OCCUPYING_STATUSES,
} from '@/runtime/turns/claim.js';
import { TURN_TRANSITIONS, isTerminalTurnStatus } from '@/runtime/turns/contract.js';

const raiz = resolve(__dirname, '../../..');
const migracao = readFileSync(
  resolve(raiz, 'migrations/124_agent_turns_stream_exclusion.sql'),
  'utf8',
);
const migracaoDown = readFileSync(
  resolve(raiz, 'migrations/124_agent_turns_stream_exclusion_down.sql'),
  'utf8',
);

describe('#625 — contrato da exclusão por stream', () => {
  it('o índice se chama exatamente como a constante que o código procura no erro', () => {
    // `tryClaimTurn` só converte um `23505` em `stream_busy` quando o nome da
    // constraint bate. Renomear o índice na migration sem renomear a constante
    // faz o `23505` VAZAR como erro 500 — a corrida rotineira vira incidente.
    expect(migracao).toContain(STREAM_EXCLUSION_CONSTRAINT);
    expect(migracaoDown).toContain(STREAM_EXCLUSION_CONSTRAINT);
  });

  it('o predicado do índice cobre exatamente STREAM_OCCUPYING_STATUSES', () => {
    const predicado = /WHERE stream_key IS NOT NULL AND status IN \(([^)]*)\)/.exec(migracao);
    expect(predicado).not.toBeNull();
    const noSql = predicado![1]!
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .sort();
    expect(noSql).toEqual([...STREAM_OCCUPYING_STATUSES].sort());
  });

  it('o índice é PARCIAL em stream_key IS NOT NULL', () => {
    // Sem o predicado, todo turno anterior ao protocolo (sem backfill, por
    // decisão da fatia A) entraria no índice. NULLs não colidem entre si numa
    // unique, então a semântica não mudaria — o CUSTO mudaria: o índice
    // passaria a valer o histórico inteiro de `agent_turns`, que cresce sem
    // limite, em vez do trabalho em voo.
    expect(migracao).toMatch(/WHERE stream_key IS NOT NULL/);
  });

  it('o índice é escopado por tenant_id e agent_id ANTES da stream_key', () => {
    // A `stream_key` embute tenant e agent no material canônico, mas embutir
    // não é escopar: uma colisão de hash, um backfill ou um replay manual
    // fariam duas tenants disputarem a MESMA chave de índice. A issue-mãe trata
    // colisão de stream como risco de SEGURANÇA.
    expect(migracao).toMatch(
      /ON agent_turns \(\s*tenant_id\s*,\s*agent_id\s*,\s*stream_key\s*\)/,
    );
  });

  it('é CONCURRENTLY e o arquivo carrega o marcador no-transaction', () => {
    expect(migracao).toMatch(/^--\s*maia:no-transaction/m);
    expect(migracao).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
    expect(migracaoDown).toContain('DROP INDEX CONCURRENTLY');
  });

  it('nenhum literal do arquivo no-transaction contém `;` (o runner quebra por `;`)', () => {
    // `splitNoTxStatements` apaga comentários de linha e parte por `;`. Um ponto
    // e vírgula dentro de uma string partiria o statement ao meio e a migration
    // morreria no primeiro deploy que a aplicasse — depois do merge, portanto.
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

  it('a recuperação percorre arestas REAIS do contrato: claimed/running -> retryable', () => {
    // A recuperação de claim expirado escreve `status = 'retryable'` direto no
    // SQL, sem passar por `transitionTurn`. Isso é legítimo (o claim já fazia o
    // mesmo desde #504), mas só enquanto o par (from, to) continuar sendo uma
    // aresta do contrato — senão a máquina de estados passa a ter um atalho que
    // nenhuma leitura da tabela revela.
    for (const from of STREAM_OCCUPYING_STATUSES) {
      expect(TURN_TRANSITIONS[from]).toContain('retryable');
    }
  });

  it('nenhum estado que ocupa a stream é terminal', () => {
    // Um terminal no predicado do índice seria uma stream travada para sempre:
    // nada sai de terminal, então nada removeria a linha do índice.
    for (const status of STREAM_OCCUPYING_STATUSES) {
      expect(isTerminalTurnStatus(status)).toBe(false);
    }
  });

  it('ocupar a stream e admitir takeover são a MESMA lista hoje', () => {
    // Constantes separadas de propósito (perguntas diferentes), mas uma
    // divergência silenciosa entre elas é um modo de falha real: um estado que
    // ocupa a stream e NÃO admite takeover não teria como ser recuperado, e a
    // stream ficaria presa. Se alguém separar as duas de propósito, este teste
    // é o lugar de registrar por quê.
    expect([...STREAM_OCCUPYING_STATUSES].sort()).toEqual([...LEASE_TAKEOVER_STATUSES].sort());
  });

  it('`stream_busy` é motivo de claim de vocabulário fechado, distinto de not_eligible', () => {
    expect(CLAIM_REJECTIONS).toContain('stream_busy');
    expect(CLAIM_REJECTIONS).toContain('not_eligible');
    expect(new Set(CLAIM_REJECTIONS).size).toBe(CLAIM_REJECTIONS.length);
  });
});
