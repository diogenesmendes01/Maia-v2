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
 *  2. suggested_level inválido (não está no enum) → null + runner status=error.
 *  3. Texto unparseable (sem JSON) → null + runner status=error.
 *  4. JSON malformado → null + runner status=error.
 *  5. Anthropic throws → null (fallback do runCognitiveModule).
 *  6. cognitive_module_log.record é chamado com module_name correto.
 *
 * Codex review #97 finding 2: parse/validation failures DEVEM ser
 * audit-visible (runner status='error', fallback_triggered=true), não
 * silent (status='success', output=null). Antes, runner classificava
 * como success quando o gate retornava null sem throw — agora o gate
 * THROW para parse failures e o runner captura como erro.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { anthropicCreateMock, recordMock } = vi.hoisted(() => ({
  anthropicCreateMock: vi.fn(),
  recordMock: vi.fn(async () => {}),
}));

vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn(function (this: unknown) {
    return { messages: { create: anthropicCreateMock } };
  });
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

  it('suggested_level inválido (não no enum) → null + runner status=error', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [
        { type: 'text', text: '{"suggested_level":"super_high","reason":"x"}' },
      ],
    });
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.LOW, context_text: 'x' }),
    );
    expect(r).toBeNull();
    // Codex finding 2: parse failure deve aparecer em audit como erro.
    expect(recordMock).toHaveBeenCalledTimes(1);
    const call = recordMock.mock.calls[0]?.[0] as {
      status?: string;
      fallback_triggered?: boolean;
      fallback_reason?: string | null;
    };
    expect(call?.status).toBe('error');
    expect(call?.fallback_triggered).toBe(true);
    expect(call?.fallback_reason).toMatch(/schema_invalid|parse failure/);
  });

  it('texto sem JSON → null + runner status=error', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'sem json desculpe' }],
    });
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.LOW, context_text: 'x' }),
    );
    expect(r).toBeNull();
    expect(recordMock).toHaveBeenCalledTimes(1);
    const call = recordMock.mock.calls[0]?.[0] as {
      status?: string;
      fallback_triggered?: boolean;
      fallback_reason?: string | null;
    };
    expect(call?.status).toBe('error');
    expect(call?.fallback_triggered).toBe(true);
    expect(call?.fallback_reason).toMatch(/no_json/);
  });

  it('JSON malformado (truncado, sem chave de fechamento) → null + runner status=error', async () => {
    // Truncado SEM '}' bate em no_json (regex /\{[\s\S]*\}/ exige fechamento).
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"suggested_level":"high",' /* trunc */ }],
    });
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.LOW, context_text: 'x' }),
    );
    expect(r).toBeNull();
    expect(recordMock).toHaveBeenCalledTimes(1);
    const call = recordMock.mock.calls[0]?.[0] as {
      status?: string;
      fallback_triggered?: boolean;
      fallback_reason?: string | null;
    };
    expect(call?.status).toBe('error');
    expect(call?.fallback_triggered).toBe(true);
    // Sem fechamento → no_json. (Para malformed_json precisaria de chaves + JSON.parse falhar.)
    expect(call?.fallback_reason).toMatch(/no_json|malformed_json/);
  });

  it('JSON com chaves mas syntax inválido → null + runner status=error (malformed_json)', async () => {
    // Tem chaves balanceadas, mas conteúdo dentro é syntax inválido (trailing comma + faltando valor).
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"suggested_level":"high", }' }],
    });
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.LOW, context_text: 'x' }),
    );
    expect(r).toBeNull();
    const call = recordMock.mock.calls[0]?.[0] as {
      status?: string;
      fallback_reason?: string | null;
    };
    expect(call?.status).toBe('error');
    expect(call?.fallback_reason).toMatch(/malformed_json/);
  });

  it('Anthropic throws → null (runCognitiveModule fallback) + runner status=error', async () => {
    anthropicCreateMock.mockRejectedValueOnce(new Error('boom'));
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.MEDIUM, context_text: 'x' }),
    );
    expect(r).toBeNull();
    expect(recordMock).toHaveBeenCalledTimes(1);
    const call = recordMock.mock.calls[0]?.[0] as {
      status?: string;
      fallback_triggered?: boolean;
    };
    expect(call?.status).toBe('error');
    expect(call?.fallback_triggered).toBe(true);
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
    const call = recordMock.mock.calls[0]?.[0] as { module_name?: string; status?: string };
    expect(call?.module_name).toBe('risk_assessor_llm');
    // Sucesso real (parse ok) → status='success', sem fallback.
    expect(call?.status).toBe('success');
  });

  it('NÃO permite suggested_level numérico → null + runner status=error', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"suggested_level":3,"reason":"x"}' }],
    });
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.LOW, context_text: 'x' }),
    );
    expect(r).toBeNull();
    expect(recordMock).toHaveBeenCalledTimes(1);
    const call = recordMock.mock.calls[0]?.[0] as {
      status?: string;
      fallback_reason?: string | null;
    };
    expect(call?.status).toBe('error');
    expect(call?.fallback_reason).toMatch(/schema_invalid/);
  });

  it('suggested_level ausente do JSON → null + runner status=error (schema_invalid)', async () => {
    anthropicCreateMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"reason":"esqueci o level"}' }],
    });
    const r = await withCtx(() =>
      haikuRiskGate({ current_level: RiskLevel.LOW, context_text: 'x' }),
    );
    expect(r).toBeNull();
    const call = recordMock.mock.calls[0]?.[0] as {
      status?: string;
      fallback_reason?: string | null;
    };
    expect(call?.status).toBe('error');
    expect(call?.fallback_reason).toMatch(/schema_invalid/);
  });
});
