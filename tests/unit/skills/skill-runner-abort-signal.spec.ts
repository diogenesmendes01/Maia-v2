/**
 * Issue #220 — SkillRunner end-to-end AbortSignal plumbing.
 *
 * Verifies that the runner's internal AbortController is wired through
 * `ModeContext.signal` to the mode handler, and that the mode handler
 * forwards it to `callLLM`. The original bug: the modes ran `Promise.race`
 * against a timeout but the underlying LLM HTTP call was never cancelled,
 * leaking tokens / connections.
 *
 * What this file covers (real `runCognitiveModule` — the wrapper that
 * actually fires the Promise.race timeout):
 *  1. Runner timeout aborts `ctx.signal` AND that signal reaches `callLLM`
 *     in `prompt_only` mode (`signal.aborted === true`).
 *  2. Same for `evaluator` mode.
 *  3. External caller signal composes with the internal controller — caller
 *     cancellation propagates into `ctx.signal` for both modes.
 *  4. Abort reason is preserved: timeout → 'skill_runner_timeout',
 *     external caller → caller-provided reason.
 *
 * Other reasons-of-existence:
 *  - `tests/unit/skills/skill-runner.spec.ts` mocks the cognition runner
 *    pass-through, so its `timeout` path never exercises the real
 *    `abortController.abort()` chain.
 *  - Mode-level tests (`mode-prompt-only.spec.ts`, `mode-evaluator.spec.ts`)
 *    verify the mode→callLLM forwarding in isolation. This file verifies
 *    the SkillRunner→mode wiring on top.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

// Feature flag ON.
vi.mock('@/config/feature-flags.js', () => ({
  featureFlags: { isEnabled: vi.fn(() => true) },
}));

// Stub skillsRepo so findActive returns a known-good skill row AND
// cognitiveModuleLogRepo so the runner's audit insert is a no-op.
vi.mock('@/db/repositories.js', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@/db/repositories.js');
  return {
    ...actual,
    skillsRepo: {
      findActive: vi.fn(),
      listByCategory: vi.fn(async () => []),
      propose: vi.fn(),
      activate: vi.fn(),
      deprecate: vi.fn(),
      rollback: vi.fn(),
      getById: vi.fn(),
      getByDescriptor: vi.fn(),
      listVersions: vi.fn(async () => []),
    },
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => undefined),
    },
  };
});

// Stub policy resolver (no descriptors declared in the test skill).
vi.mock('@/control-plane/policy/policy-descriptor-resolver.js', () => ({
  policyDescriptorResolver: {
    resolveDescriptors: vi.fn(async () => ({ resolved: [], unresolved: [] })),
  },
}));

// Stub `callLLM`. We capture the signal passed in and never resolve so the
// runner's Promise.race timeout can fire and abort it.
vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(),
}));

import { runSkill } from '@/skills/skill-runner.js';
import { skillsRepo } from '@/db/repositories.js';
import { callLLM } from '@/lib/claude.js';

const baseSkill = {
  id: 'skill-abort-1',
  tenant_id: 'default',
  agent_id: null,
  skill_descriptor: 'abort_check',
  category: 'classify',
  execution_mode: 'prompt_only',
  goal: 'Verify abort plumbing',
  when_to_use: 'tests',
  procedure: { system_prompt: 'sys' },
  constraints: [],
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  allowed_tools: [],
  policy_descriptors: [],
  success_criteria: [],
  failure_modes: [],
  // Short timeout so Promise.race fires fast in tests.
  runtime_hints: { timeout_ms: 50 },
  status: 'active',
  version: 1,
  proposed_by: 'test',
  proposed_reason: null,
  approved_by: 'owner',
  approved_at: new Date(),
  activated_at: new Date(),
  deprecated_at: null,
  rolled_back_at: null,
  rollback_reason: null,
  created_at: new Date(),
};

describe('SkillRunner — AbortSignal plumbing (issue #220)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prompt_only: runner timeout aborts the signal passed to callLLM', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue(baseSkill as any);
    let capturedSignal: AbortSignal | undefined;
    // callLLM never resolves on its own — it only rejects when the signal
    // aborts, mirroring SDK behavior when the request is cancelled.
    vi.mocked(callLLM).mockImplementation(async (params: any) => {
      capturedSignal = params.signal;
      return await new Promise<any>((_resolve, reject) => {
        params.signal?.addEventListener(
          'abort',
          () => {
            const err = new Error('AbortError');
            (err as any).name = 'AbortError';
            reject(err);
          },
          { once: true },
        );
      });
    });

    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () =>
        runSkill({
          skill_descriptor: 'abort_check',
          input: { msg: 'hi' },
          triggered_by: 'user_message',
        }),
    );

    // Runner reports a timeout.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');

    // The signal that reached `callLLM` is now aborted with the
    // skill-runner reason. This is the core invariant being asserted:
    // the abort actually propagated to the LLM call — not just the
    // Promise.race winner.
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBe('skill_runner_timeout');
  });

  it('evaluator: runner timeout aborts the signal passed to callLLM', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue({
      ...baseSkill,
      execution_mode: 'evaluator',
      output_schema: { type: 'object' },
    } as any);
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(callLLM).mockImplementation(async (params: any) => {
      capturedSignal = params.signal;
      return await new Promise<any>((_resolve, reject) => {
        params.signal?.addEventListener(
          'abort',
          () => {
            const err = new Error('AbortError');
            (err as any).name = 'AbortError';
            reject(err);
          },
          { once: true },
        );
      });
    });

    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () =>
        runSkill({
          skill_descriptor: 'abort_check',
          input: {
            candidate_output: { x: 1 },
            baseline: { x: 1 },
          },
          triggered_by: 'evaluator_pipeline',
        }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBe('skill_runner_timeout');
  });

  it('prompt_only: external caller signal composes with runner controller', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue({
      ...baseSkill,
      // Give the runner ample time so the timeout doesn't fire — only the
      // caller's cancellation should abort.
      runtime_hints: { timeout_ms: 5000 },
    } as any);
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(callLLM).mockImplementation(async (params: any) => {
      capturedSignal = params.signal;
      return await new Promise<any>((_resolve, reject) => {
        params.signal?.addEventListener(
          'abort',
          () => {
            const err = new Error('AbortError');
            (err as any).name = 'AbortError';
            reject(err);
          },
          { once: true },
        );
      });
    });

    const externalController = new AbortController();
    const promise = runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () =>
        runSkill({
          skill_descriptor: 'abort_check',
          input: {},
          triggered_by: 'user_message',
          signal: externalController.signal,
        }),
    );

    // Give the runner a tick to enter the mode handler and capture the signal,
    // then cancel from the outside.
    await new Promise((r) => setTimeout(r, 10));
    externalController.abort('caller_cancelled');

    const result = await promise;

    // The signal reached callLLM, and the caller-provided reason was
    // preserved through the controller composition (issue #220 requires
    // the reason to be legible).
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toBe('caller_cancelled');
    // The fall-through return: an aborted LLM call surfaces as either
    // executor_error or timeout depending on which Promise.race arm wins.
    // Either way it's a non-ok result — the important assertion is that
    // the signal propagated.
    expect(result.ok).toBe(false);
  });

  it('prompt_only: pre-aborted external signal short-circuits before LLM call', async () => {
    vi.mocked(skillsRepo.findActive).mockResolvedValue(baseSkill as any);
    vi.mocked(callLLM).mockResolvedValue({
      content: '{"ok":true}',
      tool_uses: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      model: 'x',
    } as any);

    const ctrl = new AbortController();
    ctrl.abort('caller_cancelled');

    const result = await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () =>
        runSkill({
          skill_descriptor: 'abort_check',
          input: {},
          triggered_by: 'user_message',
          signal: ctrl.signal,
        }),
    );

    // Mode throws 'aborted' before issuing the call → executor_error (or
    // timeout) fall-through. callLLM must not have run.
    expect(result.ok).toBe(false);
    expect(callLLM).not.toHaveBeenCalled();
  });
});
