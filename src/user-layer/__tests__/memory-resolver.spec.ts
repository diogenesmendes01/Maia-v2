import { describe, it, expect, beforeEach } from 'vitest';
import { memoryResolver } from '../resolvers/memory-resolver.js';
import { db } from '../../db/client.js';
import { memory_entry } from '../../db/schema.js';

describe('memory-resolver', () => {
  const tenant_a = 'tenant-a-p8c';
  const tenant_b = 'tenant-b-p8c';
  const pessoa_1 = 'pessoa-1-p8c';

  beforeEach(async () => {
    // Clean up test data
    await db.delete(memory_entry).where(
      /* tenant in (a, b) */
    );
  });

  it('list filters by tenant_id only (not agent_id)', async () => {
    // Insert into tenant_a with agent_1
    await db.insert(memory_entry).values({
      tenant_id: tenant_a,
      pessoa_id: pessoa_1,
      agent_id: 'agent-1',
      conteudo: 'memory in tenant-a',
      memory_type: 'fact',
      scope: 'global',
      sensitivity: 'low',
      proactive_use: false,
      mention_allowed: true,
      lifecycle_status: 'active',
    });

    // Insert into tenant_b with agent_1 (same agent, different tenant)
    await db.insert(memory_entry).values({
      tenant_id: tenant_b,
      pessoa_id: pessoa_1,
      agent_id: 'agent-1',
      conteudo: 'memory in tenant-b',
      memory_type: 'fact',
      scope: 'global',
      sensitivity: 'low',
      proactive_use: false,
      mention_allowed: true,
      lifecycle_status: 'active',
    });

    const resultA = await memoryResolver.list({
      tenant_id: tenant_a,
      pessoa_id: pessoa_1,
      limit: 10,
    });

    expect(resultA).toHaveLength(1);
    expect(resultA[0].conteudo).toContain('tenant-a');
  });

  it('respects lifecycle_status visibility', async () => {
    await db.insert(memory_entry).values([
      {
        tenant_id: tenant_a,
        pessoa_id: pessoa_1,
        conteudo: 'proposed',
        memory_type: 'fact',
        scope: 'global',
        sensitivity: 'low',
        proactive_use: false,
        mention_allowed: true,
        lifecycle_status: 'proposed',
      },
      {
        tenant_id: tenant_a,
        pessoa_id: pessoa_1,
        conteudo: 'active',
        memory_type: 'fact',
        scope: 'global',
        sensitivity: 'low',
        proactive_use: false,
        mention_allowed: true,
        lifecycle_status: 'active',
      },
    ]);

    const result = await memoryResolver.list({
      tenant_id: tenant_a,
      limit: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0].conteudo).toBe('active');
  });

  it('respects expires_at (ttl_days)', async () => {
    const now = new Date();
    const expired = new Date(now.getTime() - 86400000);

    await db.insert(memory_entry).values([
      {
        tenant_id: tenant_a,
        pessoa_id: pessoa_1,
        conteudo: 'expired',
        memory_type: 'fact',
        scope: 'global',
        sensitivity: 'low',
        proactive_use: false,
        mention_allowed: true,
        ttl_days: null,
        expires_at: expired,
        lifecycle_status: 'active',
      },
      {
        tenant_id: tenant_a,
        pessoa_id: pessoa_1,
        conteudo: 'valid',
        memory_type: 'fact',
        scope: 'global',
        sensitivity: 'low',
        proactive_use: false,
        mention_allowed: true,
        ttl_days: null,
        expires_at: null,
        lifecycle_status: 'active',
      },
    ]);

    const result = await memoryResolver.list({
      tenant_id: tenant_a,
      limit: 10,
    });

    expect(result).toHaveLength(1);
    expect(result[0].conteudo).toBe('valid');
  });
});
