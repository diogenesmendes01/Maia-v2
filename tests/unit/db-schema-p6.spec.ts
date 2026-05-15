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
  it('exports channel_policies table', () => {
    expect(schema.channel_policies).toBeDefined();
  });
  it('channel_policies has switch_behavior + by_context_guards', () => {
    const cols = Object.keys(schema.channel_policies);
    expect(cols).toContain('switch_behavior');
    expect(cols).toContain('announce_mode');
    expect(cols).toContain('by_context_guards');
    expect(cols).toContain('default_role_id');
  });
  it('exports role_selector_decisions table', () => {
    expect(schema.role_selector_decisions).toBeDefined();
  });
  it('role_selector_decisions has audit shape', () => {
    const cols = Object.keys(schema.role_selector_decisions);
    expect(cols).toContain('current_role_id');
    expect(cols).toContain('suggested_role_id');
    expect(cols).toContain('decided_role_id');
    expect(cols).toContain('action');
    expect(cols).toContain('suggested_by');
    expect(cols).toContain('decided_by');
    expect(cols).toContain('switch_count_in_conversation');
  });
});
