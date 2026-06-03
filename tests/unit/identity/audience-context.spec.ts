import { describe, it, expect } from 'vitest';
import {
  buildAudienceContext,
  DEFAULT_CHANNEL_TYPE,
} from '@/identity/audience-context.js';
import type { Pessoa, AgentAudienceProfile } from '@/db/schema.js';

const pessoa = {
  id: 'p1',
  tenant_id: 't1',
  agent_id: 'a1',
  telefone_whatsapp: '+5511999990000',
  tipo: 'cliente',
  status: 'ativa',
} as unknown as Pessoa;

function profile(over: Partial<AgentAudienceProfile> = {}): AgentAudienceProfile {
  return {
    id: 'aud-1',
    tenant_id: 't1',
    agent_id: 'a1',
    pessoa_id: 'p1',
    audience_type: 'customer',
    trust_level: 'known_external',
    status: 'active',
    permission_profile_ids: ['pp-read'],
    labels: [],
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  } as AgentAudienceProfile;
}

describe('buildAudienceContext (#407)', () => {
  it('derives the context from pessoa + active profile + scope (contact_id = pessoa.id)', () => {
    const ctx = buildAudienceContext({
      pessoa,
      profile: profile(),
      allowed_entity_ids: ['ent-1', 'ent-2'],
    });
    expect(ctx).toEqual({
      tenant_id: 't1',
      agent_id: 'a1',
      channel_id: null,
      channel_type: DEFAULT_CHANNEL_TYPE,
      contact_id: 'p1',
      audience_profile_id: 'aud-1',
      audience_type: 'customer',
      trust_level: 'known_external',
      permission_profiles: ['pp-read'],
      allowed_entity_ids: ['ent-1', 'ent-2'],
      status: 'active',
    });
  });

  it('threads channel descriptor through when provided', () => {
    const ctx = buildAudienceContext({
      pessoa,
      profile: profile(),
      allowed_entity_ids: [],
      channel_id: 'chan-7',
      channel_type: 'web',
    });
    expect(ctx?.channel_id).toBe('chan-7');
    expect(ctx?.channel_type).toBe('web');
  });

  it('fails closed (null) when profile is missing', () => {
    expect(
      buildAudienceContext({ pessoa, profile: null, allowed_entity_ids: [] }),
    ).toBeNull();
  });

  it('fails closed (null) when profile is not active', () => {
    for (const status of ['inactive', 'quarantined', 'blocked'] as const) {
      expect(
        buildAudienceContext({
          pessoa,
          profile: profile({ status }),
          allowed_entity_ids: [],
        }),
      ).toBeNull();
    }
  });
});
