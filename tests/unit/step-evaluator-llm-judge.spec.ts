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
});
