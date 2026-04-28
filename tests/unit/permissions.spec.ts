import { describe, it, expect } from 'vitest';
import { canAct, profileAllows } from '../../src/governance/permissions.js';
import type { Pessoa, Permissao, PermissionProfile } from '../../src/db/schema.js';

const baseProfileContador: PermissionProfile = {
  id: 'contador_leitura',
  nome: 'Contador',
  acoes: ['read_balance', 'read_transactions'],
  limite_default: '0',
  descricao: null,
  created_at: new Date(),
};
const ownerProfile: PermissionProfile = {
  id: 'dono_total',
  nome: 'Dono',
  acoes: ['*'],
  limite_default: '999999',
  descricao: null,
  created_at: new Date(),
};

const ativaPessoa: Pessoa = {
  id: 'p1',
  nome: 'Joana',
  apelido: null,
  telefone_whatsapp: '+5511999999999',
  tipo: 'contador',
  email: null,
  observacoes: null,
  preferencias: {},
  modelo_mental: {},
  status: 'ativa',
  created_at: new Date(),
  updated_at: new Date(),
};

const ativaPermissao: Permissao = {
  id: 'perm1',
  pessoa_id: 'p1',
  entidade_id: 'e1',
  papel: 'contador',
  profile_id: 'contador_leitura',
  acoes_permitidas: [],
  limites: {},
  status: 'ativa',
  created_at: new Date(),
};

describe('profileAllows', () => {
  it('owner profile permite tudo', () => {
    expect(profileAllows(ownerProfile, 'create_transaction')).toBe(true);
  });
  it('contador profile não permite create_transaction', () => {
    expect(profileAllows(baseProfileContador, 'create_transaction')).toBe(false);
  });
  it('contador permite read_balance', () => {
    expect(profileAllows(baseProfileContador, 'read_balance')).toBe(true);
  });
});

describe('canAct', () => {
  it('rejeita pessoa inativa', () => {
    const res = canAct({
      pessoa: { ...ativaPessoa, status: 'inativa' },
      resolved: { permissao: ativaPermissao, profile: baseProfileContador, effective_limits: { valor_max: 0 } },
      action: 'read_balance',
    });
    expect(res.allowed).toBe(false);
  });
  it('rejeita permissão suspensa', () => {
    const res = canAct({
      pessoa: ativaPessoa,
      resolved: {
        permissao: { ...ativaPermissao, status: 'suspensa' },
        profile: baseProfileContador,
        effective_limits: { valor_max: 0 },
      },
      action: 'read_balance',
    });
    expect(res.allowed).toBe(false);
  });
  it('aceita read_balance pra contador', () => {
    const res = canAct({
      pessoa: ativaPessoa,
      resolved: {
        permissao: ativaPermissao,
        profile: baseProfileContador,
        effective_limits: { valor_max: 0 },
      },
      action: 'read_balance',
    });
    expect(res.allowed).toBe(true);
  });
  it('rejeita create_transaction pra contador', () => {
    const res = canAct({
      pessoa: ativaPessoa,
      resolved: {
        permissao: ativaPermissao,
        profile: baseProfileContador,
        effective_limits: { valor_max: 0 },
      },
      action: 'create_transaction',
    });
    expect(res.allowed).toBe(false);
  });
  it('rejeita valor acima do hard limit mesmo para owner', () => {
    const res = canAct({
      pessoa: { ...ativaPessoa, tipo: 'dono' },
      resolved: { permissao: ativaPermissao, profile: ownerProfile, effective_limits: { valor_max: 999999 } },
      action: 'create_transaction',
      valor: 999999999,
    });
    expect(res.allowed).toBe(false);
  });
});
