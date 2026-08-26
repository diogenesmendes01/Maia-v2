/**
 * Issue #504 (decisão do dono) — o FENCE PERTENCE A QUEM ABSORVE.
 *
 * `markSuperseded` era UMA operação para dois fatos diferentes, e por isso não
 * tinha fence nenhum:
 *
 *   - AUTO-SUPERSESSÃO — o turno declara a si mesmo absorvido. É gravação da
 *     PRÓPRIA tentativa e tem de levar o `claim_token` do próprio turno.
 *     Enquanto não levava, esta era a única transição TERMINAL que um worker
 *     sem posse conseguia atravessar; e `superseded` é terminal, então o
 *     sucessor perdia o turno sem que nada aparecesse como conflito.
 *
 *   - ABSORÇÃO DE IRMÃO — o turno executor da rajada de debounce absorve o
 *     turno de uma mensagem irmã. A linha que muda é a do IRMÃO; a autoridade é
 *     do ABSORVEDOR. Exigir claim do irmão tornaria a absorção legítima
 *     impossível (o irmão nunca foi reivindicado); não exigir nada deixaria um
 *     worker zumbi absorver turnos do sucessor.
 *
 * Este arquivo prova o comportamento no call site REAL de produção
 * (`absorbDebounceInputs` e `concludeTurn`, em `src/runtime/turns/lifecycle.ts`).
 * O predicado SQL correspondente é provado em
 * `tests/unit/db/turn-fence-sql.spec.ts`, contra a função que o `UPDATE` usa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const repo = {
  markQueued: vi.fn(),
  markClaimed: vi.fn(),
  markRunning: vi.fn(),
  markIgnored: vi.fn(),
  markSupersededSelf: vi.fn(),
  markSupersededByAbsorber: vi.fn(),
  completeTurnTx: vi.fn(),
  markRetryable: vi.fn(),
  markDeadLetter: vi.fn(),
  findTurnByMessage: vi.fn(),
  ensureTurnForMessage: vi.fn(),
  attachInputTx: vi.fn(),
  findById: vi.fn(),
};
const auditSpy = vi.fn();
const reportFenceRejection = vi.fn();
const flags = {
  FEATURE_TURN_STATE_MACHINE: true,
  FEATURE_TURN_STATE_AUTHORITATIVE: false,
  FEATURE_TURN_CLAIM: true,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
};

vi.mock('@/db/repositories/turn-repos.js', () => ({ agentTurnsRepo: repo }));
vi.mock('@/governance/audit.js', () => ({ audit: (...a: unknown[]) => auditSpy(...a) }));
vi.mock('@/config/env.js', () => ({ config: flags }));
vi.mock('@/runtime/turns/lease.js', () => ({
  acquireTurnLease: vi.fn(),
  reportFenceRejection: (...a: unknown[]) => reportFenceRejection(...a),
  turnClaimEnabled: () => flags.FEATURE_TURN_CLAIM,
}));

const { absorbDebounceInputs, concludeTurn } = await import('@/runtime/turns/lifecycle.js');

const TOKEN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Lease dublê com as TRÊS posses possíveis (viva / perdida / inexistente). */
function lease(opts: { alive: boolean; reason?: string } = { alive: true }) {
  return {
    token: opts.alive ? TOKEN : null,
    lostReason: opts.alive ? null : (opts.reason ?? 'expired'),
    markLost: vi.fn(),
    stop: vi.fn(),
    release: vi.fn(),
  };
}

function handle(over: Record<string, unknown> = {}) {
  return {
    turn_id: 'turn-executor',
    status: 'running',
    state_version: 5,
    attempt_count: 1,
    conversa_id: 'conv-1',
    lease: lease(),
    ...over,
  } as never;
}

/** Irmã do debounce: turno próprio, em `received`, SEM claim (o caso normal). */
function sibling(id: string, state_version = 2) {
  return { id, state_version, status: 'received', claim_token: null };
}

function okSuperseded() {
  return {
    ok: true,
    to: 'superseded',
    turn: {
      id: 'turn-irmao',
      status: 'superseded',
      outcome: 'merged_into_turn',
      state_version: 3,
      attempt_count: 0,
      conversa_id: null,
    },
  };
}

beforeEach(() => {
  // `resetAllMocks`, e NÃO `clearAllMocks`: o segundo zera as CHAMADAS mas
  // preserva a fila de `mockResolvedValueOnce`. Um caso que enfileira dois
  // `Once` e consome um só (o da parada por `stale_claim`) deixaria o resto
  // sobrando para o caso seguinte — foi exatamente assim que a asserção de
  // `expected_version` leu a versão da irmã errada e o `retry` do vitest
  // escondeu o vermelho.
  vi.resetAllMocks();
  flags.FEATURE_TURN_STATE_MACHINE = true;
  flags.FEATURE_TURN_STATE_AUTHORITATIVE = false;
  flags.FEATURE_TURN_CLAIM = true;
  repo.markSupersededByAbsorber.mockResolvedValue(okSuperseded());
  repo.attachInputTx.mockResolvedValue({ attached: true });
});

describe('absorção de irmão — o fence é do ABSORVEDOR', () => {
  it('leva o claim_token do ABSORVEDOR e o CAS do IRMÃO', async () => {
    repo.findTurnByMessage.mockResolvedValue(sibling('turn-irmao', 9));

    await absorbDebounceInputs(handle(), ['msg-irma']);

    expect(repo.markSupersededByAbsorber).toHaveBeenCalledTimes(1);
    const args = repo.markSupersededByAbsorber.mock.calls[0]![0] as Record<string, unknown>;
    // A autoridade: quem absorve.
    expect(args['absorber_claim_token']).toBe(TOKEN);
    expect(args['absorbed_by_turn_id']).toBe('turn-executor');
    // O CAS do irmão: é ele que decide a corrida entre duas absorções
    // concorrentes. Sem esta linha, duas absorções que leram o mesmo estado
    // poderiam ambas se declarar vencedoras.
    expect(args['turn_id']).toBe('turn-irmao');
    expect(args['expected_version']).toBe(9);
  });

  /**
   * SONDA 2 — voltar a exigir claim do IRMÃO.
   *
   * O irmão absorvido não tem claim (`claim_token: null` acima é o estado
   * NORMAL dele). Qualquer argumento que peça a posse DELE torna a absorção
   * legítima impossível, e o repositório nem oferece o parâmetro — este caso
   * trava a fronteira para que ninguém o reintroduza pelo call site.
   */
  it('NÃO envia nenhum token do irmão ao repositório', async () => {
    repo.findTurnByMessage.mockResolvedValue(sibling('turn-irmao'));

    await absorbDebounceInputs(handle(), ['msg-irma']);

    const args = repo.markSupersededByAbsorber.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).not.toHaveProperty('expected_claim_token');
    expect(args).not.toHaveProperty('sibling_claim_token');
    expect(Object.keys(args).sort()).toEqual(
      ['absorbed_by_turn_id', 'absorber_claim_token', 'expected_version', 'turn_id'].sort(),
    );
  });

  /**
   * SONDA 1 (metade em memória) — um worker cuja lease JÁ MORREU não absorve.
   *
   * Entre a perda da lease e o takeover existe uma janela em que o token
   * antigo ainda é o vigente no banco: nela, só o predicado SQL aprovaria a
   * escrita. Por isso o guard local recusa ANTES de ir ao banco. A outra
   * metade — o zumbi que ainda não percebeu a perda — é o `EXISTS` provado em
   * `tests/unit/db/turn-fence-sql.spec.ts`.
   */
  it('lease PERDIDA: não absorve, não anexa input, e registra a rejeição', async () => {
    repo.findTurnByMessage.mockResolvedValue(sibling('turn-irmao'));

    await absorbDebounceInputs(handle({ lease: lease({ alive: false, reason: 'expired' }) }), [
      'msg-irma',
      'msg-irma-2',
    ]);

    expect(repo.markSupersededByAbsorber).not.toHaveBeenCalled();
    expect(repo.attachInputTx).not.toHaveBeenCalled();
    expect(reportFenceRejection).toHaveBeenCalledWith(
      expect.objectContaining({ turn_id: 'turn-executor', operation: 'absorb_inputs' }),
    );
  });

  it('lease perdida também barra a irmã SEM turno (o `attachInputTx`)', async () => {
    repo.findTurnByMessage.mockResolvedValue(null);

    await absorbDebounceInputs(handle({ lease: lease({ alive: false }) }), ['msg-orfa']);

    expect(repo.attachInputTx).not.toHaveBeenCalled();
  });

  it('recusa do BANCO (`stale_claim`) PARA a rajada inteira', async () => {
    repo.findTurnByMessage
      .mockResolvedValueOnce(sibling('turn-irmao-1'))
      .mockResolvedValueOnce(sibling('turn-irmao-2'));
    repo.markSupersededByAbsorber.mockResolvedValueOnce({
      ok: false,
      conflict: 'stale_claim',
      to: 'superseded',
      current_status: 'received',
      current_state_version: 3,
    });
    const h = handle();

    await absorbDebounceInputs(h, ['msg-1', 'msg-2']);

    // Uma tentativa, não duas: insistir depois de perder a posse é exatamente
    // o comportamento de zumbi que o fence existe para impedir.
    expect(repo.markSupersededByAbsorber).toHaveBeenCalledTimes(1);
    expect((h as unknown as { lease: { markLost: ReturnType<typeof vi.fn> } }).lease.markLost)
      .toHaveBeenCalledWith('token_mismatch');
    expect(reportFenceRejection).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'absorb_inputs' }),
    );
  });

  it('conflito de ESTADO do irmão não derruba a rajada (não é perda de posse)', async () => {
    repo.findTurnByMessage
      .mockResolvedValueOnce(sibling('turn-irmao-1'))
      .mockResolvedValueOnce(sibling('turn-irmao-2'));
    repo.markSupersededByAbsorber.mockResolvedValueOnce({
      ok: false,
      conflict: 'state_mismatch',
      to: 'superseded',
      current_status: 'claimed',
      current_state_version: 4,
    });

    await absorbDebounceInputs(handle(), ['msg-1', 'msg-2']);

    expect(repo.markSupersededByAbsorber).toHaveBeenCalledTimes(2);
  });

  it('regime de #503 (`FEATURE_TURN_CLAIM` OFF): absorve SEM token, como antes', async () => {
    flags.FEATURE_TURN_CLAIM = false;
    repo.findTurnByMessage.mockResolvedValue(sibling('turn-irmao', 4));

    await absorbDebounceInputs(handle({ lease: null }), ['msg-irma']);

    const args = repo.markSupersededByAbsorber.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).not.toHaveProperty('absorber_claim_token');
    // O CAS do irmão continua — ele não depende de lease nenhuma.
    expect(args['expected_version']).toBe(4);
  });
});

describe('auto-supersessão — o fence é do PRÓPRIO turno', () => {
  it('leva o claim_token do próprio turno', async () => {
    repo.markSupersededSelf.mockResolvedValue(okSuperseded());

    await concludeTurn(handle(), 'merged_into_turn');

    expect(repo.markSupersededSelf).toHaveBeenCalledWith(
      expect.objectContaining({
        turn_id: 'turn-executor',
        expected_version: 5,
        expected_claim_token: TOKEN,
      }),
    );
    // A absorção de irmão é OUTRA operação e não pode ser acionada por aqui.
    expect(repo.markSupersededByAbsorber).not.toHaveBeenCalled();
  });

  it('lease PERDIDA: não conclui como `superseded` (era a única porta sem fence)', async () => {
    await concludeTurn(handle({ lease: lease({ alive: false, reason: 'released' }) }), 'merged_into_turn');

    expect(repo.markSupersededSelf).not.toHaveBeenCalled();
    expect(reportFenceRejection).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'conclude_merged_into_turn' }),
    );
  });

  it('regime de #503: conclui sem token', async () => {
    flags.FEATURE_TURN_CLAIM = false;
    repo.markSupersededSelf.mockResolvedValue(okSuperseded());

    await concludeTurn(handle({ lease: null }), 'merged_into_turn');

    const args = repo.markSupersededSelf.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).not.toHaveProperty('expected_claim_token');
  });
});
