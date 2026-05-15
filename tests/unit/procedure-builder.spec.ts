import { describe, it, expect, vi, beforeEach } from 'vitest';
import { teachProcedure, teachProcedureSafe } from '@/cognition/procedure-builder.js';
import { runWithTenantContext } from '@/db/tenant-context.js';

vi.mock('@/lib/claude.js', () => ({
  callLLM: vi.fn(),
}));

vi.mock('@/db/repositories.js', async () => {
  const actual = await vi.importActual<typeof import('@/db/repositories.js')>('@/db/repositories.js');
  return {
    ...actual,
    cognitiveModuleLogRepo: { record: vi.fn(async () => {}), recentByModule: vi.fn(async () => []) },
  };
});

import { callLLM } from '@/lib/claude.js';

describe('teachProcedure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('estrutura input livre em draft válido', async () => {
    (callLLM as any).mockResolvedValueOnce({
      content: JSON.stringify({
        intencao: 'Qualificar lead de inglês adulto',
        when_apply: { tags: ['lead_b2c_adulto'] },
        when_not_apply: { tags: ['lead_em_fechamento'] },
        steps: [
          { id: 'descobrir_motivo', intencao: 'Entender porquê', como: 'Pergunte aberto', sucesso_criteria_ref: 'tem_motivo' },
          { id: 'estimar_nivel', intencao: 'Calibrar nível', como: 'Não pergunte direto', depends_on: ['descobrir_motivo'] },
        ],
        success_criteria: [
          { id: 'tem_motivo', type: 'llm_judge', prompt: 'Cliente expressou motivo real?', threshold: 0.7 },
        ],
        failure_modes: ['Confiar no nível declarado'],
        tools_referenced: ['ask_pending_question'],
      }),
    });

    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const draft = await teachProcedure({
        nome: 'qualificar-lead-ingles',
        descricao_livre: 'Quando entra lead novo de inglês adulto, primeiro descobre motivo real (viagem? trabalho? hobby?), depois estima nível sem confrontar...',
        scope: 'tenant',
      });
      expect(draft).not.toBeNull();
      expect(draft?.nome).toBe('qualificar-lead-ingles');
      expect(draft?.intencao).toContain('Qualificar');
      expect(draft?.steps.length).toBe(2);
      expect(draft?.success_criteria.length).toBe(1);
      expect(draft?.source).toBe('ensino');
    });
  });

  it('retorna null quando LLM output inválido', async () => {
    (callLLM as any).mockResolvedValueOnce({ content: 'invalid json' });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const draft = await teachProcedure({
        nome: 'foo',
        descricao_livre: 'algo',
        scope: 'tenant',
      });
      expect(draft).toBeNull();
    });
  });

  // PR #83 C1: teachProcedureSafe surfaces typed failure reasons instead
  // of silent null. Each failure mode below must produce a distinct
  // discriminated outcome that the caller can audit.
  describe('teachProcedureSafe — typed failure reasons (C1)', () => {
    it('llm_rejected: envelope {"error":"..."} is detected explicitly', async () => {
      (callLLM as any).mockResolvedValueOnce({
        content: JSON.stringify({ error: 'input vago — não entendi' }),
      });
      await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
        const res = await teachProcedureSafe({
          nome: 'foo',
          descricao_livre: 'ok',
          scope: 'agent',
        });
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.reason).toBe('llm_rejected');
          expect(res.detail).toContain('vago');
        }
      });
    });

    it('invalid_json: malformed JSON envelope surfaces invalid_json reason', async () => {
      // Has matching {...} braces so the regex extracts the block, but
      // the inner content fails JSON.parse.
      (callLLM as any).mockResolvedValueOnce({ content: '{ not json: yes }' });
      await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
        const res = await teachProcedureSafe({
          nome: 'foo',
          descricao_livre: 'ok',
          scope: 'agent',
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('invalid_json');
      });
    });

    it('no_json_envelope: text without a JSON block surfaces no_json_envelope', async () => {
      (callLLM as any).mockResolvedValueOnce({ content: 'no json here at all' });
      await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
        const res = await teachProcedureSafe({
          nome: 'foo',
          descricao_livre: 'ok',
          scope: 'agent',
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('no_json_envelope');
      });
    });

    it('invalid_schema: parsable JSON missing required fields', async () => {
      (callLLM as any).mockResolvedValueOnce({
        content: JSON.stringify({ intencao: 'X' /* missing steps + success_criteria */ }),
      });
      await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
        const res = await teachProcedureSafe({
          nome: 'foo',
          descricao_livre: 'ok',
          scope: 'agent',
        });
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.reason).toBe('invalid_schema');
          expect(res.detail).toBeDefined();
        }
      });
    });

    it('input_too_long: bounded by MAX_DESCRICAO_LIVRE_LENGTH (M4)', async () => {
      const big = 'x'.repeat(8001);
      await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
        const res = await teachProcedureSafe({
          nome: 'foo',
          descricao_livre: big,
          scope: 'agent',
        });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('input_too_long');
      });
    });
  });

  it('aceita source diferente de ensino (observacao/pratica)', async () => {
    (callLLM as any).mockResolvedValueOnce({
      content: JSON.stringify({
        intencao: 'X',
        when_apply: {},
        steps: [{ id: 's1', intencao: 'a', como: 'b' }],
        success_criteria: [{ id: 'c1', type: 'machine_check', expression: 'x' }],
      }),
    });
    await runWithTenantContext({ tenant_id: 'default', agent_id: 'default' }, async () => {
      const draft = await teachProcedure({
        nome: 'foo',
        descricao_livre: 'algo',
        scope: 'agent',
        source: 'observacao',
      });
      expect(draft?.source).toBe('observacao');
    });
  });
});
