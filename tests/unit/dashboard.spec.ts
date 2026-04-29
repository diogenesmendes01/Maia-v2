/**
 * Dashboard smoke tests for pure helpers + schema export.
 * Full HTTP integration tests live in tests/integration/dashboard (deferred).
 */
import { describe, it, expect } from 'vitest';
import * as schema from '../../src/db/schema.js';

describe('dashboard — schema regression guard', () => {
  it('exports dashboard_sessions (was crashing src/dashboard/index.ts at runtime)', () => {
    expect(schema.dashboard_sessions).toBeDefined();
  });
  it('exports DashboardSession type (compile-time)', () => {
    type _S = schema.DashboardSession;
    const s: _S | null = null;
    expect(s).toBeNull();
  });
});
