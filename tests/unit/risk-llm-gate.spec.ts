/**
 * P9c — Haiku risk gate tests.
 *
 * Mock pattern: `vi.hoisted` + `vi.mock('@anthropic-ai/sdk')` (mesmo
 * shape do role-selector llm-suggester). `runCognitiveModule` é executado
 * real (não-mock) para validar fallback=null em throw + audit em
 * cognitive_module_log.
 *
 * Cenários:
 *  1. Anthropic ok com {suggested_level, reason} → resultado parsed.
 *  2. suggested_level inválido (não está no enum) → null.
 *  3. Texto unparseable (sem JSON) → null.
 *  4. JSON malformado → null.
 *  5. Anthropic throws → null (fallback do runCognitiveModule).
 *  6. cognitive_module_log.record é chamado com module_name correto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { anthropicCreateMock, recordMock } = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  recordMock: vi.fn(async () => {}),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: { create: anthropicCreateMock },
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
      record: recordMock,
      recentByModule: vi.fn(async () => []),
    },
  };
});

import { runWithTenantContext } from '@/db/tenant-context.js';
import { haikuRiskGate } from '@/shared/risk/llm-gate.ts';
import { RiskLevel } from '@/types/enums.js';

beforeEach(() => {
  anthropicCreateMock.mockReset();
  recordMock.mockClear();
});

async function withCtx<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, fn);
}

describe('haikuRiskGate', () => {
  it('Anthropic ok → retorna {suggested_level, reason}', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: '{"suggested_level":"high","reason":"financeiro irreversível"}',
        },
      ],
    });
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.MEDIUM, context_text: 'transferir 5k' }),
    );
    expect(r).not.toBeNull();
    expect(r?.suggested_level).toBe(RiskLevel.HIGH);
    expect(r?.reason).toBe('financeiro irreversível');
  });

  it('suggested_level inválido (não no enum) → null', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [
        { type: 'text', text: '{"suggested_level":"super_high","reason":"x"}' },
      ],
    });
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.LOW, context_text: 'x' }),
    );
    expect(r).toBeNull();
  });

  it('texto sem JSON → null sem crash', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'sem json desculpe' }],
    });
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.LOW, context_text: 'x' }),
    );
    expect(r).toBeNull();
  });

  it('JSON malformado (truncado) → null sem crash', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"suggested_level":"high",' /* trunc */ }],
    });
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.LOW, context_text: 'x' }),
    );
    expect(r).toBeNull();
  });

  it('Anthropic throws → null (runCognitiveModule fallback)', async () => {
    anthropicCreateMock.mockRejectedValueOnce(new Error('boom'));
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.MEDIUM, context_text: 'x' }),
    );
    expect(r).toBeNull();
  });

  it('cognitive_module_log.record chamado com module_name=risk_assessor_llm', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [
        { type: 'text', text: '{"suggested_level":"medium","reason":"x"}' },
      ],
    });
    await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.LOW, context_text: 'x' }),
    );
    expect(recordMock).toHaveBeenCalledTimes(1);
    const call = recordMock.mock.calls[0]?.[0] as { module_name?: string };
    expect(call?.module_name).toBe('risk_assessor_llm');
  });

  it('NÃO permite suggested_level numérico', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"suggested_level":3,"reason":"x"}' }],
    });
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.LOW, context_text: 'x' }),
    );
    expect(r).toBeNull();
  });
});
