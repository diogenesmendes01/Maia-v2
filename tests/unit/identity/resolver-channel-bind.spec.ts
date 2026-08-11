/**
 * Review PR #496 (alto 6) — vínculo de conversa LEGADA ao canal resolvido.
 *
 * Sem o bind, uma conversa com channel_id NULL casa qualquer linha no
 * findActive mas a saída (`forCurrentAgentChannel(null)`) exige canal único
 * do agente — com 2+ linhas ativas toda resposta lançaria `channel_ambiguous`
 * e a conversa ficaria MUDA até encerrar naturalmente. O resolver agora:
 *   - vincula (CAS `channel_id IS NULL`) no primeiro inbound RESOLVIDO;
 *   - na corrida perdida, reencontra/cria a conversa da própria linha;
 *   - nunca toca conversas que já têm canal, nem quando o inbound não traz.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  findByPhone,
  findByPessoa,
  findActive,
  createConversa,
  touch,
  close,
  bindChannelIfNull,
  resolveScope,
  audit,
} = vi.hoisted(() => ({
  findByPhone: vi.fn(),
  findByPessoa: vi.fn(),
  findActive: vi.fn(),
  createConversa: vi.fn(),
  touch: vi.fn(),
  close: vi.fn(),
  bindChannelIfNull: vi.fn(),
  resolveScope: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@/db/repositories.js', () => ({
  pessoasRepo: { findByPhone },
  agentAudienceProfilesRepo: { findByPessoa },
  conversasRepo: { findActive, create: createConversa, touch, close, bindChannelIfNull },
}));
vi.mock('@/governance/permissions.js', () => ({ resolveScope }));
vi.mock('@/governance/audit.js', () => ({ audit }));
vi.mock('@/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { resolveIdentity } from '@/identity/resolver.js';

const pessoa = {
  id: 'pessoa-1',
  tenant_id: 'default',
  agent_id: 'agent-x',
  nome: 'Maria',
  telefone_whatsapp: '+5511999990000',
  tipo: 'cliente',
  status: 'ativa',
} as never;

const audienceProfile = {
  id: 'aud-1',
  tenant_id: 'default',
  agent_id: 'agent-x',
  pessoa_id: 'pessoa-1',
  audience_type: 'customer',
  trust_level: 'known_external',
  status: 'active',
  permission_profile_ids: [],
} as never;

const legacyConversa = (over: Record<string, unknown> = {}) => ({
  id: 'conv-legacy',
  pessoa_id: 'pessoa-1',
  status: 'ativa',
  channel_id: null,
  ultima_atividade_em: new Date(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  findByPhone.mockResolvedValue(pessoa);
  findByPessoa.mockResolvedValue(audienceProfile);
  resolveScope.mockResolvedValue({ entidades: [], byEntity: new Map() });
  createConversa.mockResolvedValue({ id: 'conv-new', channel_id: 'ch-1' });
});

describe('resolveIdentity — bind da conversa legada ao canal (review #496 alto 6)', () => {
  it('conversa legada + inbound resolvido ⇒ bindChannelIfNull e conversa devolvida JÁ com o canal', async () => {
    findActive.mockResolvedValueOnce(legacyConversa());
    bindChannelIfNull.mockResolvedValueOnce(true);

    const r = await resolveIdentity({
      telefone_whatsapp: '+5511999990000',
      channel_id: 'ch-1',
    });

    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') throw new Error('unreachable');
    expect(bindChannelIfNull).toHaveBeenCalledWith('conv-legacy', 'ch-1');
    expect(r.conversa.channel_id).toBe('ch-1');
    expect(touch).toHaveBeenCalledWith('conv-legacy');
    expect(createConversa).not.toHaveBeenCalled();
  });

  it('corrida perdida (outra linha vinculou antes) ⇒ reencontra a conversa da PRÓPRIA linha', async () => {
    findActive
      .mockResolvedValueOnce(legacyConversa()) // primeira leitura: ainda NULL
      .mockResolvedValueOnce(legacyConversa({ id: 'conv-mine', channel_id: 'ch-2' }));
    bindChannelIfNull.mockResolvedValueOnce(false); // CAS perdeu

    const r = await resolveIdentity({
      telefone_whatsapp: '+5511999990000',
      channel_id: 'ch-2',
    });

    if (r.kind !== 'resolved') throw new Error('unreachable');
    expect(r.conversa.id).toBe('conv-mine');
    expect(findActive).toHaveBeenLastCalledWith('pessoa-1', 'ch-2');
    expect(createConversa).not.toHaveBeenCalled();
    expect(touch).toHaveBeenCalledWith('conv-mine');
  });

  it('corrida perdida SEM conversa da linha ⇒ cria conversa nova COM o canal', async () => {
    findActive
      .mockResolvedValueOnce(legacyConversa())
      .mockResolvedValueOnce(null);
    bindChannelIfNull.mockResolvedValueOnce(false);

    const r = await resolveIdentity({
      telefone_whatsapp: '+5511999990000',
      channel_id: 'ch-1',
    });

    if (r.kind !== 'resolved') throw new Error('unreachable');
    expect(createConversa).toHaveBeenCalledWith(
      expect.objectContaining({ pessoa_id: 'pessoa-1', channel_id: 'ch-1' }),
    );
    expect(r.conversa.id).toBe('conv-new');
  });

  it('conversa que JÁ tem canal nunca é re-vinculada', async () => {
    findActive.mockResolvedValueOnce(legacyConversa({ channel_id: 'ch-1' }));

    const r = await resolveIdentity({
      telefone_whatsapp: '+5511999990000',
      channel_id: 'ch-1',
    });

    if (r.kind !== 'resolved') throw new Error('unreachable');
    expect(bindChannelIfNull).not.toHaveBeenCalled();
    expect(touch).toHaveBeenCalledWith('conv-legacy');
  });

  it('inbound SEM canal resolvido (proativo/legado) não tenta vincular', async () => {
    findActive.mockResolvedValueOnce(legacyConversa());

    const r = await resolveIdentity({ telefone_whatsapp: '+5511999990000' });

    if (r.kind !== 'resolved') throw new Error('unreachable');
    expect(bindChannelIfNull).not.toHaveBeenCalled();
    expect(r.conversa.channel_id).toBeNull();
  });
});
