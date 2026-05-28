/**
 * Issue #227 — execute-skill outbound guard tests.
 *
 * Validates the per-turn guard added at the top of `executeSelectedSkill`:
 *   - prior row at status='sent' / 'unknown' / 'pending' ⇒ returns
 *     `handled: true` (the caller treats this turn as terminal — no
 *     ReAct fall-through, no skill execution).
 *   - prior row at status='failed' ⇒ no block (the skill runs as before).
 *   - no prior row ⇒ no block.
 *   - ledger read throws ⇒ fail-open (the skill runs; a DB hiccup must
 *     not silence the user).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  executeSelectedSkill,
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

function mkDeps(
  guardPriorAttempt: unknown,
  overrides?: Partial<ExecuteSelectedSkillDeps>,
): ExecuteSelectedSkillDeps {
  return {
    resolveActiveSkill: vi.fn().mockResolvedValue({ id: 'skill_faq', version: 3 }),
    runSkill: vi.fn().mockResolvedValue({
      ok: true,
      output: { reply: 'Resposta da skill.' },
      latency_ms: 10,
      resolved_policies: [],
      trace: { mode: 'prompt_only', skill_version: 3, skill_id: 'skill_faq' },
    } satisfies SkillExecutionOutput),
    safeDispatchOutput: vi.fn().mockResolvedValue({ status: 'delivered', allowReact: false }),
    outboundMessagesRepo: {
      findByConversaTurn: vi.fn().mockResolvedValue(guardPriorAttempt),
    },
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

describe('executeSelectedSkill — outbound guard (#227)', () => {
  it('BLOCKS execution when prior outbound is sent', async () => {
    const deps = mkDeps({
      idempotency_key: 'k',
      status: 'sent',
      provider_message_id: 'wa-prior',
    });

    const outcome = await executeSelectedSkill(mkArgs(), deps);
    expect(outcome).toEqual({ handled: true });
    expect(deps.runSkill).not.toHaveBeenCalled();
    expect(deps.safeDispatchOutput).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        prior_status: 'sent',
        prior_provider_message_id: 'wa-prior',
      }),
      'skill.outbound_guard_blocked_double_send',
    );
  });

  it('BLOCKS execution when prior outbound is unknown (ambiguous-throw signal)', async () => {
    const deps = mkDeps({
      idempotency_key: 'k',
      status: 'unknown',
      provider_message_id: null,
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);
    expect(outcome).toEqual({ handled: true });
    expect(deps.runSkill).not.toHaveBeenCalled();
  });

  it('BLOCKS execution when prior outbound is pending (conservative)', async () => {
    const deps = mkDeps({
      idempotency_key: 'k',
      status: 'pending',
      provider_message_id: null,
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);
    expect(outcome).toEqual({ handled: true });
    expect(deps.runSkill).not.toHaveBeenCalled();
  });

  it('DOES NOT block when prior outbound is failed (safe to retry via ReAct)', async () => {
    const deps = mkDeps({
      idempotency_key: 'k',
      status: 'failed',
      provider_message_id: null,
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);
    // The skill runs and dispatches; outcome is handled because skill succeeded.
    expect(outcome).toEqual({ handled: true });
    expect(deps.runSkill).toHaveBeenCalledTimes(1);
    expect(deps.safeDispatchOutput).toHaveBeenCalledTimes(1);
  });

  it('DOES NOT block when there is no prior attempt', async () => {
    const deps = mkDeps(null);
    const outcome = await executeSelectedSkill(mkArgs(), deps);
    expect(outcome).toEqual({ handled: true });
    expect(deps.runSkill).toHaveBeenCalledTimes(1);
  });

  it('FAIL-OPEN: ledger read throw lets the skill run (no silence)', async () => {
    const deps = mkDeps(null, {
      outboundMessagesRepo: {
        findByConversaTurn: vi.fn().mockRejectedValue(new Error('ledger_down')),
      },
    });
    const outcome = await executeSelectedSkill(mkArgs(), deps);
    expect(outcome).toEqual({ handled: true });
    expect(deps.runSkill).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'ledger_down' }),
      'skill.outbound_guard_lookup_failed_proceeding',
    );
  });
});
