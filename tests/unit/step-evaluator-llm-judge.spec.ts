import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithTenantContext } from '@/db/tenant-context.js';

const messagesCreateMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: { create: messagesCreateMock },
  }));
  return { default: Anthropic };
});

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>(
    '@/db/repositories.js',
  );
  return {
    ...actual,
    cognitiveModuleLogRepo: {
      record: vi.fn(async () => {}),
      recentByModule: vi.fn(async () => []),
    },
  };
});

import { judgeStepCriterion } from '@/cognition/step-evaluator-llm-judge.js';

function makeAnthropicReply(jsonObj: Record<string, unknown>): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(jsonObj) }],
  };
}

describe('judgeStepCriterion', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
  });

  it('score acima do threshold → passed=true, score e reasoning preservados', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ score: 0.85, reasoning: 'good' }),
    );
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const out = await judgeStepCriterion({
          prompt: 'Resposta esclarece o motivo?',
          threshold: 0.7,
          response_text: 'Sim, esclareci com detalhes',
        });
        expect(out.passed).toBe(true);
        expect(out.score).toBe(0.85);
        expect(out.reasoning).toBe('good');
      },
    );
  });

  it('score abaixo do threshold → passed=false', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ score: 0.5, reasoning: 'too vague' }),
    );
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const out = await judgeStepCriterion({
          prompt: 'Resposta clara?',
          threshold: 0.7,
          response_text: 'hmm',
        });
        expect(out.passed).toBe(false);
        expect(out.score).toBe(0.5);
        expect(out.reasoning).toBe('too vague');
      },
    );
  });

  it('Anthropic lança erro → fallback passed=false, reasoning inclui timeout_or_error', async () => {
    messagesCreateMock.mockRejectedValueOnce(new Error('network exploded'));
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const out = await judgeStepCriterion({
          prompt: 'X?',
          threshold: 0.7,
          response_text: 'resposta',
        });
        expect(out.passed).toBe(false);
        expect(out.score).toBe(0);
        expect(out.reasoning).toContain('timeout_or_error');
      },
    );
  });

  it('rubric opcional é incluído no user prompt sem quebrar parsing', async () => {
    messagesCreateMock.mockResolvedValueOnce(
      makeAnthropicReply({ score: 0.9, reasoning: 'rubric ok' }),
    );
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const out = await judgeStepCriterion({
          prompt: 'Resposta cobre todos os pontos?',
          threshold: 0.7,
          response_text: 'sim, cobri A, B e C',
          rubric: 'precisa mencionar A, B, C',
        });
        expect(out.passed).toBe(true);
        const lastCall = messagesCreateMock.mock.calls[0]?.[0] as {
          messages: Array<{ content: string }>;
        };
        expect(lastCall.messages[0].content).toContain('RUBRIC');
        expect(lastCall.messages[0].content).toContain('precisa mencionar A, B, C');
      },
    );
  });

  it('resposta sem JSON parseável → reasoning indica falha de parsing', async () => {
    messagesCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'desculpe, sem json' }],
    });
    await runWithTenantContext(
      { tenant_id: 'default', agent_id: 'default' },
      async () => {
        const out = await judgeStepCriterion({
          prompt: 'X?',
          threshold: 0.7,
          response_text: 'r',
        });
        expect(out.passed).toBe(false);
        expect(out.score).toBe(0);
      },
    );
  });

  // PR #85 fix P85-I5 — distinct reasoning when ANTHROPIC_API_KEY is unset
  // so ops can triage configuration failures from "judge legitimately
  // scored low". We mock @/config/env so config validation doesn't fail
  // at module-load time (env.ts enforces "key required when
  // LLM_PROVIDER=anthropic"); the runtime short-circuit inside
  // step-evaluator-llm-judge.ts kicks in regardless of how the key got
  // unset in production (rotation forgot to update staging, secret
  // manager outage, etc.).
  it('ANTHROPIC_API_KEY ausente → reasoning=judge_missing_api_key (sem chamar SDK)', async () => {
    vi.resetModules();
    // Mock config so the runtime sees an empty ANTHROPIC_API_KEY without
    // triggering env.ts's startup validation. Logger.ts also imports
    // config at top-level, so we need to provide the minimal surface it
    // relies on (LOG_LEVEL/NODE_ENV) — same convention as
    // tests/unit/logger-redact.spec.ts when it stubs config.
    vi.doMock('@/config/env.js', () => ({
      config: {
        ANTHROPIC_API_KEY: undefined,
        LLM_PROVIDER: 'anthropic',
        LOG_LEVEL: 'info',
        NODE_ENV: 'test',
      },
    }));
    try {
      const { judgeStepCriterion: judgeReloaded } = await import(
        '@/cognition/step-evaluator-llm-judge.js'
      );
      await runWithTenantContext(
        { tenant_id: 'default', agent_id: 'default' },
        async () => {
          const out = await judgeReloaded({
            prompt: 'X?',
            threshold: 0.7,
            response_text: 'qualquer coisa',
          });
          expect(out.passed).toBe(false);
          expect(out.score).toBe(0);
          expect(out.reasoning).toBe('judge_missing_api_key');
        },
      );
      // SDK MUST NOT be invoked when key is missing — short-circuited.
      expect(messagesCreateMock).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('@/config/env.js');
    }
  });
});
