/**
 * F1 Phase 1 — safety-critical unit tests for the execute_skill call-site
 * logic (src/agent/execute-skill.ts).
 *
 * The actual core.ts branch is not directly unit-testable (DB + network), so
 * the HIGH-risk decision logic lives in `executeSelectedSkill`, injected with
 * test doubles. We assert the safety contracts:
 *  - immutable identity: a version bump between select and execute ⇒ fall
 *    through, runSkill NOT called.
 *  - ok ⇒ reply delivered via dispatchOutput (NOT raw sendOutbound) + handled.
 *  - !ok ⇒ fall through to the normal turn.
 *  - no reply ⇒ fall through (never fabricate text).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  executeSelectedSkill,
  buildSkillInput,
  buildSkillReply,
  type ExecuteSelectedSkillDeps,
  type PinnedSkillIdentity,
} from '@/agent/execute-skill.js';
import type { Pessoa, Conversa, Mensagem } from '@/db/schema.js';
import type { SkillExecutionOutput } from '@/skills/types.js';

const pessoa = { id: 'p_1', telefone_whatsapp: '+5511999999999' } as Pessoa;
const conversa = { id: 'c_1' } as Conversa;
const inbound = { id: 'msg_1', conteudo: 'oi', metadata: null } as unknown as Mensagem;

function mkPinned(overrides?: Partial<PinnedSkillIdentity>): PinnedSkillIdentity {
  return {
    selected_skill_descriptor: 'faq.answer',
    selected_skill_version: 3,
    selected_skill_id: 'skill_faq',
    ...overrides,
  };
}

function mkDeps(overrides?: Partial<ExecuteSelectedSkillDeps>): ExecuteSelectedSkillDeps {
  return {
    resolveActiveSkill: vi
      .fn()
      .mockResolvedValue({ id: 'skill_faq', version: 3 }),
    runSkill: vi.fn().mockResolvedValue({
      ok: true,
      output: { reply: 'Aqui está sua resposta.' },
      latency_ms: 10,
      resolved_policies: [],
      trace: { mode: 'prompt_only', skill_version: 3, skill_id: 'skill_faq' },
    } satisfies SkillExecutionOutput),
    dispatchOutput: vi.fn().mockResolvedValue(undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

function mkArgs() {
  return {
    pinned: mkPinned(),
    routedAgentId: 'ag_1',
    pessoa,
    conversa,
    inbound,
    jid: '5511999999999@s.whatsapp.net',
    aggregatedText: 'oi, qual o horário?',
  };
}

describe('F1 Phase 1 — buildSkillInput', () => {
  it('builds the conventional { message, pessoa_id, conversa_id } payload', () => {
    expect(
      buildSkillInput({ message: 'oi', pessoa_id: 'p_1', conversa_id: 'c_1' }),
    ).toEqual({ message: 'oi', pessoa_id: 'p_1', conversa_id: 'c_1' });
  });
});

describe('F1 Phase 1 — buildSkillReply', () => {
  it('maps output.reply to text', () => {
    const r = buildSkillReply({
      ok: true,
      output: { reply: 'olá' },
      latency_ms: 1,
      resolved_policies: [],
      trace: { mode: 'prompt_only', skill_version: 1, skill_id: 's' },
    });
    expect(r).toEqual({ text: 'olá', turnHasSensitive: false, sensitiveTools: [] });
  });

  it('marks sensitive output so view-once is applied downstream', () => {
    const r = buildSkillReply({
      ok: true,
      output: { reply: 'saldo: R$ 100', sensitive: true },
      latency_ms: 1,
      resolved_policies: [],
      trace: { mode: 'prompt_only', skill_version: 1, skill_id: 's' },
    });
    expect(r?.turnHasSensitive).toBe(true);
    expect(r?.sensitiveTools).toEqual(['skill_output']);
  });

  it('returns null when reply is absent (do NOT fabricate text)', () => {
    expect(
      buildSkillReply({
        ok: true,
        output: { other: 'x' },
        latency_ms: 1,
        resolved_policies: [],
        trace: { mode: 'prompt_only', skill_version: 1, skill_id: 's' },
      }),
    ).toBeNull();
  });

  it('returns null when result is not ok', () => {
    expect(
      buildSkillReply({
        ok: false,
        reason: 'invalid_output',
        latency_ms: 1,
        resolved_policies: [],
        trace: { mode: null, skill_version: null, skill_id: null },
      }),
    ).toBeNull();
  });

  it('returns null when reply is only whitespace (item 8 — never dispatch a blank message)', () => {
    expect(
      buildSkillReply({
        ok: true,
        output: { reply: '   \n\t  ' },
        latency_ms: 1,
        resolved_policies: [],
        trace: { mode: 'prompt_only', skill_version: 1, skill_id: 's' },
      }),
    ).toBeNull();
  });
});

describe('F1 Phase 1 — executeSelectedSkill', () => {
  it('ok ⇒ dispatchOutput called (NOT raw sendOutbound) + handled:true', async () => {
    const deps = mkDeps();
    const outcome = await executeSelectedSkill(mkArgs(), deps);

    expect(outcome).toEqual({ handled: true });
    expect(deps.runSkill).toHaveBeenCalledOnce();
    expect(deps.dispatchOutput).toHaveBeenCalledOnce();
    // The reply went through dispatchOutput with the skill text + channel ctx.
    const ctx = (deps.dispatchOutput as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(ctx.text).toBe('Aqui está sua resposta.');
    expect(ctx.pessoa).toBe(pessoa);
    expect(ctx.conversa).toBe(conversa);
    expect(ctx.inbound).toBe(inbound);
    // dispatchOutput is the ONLY outbound dep injected — there is no
    // sendOutbound path here, which is the contract (Codex HIGH-3).
  });

  it('passes the pinned descriptor + aggregated text + turno_id to runSkill', async () => {
    const deps = mkDeps();
    await executeSelectedSkill(mkArgs(), deps);
    const input = (deps.runSkill as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(input.skill_descriptor).toBe('faq.answer');
    expect(input.triggered_by).toBe('user_message');
    expect(input.conversa_id).toBe('c_1');
    expect(input.turno_id).toBe('msg_1');
    expect(input.agent_id).toBe('ag_1');
    // Immutable-identity pin forwarded so runSkill can close the TOCTOU (HIGH-B).
    expect(input.expected_skill_id).toBe('skill_faq');
    expect(input.expected_skill_version).toBe(3);
    expect(input.input).toEqual({
      message: 'oi, qual o horário?',
      pessoa_id: 'p_1',
      conversa_id: 'c_1',
    });
  });

  it('identity mismatch (version bumped between select and execute) ⇒ fall through, runSkill NOT called', async () => {
    const deps = mkDeps({
      // The active row was re-activated at a higher version after selection.
      resolveActiveSkill: vi.fn().mockResolvedValue({ id: 'skill_faq', version: 4 }),
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);

    expect(outcome).toEqual({ handled: false, reason: 'identity_mismatch' });
    expect(deps.runSkill).not.toHaveBeenCalled();
    expect(deps.dispatchOutput).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      'skill.identity_mismatch',
    );
  });

  it('identity mismatch (different id, same version) ⇒ fall through, runSkill NOT called', async () => {
    const deps = mkDeps({
      resolveActiveSkill: vi
        .fn()
        .mockResolvedValue({ id: 'skill_other', version: 3 }),
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);
    expect(outcome).toEqual({ handled: false, reason: 'identity_mismatch' });
    expect(deps.runSkill).not.toHaveBeenCalled();
  });

  it('active skill no longer resolvable ⇒ fall through, runSkill NOT called', async () => {
    const deps = mkDeps({
      resolveActiveSkill: vi.fn().mockResolvedValue(null),
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);
    expect(outcome).toEqual({ handled: false, reason: 'skill_not_resolved' });
    expect(deps.runSkill).not.toHaveBeenCalled();
  });

  it('no pinned identity ⇒ fall through without resolving or executing', async () => {
    const deps = mkDeps();
    const outcome = await executeSelectedSkill(
      { ...mkArgs(), pinned: null },
      deps,
    );
    expect(outcome).toEqual({ handled: false, reason: 'no_pinned_identity' });
    expect(deps.resolveActiveSkill).not.toHaveBeenCalled();
    expect(deps.runSkill).not.toHaveBeenCalled();
  });

  it('!ok ⇒ fall through to the normal turn (prompt_only/evaluator have no side effects)', async () => {
    const deps = mkDeps({
      runSkill: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'invalid_output',
        latency_ms: 5,
        resolved_policies: [],
        trace: { mode: 'prompt_only', skill_version: 3, skill_id: 'skill_faq' },
      } satisfies SkillExecutionOutput),
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);

    expect(outcome).toEqual({ handled: false, reason: 'execution_failed' });
    expect(deps.runSkill).toHaveBeenCalledOnce();
    expect(deps.dispatchOutput).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'invalid_output' }),
      'skill.execution_failed',
    );
  });

  it('ok but no reply ⇒ fall through (never fabricate text)', async () => {
    const deps = mkDeps({
      runSkill: vi.fn().mockResolvedValue({
        ok: true,
        output: { score: 0.9 }, // no `reply`
        latency_ms: 5,
        resolved_policies: [],
        trace: { mode: 'evaluator', skill_version: 3, skill_id: 'skill_faq' },
      } satisfies SkillExecutionOutput),
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);

    expect(outcome).toEqual({ handled: false, reason: 'no_reply' });
    expect(deps.dispatchOutput).not.toHaveBeenCalled();
  });

  it('runSkill REJECTS (timeout/throw) ⇒ fall through, dispatchOutput NOT called (item 1/3)', async () => {
    // Codex #216 review item 1/3: a rejected runSkill promise must be caught and
    // treated like a resolved !ok — controlled fall-through, no dispatch. Nothing
    // was sent, so degrading to the normal turn is safe (no double-action).
    const deps = mkDeps({
      runSkill: vi.fn().mockRejectedValue(new Error('skill_runner_timeout')),
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);

    expect(outcome).toEqual({ handled: false, reason: 'execution_failed' });
    expect(deps.runSkill).toHaveBeenCalledOnce();
    expect(deps.dispatchOutput).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'skill_runner_timeout' }),
      'skill.execution_failed',
    );
  });

  it('dispatchOutput throws with UNKNOWN delivery phase ⇒ handled (no fallback, no double-send) + loud log (HIGH-A)', async () => {
    // A throw with no `delivered` flag is treated CONSERVATIVELY as delivered:
    // the message may have reached the user, so we must NOT re-send (no canned
    // fallback, no ReAct fall-through) — just report handled and log the
    // inconsistency at error level with an ops_alert flag for reconciliation.
    const deps = mkDeps({
      dispatchOutput: vi.fn().mockRejectedValue(new Error('db_commit_failed')),
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);

    expect(outcome).toEqual({ handled: true });
    expect(deps.runSkill).toHaveBeenCalledOnce();
    expect(deps.dispatchOutput).toHaveBeenCalledOnce(); // no second (fallback) send
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ ops_alert: true, err: 'db_commit_failed' }),
      'skill.dispatch_failed_after_send_inconsistency',
    );
  });

  it('dispatchOutput fails POST-send (delivered:true, persist failed) ⇒ handled, NO re-send + loud log (HIGH-1)', async () => {
    // The channel send SUCCEEDED but the DB persist threw: the user already has
    // the reply. We must NOT re-send (a fall-through to ReAct would double-send a
    // financial message) — report handled and log the inconsistency for ops.
    const persistErr = Object.assign(new Error('persist_failed'), { delivered: true });
    const deps = mkDeps({
      dispatchOutput: vi.fn().mockRejectedValue(persistErr),
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);

    expect(outcome).toEqual({ handled: true });
    expect(deps.dispatchOutput).toHaveBeenCalledOnce(); // never re-dispatch
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ ops_alert: true, err: 'persist_failed' }),
      'skill.dispatch_failed_after_send_inconsistency',
    );
  });

  it('dispatchOutput fails PRE-send (delivered:false) ⇒ fall through to ReAct (handled:false), no second send (HIGH-A)', async () => {
    // The channel send threw, so NOTHING reached the user. LLM-first: fall
    // through to the normal ReAct turn so the agent still answers with a real,
    // adaptive reply — not a canned message. Safe: nothing was sent (no
    // double-send), and we never re-dispatch from here.
    const sendErr = Object.assign(new Error('send_failed'), { delivered: false });
    const deps = mkDeps({
      dispatchOutput: vi.fn().mockRejectedValue(sendErr),
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);

    expect(outcome).toEqual({ handled: false, reason: 'dispatch_send_failed' });
    expect(deps.dispatchOutput).toHaveBeenCalledOnce(); // no second (fallback) send
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.anything(),
      'skill.dispatch_send_failed_fallthrough',
    );
  });

  it('evaluator WITH a user-facing reply ⇒ dispatched + handled (item 4 contract)', async () => {
    // Evaluator that chooses to speak to the user: verdict/score stay internal,
    // the user-facing text is in `reply` (the sibling no-reply evaluator test
    // above proves the verdict-only case falls through without surfacing scores).
    const deps = mkDeps({
      runSkill: vi.fn().mockResolvedValue({
        ok: true,
        output: { reply: 'Sua solicitação foi aprovada.', verdict: 'pass', score: 0.92 },
        latency_ms: 8,
        resolved_policies: [],
        trace: { mode: 'evaluator', skill_version: 3, skill_id: 'skill_faq' },
      } satisfies SkillExecutionOutput),
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);

    expect(outcome).toEqual({ handled: true });
    const ctx = (deps.dispatchOutput as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(ctx.text).toBe('Sua solicitação foi aprovada.');
  });
});
