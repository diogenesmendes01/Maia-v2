/**
 * P02.0 (spec §5.3) — CONTRATOS DA PORTA DE ENGINE.
 *
 * `AgentEnginePortV1` é a fronteira entre o turno da Maia e QUALQUER motor de
 * raciocínio — o local (`maia_react`) e o remoto (`hermes`). Os schemas deste
 * arquivo são o que impede que a fronteira vire um canal de autoridade.
 *
 * Três coisas que a spec exige e que este arquivo prende:
 *
 *  1. **A proposta terminal do motor não é autoritativa.** `EngineTerminalProposalV1`
 *     não admite `dispatched`, `persistUnknown`, `sideEffectsCommitted`,
 *     destinatário, grants, claim token ou lista de efeitos: essas estruturas
 *     são exclusivamente da Maia (§5.3.3). Um motor que “avisa” que entregou a
 *     mensagem precisa ser recusado no schema, não desmentido depois.
 *  2. **Dinheiro não é float.** `max_cost_microusd` e o custo reportado são
 *     inteiros decimais em STRING (§5.3.1). Um `number` aqui é erro de
 *     arredondamento em ledger financeiro.
 *  3. **Snapshot de contexto não carrega credencial.** `HostContextSnapshotV1`
 *     é contexto protegido da Maia, nunca material de autenticação: o
 *     `claim_token` fica só no banco (§5.6.1).
 */
import { describe, it, expect } from 'vitest';
import {
  engineRequestV1Schema,
  engineTerminalProposalV1Schema,
  engineToolCallV1Schema,
  engineToolReplyV1Schema,
  hostContextSnapshotV1Schema,
  enginePinV1Schema,
  engineObservationV1Schema,
  engineStartResultV1Schema,
  ENGINE_RUN_PHASES,
  ENGINE_TOOL_CALL_STATES,
  ENGINE_CLOSE_REASONS,
  ENGINE_KINDS,
} from '@/runtime/engines/schemas.js';

const RUN = '3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70';
const KEY = '8a1e2c3d-4b5a-4c7d-8e9f-0a1b2c3d4e5f';
const SHA = 'a'.repeat(64);

const request = (over: Record<string, unknown> = {}) => ({
  version: 1,
  run_id: RUN,
  request_key: KEY,
  task: 'reasoner',
  isolation: 'one_run_no_shared_memory',
  context: {
    system: 'instruções aprovadas',
    messages: [{ role: 'user', content: '<user_message>oi</user_message>' }],
    tools: [{ name: 'fixture_echo', description: 'eco', input_schema: { type: 'object' } }],
  },
  limits: {
    max_iterations: 5,
    max_output_tokens_per_call: 1024,
    max_tool_calls: 4,
    deadline_at: '2026-09-15T23:00:00.000Z',
    max_cost_microusd: '250000',
  },
  ...over,
});

const proposal = (over: Record<string, unknown> = {}) => ({
  version: 1,
  run_id: RUN,
  request_key: KEY,
  stop: { kind: 'reply', raw_text: 'candidato' },
  iterations: 2,
  observed_tool_call_ids: [`${RUN}:0`, `${RUN}:1`],
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cost_microusd: null,
    source: 'engine_reported',
  },
  ...over,
});

const snapshot = (over: Record<string, unknown> = {}) => ({
  version: 1,
  tenant_id: 'primary',
  agent_id: 'primary',
  turn_id: RUN,
  pessoa_id: KEY,
  conversa_id: KEY,
  channel_id: KEY,
  representative_message_id: KEY,
  input_message_ids: [KEY],
  stream_key: 'wa:primary:primary:5511999999999',
  control_id: KEY,
  control_epoch: '7',
  remote_jid: '5511999999999@s.whatsapp.net',
  trace_id: 'trace-1',
  active_role_id: null,
  active_execution_id: null,
  outbound_prefix: null,
  allowed_entity_ids: [KEY],
  allowed_tool_names: ['fixture_echo'],
  policy_digest: SHA,
  source_versions: [{ kind: 'role', id: KEY, version: null }],
  ...over,
});

// ─── enums do §5.3.1 ────────────────────────────────────────────────────────

describe('enums duráveis do contrato', () => {
  it('as fases do run são exatamente as nove da spec §5.6.2', () => {
    expect([...ENGINE_RUN_PHASES]).toEqual([
      'prepared',
      'submitting',
      'submission_unknown',
      'running',
      'cancelling',
      'reconciling',
      'result_ready',
      'blocked',
      'closed',
    ]);
  });

  it('os estados de tool call e os motivos de fechamento são os da spec', () => {
    expect([...ENGINE_TOOL_CALL_STATES]).toEqual([
      'received',
      'dispatching',
      'handler_started',
      'completed',
      'denied',
      'approval_required',
      'effect_unknown',
      'cancelled',
    ]);
    expect([...ENGINE_CLOSE_REASONS]).toEqual([
      'handed_to_outbox',
      'completed_no_reply',
      'safe_to_retry',
      'discarded',
      'manual_resolved',
    ]);
  });

  it('o enum de engine persistido é `maia_react | hermes` (rótulo de UI não entra)', () => {
    expect([...ENGINE_KINDS]).toEqual(['maia_react', 'hermes']);
    expect(enginePinV1Schema.safeParse({
      engine: 'Maia',
      adapter_revision: 'v1',
      configuration_digest: SHA,
      protocol_version: 1,
    }).success).toBe(false);
  });
});

// ─── EngineRequestV1 ────────────────────────────────────────────────────────

describe('EngineRequestV1 — o pedido durável', () => {
  it('aceita o pedido canônico', () => {
    expect(engineRequestV1Schema.safeParse(request()).success).toBe(true);
  });

  it.each([
    ['api_key', 'sk-secreto'],
    ['claim_token', RUN],
    ['tenant_id', 'primary'],
    ['pessoa_id', KEY],
    ['callback_url', 'http://x/y'],
  ])('recusa credencial/autoridade no pedido: %s', (chave, valor) => {
    expect(engineRequestV1Schema.safeParse(request({ [chave as string]: valor })).success).toBe(
      false,
    );
  });

  it('custo é inteiro decimal em string, nunca número', () => {
    const comNumero = request();
    (comNumero.limits as Record<string, unknown>).max_cost_microusd = 250000;
    expect(engineRequestV1Schema.safeParse(comNumero).success).toBe(false);

    for (const ruim of ['25.5', '-1', '1e5', '', 'abc', '007']) {
      const r = request();
      (r.limits as Record<string, unknown>).max_cost_microusd = ruim;
      expect(engineRequestV1Schema.safeParse(r).success, `aceitou ${ruim}`).toBe(false);
    }
  });

  it('limites precisam ser finitos e positivos, e o prazo é instante absoluto', () => {
    for (const patch of [
      { max_iterations: 0 },
      { max_tool_calls: 0 },
      { max_output_tokens_per_call: 0 },
      { deadline_at: 'amanhã' },
      { deadline_at: 1_760_000_000_000 },
    ]) {
      const r = request();
      Object.assign(r.limits as Record<string, unknown>, patch);
      expect(engineRequestV1Schema.safeParse(r).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it('task e isolamento são literais fechados', () => {
    expect(engineRequestV1Schema.safeParse(request({ task: 'classificar' })).success).toBe(false);
    expect(
      engineRequestV1Schema.safeParse(request({ isolation: 'shared_memory' })).success,
    ).toBe(false);
  });
});

// ─── EngineTerminalProposalV1 ───────────────────────────────────────────────

describe('EngineTerminalProposalV1 — proposta NÃO autoritativa', () => {
  it('aceita a proposta canônica e os quatro desfechos', () => {
    expect(engineTerminalProposalV1Schema.safeParse(proposal()).success).toBe(true);
    for (const stop of [
      { kind: 'no_reply', reason: 'empty_final_text' },
      { kind: 'no_reply', reason: 'iteration_cap' },
      { kind: 'failed', code: 'reasoner_failed' },
      { kind: 'failed', code: 'deadline_exceeded' },
      { kind: 'failed', code: 'protocol_error' },
      { kind: 'cancelled', reason: 'ownership_lost' },
      { kind: 'cancelled', reason: 'operator' },
      { kind: 'cancelled', reason: 'shutdown' },
    ]) {
      expect(
        engineTerminalProposalV1Schema.safeParse(proposal({ stop })).success,
        JSON.stringify(stop),
      ).toBe(true);
    }
  });

  it.each([
    'dispatched',
    'persistUnknown',
    'sideEffectsCommitted',
    'delivery',
    'effects',
    'outbound_ids',
    'approved',
    'grants',
  ])('recusa o campo exclusivo da Maia: %s', (chave) => {
    expect(engineTerminalProposalV1Schema.safeParse(proposal({ [chave]: true })).success).toBe(
      false,
    );
  });

  it('ids de tool call observados não podem repetir (§5.3.4)', () => {
    expect(
      engineTerminalProposalV1Schema.safeParse(
        proposal({ observed_tool_call_ids: [`${RUN}:0`, `${RUN}:0`] }),
      ).success,
    ).toBe(false);
  });

  it('custo desconhecido é null — nunca zero fabricado', () => {
    const comZero = proposal();
    (comZero.usage as Record<string, unknown>).cost_microusd = '0';
    // '0' é um custo MEDIDO de zero e continua válido; o que o schema não pode
    // aceitar é um número, que abriria a porta para float financeiro.
    expect(engineTerminalProposalV1Schema.safeParse(comZero).success).toBe(true);

    const comNumero = proposal();
    (comNumero.usage as Record<string, unknown>).cost_microusd = 0;
    expect(engineTerminalProposalV1Schema.safeParse(comNumero).success).toBe(false);
  });

  it('reply vazio (inclusive só espaços) não é reply', () => {
    for (const raw_text of ['', '   \n']) {
      expect(
        engineTerminalProposalV1Schema.safeParse(proposal({ stop: { kind: 'reply', raw_text } }))
          .success,
      ).toBe(false);
    }
  });
});

// ─── Tool call / reply ──────────────────────────────────────────────────────

describe('EngineToolCallV1 / EngineToolReplyV1', () => {
  const call = (over: Record<string, unknown> = {}) => ({
    version: 1,
    run_id: RUN,
    call_id: `${RUN}:0`,
    ordinal: 0,
    iteration: null,
    name: 'fixture_echo',
    args: { texto: 'oi' },
    ...over,
  });

  it('iteration null é válido — o handler comum do Hermes não recebe o número autoritativo', () => {
    expect(engineToolCallV1Schema.safeParse(call()).success).toBe(true);
    expect(engineToolCallV1Schema.safeParse(call({ iteration: 3 })).success).toBe(true);
    expect(engineToolCallV1Schema.safeParse(call({ iteration: 0 })).success).toBe(false);
  });

  it('ordinal começa em zero e não admite negativo nem fracionário', () => {
    expect(engineToolCallV1Schema.safeParse(call({ ordinal: 0 })).success).toBe(true);
    expect(engineToolCallV1Schema.safeParse(call({ ordinal: -1 })).success).toBe(false);
    expect(engineToolCallV1Schema.safeParse(call({ ordinal: 1.5 })).success).toBe(false);
  });

  it('a chamada não carrega contexto de autorização', () => {
    for (const chave of ['pessoa', 'scope', 'grants', 'tenant_id', 'claim_token', 'approved']) {
      expect(engineToolCallV1Schema.safeParse(call({ [chave]: 'x' })).success).toBe(false);
    }
  });

  it('as três respostas do §5.3.2 e seus códigos fechados', () => {
    expect(
      engineToolReplyV1Schema.safeParse({
        kind: 'result',
        call_id: `${RUN}:0`,
        result: { saldo: '10.00' },
        is_error: false,
      }).success,
    ).toBe(true);
    expect(
      engineToolReplyV1Schema.safeParse({
        kind: 'in_progress',
        call_id: `${RUN}:0`,
        retry_after_ms: 250,
      }).success,
    ).toBe(true);
    expect(
      engineToolReplyV1Schema.safeParse({
        kind: 'refused',
        call_id: `${RUN}:0`,
        code: 'tool_not_allowed',
      }).success,
    ).toBe(true);
    expect(
      engineToolReplyV1Schema.safeParse({
        kind: 'refused',
        call_id: `${RUN}:0`,
        code: 'porque_sim',
      }).success,
    ).toBe(false);
  });
});

// ─── HostContextSnapshotV1 ──────────────────────────────────────────────────

describe('HostContextSnapshotV1 — contexto protegido, não credencial', () => {
  it('aceita o snapshot canônico com controle de conversa', () => {
    const r = hostContextSnapshotV1Schema.safeParse(snapshot());
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues[0])).toBe(true);
  });

  it('recusa material de autenticação no snapshot (§5.6.1: o token fica no banco)', () => {
    for (const chave of ['claim_token', 'api_key', 'bearer', 'origin_claim_token']) {
      expect(hostContextSnapshotV1Schema.safeParse(snapshot({ [chave]: RUN })).success).toBe(false);
    }
  });

  it('control_epoch é string decimal (bigint do Postgres não cabe em number)', () => {
    expect(hostContextSnapshotV1Schema.safeParse(snapshot({ control_epoch: 7 })).success).toBe(
      false,
    );
    expect(
      hostContextSnapshotV1Schema.safeParse({
        ...snapshot(),
        control_epoch: '9007199254740993',
      }).success,
    ).toBe(true);
    for (const ruim of ['-1', '1.5', '007', '']) {
      expect(
        hostContextSnapshotV1Schema.safeParse(snapshot({ control_epoch: ruim })).success,
        ruim,
      ).toBe(false);
    }
  });

  it('allowed_tool_names é o resultado pós-reduções, e a lista vazia é válida', () => {
    expect(hostContextSnapshotV1Schema.safeParse(snapshot({ allowed_tool_names: [] })).success).toBe(
      true,
    );
  });
});

// ─── Observação e início ────────────────────────────────────────────────────

describe('EngineStartResultV1 / EngineObservationV1', () => {
  it('“não aceito” exige a prova explícita; “desconhecido” não a tem', () => {
    expect(
      engineStartResultV1Schema.safeParse({
        kind: 'rejected',
        definitely_not_accepted: true,
        code: 'admission_refused',
      }).success,
    ).toBe(true);
    // `definitely_not_accepted: false` não existe: ou há prova, ou é `unknown`.
    expect(
      engineStartResultV1Schema.safeParse({
        kind: 'rejected',
        definitely_not_accepted: false,
        code: 'admission_refused',
      }).success,
    ).toBe(false);
    expect(engineStartResultV1Schema.safeParse({ kind: 'unknown', code: 'timeout' }).success).toBe(
      true,
    );
  });

  it('observação `not_found` precisa dizer se a prova é conclusiva', () => {
    expect(
      engineObservationV1Schema.safeParse({
        kind: 'not_found',
        proof: 'definitely_not_accepted',
      }).success,
    ).toBe(true);
    expect(
      engineObservationV1Schema.safeParse({ kind: 'not_found', proof: 'inconclusive' }).success,
    ).toBe(true);
    expect(engineObservationV1Schema.safeParse({ kind: 'not_found' }).success).toBe(false);
  });

  it('terminal observado carrega a proposta completa, e não um texto solto', () => {
    expect(
      engineObservationV1Schema.safeParse({
        kind: 'terminal',
        remote_run_id: 'w-1',
        proposal: proposal(),
      }).success,
    ).toBe(true);
    expect(
      engineObservationV1Schema.safeParse({
        kind: 'terminal',
        remote_run_id: 'w-1',
        proposal: { texto: 'oi' },
      }).success,
    ).toBe(false);
  });
});
