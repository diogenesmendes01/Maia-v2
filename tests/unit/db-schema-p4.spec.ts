import { describe, it, expect } from 'vitest';
import * as schema from '@/db/schema.js';

describe('P4 schema', () => {
  it('exports agent_operational_profile_versions table', () => {
    expect(schema.agent_operational_profile_versions).toBeDefined();
  });
  it('has 4 camada columns + status + audit', () => {
    const cols = Object.keys(schema.agent_operational_profile_versions);
    expect(cols).toContain('core_immutable');
    expect(cols).toContain('operational_profile');
    expect(cols).toContain('episodic_temp');
    expect(cols).toContain('growth_backlog');
    expect(cols).toContain('status');
    expect(cols).toContain('proposed_by');
    expect(cols).toContain('rollback_reason');
  });
});
