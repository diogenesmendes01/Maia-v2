import { describe, it, expect } from 'vitest';
import * as schema from '@/db/schema.js';

describe('P5 schema', () => {
  it('exports gap_escalation_rules table', () => {
    expect(schema.gap_escalation_rules).toBeDefined();
  });
  it('has thresholds + cooldown', () => {
    const cols = Object.keys(schema.gap_escalation_rules);
    expect(cols).toContain('dashboard_freq_threshold');
    expect(cols).toContain('mentionable_severity_threshold');
    expect(cols).toContain('proposed_combined_threshold');
    expect(cols).toContain('proposed_min_distinct_contexts');
    expect(cols).toContain('cooldown_days_proposed_to_proposed');
  });
});
