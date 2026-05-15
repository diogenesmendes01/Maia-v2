import { describe, it, expect } from 'vitest';
import * as schema from '@/db/schema.js';

describe('P4 schema', () => {
  it('exports agent_operational_profile_versions table', () => {
    expect(schema.agent_operational_profile_versions).toBeDefined();
  });
  it('has profile_body (v3.1.1 1-column JSONB) + status + audit', () => {
    const cols = Object.keys(schema.agent_operational_profile_versions);
    expect(cols).toContain('profile_body');
    expect(cols).toContain('status');
    expect(cols).toContain('proposed_by');
    expect(cols).toContain('rollback_reason');
    // legacy 4-column shape removed in P4 v3.1.1 refactor
    expect(cols).not.toContain('core_immutable');
    expect(cols).not.toContain('operational_profile');
    expect(cols).not.toContain('episodic_temp');
    expect(cols).not.toContain('growth_backlog');
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
