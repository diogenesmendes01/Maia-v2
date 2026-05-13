import { describe, it, expect } from 'vitest';
import * as schema from '@/db/schema.js';

describe('P6 schema', () => {
  it('exports channels table', () => {
    expect(schema.channels).toBeDefined();
  });
  it('channels has channel_type + external_id + active', () => {
    const cols = Object.keys(schema.channels);
    expect(cols).toContain('channel_type');
    expect(cols).toContain('external_id');
    expect(cols).toContain('active');
  });
});
