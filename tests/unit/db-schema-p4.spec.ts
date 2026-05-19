import { describe, it, expect } from 'vitest';
import * as schema from '@/db/schema.js';

describe('P4 schema', () => {
  it('exports agent_operational_profile_versions table', () => {
    expect(schema.agent_operational_profile_versions).toBeDefined();
  });
  it('has profile_body JSONB column + status + audit (v3.1.1 schema)', () => {
    // The table was consolidated from 4 legacy JSONB columns into a single
    // `profile_body` column in migration 025 (v3.1.1). Specs asserting the
    // old column names (core_immutable / operational_profile / episodic_temp /
    // growth_backlog) were updated in the fix for issue #108.
    const cols = Object.keys(schema.agent_operational_profile_versions);
    expect(cols).toContain('profile_body');
    expect(cols).toContain('status');
    expect(cols).toContain('proposed_by');
    expect(cols).toContain('rollback_reason');
  });
  it('exports agent_drift_alerts table', () => {
    expect(schema.agent_drift_alerts).toBeDefined();
  });
  it('drift alerts has drift_type, severity, decision, evidence', () => {
    const cols = Object.keys(schema.agent_drift_alerts);
    expect(cols).toContain('drift_type');
    expect(cols).toContain('severity');
    expect(cols).toContain('decision');
    expect(cols).toContain('evidence');
    expect(cols).toContain('profile_version_id');
  });
});
