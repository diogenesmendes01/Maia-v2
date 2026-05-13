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
  it('exports roles table', () => {
    expect(schema.roles).toBeDefined();
  });
  it('roles has role_key + is_default + prompt_addendum', () => {
    const cols = Object.keys(schema.roles);
    expect(cols).toContain('role_key');
    expect(cols).toContain('is_default');
    expect(cols).toContain('prompt_addendum');
  });
});
