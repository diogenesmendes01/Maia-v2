import { describe, it, expect } from 'vitest';
import { db } from '../../src/db/client.js';
import { memory_entry } from '../../src/db/schema.js';

describe('P8c schema: lifecycle_status columns', () => {
  it('memory_entry has lifecycle_status with DEFAULT active', async () => {
    // Insert a row with explicit tenant_id and no lifecycle_status
    const tenant_id = 'test-tenant-p8c';
    const inserted = await db.insert(memory_entry).values({
      tenant_id,
      pessoa_id: 'pessoa-1',
      conteudo: 'test',
      memory_type: 'fact',
      scope: 'global',
      sensitivity: 'low',
      proactive_use: false,
      mention_allowed: true,
      ttl_days: null,
    }).returning();

    expect(inserted[0].lifecycle_status).toBe('active');
    expect(inserted[0].evidence_count).toBe(1);
    expect(inserted[0].confidence).toBe(1.00);
  });
});
