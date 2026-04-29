/**
 * C-004 cross-entity suite — spec 09 + spec 16 §6.3.
 *
 * For every tool that takes entidade_id, prove the constitutional check
 * rejects an out-of-scope entidade BEFORE permission/idempotency layers
 * even run. This catches a regression where a new tool forgets the scope
 * gate (e.g., copy-pastes from a tool that doesn't take entidade_id).
 */
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

const SCOPE = { entidades: ['scoped-1', 'scoped-2'] };
const OUT_OF_SCOPE = 'forbidden-entity';

const TOOLS_WITH_ENTITY: ReadonlyArray<{ tool: string; extraArgs?: Record<string, unknown> }> = [
  { tool: 'register_transaction', extraArgs: { valor: 50 } },
  { tool: 'correct_transaction', extraArgs: { valor: 50, transacao_id: 't1' } },
  { tool: 'cancel_transaction', extraArgs: { transacao_id: 't1' } },
  { tool: 'query_balance' },
  { tool: 'list_transactions' },
  { tool: 'list_pending' },
  { tool: 'identify_entity' },
  { tool: 'classify_transaction', extraArgs: { transacao_id: 't1' } },
  { tool: 'compare_entities', extraArgs: { other_entidade_id: 'scoped-2' } },
  { tool: 'parse_boleto', extraArgs: { sha256: 'abc' } },
  { tool: 'schedule_reminder', extraArgs: { quando: '2026-12-01', texto: 'x' } },
  { tool: 'recall_memory', extraArgs: { query: 'q' } },
  { tool: 'save_fact', extraArgs: { chave: 'k', valor: 1 } },
  { tool: 'start_workflow', extraArgs: { tipo: 'follow_up', resumo: 'x', steps: [] } },
];

describe('C-004 cross-entity dispatcher gate', () => {
  for (const { tool, extraArgs } of TOOLS_WITH_ENTITY) {
    it(`${tool}: rejects entidade_id outside scope`, () => {
      const r = constitutionalCheck({
        intent: { tool, args: { entidade_id: OUT_OF_SCOPE, ...(extraArgs ?? {}) } },
        pessoa,
        resolved: null,
        scope: SCOPE,
      });
      expect(r?.kind).toBe('forbidden');
      if (r?.kind === 'forbidden') expect(r.rule_id).toBe('C-004');
    });

    it(`${tool}: passes when entidade_id is in scope`, () => {
      const r = constitutionalCheck({
        intent: { tool, args: { entidade_id: SCOPE.entidades[0], ...(extraArgs ?? {}) } },
        pessoa,
        resolved: null,
        scope: SCOPE,
      });
      // Either null (allowed) or a different rule kind — never C-004.
      if (r?.kind === 'forbidden') {
        expect(r.rule_id).not.toBe('C-004');
      }
    });
  }

  it('omitting entidade_id does not trigger C-004 (other layers handle it)', () => {
    const r = constitutionalCheck({
      intent: { tool: 'query_balance', args: {} },
      pessoa,
      resolved: null,
      scope: SCOPE,
    });
    if (r?.kind === 'forbidden') {
      expect(r.rule_id).not.toBe('C-004');
    }
  });

  it('null entidade_id does not trigger C-004', () => {
    const r = constitutionalCheck({
      intent: { tool: 'query_balance', args: { entidade_id: null } },
      pessoa,
      resolved: null,
      scope: SCOPE,
    });
    if (r?.kind === 'forbidden') {
      expect(r.rule_id).not.toBe('C-004');
    }
  });

  it('empty scope rejects any entidade_id (defense-in-depth)', () => {
    const r = constitutionalCheck({
      intent: { tool: 'query_balance', args: { entidade_id: 'any' } },
      pessoa,
      resolved: null,
      scope: { entidades: [] },
    });
    expect(r?.kind).toBe('forbidden');
  });
});
