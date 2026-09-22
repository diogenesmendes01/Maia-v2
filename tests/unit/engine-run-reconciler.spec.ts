/**
 * Spec Maia+Hermes §5.8.2/§5.8.4, INV-06, INV-09 — o CONTRATO do reconciliador
 * de runs do motor (`src/workers/engine-run-reconciler.ts`).
 *
 * O worker é o consumidor que faltava para `listDueRuns` e `classifyRecovery`.
 * O que ele promete, e que nenhum compilador cobra:
 *
 *   1. **A perda de fence é recusa, não escrita.** O CAS do registro vem ANTES
 *      de qualquer mudança de fase; quando ele falha, nem revogação, nem
 *      bloqueio, nem fechamento acontecem;
 *   2. **INV-06.** Um run em `submitting`/`submission_unknown` nunca é
 *      declarado morto. Nenhum caminho o fecha — ele observa e, no limite do
 *      prazo, vai para `blocked`, que é gente olhando, não desfecho inventado;
 *   3. **A adoção continua sendo do dono.** Um `result_ready` cujo turno ainda
 *      é reivindicável é DEIXADO para quem tiver o claim; o scanner só fecha o
 *      ÓRFÃO, que é o run cujo dono não volta (§5.7.3 item 5);
 *   4. **Run fechado não é reprocessado** — duas camadas independentes.
 *
 * Toda promessa vem com CONTRA-PROVA: um caso vizinho em que a mesma função
 * decide DIFERENTE. Sem isso, uma implementação que recusasse sempre (ou
 * observasse sempre) passaria por vacuidade.
 *
 * Puro: nenhum caso toca banco, fila ou rede — o worker recebe o repositório
 * por injeção.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  RECONCILE_CODES,
  planRunReconciliation,
  reconcileDueRun,
  runEngineRunReconciler,
  type EngineJournalMaintenancePortV1,
  type ReconcileActionV1,
} from '@/workers/engine-run-reconciler.js';
import { RECOVERY_DISPOSITIONS, type RecoveryDisposition } from '@/runtime/engines/recovery.js';
import type { DueRun, RunRecoveryFacts } from '@/db/repositories/engine-repos.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const TURNO = '22222222-2222-4222-8222-222222222222';

/** Fatos mínimos e INERTES: nada pendente, nada decidido, prazo em dia. */
function fatos(over: Partial<RunRecoveryFacts> = {}): RunRecoveryFacts {
  return {
    run_id: RUN,
    turn_id: TURNO,
    phase: 'running',
    turn_status: 'running',
    lease_alive: false,
    control_mode: 'bot',
    has_terminal: false,
    adopted: false,
    unreconciled_calls: 0,
    effect_unknown_calls: 0,
    outbound_rows: 0,
    outbound_completed: 0,
    remote_run_id_known: true,
    capabilities_revoked: false,
    reconcile_deadline_passed: false,
    ...over,
  };
}

function due(over: Partial<DueRun> = {}): DueRun {
  return {
    run_id: RUN,
    turn_id: TURNO,
    phase: 'running',
    next_poll_at: '2026-01-01T00:00:00.000Z',
    turn_status: 'running',
    maintenance_only: false,
    ...over,
  };
}

type RepoOverrides = Partial<EngineJournalMaintenancePortV1>;

/**
 * Repositório de mentira cujo default é o CAMINHO FELIZ: a reserva concede, os
 * fatos existem, o registro grava. Cada caso sobrescreve só a porta que está
 * sob exame — é assim que a asserção "as outras não foram chamadas" significa
 * alguma coisa.
 */
function repoFalso(fatosDoRun: RunRecoveryFacts, over: RepoOverrides = {}) {
  const espioes = {
    reserveMaintenanceObservation: vi.fn(async () => ({
      ok: true as const,
      reserved_row_version: 7,
      next_poll_at: '2026-01-01T00:01:00.000Z',
    })),
    readRecoveryFacts: vi.fn(async () => fatosDoRun),
    recordMaintenanceObservation: vi.fn(async () => ({ ok: true as const, row_version: 8 })),
    revokeRunCapabilities: vi.fn(async () => ({
      ok: true as const,
      revoked_at: '2026-01-01T00:00:00.000Z',
      already: false,
    })),
    markRunBlocked: vi.fn(async () => ({
      ok: true as const,
      row_version: 9,
      already_blocked: false,
    })),
    closeRunAfterHandoff: vi.fn(async () => ({
      ok: true as const,
      row_version: 9,
      already_closed: false,
    })),
    enumerateDueScopes: vi.fn(async () => ({ scopes: [], next_cursor: null })),
    listDueRuns: vi.fn(async () => ({ runs: [], next_cursor: null })),
  };
  return {
    espioes,
    repo: { ...espioes, ...over } as unknown as EngineJournalMaintenancePortV1,
  };
}

// ---------------------------------------------------------------------------
// 1. O plano é total, fechado e DISCRIMINA
// ---------------------------------------------------------------------------

describe('o plano é total e o vocabulário é fechado', () => {
  it('toda disposição do §5.8.2 tem plano, e o código está na lista fechada', () => {
    for (const d of RECOVERY_DISPOSITIONS) {
      const acao = planRunReconciliation(d, fatos());
      expect(RECONCILE_CODES, `código de ${d}`).toContain(acao.code);
    }
  });

  it('CONTRA-PROVA: o plano NÃO é constante — as quatro ações aparecem', () => {
    // Uma implementação que devolvesse sempre `observe` passaria no caso
    // acima e morreria aqui. É a diferença entre "responde" e "decide".
    const vistos = new Set<ReconcileActionV1['kind']>();
    const amostras: Array<[RecoveryDisposition, RunRecoveryFacts]> = [
      ['nothing_to_do', fatos()],
      ['block', fatos({ phase: 'blocked' })],
      ['revoke_and_observe', fatos({ capabilities_revoked: false })],
      ['maintenance_only', fatos({ turn_status: 'dead_letter' })],
    ];
    for (const [d, f] of amostras) vistos.add(planRunReconciliation(d, f).kind);
    expect([...vistos].sort()).toEqual(['block', 'close_orphan', 'observe', 'revoke']);
  });

  it('nenhum plano consegue pedir a retomada da sequência de ferramentas', () => {
    // INV-09 pelo mesmo mecanismo de `RECOVERY_DISPOSITIONS`: o tipo não tem
    // membro que signifique "reexecute as tools", então nenhum call site
    // consegue pedi-lo. A asserção é sobre o VOCABULÁRIO, não sobre um caminho.
    const kinds = RECOVERY_DISPOSITIONS.map((d) => planRunReconciliation(d, fatos()).kind);
    expect(kinds.every((k) => ['observe', 'revoke', 'close_orphan', 'block'].includes(k))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. INV-06 — `submission_unknown` NÃO é declarado morto
// ---------------------------------------------------------------------------

describe('INV-06 — submissão incerta não vira run morto', () => {
  it('`submission_unknown` sem prova observa e NÃO fecha nem revoga', async () => {
    const f = fatos({ phase: 'submission_unknown', turn_status: 'retryable' });
    const { repo, espioes } = repoFalso(f);

    const r = await reconcileDueRun(repo, due({ phase: 'submission_unknown' }));

    expect(r).toEqual({ result: 'acted', code: 'awaiting_engine_lookup' });
    expect(espioes.closeRunAfterHandoff).not.toHaveBeenCalled();
    expect(espioes.markRunBlocked).not.toHaveBeenCalled();
  });

  it('`submitting` também não fecha — o run pode ter sido aceito', async () => {
    const f = fatos({ phase: 'submitting', remote_run_id_known: false });
    const { repo, espioes } = repoFalso(f);

    await reconcileDueRun(repo, due({ phase: 'submitting' }));

    expect(espioes.closeRunAfterHandoff).not.toHaveBeenCalled();
  });

  it('CONTRA-PROVA: passado o prazo ele vai para `blocked` — e não some', async () => {
    // Sem esta perna, a promessa "não declara morto" seria satisfeita por um
    // worker que simplesmente nunca faz nada. O desfecho existe; ele é uma
    // PESSOA, não um fechamento fabricado.
    const f = fatos({ phase: 'submission_unknown', reconcile_deadline_passed: true });
    const { repo, espioes } = repoFalso(f);

    const r = await reconcileDueRun(repo, due({ phase: 'submission_unknown' }));

    expect(r).toEqual({ result: 'acted', code: 'blocked_after_deadline' });
    expect(espioes.markRunBlocked).toHaveBeenCalledTimes(1);
    expect(espioes.closeRunAfterHandoff).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. `result_ready` — o órfão fecha, o do dono vivo não
// ---------------------------------------------------------------------------

describe('result_ready: o scanner fecha o ÓRFÃO e não rouba a adoção do dono', () => {
  it('turno fora de `RECOVERABLE_TURN_STATUSES` ⇒ fechado como `safe_to_retry`', async () => {
    // §5.7.3 item 5: "o scanner fecha órfãos com actor_kind=recovery". É o que
    // tira o turno do limbo — o run sai de `phase IN (abertas)` e
    // `routeExistingEngineRun` volta a devolver `run_pipeline`.
    const f = fatos({
      phase: 'result_ready',
      has_terminal: true,
      turn_status: 'dead_letter',
      lease_alive: false,
    });
    const { repo, espioes } = repoFalso(f);

    const r = await reconcileDueRun(repo, due({ phase: 'result_ready' }));

    expect(r).toEqual({ result: 'acted', code: 'orphan_closed' });
    expect(espioes.closeRunAfterHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: RUN,
        turn_id: TURNO,
        decision: 'safe_to_retry',
        actor: expect.objectContaining({ kind: 'recovery' }),
        // O fence ENCADEADO: a versão que o registro devolveu, não a da
        // reserva — o registro já consumiu a reserva e incrementou a linha.
        expected_row_version: 8,
      }),
    );
  });

  it('CONTRA-PROVA: turno ainda reivindicável ⇒ só observa, esperando o dono adotar', async () => {
    // `adoptTerminalResult` exige claim vivo + `running`, e a reserva de
    // manutenção só existe quando o dono sumiu. Fechar aqui jogaria fora um
    // terminal que um novo dono ainda pode adotar — o "pagar outra
    // deliberação" que o §5.8.2 proíbe.
    const f = fatos({
      phase: 'result_ready',
      has_terminal: true,
      turn_status: 'retryable',
      lease_alive: false,
    });
    const { repo, espioes } = repoFalso(f);

    const r = await reconcileDueRun(repo, due({ phase: 'result_ready' }));

    expect(r).toEqual({ result: 'acted', code: 'awaiting_owner_adoption' });
    expect(espioes.closeRunAfterHandoff).not.toHaveBeenCalled();
    expect(espioes.markRunBlocked).not.toHaveBeenCalled();
  });

  it('órfão COM saída no outbox não é fechado — `safe_to_retry` afirmaria o falso', async () => {
    const f = fatos({
      phase: 'result_ready',
      has_terminal: true,
      turn_status: 'completed',
      outbound_rows: 1,
      outbound_completed: 1,
    });
    const { repo, espioes } = repoFalso(f);

    const r = await reconcileDueRun(repo, due({ phase: 'result_ready' }));

    expect(r.code).toBe('metadata_only');
    expect(espioes.closeRunAfterHandoff).not.toHaveBeenCalled();
  });

  it('órfão com efeito não liquidado não é fechado (invariante 7)', async () => {
    const f = fatos({
      phase: 'result_ready',
      has_terminal: true,
      turn_status: 'completed',
      unreconciled_calls: 1,
      effect_unknown_calls: 1,
    });
    const { repo, espioes } = repoFalso(f);

    await reconcileDueRun(repo, due({ phase: 'result_ready' }));

    expect(espioes.closeRunAfterHandoff).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. O FENCE — perda é recusa, e recusa não escreve
// ---------------------------------------------------------------------------

describe('o fence: perder a corrida é recusa, nunca escrita', () => {
  it('`reservation_stale` no registro impede TODA ação de estado', async () => {
    const f = fatos({ phase: 'result_ready', has_terminal: true, turn_status: 'dead_letter' });
    const { repo, espioes } = repoFalso(f, {
      recordMaintenanceObservation: vi.fn(async () => ({
        ok: false as const,
        reason: 'reservation_stale' as const,
        current_row_version: 99,
      })),
    });

    const r = await reconcileDueRun(repo, due({ phase: 'result_ready' }));

    expect(r).toEqual({ result: 'refused', code: 'reservation_stale' });
    // O caso gêmeo acima FECHA com estes mesmos fatos. A única diferença é o
    // CAS — é isso que prova que o fence é o que segura a escrita.
    expect(espioes.closeRunAfterHandoff).not.toHaveBeenCalled();
    expect(espioes.markRunBlocked).not.toHaveBeenCalled();
    expect(espioes.revokeRunCapabilities).not.toHaveBeenCalled();
  });

  it('reserva recusada (`not_due`) nem chega a ler os fatos', async () => {
    const f = fatos();
    const { repo, espioes } = repoFalso(f, {
      reserveMaintenanceObservation: vi.fn(async () => ({
        ok: false as const,
        reason: 'not_due' as const,
        next_poll_at: '2026-01-01T00:05:00.000Z',
      })),
    });

    const r = await reconcileDueRun(repo, due());

    expect(r).toEqual({ result: 'skipped', code: 'not_due' });
    expect(espioes.readRecoveryFacts).not.toHaveBeenCalled();
    expect(espioes.recordMaintenanceObservation).not.toHaveBeenCalled();
  });

  it('`owner_alive` para a varredura: quem tem a posse decide', async () => {
    const { repo, espioes } = repoFalso(fatos(), {
      reserveMaintenanceObservation: vi.fn(async () => ({
        ok: false as const,
        reason: 'owner_alive' as const,
        turn_status: 'running',
      })),
    });

    const r = await reconcileDueRun(repo, due());

    expect(r).toEqual({ result: 'skipped', code: 'owner_alive' });
    expect(espioes.recordMaintenanceObservation).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. CONTRA-PROVA CENTRAL — run fechado não é reprocessado
// ---------------------------------------------------------------------------

describe('run fechado não volta para a varredura', () => {
  it('a reserva recusa com `phase_conflict` e nada é escrito', async () => {
    const { repo, espioes } = repoFalso(fatos({ phase: 'closed' }), {
      reserveMaintenanceObservation: vi.fn(async () => ({
        ok: false as const,
        reason: 'phase_conflict' as const,
        current_phase: 'closed' as const,
      })),
    });

    const r = await reconcileDueRun(repo, due({ phase: 'closed' }));

    expect(r).toEqual({ result: 'skipped', code: 'phase_conflict' });
    expect(espioes.recordMaintenanceObservation).not.toHaveBeenCalled();
    expect(espioes.closeRunAfterHandoff).not.toHaveBeenCalled();
  });

  it('CONTRA-PROVA: com a reserva concedida o MESMO run seria processado', async () => {
    // Anti-vacuidade do caso acima: ele só significa algo se o worker de fato
    // agiria caso a reserva concedesse. É a reserva que barra, não uma
    // desistência silenciosa em algum ponto anterior.
    const f = fatos({ phase: 'result_ready', has_terminal: true, turn_status: 'dead_letter' });
    const { repo, espioes } = repoFalso(f);

    const r = await reconcileDueRun(repo, due({ phase: 'result_ready' }));

    expect(r.result).toBe('acted');
    expect(espioes.recordMaintenanceObservation).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Revogação e controle humano
// ---------------------------------------------------------------------------

describe('revogação é monotônica e o controle humano não vira incidente', () => {
  it('run sem dono e com ID remoto revoga capacidades antes de observar', async () => {
    const f = fatos({ phase: 'running', lease_alive: false, remote_run_id_known: true });
    const { repo, espioes } = repoFalso(f);

    const r = await reconcileDueRun(repo, due());

    expect(r).toEqual({ result: 'acted', code: 'capabilities_revoked' });
    expect(espioes.revokeRunCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: RUN, turn_id: TURNO, reason_code: 'recovery_owner_lost' }),
    );
  });

  it('CONTRA-PROVA: já revogado ⇒ nenhuma transação nova', async () => {
    const f = fatos({ phase: 'running', lease_alive: false, capabilities_revoked: true });
    const { repo, espioes } = repoFalso(f);

    const r = await reconcileDueRun(repo, due());

    expect(r).toEqual({ result: 'acted', code: 'capabilities_revoked' });
    expect(espioes.revokeRunCapabilities).not.toHaveBeenCalled();
  });

  it('conversa em mão humana nunca vai para `blocked`, mesmo com o prazo vencido', async () => {
    // Tomada humana é operação NORMAL. Mandá-la para a fila de intervenção
    // encheria a DLQ de eventos que já têm dono — o atendente.
    const f = fatos({
      phase: 'running',
      control_mode: 'human',
      lease_alive: false,
      turn_status: 'retryable',
      reconcile_deadline_passed: true,
    });
    const { repo, espioes } = repoFalso(f);

    const r = await reconcileDueRun(repo, due());

    expect(r).toEqual({ result: 'acted', code: 'human_control' });
    expect(espioes.markRunBlocked).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7. O tick — isolamento e fail-isolation
// ---------------------------------------------------------------------------

describe('o tick varre por par e isola falhas', () => {
  it('todo run é visitado DENTRO do escopo do par, nunca fora', async () => {
    const escopos: Array<{ tenant_id: string; agent_id: string }> = [];
    let escopoCorrente: string | null = null;
    const vistosSobEscopo: string[] = [];

    const f = fatos({ phase: 'running', lease_alive: false, capabilities_revoked: true });
    const { repo: base, espioes } = repoFalso(f);
    const repo = {
      ...base,
      enumerateDueScopes: vi.fn(async () => ({
        scopes: [{ tenant_id: 'primary', agent_id: 'maia' }],
        next_cursor: null,
      })),
      listDueRuns: vi.fn(async () => {
        vistosSobEscopo.push(escopoCorrente ?? 'SEM_ESCOPO');
        return { runs: [due()], next_cursor: null };
      }),
    } as unknown as EngineJournalMaintenancePortV1;

    const stats = await runEngineRunReconciler({
      repo,
      withScope: async (scope, fn) => {
        escopos.push(scope);
        escopoCorrente = `${scope.tenant_id}/${scope.agent_id}`;
        try {
          return await fn();
        } finally {
          escopoCorrente = null;
        }
      },
    });

    expect(escopos).toEqual([{ tenant_id: 'primary', agent_id: 'maia' }]);
    expect(vistosSobEscopo).toEqual(['primary/maia']);
    expect(stats).toMatchObject({ scopes: 1, runs_seen: 1, acted: 1 });
    expect(espioes.recordMaintenanceObservation).toHaveBeenCalledTimes(1);
  });

  it('um par que explode não cala os outros', async () => {
    const f = fatos({ phase: 'running', lease_alive: false, capabilities_revoked: true });
    const { repo: base } = repoFalso(f);
    let chamada = 0;
    const repo = {
      ...base,
      enumerateDueScopes: vi.fn(async () => ({
        scopes: [
          { tenant_id: 'doente', agent_id: 'a' },
          { tenant_id: 'saudavel', agent_id: 'b' },
        ],
        next_cursor: null,
      })),
      listDueRuns: vi.fn(async () => {
        chamada++;
        if (chamada === 1) throw new Error('banco do tenant doente caiu');
        return { runs: [due()], next_cursor: null };
      }),
    } as unknown as EngineJournalMaintenancePortV1;

    const stats = await runEngineRunReconciler({
      repo,
      withScope: async (_scope, fn) => fn(),
    });

    expect(stats.scopes_failed).toBe(1);
    expect(stats.scopes).toBe(1);
    expect(stats.acted).toBe(1);
  });

  it('CONTRA-PROVA: sem par vencido o tick não toca em nada', async () => {
    const { repo: base, espioes } = repoFalso(fatos());
    const repo = {
      ...base,
      enumerateDueScopes: vi.fn(async () => ({ scopes: [], next_cursor: null })),
    } as unknown as EngineJournalMaintenancePortV1;

    const stats = await runEngineRunReconciler({ repo, withScope: async (_s, fn) => fn() });

    expect(stats.runs_seen).toBe(0);
    expect(espioes.reserveMaintenanceObservation).not.toHaveBeenCalled();
  });
});
