import { describe, it, expect } from 'vitest';
import { constitutionalCheck } from '../../src/governance/rules.js';
import type { Pessoa } from '../../src/db/schema.js';

const pessoa: Pessoa = {
  id: 'p1',
  nome: 'Mendes',
  apelido: null,
  telefone_whatsapp: '+5511999999998',
  tipo: 'dono',
  email: null,
  observacoes: null,
  preferencias: {},
  modelo_mental: {},
  status: 'ativa',
  created_at: new Date(),
  updated_at: new Date(),
};

describe('constitutional rules', () => {
  it('C-001 — bloqueia transação acima do hard limit', () => {
    const r = constitutionalCheck({
      intent: { tool: 'register_transaction', args: { valor: 100_000_000 } },
      pessoa,
      resolved: null,
      scope: { entidades: ['e1'] },
    });
    expect(r?.kind).toBe('forbidden');
    if (r?.kind === 'forbidden') expect(r.rule_id).toBe('C-001');
  });

  it('C-003 — bloqueia send_proactive_message sem dual approval', () => {
    const r = constitutionalCheck({
      intent: { tool: 'send_proactive_message', args: {} },
      pessoa,
      resolved: null,
      scope: { entidades: [] },
    });
    expect(r?.kind).toBe('limit_exceeded');
  });

  it('C-003 — permite send_proactive_message com dual approval', () => {
    const r = constitutionalCheck({
      intent: { tool: 'send_proactive_message', args: {} },
      pessoa,
      resolved: null,
      scope: { entidades: [] },
      dual_approval_granted: true,
    });
    expect(r).toBe(null);
  });

  it('C-004 — bloqueia entidade fora do escopo', () => {
    const r = constitutionalCheck({
      intent: { tool: 'register_transaction', args: { entidade_id: 'fora-do-escopo', valor: 50 } },
      pessoa,
      resolved: null,
      scope: { entidades: ['e1', 'e2'] },
    });
    expect(r?.kind).toBe('forbidden');
    if (r?.kind === 'forbidden') expect(r.rule_id).toBe('C-004');
  });

  it('C-005 — bloqueia investimento estratégico', () => {
    const r = constitutionalCheck({
      intent: {
        tool: 'register_transaction',
        args: { valor: 1000, entidade_id: 'e1', metadata: { tipo: 'investimento_estrategico' } },
      },
      pessoa,
      resolved: null,
      scope: { entidades: ['e1'] },
    });
    expect(r?.kind).toBe('forbidden');
  });

  it('passa em transação normal', () => {
    const r = constitutionalCheck({
      intent: { tool: 'register_transaction', args: { valor: 50, entidade_id: 'e1' } },
      pessoa,
      resolved: null,
      scope: { entidades: ['e1'] },
    });
    expect(r).toBe(null);
  });

  // C-009 (issue #437) — the boleto sensitive writes require confirmation /
  // dual approval before execution. Composes with confirm_before_write_policy
  // (the DSL decider at the Mid PEP) + the dispatcher guard.
  it.each(['boleto_cancel', 'company_campaign_remove', 'refund_create'])(
    'C-009 — bloqueia %s sem confirmação (dual approval)',
    (tool) => {
      const r = constitutionalCheck({
        intent: { tool, args: { entidade_id: 'e1', valor: 10 } },
        pessoa,
        resolved: null,
        scope: { entidades: ['e1'] },
      });
      expect(r?.kind).toBe('limit_exceeded');
      if (r?.kind === 'limit_exceeded') {
        expect(r.required_action).toBe('dual_approval');
      }
    },
  );

  it.each(['boleto_cancel', 'company_campaign_remove', 'refund_create'])(
    'C-009 — permite %s com confirmação (dual_approval_granted)',
    (tool) => {
      const r = constitutionalCheck({
        intent: { tool, args: { entidade_id: 'e1', valor: 10 } },
        pessoa,
        resolved: null,
        scope: { entidades: ['e1'] },
        dual_approval_granted: true,
      });
      expect(r).toBe(null);
    },
  );

  it('C-009 — não afeta tools de leitura do vertical boleto', () => {
    const r = constitutionalCheck({
      intent: { tool: 'boleto_search', args: { entidade_id: 'e1' } },
      pessoa,
      resolved: null,
      scope: { entidades: ['e1'] },
    });
    expect(r).toBe(null);
  });
});
