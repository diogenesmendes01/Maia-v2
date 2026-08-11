import { describe, it, expect } from 'vitest';
import {
  evaluateFinancialAuthorization,
  toCents,
  type FinancialDecision,
} from '../../src/governance/financial-authorization.js';
import { canAct } from '../../src/governance/permissions.js';
import { config } from '../../src/config/env.js';
import type { Pessoa, Permissao, PermissionProfile } from '../../src/db/schema.js';

const financeProfile: PermissionProfile = {
  id: 'financeiro',
  nome: 'Financeiro',
  acoes: ['create_transaction', 'read_balance'],
  limite_default: '1000',
  descricao: null,
  created_at: new Date(),
};

const ownerProfile: PermissionProfile = {
  id: 'dono_total',
  nome: 'Dono',
  acoes: ['*'],
  limite_default: null,
  descricao: null,
  created_at: new Date(),
};

const pessoa: Pessoa = {
  id: 'p1',
  nome: 'Joana',
  apelido: null,
  telefone_whatsapp: '+5511999999999',
  tipo: 'socio',
  email: null,
  observacoes: null,
  preferencias: {},
  modelo_mental: {},
  status: 'ativa',
  created_at: new Date(),
  updated_at: new Date(),
};

const permissao: Permissao = {
  id: 'perm1',
  pessoa_id: 'p1',
  entidade_id: 'e1',
  papel: 'socio',
  profile_id: 'financeiro',
  acoes_permitidas: [],
  limites: {},
  status: 'ativa',
  created_at: new Date(),
};

function resolved(overrides?: {
  valor_max?: number | null;
  naturezas_permitidas?: string[];
  categorias_permitidas?: string[];
  horario_permitido?: { dias: number[]; inicio: string; fim: string };
  profile?: PermissionProfile;
  permissao?: Permissao;
}) {
  return {
    permissao: overrides?.permissao ?? permissao,
    profile: overrides?.profile ?? financeProfile,
    effective_limits: {
      valor_max: overrides?.valor_max === undefined ? 1000 : overrides.valor_max,
      naturezas_permitidas: overrides?.naturezas_permitidas,
      categorias_permitidas: overrides?.categorias_permitidas,
      horario_permitido: overrides?.horario_permitido,
    },
  };
}

function evaluate(input: Partial<Parameters<typeof evaluateFinancialAuthorization>[0]>) {
  return evaluateFinancialAuthorization({
    pessoa,
    resolved: resolved(),
    action: 'create_transaction',
    valor: 100,
    ...input,
  });
}

describe('toCents', () => {
  it('converte reais para centavos inteiros', () => {
    expect(toCents(10)).toBe(1000);
    expect(toCents(0.1)).toBe(10);
    expect(toCents(1234.56)).toBe(123456);
    expect(toCents(0)).toBe(0);
  });
  it('rejeita NaN, infinito, negativo e overflow', () => {
    expect(toCents(Number.NaN)).toBeNull();
    expect(toCents(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toCents(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(toCents(-1)).toBeNull();
    expect(toCents(Number.MAX_VALUE)).toBeNull();
  });
});

describe('evaluateFinancialAuthorization — status e permissão', () => {
  it('nega pessoa inativa', () => {
    const d = evaluate({ pessoa: { ...pessoa, status: 'inativa' } });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'pessoa_inactive' });
  });
  it('nega sem permissão para a entidade', () => {
    const d = evaluate({ resolved: null });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'no_permission_for_entity' });
  });
  it('nega permissão suspensa', () => {
    const d = evaluate({
      resolved: resolved({ permissao: { ...permissao, status: 'suspensa' } }),
    });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'permission_inactive' });
  });
  it('nega ação fora do profile', () => {
    const d = evaluate({ action: 'change_permission' });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'action_not_allowed' });
  });
});

describe('evaluateFinancialAuthorization — valores inválidos', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -10, Number.MAX_VALUE])(
    'nega valor inválido %s',
    (valor) => {
      const d = evaluate({ valor, resolved: resolved({ valor_max: null }) });
      expect(d).toMatchObject({ decision: 'deny', reason_code: 'invalid_amount' });
    },
  );
});

describe('evaluateFinancialAuthorization — limite individual', () => {
  it('nega acima do limite individual mesmo abaixo do teto global', () => {
    const d = evaluate({ valor: 1500, resolved: resolved({ valor_max: 1000 }) });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'above_individual_limit' });
  });
  it('permite exatamente no limite individual (borda inclusiva)', () => {
    const d = evaluate({ valor: 1000, resolved: resolved({ valor_max: 1000 }) });
    expect(d.decision).not.toBe('deny');
  });
  it('valor_max null = sem limite individual (teto global aplica)', () => {
    const d = evaluate({
      valor: config.VALOR_LIMITE_DURO,
      resolved: resolved({ valor_max: null }),
    });
    expect(d.decision).not.toBe('deny');
  });
  it('valor_max 0 bloqueia qualquer valor positivo (fail-closed)', () => {
    const d = evaluate({ valor: 0.01, resolved: resolved({ valor_max: 0 }) });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'above_individual_limit' });
  });
  it('owner (profile *) continua sujeito ao teto global', () => {
    const d = evaluate({
      valor: config.VALOR_LIMITE_DURO + 1,
      resolved: resolved({ valor_max: null, profile: ownerProfile }),
      pessoa: { ...pessoa, tipo: 'dono' },
    });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'above_hard_limit' });
  });
  it('limite individual não amplia o teto global', () => {
    const d = evaluate({
      valor: config.VALOR_LIMITE_DURO + 1,
      resolved: resolved({ valor_max: config.VALOR_LIMITE_DURO * 10 }),
    });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'above_hard_limit' });
  });
});

describe('evaluateFinancialAuthorization — natureza e categoria', () => {
  it('undefined = sem restrição adicional', () => {
    const d = evaluate({ natureza: 'despesa' });
    expect(d.decision).not.toBe('deny');
  });
  it('array vazio = nada permitido', () => {
    const d = evaluate({
      natureza: 'despesa',
      resolved: resolved({ naturezas_permitidas: [] }),
    });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'natureza_not_allowed' });
  });
  it('natureza fora da lista é negada', () => {
    const d = evaluate({
      natureza: 'despesa',
      resolved: resolved({ naturezas_permitidas: ['receita'] }),
    });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'natureza_not_allowed' });
  });
  it('restrição presente + natureza ausente no intent = fail-closed', () => {
    const d = evaluate({ resolved: resolved({ naturezas_permitidas: ['receita'] }) });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'natureza_not_allowed' });
  });
  it('categoria fora da lista é negada', () => {
    const d = evaluate({
      categoria_id: 'cat-b',
      resolved: resolved({ categorias_permitidas: ['cat-a'] }),
    });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'categoria_not_allowed' });
  });
  it('categoria na lista passa', () => {
    const d = evaluate({
      categoria_id: 'cat-a',
      resolved: resolved({ categorias_permitidas: ['cat-a'] }),
    });
    expect(d.decision).not.toBe('deny');
  });
  it('restrição malformada (não-array vinda do jsonb) falha fechado', () => {
    const d = evaluate({
      natureza: 'despesa',
      resolved: resolved({
        naturezas_permitidas: null as unknown as string[],
      }),
    });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'natureza_not_allowed' });
  });
  it('horario_permitido malformado (null do jsonb) falha fechado', () => {
    const d = evaluate({
      resolved: resolved({
        horario_permitido: null as unknown as { dias: number[]; inicio: string; fim: string },
      }),
    });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'invalid_time_window' });
  });
});

describe('evaluateFinancialAuthorization — janela de horário', () => {
  // 2026-07-15 é uma quarta-feira (ISO dia 3). 15:00 UTC = 12:00 em
  // America/Sao_Paulo (UTC-3).
  const wednesdayNoonSP = new Date('2026-07-15T15:00:00Z');

  it('dentro da janela passa', () => {
    const d = evaluate({
      now: wednesdayNoonSP,
      timezone: 'America/Sao_Paulo',
      resolved: resolved({
        horario_permitido: { dias: [1, 2, 3, 4, 5], inicio: '09:00', fim: '18:00' },
      }),
    });
    expect(d.decision).not.toBe('deny');
  });
  it('fora do horário é negado', () => {
    const d = evaluate({
      now: wednesdayNoonSP,
      timezone: 'America/Sao_Paulo',
      resolved: resolved({
        horario_permitido: { dias: [1, 2, 3, 4, 5], inicio: '14:00', fim: '18:00' },
      }),
    });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'outside_allowed_hours' });
  });
  it('dia fora da lista é negado', () => {
    const d = evaluate({
      now: wednesdayNoonSP,
      timezone: 'America/Sao_Paulo',
      resolved: resolved({
        horario_permitido: { dias: [6, 7], inicio: '00:00', fim: '23:59' },
      }),
    });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'outside_allowed_hours' });
  });
  it('timezone muda o resultado (virada do dia)', () => {
    // 2026-07-16T01:00Z = quarta 22:00 em São Paulo, quinta 01:00 em UTC.
    const d = evaluate({
      now: new Date('2026-07-16T01:00:00Z'),
      timezone: 'America/Sao_Paulo',
      resolved: resolved({
        horario_permitido: { dias: [3], inicio: '20:00', fim: '23:00' },
      }),
    });
    expect(d.decision).not.toBe('deny');
  });
  it('janela overnight cobre a madrugada do dia seguinte', () => {
    // Quinta 01:00 em São Paulo (2026-07-16T04:00Z), janela quarta 22:00→02:00.
    const d = evaluate({
      now: new Date('2026-07-16T04:00:00Z'),
      timezone: 'America/Sao_Paulo',
      resolved: resolved({
        horario_permitido: { dias: [3], inicio: '22:00', fim: '02:00' },
      }),
    });
    expect(d.decision).not.toBe('deny');
  });
  it('janela malformada falha fechado', () => {
    const d = evaluate({
      resolved: resolved({
        horario_permitido: { dias: [9], inicio: '25:00', fim: 'xx' },
      }),
    });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'invalid_time_window' });
  });
});

describe('evaluateFinancialAuthorization — thresholds e bordas', () => {
  const noLimit = () => resolved({ valor_max: null });

  it('valor == SEM_CONFIRMACAO fica na faixa allow (igualdade não escala)', () => {
    const d = evaluate({ valor: config.VALOR_LIMITE_SEM_CONFIRMACAO, resolved: noLimit() });
    expect(d.decision).toBe('allow_without_confirmation');
  });
  it('1 centavo acima de SEM_CONFIRMACAO exige confirmação simples', () => {
    const d = evaluate({
      valor: config.VALOR_LIMITE_SEM_CONFIRMACAO + 0.01,
      resolved: noLimit(),
    });
    expect(d.decision).toBe('require_single_confirmation');
  });
  it('valor == DUAL_APPROVAL fica na confirmação simples', () => {
    const d = evaluate({ valor: config.VALOR_DUAL_APPROVAL, resolved: noLimit() });
    expect(d.decision).toBe('require_single_confirmation');
  });
  it('1 centavo acima de DUAL_APPROVAL exige aprovação dupla', () => {
    const d = evaluate({ valor: config.VALOR_DUAL_APPROVAL + 0.01, resolved: noLimit() });
    expect(d.decision).toBe('require_dual_approval');
  });
  it('valor == LIMITE_DURO fica na aprovação dupla', () => {
    const d = evaluate({ valor: config.VALOR_LIMITE_DURO, resolved: noLimit() });
    expect(d.decision).toBe('require_dual_approval');
  });
  it('acima de LIMITE_DURO é negado', () => {
    const d = evaluate({ valor: config.VALOR_LIMITE_DURO + 0.01, resolved: noLimit() });
    expect(d).toMatchObject({ decision: 'deny', reason_code: 'above_hard_limit' });
  });
});

describe('evaluateFinancialAuthorization — monotonicidade (property)', () => {
  const RANK: Record<FinancialDecision['decision'], number> = {
    allow_without_confirmation: 0,
    require_single_confirmation: 1,
    require_dual_approval: 2,
    deny: 3,
  };

  it('aumentar o valor nunca reduz a exigência', () => {
    // Varredura determinística cruzando todas as bordas de threshold.
    const values: number[] = [];
    for (let v = 0; v <= config.VALOR_LIMITE_DURO + 200; v += 97.13) values.push(v);
    values.push(
      config.VALOR_LIMITE_SEM_CONFIRMACAO,
      config.VALOR_LIMITE_SEM_CONFIRMACAO + 0.01,
      config.VALOR_DUAL_APPROVAL,
      config.VALOR_DUAL_APPROVAL + 0.01,
      config.VALOR_LIMITE_DURO,
      config.VALOR_LIMITE_DURO + 0.01,
    );
    values.sort((a, b) => a - b);
    let previousRank = -1;
    for (const valor of values) {
      const d = evaluate({ valor, resolved: resolved({ valor_max: null }) });
      const rank = RANK[d.decision];
      expect(rank, `valor=${valor}`).toBeGreaterThanOrEqual(previousRank);
      previousRank = rank;
    }
  });
});

describe('canAct — delega a decisão de valor ao avaliador financeiro', () => {
  it('nega acima do limite individual', () => {
    const res = canAct({
      pessoa,
      resolved: resolved({ valor_max: 1000 }),
      action: 'create_transaction',
      valor: 5000,
    });
    expect(res).toMatchObject({ allowed: false, reason: 'above_individual_limit' });
  });
  it('require_* não nega em canAct (classificação é do dispatcher)', () => {
    const res = canAct({
      pessoa,
      resolved: resolved({ valor_max: null }),
      action: 'create_transaction',
      valor: config.VALOR_DUAL_APPROVAL,
    });
    expect(res.allowed).toBe(true);
  });
  it('nega natureza fora da permissão', () => {
    const res = canAct({
      pessoa,
      resolved: resolved({ valor_max: null, naturezas_permitidas: ['receita'] }),
      action: 'create_transaction',
      valor: 10,
      natureza: 'despesa',
    });
    expect(res).toMatchObject({ allowed: false, reason: 'natureza_not_allowed' });
  });
});
