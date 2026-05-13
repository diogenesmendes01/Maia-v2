import { describe, it, expect } from 'vitest';
import * as schema from '@/db/schema.js';

describe('P3c schema', () => {
  it('exports procedure_tests table', () => {
    expect(schema.procedure_tests).toBeDefined();
  });
  it('procedure_tests has scenario JSONB column', () => {
    const cols = Object.keys(schema.procedure_tests);
    expect(cols).toContain('scenario');
    expect(cols).toContain('expected_outcome');
    expect(cols).toContain('definition_id');
  });
});
