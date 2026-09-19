/**
 * Issue #503 — máquina de estados durável do turno inbound.
 *
 * Testa o CONTRATO puro (src/runtime/turns/contract.ts): tabela completa de
 * transições válidas, tabela completa de inválidas, exigência de outcome em
 * terminal, `outbound_pending` que nunca volta para `running`, e sanitização
 * do erro persistido. Nada aqui toca Postgres — o CAS real é coberto em
 * tests/integration/agent-turns-real-db.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  TURN_STATUSES,
  TURN_OUTCOMES,
  TURN_TRANSITIONS,
  TERMINAL_TURN_STATUSES,
  TERMINAL_OUTCOMES,
  RECOVERABLE_TURN_STATUSES,
  MANUAL_TRANSITIONS,
  checkTurnTransition,
  assertTurnTransition,
  sourceStatusesFor,
  isTerminalTurnStatus,
  isRecoverableTurnStatus,
  isTurnStatus,
  isTurnOutcome,
  InvalidTurnTransitionError,
  sanitizeTurnError,
  normalizeTurnErrorCode,
  TURN_ERROR_SUMMARY_MAX,
  type TurnStatus,
  type TurnOutcome,
} from '@/runtime/turns/contract.js';

/** Outcome canônico para cada estado terminal (o primeiro admitido). */
function outcomeFor(to: TurnStatus): TurnOutcome | null {
  return isTerminalTurnStatus(to) ? (TERMINAL_OUTCOMES[to][0] as TurnOutcome) : null;
}

describe('turn state machine — vocabulário', () => {
  it('todo estado terminal está no vocabulário de estados', () => {
    for (const s of TERMINAL_TURN_STATUSES) expect(TURN_STATUSES).toContain(s);
  });

  it('todo estado recuperável é não-terminal', () => {
    for (const s of RECOVERABLE_TURN_STATUSES) {
      expect(isTerminalTurnStatus(s)).toBe(false);
      expect(isRecoverableTurnStatus(s)).toBe(true);
    }
  });

  it('outbound_pending NÃO é recuperável (a resposta já foi comprometida)', () => {
    expect(isRecoverableTurnStatus('outbound_pending')).toBe(false);
  });

  it('todo estado é terminal OU recuperável — sem estado órfão', () => {
    for (const s of TURN_STATUSES) {
      const classified = isTerminalTurnStatus(s) || isRecoverableTurnStatus(s);
      // outbound_pending é a única exceção deliberada: nem terminal nem
      // recuperável (só o delivery worker o finaliza — #506).
      if (s === 'outbound_pending') expect(classified).toBe(false);
      else expect(classified).toBe(true);
    }
  });

  it('cada outcome pertence a EXATAMENTE um estado terminal', () => {
    const seen = new Map<TurnOutcome, TurnStatus>();
    for (const terminal of TERMINAL_TURN_STATUSES) {
      for (const outcome of TERMINAL_OUTCOMES[terminal]) {
        const previous = seen.get(outcome);
        // operator_cancelled é o único par admitido em dois terminais
        // (ignored = cancelado antes de executar; dead_letter = cancelado
        // já em execução). Qualquer OUTRO par duplicado é ambiguidade.
        if (previous && outcome !== 'operator_cancelled') {
          throw new Error(`outcome '${outcome}' aparece em '${previous}' e em '${terminal}'`);
        }
        seen.set(outcome, terminal);
      }
    }
    for (const outcome of TURN_OUTCOMES) expect(seen.has(outcome)).toBe(true);
  });

  it('type guards rejeitam valores fora do vocabulário', () => {
    expect(isTurnStatus('running')).toBe(true);
    expect(isTurnStatus('processing')).toBe(false);
    expect(isTurnStatus(null)).toBe(false);
    expect(isTurnOutcome('reply_delivered')).toBe(true);
    expect(isTurnOutcome('done')).toBe(false);
  });
});

describe('turn state machine — tabela COMPLETA de transições válidas', () => {
  // Enumeração explícita (não derivada de TURN_TRANSITIONS) — se alguém
  // alterar a tabela, este teste falha e obriga a decisão consciente.
  const VALID: ReadonlyArray<readonly [TurnStatus, TurnStatus]> = [
    // fluxo principal
    ['received', 'queued'],
    ['queued', 'claimed'],
    ['claimed', 'running'],
    ['running', 'outbound_pending'],
    ['outbound_pending', 'completed'],
    // atalhos e alternativos
    ['received', 'claimed'],
    ['received', 'retryable'],
    ['received', 'ignored'],
    ['received', 'superseded'],
    ['queued', 'retryable'],
    ['queued', 'superseded'],
    ['claimed', 'retryable'],
    ['claimed', 'dead_letter'],
    ['running', 'completed'],
    ['running', 'ignored'],
    ['running', 'retryable'],
    ['running', 'dead_letter'],
    ['outbound_pending', 'dead_letter'],
    ['retryable', 'queued'],
    ['retryable', 'dead_letter'],
  ];

  it.each(VALID)('permite %s -> %s', (from, to) => {
    expect(checkTurnTransition(from, to, outcomeFor(to))).toEqual({ allowed: true });
  });

  it('a tabela do contrato tem exatamente as arestas enumeradas acima', () => {
    const fromTable: string[] = [];
    for (const from of TURN_STATUSES) {
      for (const to of TURN_TRANSITIONS[from]) fromTable.push(`${from}->${to}`);
    }
    expect(fromTable.sort()).toEqual(VALID.map(([f, t]) => `${f}->${t}`).sort());
  });
});

describe('turn state machine — tabela COMPLETA de transições inválidas', () => {
  it('todo par NÃO enumerado na tabela é rejeitado', () => {
    for (const from of TURN_STATUSES) {
      for (const to of TURN_STATUSES) {
        if (TURN_TRANSITIONS[from].includes(to)) continue;
        const check = checkTurnTransition(from, to, outcomeFor(to));
        expect(check.allowed, `${from} -> ${to} deveria ser rejeitado`).toBe(false);
      }
    }
  });

  it('outbound_pending NUNCA volta para running', () => {
    const check = checkTurnTransition('outbound_pending', 'running');
    expect(check).toMatchObject({ allowed: false, reason: 'not_in_transition_table' });
  });

  it('estado terminal não volta automaticamente a estado executável', () => {
    for (const terminal of TERMINAL_TURN_STATUSES) {
      for (const to of RECOVERABLE_TURN_STATUSES) {
        const check = checkTurnTransition(terminal, to);
        expect(check).toMatchObject({ allowed: false, reason: 'terminal_source' });
      }
    }
  });

  it('nenhum estado transiciona para si mesmo', () => {
    for (const s of TURN_STATUSES) expect(TURN_TRANSITIONS[s]).not.toContain(s);
  });

  it('replay de dead_letter só existe na porta MANUAL (auditada)', () => {
    expect(checkTurnTransition('dead_letter', 'queued').allowed).toBe(false);
    expect(checkTurnTransition('dead_letter', 'queued', null, { manual: true })).toEqual({
      allowed: true,
    });
    expect(MANUAL_TRANSITIONS['dead_letter']).toEqual(['queued']);
  });

  it('a porta manual NÃO reabre outros terminais', () => {
    for (const terminal of TERMINAL_TURN_STATUSES) {
      if (terminal === 'dead_letter') continue;
      expect(checkTurnTransition(terminal, 'queued', null, { manual: true }).allowed).toBe(false);
    }
  });

  // ─── P04.5b.1 — o descarte administrativo de backlog (spec maia-hermes §8.2.5)
  //
  // A spec manda: "turnos `received/queued/retryable` retidos pelo controle, sem
  // execução/efeito pendente e anteriores ou iguais ao watermark, terminam em
  // `ignored` + `operator_cancelled`" e "acrescentar as arestas estritamente
  // manuais necessárias em `MANUAL_TRANSITIONS`, **sem liberar `queued →
  // ignored` para callers automáticos**".
  //
  // `received → ignored` e `running → ignored` JÁ existem na tabela automática,
  // então só duas arestas faltam. Elas entram pela porta MANUAL porque o
  // caminho automático de um turno `queued` é avançar, não ser descartado: um
  // `ignored` alcançável automaticamente daria a qualquer caller a capacidade de
  // sumir com trabalho enfileirado sem operação auditada.

  it('`queued → ignored` e `retryable → ignored` existem SÓ na porta manual', () => {
    for (const from of ['queued', 'retryable'] as const) {
      // Fechado para o caminho automático — a cláusula literal da spec.
      expect(checkTurnTransition(from, 'ignored', 'operator_cancelled')).toMatchObject({
        allowed: false,
        reason: 'not_in_transition_table',
      });
      // Aberto para a operação explícita e auditada.
      expect(checkTurnTransition(from, 'ignored', 'operator_cancelled', { manual: true })).toEqual({
        allowed: true,
      });
      expect(MANUAL_TRANSITIONS[from]).toEqual(['ignored']);
    }
  });

  it('a porta manual NÃO vira um curinga: só `ignored` se abre para esses dois', () => {
    // Sem esta guarda, acrescentar uma aresta manual seria acrescentar um
    // caminho livre a partir do mesmo estado. `completed` é o caso que mais
    // importa: descartar backlog é diferente de declarar que ele foi executado.
    //
    // ⚠️ A primeira versão deste caso também exigia que `queued → superseded`
    // fosse recusado na porta manual, e a asserção era FALSA: `superseded` é
    // aresta AUTOMÁTICA de `queued` desde o #503 (é como o debounce absorve um
    // irmão). O vermelho a pegou. Registro em vez de apagar porque o conserto
    // tentador era o perigoso — "ajustar" o contrato para satisfazer o teste
    // teria removido uma transição legítima e viva.
    //
    // A invariante correta não é "nada mais se abre a partir daqui", é "a PORTA
    // MANUAL não acrescenta nada além de `ignored`". O conjunto manual é
    // afirmado por extenso; o que já era automático continua sendo, e isso é
    // verificado pelo caso da tabela de transições, não aqui.
    for (const from of ['queued', 'retryable'] as const) {
      expect(
        checkTurnTransition(from, 'completed', 'reply_delivered', { manual: true }).allowed,
      ).toBe(false);
      expect(MANUAL_TRANSITIONS[from]).toHaveLength(1);
    }
    // E o replay de dead letter continua sendo o que era, sem ganhar destinos.
    expect(MANUAL_TRANSITIONS['dead_letter']).toEqual(['queued']);
    expect(
      checkTurnTransition('dead_letter', 'ignored', 'operator_cancelled', { manual: true }).allowed,
    ).toBe(false);
  });

  it('a compatibilidade estado/outcome continua valendo DENTRO da porta manual', () => {
    // A porta manual admite a ARESTA; ela não relaxa o par estado/outcome. Um
    // `retry_exhausted` pertence a `dead_letter`, e atravessar por aqui seria
    // gravar um outcome que o CHECK da migration 097 recusaria no banco — erro
    // que apareceria como exceção de escrita, não como recusa tipada.
    expect(
      checkTurnTransition('queued', 'ignored', 'retry_exhausted', { manual: true }),
    ).toMatchObject({ allowed: false, reason: 'incompatible_outcome' });
    // E terminal sem outcome continua recusado.
    expect(checkTurnTransition('queued', 'ignored', null, { manual: true })).toMatchObject({
      allowed: false,
      reason: 'missing_outcome',
    });
  });

  it('`sourceStatusesFor` revela que a porta manual inclui `running` — e por isso o caller TEM de interseccionar', () => {
    // Esta é a asserção que a fatia do cancelamento depende, e ela existe para
    // um erro específico: `running → ignored` é AUTOMÁTICO (um turno em
    // execução pode se descartar por política), então pedir as origens de
    // `ignored` em modo manual devolve `running` JUNTO. Um caller que passasse
    // esse conjunto direto ao `UPDATE` cancelaria administrativamente um turno
    // que está EXECUTANDO — o oposto do "sem execução/efeito pendente" que a
    // spec exige.
    //
    // Comparação por conjunto ordenado, e não por ordem de array: a ordem aqui é
    // a de `TURN_STATUSES`, um detalhe interno que não deve prender o teste.
    expect([...sourceStatusesFor('ignored')].sort()).toEqual(['received', 'running']);
    expect([...sourceStatusesFor('ignored', { manual: true })].sort()).toEqual(
      ['queued', 'received', 'retryable', 'running'].sort(),
    );
  });
});

describe('turn state machine — estado terminal exige outcome compatível', () => {
  it.each(TERMINAL_TURN_STATUSES)('%s sem outcome é rejeitado', (terminal) => {
    const from = sourceStatusesFor(terminal)[0]!;
    expect(checkTurnTransition(from, terminal, null)).toMatchObject({
      allowed: false,
      reason: 'missing_outcome',
    });
  });

  it('outcome incompatível com o estado terminal é rejeitado', () => {
    // merged_into_turn pertence a `superseded`, não a `completed`.
    expect(checkTurnTransition('running', 'completed', 'merged_into_turn')).toMatchObject({
      allowed: false,
      reason: 'incompatible_outcome',
    });
    // identity_unknown pertence a `ignored`.
    expect(checkTurnTransition('running', 'completed', 'identity_unknown')).toMatchObject({
      allowed: false,
      reason: 'incompatible_outcome',
    });
    // retry_exhausted pertence a `dead_letter`.
    expect(checkTurnTransition('running', 'ignored', 'retry_exhausted')).toMatchObject({
      allowed: false,
      reason: 'incompatible_outcome',
    });
  });

  it('estado NÃO-terminal com outcome é rejeitado', () => {
    expect(checkTurnTransition('received', 'queued', 'reply_delivered')).toMatchObject({
      allowed: false,
      reason: 'outcome_on_non_terminal',
    });
  });

  it('assertTurnTransition lança InvalidTurnTransitionError fail-loud', () => {
    expect(() => assertTurnTransition('outbound_pending', 'running')).toThrow(
      InvalidTurnTransitionError,
    );
    try {
      assertTurnTransition('running', 'completed', 'merged_into_turn');
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTurnTransitionError);
      expect((err as InvalidTurnTransitionError).code).toBe('INVALID_TURN_TRANSITION');
      expect((err as InvalidTurnTransitionError).from).toBe('running');
      expect((err as InvalidTurnTransitionError).to).toBe('completed');
    }
  });
});

describe('turn state machine — sourceStatusesFor (predicado do CAS)', () => {
  it('lista todos os estados que alcançam o destino', () => {
    expect(sourceStatusesFor('queued').sort()).toEqual(['received', 'retryable']);
    expect(sourceStatusesFor('dead_letter').sort()).toEqual([
      'claimed',
      'outbound_pending',
      'retryable',
      'running',
    ]);
    expect(sourceStatusesFor('completed').sort()).toEqual(['outbound_pending', 'running']);
  });

  it('inclui a porta manual quando pedido', () => {
    expect(sourceStatusesFor('queued', { manual: true })).toContain('dead_letter');
    expect(sourceStatusesFor('queued')).not.toContain('dead_letter');
  });
});

describe('turn state machine — erro persistido é sanitizado e limitado', () => {
  it('redige telefone, JID e e-mail', () => {
    const { summary } = sanitizeTurnError({
      code: 'send_failed',
      error: new Error(
        'falha ao enviar para +55 11 98888-7777 (5511988887777@s.whatsapp.net) — avise fulano@exemplo.com',
      ),
    });
    expect(summary).not.toMatch(/98888/);
    expect(summary).not.toMatch(/s\.whatsapp\.net/);
    expect(summary).not.toMatch(/exemplo\.com/);
    expect(summary).toContain('[JID]');
    expect(summary).toContain('[EMAIL]');
    expect(summary).toContain('[NUM]');
  });

  it('redige UUIDs (ids de payload não entram no resumo)', () => {
    const { summary } = sanitizeTurnError({
      error: new Error('row 3f2504e0-4f89-11d3-9a0c-0305e82c3301 not found'),
    });
    expect(summary).toBe('row [UUID] not found');
  });

  it('trunca duro no limite persistível', () => {
    const { summary } = sanitizeTurnError({ error: new Error('x'.repeat(5000)) });
    expect(summary!.length).toBeLessThanOrEqual(TURN_ERROR_SUMMARY_MAX);
    expect(summary!.endsWith('…')).toBe(true);
  });

  it('colapsa espaços e devolve null para mensagem vazia', () => {
    expect(sanitizeTurnError({ error: new Error('  a\n\n  b  ') }).summary).toBe('a b');
    expect(sanitizeTurnError({ error: new Error('   ') }).summary).toBeNull();
    expect(sanitizeTurnError({ code: 'x', error: undefined }).summary).toBeNull();
  });

  it('normaliza o código para label de métrica de baixa cardinalidade', () => {
    expect(normalizeTurnErrorCode('QUEUE_REDIS_UNAVAILABLE')).toBe('queue_redis_unavailable');
    expect(normalizeTurnErrorCode('  Reasoner Timeout! ')).toBe('reasoner_timeout');
    expect(normalizeTurnErrorCode('')).toBe('unknown_error');
    expect(normalizeTurnErrorCode(null)).toBe('unknown_error');
    expect(normalizeTurnErrorCode('x'.repeat(200)).length).toBeLessThanOrEqual(64);
  });

  it('herda o code de err.code quando o chamador não fornece', () => {
    const err = Object.assign(new Error('boom'), { code: 'DEBOUNCER_REDIS_UNAVAILABLE' });
    expect(sanitizeTurnError({ error: err }).code).toBe('debouncer_redis_unavailable');
  });

  it('nunca deriva o code do texto livre da mensagem', () => {
    expect(sanitizeTurnError({ error: new Error('mensagem do usuário vazou') }).code).toBe(
      'unknown_error',
    );
  });
});
