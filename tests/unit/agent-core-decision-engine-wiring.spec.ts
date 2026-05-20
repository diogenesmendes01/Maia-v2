/**
 * P9b — Agent core × Decision Engine wiring: 8 tests per spec §12 + task brief.
 *
 * Tests cover `runDecisionEngineForTurn` (production hot-path wrapper),
 * `applyToolReductions`, and `buildBaseContextPacketFromTurn` — the three
 * components wired into agent/core.ts's hot path.
 *
 * Strategy: no DB, no network. Engine singleton injected via
 * `_overrideDecisionEngineSingleton`; config flags mutated inline and
 * restored in afterEach.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  runDecisionEngineForTurn,
  DecisionEngineFailClosedError,
  _resetDecisionEngineSingleton,
  _overrideDecisionEngineSingleton,
} from '@/runtime/decision/integration.js';
import {
  applyToolReductions,
  buildBaseContextPacketFromTurn,
} from '@/runtime/decision/build-base-context.js';
import { config } from '@/config/env.js';
import type { BaseContextPacket, DecisionPacket } from '@/runtime/context-packet/types.js';
import { DEFAULT_CONTEXT_REQUIREMENTS } from '@/runtime/context-packet/types.js';
import type { DecisionEngineResult } from '@/runtime/decision/decision-engine.js';

// ─── Config flag helpers ──────────────────────────────────────────────────────

type ConfigMutated = {
  FEATURE_DECISION_ENGINE_V1: boolean;
  FEATURE_DECISION_ENGINE_V1_KILL_SWITCH: boolean;
  FEATURE_DECISION_ENGINE_ERROR_FALLBACK: 'fail-closed' | 'legacy';
};

/** Save + override config flags; returns a restore fn. */
function patchConfig(overrides: Partial<ConfigMutated>): () => void {
  const saved = {
    FEATURE_DECISION_ENGINE_V1: config.FEATURE_DECISION_ENGINE_V1,
    FEATURE_DECISION_ENGINE_V1_KILL_SWITCH: config.FEATURE_DECISION_ENGINE_V1_KILL_SWITCH,
    FEATURE_DECISION_ENGINE_ERROR_FALLBACK: config.FEATURE_DECISION_ENGINE_ERROR_FALLBACK,
  };
  if ('FEATURE_DECISION_ENGINE_V1' in overrides) {
    // @ts-expect-error — test override of parsed config
    config.FEATURE_DECISION_ENGINE_V1 = overrides.FEATURE_DECISION_ENGINE_V1;
  }
  if ('FEATURE_DECISION_ENGINE_V1_KILL_SWITCH' in overrides) {
    // @ts-expect-error
    config.FEATURE_DECISION_ENGINE_V1_KILL_SWITCH = overrides.FEATURE_DECISION_ENGINE_V1_KILL_SWITCH;
  }
  if ('FEATURE_DECISION_ENGINE_ERROR_FALLBACK' in overrides) {
    // @ts-expect-error
    config.FEATURE_DECISION_ENGINE_ERROR_FALLBACK = overrides.FEATURE_DECISION_ENGINE_ERROR_FALLBACK;
  }
  return () => {
    // @ts-expect-error
    config.FEATURE_DECISION_ENGINE_V1 = saved.FEATURE_DECISION_ENGINE_V1;
    // @ts-expect-error
    config.FEATURE_DECISION_ENGINE_V1_KILL_SWITCH = saved.FEATURE_DECISION_ENGINE_V1_KILL_SWITCH;
    // @ts-expect-error
    config.FEATURE_DECISION_ENGINE_ERROR_FALLBACK = saved.FEATURE_DECISION_ENGINE_ERROR_FALLBACK;
  };
}

// ─── BaseContextPacket factory ────────────────────────────────────────────────

function mkBase(overrides?: Partial<BaseContextPacket>): BaseContextPacket {
  return {
    trace_id: 'trace_wiring_01',
    tenant_id: 'tn_wiring',
    agent_id: 'ag_wiring',
    session_id: 'conv_001',
    conversation_id: 'conv_001',
    channel: { id: 'ch_wpp', kind: 'whatsapp', is_locked_down: false },
    actor: { user_id: null, pessoa_id: 'p_001', role: 'end_user', is_authenticated: true },
    input: {
      kind: 'text',
      content_ref: 'msg_001',
      content_hmac: '',
      received_at: new Date().toISOString(),
    },
    active_procedure_execution_id: null,
    feature_flags_snapshot: {},
    entered_at_ms: Date.now(),
    ...overrides,
  };
}

// ─── DecisionPacket factory ───────────────────────────────────────────────────

function mkPacket(overrides?: Partial<DecisionPacket>): DecisionPacket {
  return {
    trace_id: 'trace_wiring_01',
    intent: { label: 'greet', confidence: 0.9 },
    risk_profile: { level: 'low', reasons: [], requires_human_review: false },
    routing: { agent_id: 'ag_wiring', candidate_skill_ids: [] },
    action_mode: 'respond',
    tool_permissions: {
      allowed_tools: ['query_balance', 'set_reminder'],
      blocked_tools: [],
      requires_confirmation: [],
    },
    context_requirements: DEFAULT_CONTEXT_REQUIREMENTS,
    evaluation_plan: { validators: [], llm_judge_required: false, human_review_required: false },
    policy_decisions: [],
    rationale: 'all clear',
    ...overrides,
  };
}

/** Inject a fake engine whose `run` returns the given result. */
function injectEngine(result: DecisionEngineResult | (() => Promise<DecisionEngineResult>)) {
  const runFn = typeof result === 'function' ? result : async () => result;
  const fakeEngine = { run: vi.fn((_input: { base: BaseContextPacket }) => runFn()) } as ReturnType<typeof import('@/runtime/decision/index.js').getDecisionEngine>;
  _overrideDecisionEngineSingleton(fakeEngine);
  return fakeEngine;
}

/** Inject an engine whose `run` throws. */
function injectThrowingEngine(err: Error) {
  const fakeEngine = {
    run: vi.fn().mockRejectedValue(err),
  } as ReturnType<typeof import('@/runtime/decision/index.js').getDecisionEngine>;
  _overrideDecisionEngineSingleton(fakeEngine);
  return fakeEngine;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('P9b — agent/core.ts × Decision Engine wiring (8 tests)', () => {
  beforeEach(() => {
    _resetDecisionEngineSingleton();
  });

  afterEach(() => {
    _resetDecisionEngineSingleton();
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // T1 — flag OFF: engine skipped, skip_reason='flag_off'
  // --------------------------------------------------------------------------
  it('T1 (flag off): FEATURE_DECISION_ENGINE_V1=false → engine_ran=false, skip_reason=flag_off', async () => {
    const restore = patchConfig({
      FEATURE_DECISION_ENGINE_V1: false,
      FEATURE_DECISION_ENGINE_V1_KILL_SWITCH: false,
    });
    try {
      const result = await runDecisionEngineForTurn(mkBase());
      expect(result.engine_ran).toBe(false);
      expect(result.skip_reason).toBe('flag_off');
    } finally {
      restore();
    }
  });

  // --------------------------------------------------------------------------
  // T2 — kill switch: always returns skip_reason='kill_switch' regardless of flag
  // --------------------------------------------------------------------------
  it('T2 (kill switch): FEATURE_DECISION_ENGINE_V1_KILL_SWITCH=true → engine_ran=false, skip_reason=kill_switch', async () => {
    const restore = patchConfig({
      FEATURE_DECISION_ENGINE_V1_KILL_SWITCH: true,
      FEATURE_DECISION_ENGINE_V1: true,
    });
    try {
      const result = await runDecisionEngineForTurn(mkBase());
      expect(result.engine_ran).toBe(false);
      expect(result.skip_reason).toBe('kill_switch');
    } finally {
      restore();
    }
  });

  // --------------------------------------------------------------------------
  // T3 — allow: flag on + engine returns action_mode='respond' → engine_ran=true
  // --------------------------------------------------------------------------
  it('T3 (allow): flag on + engine returns action_mode=respond → engine_ran=true, packet returned', async () => {
    const restore = patchConfig({
      FEATURE_DECISION_ENGINE_V1_KILL_SWITCH: false,
      FEATURE_DECISION_ENGINE_V1: true,
    });
    const fakeEngine = injectEngine({ packet: mkPacket({ action_mode: 'respond' }) });
    try {
      const result = await runDecisionEngineForTurn(mkBase());
      expect(result.engine_ran).toBe(true);
      expect(result.result?.packet.action_mode).toBe('respond');
      expect(fakeEngine.run).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  // --------------------------------------------------------------------------
  // T4 — blocked: engine returns block → engine_ran=true, result.block populated
  // --------------------------------------------------------------------------
  it('T4 (blocked): engine returns block decision → engine_ran=true, result.block populated', async () => {
    const restore = patchConfig({
      FEATURE_DECISION_ENGINE_V1_KILL_SWITCH: false,
      FEATURE_DECISION_ENGINE_V1: true,
    });
    const blockDecision = {
      pep: 'early' as const,
      policy_id: 'p_lock',
      rule_descriptor: 'channel.locked_down.global',
      decision: 'block' as const,
      reason: 'channel locked',
      severity: 'high' as const,
    };
    injectEngine({
      packet: mkPacket({ action_mode: 'escalate' }),
      block: blockDecision,
    });
    try {
      const result = await runDecisionEngineForTurn(mkBase());
      expect(result.engine_ran).toBe(true);
      expect(result.result?.block).toBeDefined();
      expect(result.result?.block?.decision).toBe('block');
    } finally {
      restore();
    }
  });

  // --------------------------------------------------------------------------
  // T5 — requires_approval: action_mode='escalate' without hard block (dual-approval)
  // --------------------------------------------------------------------------
  it('T5 (requires_approval): engine returns action_mode=escalate without hard block → engine_ran=true', async () => {
    const restore = patchConfig({
      FEATURE_DECISION_ENGINE_V1_KILL_SWITCH: false,
      FEATURE_DECISION_ENGINE_V1: true,
    });
    injectEngine({
      packet: mkPacket({
        action_mode: 'escalate',
        rationale: 'require_dual_approval:owner_plus_compliance',
      }),
      // no block: undefined
    });
    try {
      const result = await runDecisionEngineForTurn(mkBase());
      expect(result.engine_ran).toBe(true);
      expect(result.result?.packet.action_mode).toBe('escalate');
      expect(result.result?.block).toBeUndefined();
    } finally {
      restore();
    }
  });

  // --------------------------------------------------------------------------
  // T6 — tool_reductions: applyToolReductions removes blocked tools from toolSet
  // --------------------------------------------------------------------------
  it('T6 (tool_reductions): applyToolReductions removes blocked tools from toolSet; LLM called without set_reminder', () => {
    const toolSet = [
      { name: 'query_balance', description: 'Query balance', input_schema: { type: 'object' as const, additionalProperties: true } },
      { name: 'set_reminder', description: 'Set reminder', input_schema: { type: 'object' as const, additionalProperties: true } },
      { name: 'register_transaction', description: 'Register', input_schema: { type: 'object' as const, additionalProperties: true } },
    ];

    const toolPermissions = {
      allowed_tools: ['query_balance', 'register_transaction'],
      blocked_tools: ['set_reminder'],
      requires_confirmation: [],
    };

    const reduced = applyToolReductions(toolSet, toolPermissions);

    expect(reduced).toHaveLength(2);
    expect(reduced.map((t) => t.name)).not.toContain('set_reminder');
    expect(reduced.map((t) => t.name)).toContain('query_balance');
    expect(reduced.map((t) => t.name)).toContain('register_transaction');
  });

  // --------------------------------------------------------------------------
  // T7 — engine_error fail-closed (default): throws DecisionEngineFailClosedError
  // --------------------------------------------------------------------------
  it('T7 (engine_error fail-closed): engine throws + fallback=fail-closed → throws DecisionEngineFailClosedError', async () => {
    const restore = patchConfig({
      FEATURE_DECISION_ENGINE_V1_KILL_SWITCH: false,
      FEATURE_DECISION_ENGINE_V1: true,
      FEATURE_DECISION_ENGINE_ERROR_FALLBACK: 'fail-closed',
    });
    injectThrowingEngine(new Error('engine crashed hard'));
    try {
      await expect(runDecisionEngineForTurn(mkBase())).rejects.toThrow(DecisionEngineFailClosedError);
    } finally {
      restore();
    }
  });

  // --------------------------------------------------------------------------
  // T8 — engine_error legacy fallback: engine throws + fallback=legacy → skip
  // --------------------------------------------------------------------------
  it('T8 (engine_error legacy fallback): engine throws + fallback=legacy → engine_ran=false, skip_reason=engine_error', async () => {
    const restore = patchConfig({
      FEATURE_DECISION_ENGINE_V1_KILL_SWITCH: false,
      FEATURE_DECISION_ENGINE_V1: true,
      FEATURE_DECISION_ENGINE_ERROR_FALLBACK: 'legacy',
    });
    injectThrowingEngine(new Error('engine crashed'));
    try {
      const result = await runDecisionEngineForTurn(mkBase());
      expect(result.engine_ran).toBe(false);
      expect(result.skip_reason).toBe('engine_error');
    } finally {
      restore();
    }
  });

  // --------------------------------------------------------------------------
  // Bonus — buildBaseContextPacketFromTurn: field mapping sanity check
  // (Not one of the named 8 but guards the helper contract)
  // --------------------------------------------------------------------------
  it('buildBaseContextPacketFromTurn: maps turn state to BaseContextPacket correctly', () => {
    const inbound = {
      id: 'msg_001',
      tipo: 'texto',
      conteudo: 'Oi!',
      created_at: new Date('2026-05-20T10:00:00Z'),
      processada_em: null,
      conversa_id: 'conv_001',
      metadata: { telefone: '+5511999999999' },
    } as unknown as import('@/db/schema.js').Mensagem;

    const conversa = { id: 'conv_001' } as import('@/db/schema.js').Conversa;
    const pessoa = { id: 'p_001', telefone_whatsapp: '+5511999999999' } as import('@/db/schema.js').Pessoa;

    const packet = buildBaseContextPacketFromTurn({
      inbound,
      conversa,
      pessoa,
      tenant_id: 'tn_test',
      agent_id: 'ag_test',
      channel_id: 'ch_wpp',
      active_procedure_execution_id: null,
    });

    expect(packet.trace_id).toBe('msg_001');
    expect(packet.tenant_id).toBe('tn_test');
    expect(packet.agent_id).toBe('ag_test');
    expect(packet.conversation_id).toBe('conv_001');
    expect(packet.channel.id).toBe('ch_wpp');
    expect(packet.channel.kind).toBe('whatsapp');
    expect(packet.actor.pessoa_id).toBe('p_001');
    expect(packet.actor.role).toBe('end_user');
    expect(packet.input.kind).toBe('text');
    expect(packet.input.content_ref).toBe('msg_001');
    expect(packet.active_procedure_execution_id).toBeNull();
  });
});
