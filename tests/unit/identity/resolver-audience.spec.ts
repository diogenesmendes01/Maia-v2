/**
 * Issue #407 — resolveIdentity audience wiring.
 *
 * Covers the acceptance criteria:
 *  (a) two agents / same phone with distinct audience roles;
 *  (b) known pessoa with NO active audience profile → audited block;
 *  (c) AudienceContext built from the channel's active agent;
 *  + the inactive-profile fail-closed path and the audit labels.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factories (also hoisted) can reference these without
// the "Cannot access before initialization" TDZ error.
const { findByPhone, findByPessoa, findActive, createConversa, touch, close, resolveScope, audit } =
  vi.hoisted(() => ({
    findByPhone: vi.fn(),
    findByPessoa: vi.fn(),
    findActive: vi.fn(),
    createConversa: vi.fn(),
    touch: vi.fn(),
    close: vi.fn(),
    resolveScope: vi.fn(),
    audit: vi.fn(),
  }));

vi.mock('@/db/repositories.js', () => ({
  pessoasRepo: { findByPhone },
  agentAudienceProfilesRepo: { findByPessoa },
  conversasRepo: { findActive, create: createConversa, touch, close },
}));
vi.mock('@/governance/permissions.js', () => ({ resolveScope }));
vi.mock('@/governance/audit.js', () => ({ audit }));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { resolveIdentity } from '@/identity/resolver.js';
import type { Pessoa, AgentAudienceProfile } from '@/db/schema.js';

function mkPessoa(over: Partial<Pessoa> = {}): Pessoa {
  return {
    id: 'pessoa-1',
    tenant_id: 'default',
    agent_id: 'agent-x',
    nome: 'Maria',
    apelido: null,
    telefone_whatsapp: '+5511999990000',
    tipo: 'cliente',
    email: null,
    observacoes: null,
    preferencias: {},
    modelo_mental: {},
    status: 'ativa',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  } as Pessoa;
}

function mkProfile(over: Partial<AgentAudienceProfile> = {}): AgentAudienceProfile {
  return {
    id: 'aud-1',
    tenant_id: 'default',
    agent_id: 'agent-x',
    pessoa_id: 'pessoa-1',
    audience_type: 'customer',
    trust_level: 'known_external',
    status: 'active',
    permission_profile_ids: [],
    labels: [],
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  } as AgentAudienceProfile;
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveScope.mockResolvedValue({ entidades: ['ent-1'], byEntity: new Map() });
  findActive.mockResolvedValue(null);
  createConversa.mockResolvedValue({ id: 'conv-1' });
});

describe('resolveIdentity — AudienceContext (#407)', () => {
  it('(c) builds AudienceContext from the resolved pessoa + active profile and audits audience_resolved', async () => {
    findByPhone.mockResolvedValue(mkPessoa());
    findByPessoa.mockResolvedValue(mkProfile());

    const r = await resolveIdentity({ telefone_whatsapp: '+5511999990000' });
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') throw new Error('unreachable');

    expect(r.audience).toMatchObject({
      tenant_id: 'default',
      agent_id: 'agent-x',
      contact_id: 'pessoa-1',
      audience_profile_id: 'aud-1',
      audience_type: 'customer',
      trust_level: 'known_external',
      allowed_entity_ids: ['ent-1'],
      status: 'active',
      channel_id: null,
      channel_type: 'whatsapp',
      permission_profiles: [],
    });

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'audience_resolved',
        pessoa_id: 'pessoa-1',
        metadata: expect.objectContaining({
          audience_type: 'customer',
          trust_level: 'known_external',
          audience_profile_id: 'aud-1',
        }),
      }),
    );
  });

  it('(a) same phone resolves to DIFFERENT audience_type per agent', async () => {
    // Agent X sees the phone as a customer.
    findByPhone.mockResolvedValueOnce(mkPessoa({ agent_id: 'agent-x' }));
    findByPessoa.mockResolvedValueOnce(
      mkProfile({ agent_id: 'agent-x', audience_type: 'customer', trust_level: 'known_external' }),
    );
    const x = await resolveIdentity({ telefone_whatsapp: '+5511999990000' });

    // Agent Y sees the SAME phone as an employee (different pessoa row, scoped
    // by the other agent — exactly what the relaxed composite unique enables).
    findByPhone.mockResolvedValueOnce(
      mkPessoa({ id: 'pessoa-2', agent_id: 'agent-y' }),
    );
    findByPessoa.mockResolvedValueOnce(
      mkProfile({
        id: 'aud-2',
        pessoa_id: 'pessoa-2',
        agent_id: 'agent-y',
        audience_type: 'employee',
        trust_level: 'trusted_internal',
      }),
    );
    const y = await resolveIdentity({ telefone_whatsapp: '+5511999990000' });

    expect(x.kind).toBe('resolved');
    expect(y.kind).toBe('resolved');
    if (x.kind !== 'resolved' || y.kind !== 'resolved') throw new Error('unreachable');
    expect(x.audience.audience_type).toBe('customer');
    expect(x.audience.agent_id).toBe('agent-x');
    expect(y.audience.audience_type).toBe('employee');
    expect(y.audience.agent_id).toBe('agent-y');
    expect(y.audience.trust_level).toBe('trusted_internal');
  });

  it('(b) known pessoa with NO audience profile → quarantined + audience_blocked_no_profile', async () => {
    findByPhone.mockResolvedValue(mkPessoa());
    findByPessoa.mockResolvedValue(null);

    const r = await resolveIdentity({ telefone_whatsapp: '+5511999990000' });
    expect(r.kind).toBe('quarantined');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'audience_blocked_no_profile', pessoa_id: 'pessoa-1' }),
    );
    // Must NOT have created a conversation / resolved scope for a blocked contact.
    expect(createConversa).not.toHaveBeenCalled();
    expect(resolveScope).not.toHaveBeenCalled();
  });

  it('profile exists but is NOT active → quarantined + audience_quarantined', async () => {
    findByPhone.mockResolvedValue(mkPessoa());
    findByPessoa.mockResolvedValue(mkProfile({ status: 'inactive' }));

    const r = await resolveIdentity({ telefone_whatsapp: '+5511999990000' });
    expect(r.kind).toBe('quarantined');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        acao: 'audience_quarantined',
        metadata: expect.objectContaining({ profile_status: 'inactive' }),
      }),
    );
  });

  it('still short-circuits on unknown phone before touching audience repo', async () => {
    findByPhone.mockResolvedValue(null);
    const r = await resolveIdentity({ telefone_whatsapp: '+5511000000000' });
    expect(r.kind).toBe('unknown');
    expect(findByPessoa).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ acao: 'unknown_number_message_received' }),
    );
  });

  it('blocked pessoa status short-circuits before audience resolution', async () => {
    findByPhone.mockResolvedValue(mkPessoa({ status: 'bloqueada' }));
    const r = await resolveIdentity({ telefone_whatsapp: '+5511999990000' });
    expect(r.kind).toBe('blocked');
    expect(findByPessoa).not.toHaveBeenCalled();
  });
});
