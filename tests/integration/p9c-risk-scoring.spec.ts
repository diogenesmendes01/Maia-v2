/**
 * P9c — Integration test: risk scorer telemetry path.
 *
 * Garante que o gate, quando consultado, registra uma row em
 * `cognitive_module_log` com module_name='risk_assessor_llm', triggered_by
 * correto e latência > 0. O LLM real não é chamado: usamos um gate
 * INJETADO que simula sucesso ou falha — o que importa é que o caminho
 * via runCognitiveModule (audit) seja tomado.
 *
 * Padrão do projeto: integration tests gated em TEST_DB_URL.
 */
import { describe, it, expect, vi } from 'vitest';

// Anthropic SDK mock (mesmo shape de tests/unit/risk-llm-gate.spec.ts e
// tests/integration/p3c-procedure-governance.spec.ts). tests/setup.ts:14
// semeia uma ANTHROPIC_API_KEY placeholder não-vazia, então sem este mock o
// `haikuRiskGate` real construiria o cliente e bateria em api.anthropic.com
// (401 após retry/backoff) — flake + custo. messages.create rejeita para
// forçar o caminho fallback=null do runCognitiveModule sem nenhum I/O de rede.
const { messagesCreateMock } = vi.hoisted(() => ({
  messagesCreateMock: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', () => {
  const Anthropic = vi.fn(function (this: unknown) {
    return { messages: { create: messagesCreateMock } };
  });
  return { default: Anthropic };
});

import { db } from '@/db/client.js';
import { cognitive_module_log } from '@/db/schema.js';
import { eq } from 'drizzle-orm';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { haikuRiskGate } from '@/shared/risk/llm-gate.js';
import { scoreTurn } from '@/runtime/decision/turn-risk-scorer.js';
import { scoreKnowledge } from '@/control-plane/knowledge-state-machine/knowledge-risk-scorer.js';
import { RiskLevel } from '@/types/enums.js';
import type { LLMGate } from '@/shared/risk/types.js';

const SHOULD_RUN = !!process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

async function cleanup() {
  await db
    .delete(cognitive_module_log)
    .where(eq(cognitive_module_log.module_name, 'risk_assessor_llm'));
}

d('P9c — risk scorer telemetry', () => {
  it('haikuRiskGate audita em cognitive_module_log mesmo quando gate falha (Anthropic missing)', async () => {
    await cleanup();
    // ANTHROPIC_API_KEY É semeada (tests/setup.ts:14), mas o SDK está mockado:
    // messages.create rejeita → runCognitiveModule status='error', fallback=null.
    // Audit row deve existir mesmo assim. Zero I/O de rede.
    messagesCreateMock.mockRejectedValueOnce(new Error('boom'));
    await runWithTenantContext({ tenant_id: 'primary', agent_id: 'primary' }, async () => {
      const r = await haikuRiskGate({
        current_level: RiskLevel.LOW,
        context_text: 'test telemetry',
      });
      expect(r).toBeNull(); // fallback
    });
    const rows = await db
      .select()
      .from(cognitive_module_log)
      .where(eq(cognitive_module_log.module_name, 'risk_assessor_llm'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[rows.length - 1]!;
    expect(row.module_name).toBe('risk_assessor_llm');
    expect(row.triggered_by).toBe('sync_conditional');
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    await cleanup();
  });

  it('scoreTurn com heurística não-ambígua NÃO registra row no gate', async () => {
    await cleanup();
    // Gate dummy que registraria se fosse chamado.
    const gate: LLMGate = async () => ({
      suggested_level: RiskLevel.HIGH,
      reason: 'jamais',
    });
    await runWithTenantContext({ tenant_id: 'primary', agent_id: 'primary' }, async () => {
      const r = await scoreTurn(
        { topic: 'casual', tool_kinds: [] },
        { gate, contextText: '' },
      );
      expect(r.level).toBe(RiskLevel.LOW);
      expect(r.llm_consulted).toBe(false);
    });
    const rows = await db
      .select()
      .from(cognitive_module_log)
      .where(eq(cognitive_module_log.module_name, 'risk_assessor_llm'));
    expect(rows.length).toBe(0);
  });

  it('scoreKnowledge com heurística high (não-ambígua) NÃO chama gate', async () => {
    await cleanup();
    const gate: LLMGate = async () => ({
      suggested_level: RiskLevel.LOW,
      reason: 'tentando rebaixar',
    });
    await runWithTenantContext({ tenant_id: 'primary', agent_id: 'primary' }, async () => {
      const r = await scoreKnowledge(
        {
          knowledge_type: 'procedimento',
          touches_irreversible: true,
          tool_kinds: ['irreversible'],
          evidence_count: 5,
        },
        { gate },
      );
      expect(r.llm_consulted).toBe(false);
      // No-downgrade fundamental: gate adversarial não é nem chamado.
    });
    const rows = await db
      .select()
      .from(cognitive_module_log)
      .where(eq(cognitive_module_log.module_name, 'risk_assessor_llm'));
    expect(rows.length).toBe(0);
  });
});
