/**
 * Regression — `toolMediatedMode` must fail-closed when ALS tenant context
 * is absent (issue #262).
 *
 * Background:
 *  Before the #262 fix, `src/skills/modes/tool-mediated.ts` degraded missing
 *  tenant context to the literal strings `'unknown:unknown'` via
 *  `tryGetCurrentContext()?.tenant_id ?? 'unknown'`. That:
 *    (a) created a cross-tenant idempotency collision surface (every
 *        caller without ALS context wrote/read from the same shared
 *        `unknown:unknown:<skill_id>:<version>:<turno>` bucket),
 *    (b) silenced caller bugs that forgot to wrap execution in
 *        `runWithTenantContext`,
 *    (c) diverged from the fail-closed pattern enforced by every other
 *        tenant-scoped store (rulesRepo, agent_memories, ledgers — see
 *        PRs #232 / #237 / #241 / #243).
 *
 * After the fix:
 *  `toolMediatedMode` calls `getCurrentTenant()` / `getCurrentAgent()`
 *  directly — both throw `MissingTenantContextError` when ALS is empty.
 *  The shared `unknown:` bucket is no longer reachable.
 *
 * What this file proves:
 *  1. Calling `toolMediatedMode` OUTSIDE `runWithTenantContext` throws
 *     `MissingTenantContextError` BEFORE any LLM/tool dispatch fires.
 *  2. Calling it INSIDE `runWithTenantContext` uses the real
 *     tenant_id / agent_id in the idempotency key.
 *  3. The idempotency key never contains the literal string `'unknown'`
 *     (regression guard against the old fallback).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runWithTenantContext,
  MissingTenantContextError,
} from '@/db/tenant-context.js';

vi.mock('@/lib/claude.js', () => ({ callLLM: vi.fn() }));

import { toolMediatedMode, setToolDispatcher } from '@/skills/modes/tool-mediated.js';
import { callLLM } from '@/lib/claude.js';

const baseSkill = {
  id: 'tm-262',
  tenant_id: 'acme',
  agent_id: 'sofia',
  version: 7,
  procedure: {
    system_prompt: 'system',
    tool_schemas: [
      { name: 'write_db', description: 'side effect', input_schema: { type: 'object' } },
    ],
  },
  allowed_tools: ['write_db'],
  runtime_hints: { max_tool_calls: 2, max_output_tokens: 100 },
} as any;

const TURNO = 'turn-262-test';

describe('tool_mediated: tenant context fail-closed (#262)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setToolDispatcher(null);
  });

  it('throws MissingTenantContextError when called outside runWithTenantContext', async () => {
    // No LLM should be invoked — we must fail BEFORE dispatch.
    setToolDispatcher(async () => ({ ok: true }));
    vi.mocked(callLLM).mockResolvedValue({
      content: '{"answer":"never reached"}',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'x',
    });

    await expect(
      toolMediatedMode({
        skill: baseSkill,
        input: {},
        resolvedPolicies: [],
        turno_id: TURNO,
      }),
    ).rejects.toThrow(MissingTenantContextError);

    // Regression guard: the LLM (and therefore the loop body) must not
    // execute when context is missing — otherwise the old 'unknown' bucket
    // could have leaked a side effect.
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('throws MissingTenantContextError with stable error code', async () => {
    try {
      await toolMediatedMode({
        skill: baseSkill,
        input: {},
        resolvedPolicies: [],
        turno_id: TURNO,
      });
      throw new Error('expected throw, did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingTenantContextError);
      expect((err as MissingTenantContextError).code).toBe('MISSING_TENANT_CONTEXT');
    }
  });

  it('uses the real tenant_id / agent_id in idempotency key when context is set', async () => {
    let capturedKey: string | undefined;
    setToolDispatcher(async (_name, _args, opts) => {
      capturedKey = opts?.idempotency_key;
      return { ok: true };
    });
    vi.mocked(callLLM)
      .mockResolvedValueOnce({
        content: null,
        tool_uses: [{ id: 't1', tool: 'write_db', args: { x: 1 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      })
      .mockResolvedValueOnce({
        content: '{"answer":"done"}',
        tool_uses: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      });

    await runWithTenantContext(
      { tenant_id: 'acme', agent_id: 'sofia' },
      async () => {
        const out = await toolMediatedMode({
          skill: baseSkill,
          input: {},
          resolvedPolicies: [],
          turno_id: TURNO,
        });
        expect(out.answer).toBe('done');
      },
    );

    expect(capturedKey).toBeDefined();
    // Key shape: tenant:agent:skill_id:skill_version:exec_id:tool_name:args_hash
    expect(capturedKey).toMatch(/^acme:sofia:tm-262:7:turn-262-test:write_db:/);
  });

  it('idempotency key MUST NOT contain "unknown" when context is set (regression for #262)', async () => {
    let capturedKey: string | undefined;
    setToolDispatcher(async (_name, _args, opts) => {
      capturedKey = opts?.idempotency_key;
      return { ok: true };
    });
    vi.mocked(callLLM)
      .mockResolvedValueOnce({
        content: null,
        tool_uses: [{ id: 't1', tool: 'write_db', args: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      })
      .mockResolvedValueOnce({
        content: '{"answer":"done"}',
        tool_uses: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'x',
      });

    await runWithTenantContext(
      { tenant_id: 'tenantA', agent_id: 'agentA' },
      async () => {
        await toolMediatedMode({
          skill: baseSkill,
          input: {},
          resolvedPolicies: [],
          turno_id: TURNO,
        });
      },
    );

    expect(capturedKey).toBeDefined();
    // Adversarial: the literal string 'unknown' must not appear anywhere.
    // This guards against a re-introduction of the `?? 'unknown'` fallback.
    expect(capturedKey).not.toContain('unknown');
  });

  it('cross-tenant: same skill/turno from distinct tenants produces distinct keys (no shared bucket)', async () => {
    const captured: string[] = [];
    setToolDispatcher(async (_name, _args, opts) => {
      if (opts?.idempotency_key) captured.push(opts.idempotency_key);
      return { ok: true };
    });
    // Two full runs (4 LLM calls total) — each tenant gets: tool turn + end turn.
    const toolUseTurn = {
      content: null,
      tool_uses: [{ id: 't1', tool: 'write_db', args: {} }],
      stop_reason: 'tool_use' as const,
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'x',
    };
    const endTurn = {
      content: '{"answer":"done"}',
      tool_uses: [],
      stop_reason: 'end_turn' as const,
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'x',
    };
    vi.mocked(callLLM)
      .mockResolvedValueOnce(toolUseTurn)
      .mockResolvedValueOnce(endTurn)
      .mockResolvedValueOnce(toolUseTurn)
      .mockResolvedValueOnce(endTurn);

    // Use tenant-wide skills (agent_id: null) so each tenant can run the
    // same skill row identity; key isolation must come from the ALS
    // context, not from the skill row.
    const sharedSkill = { ...baseSkill, agent_id: null };

    await runWithTenantContext(
      { tenant_id: 'tenantA', agent_id: 'agentA' },
      async () => {
        await toolMediatedMode({
          skill: sharedSkill,
          input: {},
          resolvedPolicies: [],
          turno_id: TURNO,
        });
      },
    );
    await runWithTenantContext(
      { tenant_id: 'tenantB', agent_id: 'agentB' },
      async () => {
        await toolMediatedMode({
          skill: sharedSkill,
          input: {},
          resolvedPolicies: [],
          turno_id: TURNO,
        });
      },
    );

    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatch(/^tenantA:agentA:/);
    expect(captured[1]).toMatch(/^tenantB:agentB:/);
    expect(captured[0]).not.toEqual(captured[1]);
  });
});
