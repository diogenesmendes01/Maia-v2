import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

describe('pending lifecycle — agent layer must use pendingQuestionsRepo, not lightweight helpers', () => {
  it('no callers of setLightweightPending/getActivePending/clearLightweightPending in src/agent/', () => {
    let output = '';
    try {
      // grep -rl returns non-zero when no matches; swallow.
      output = execSync(
        'grep -rl "setLightweightPending\\|getActivePending\\|clearLightweightPending" src/agent/ 2>/dev/null || true',
        { encoding: 'utf8' },
      );
    } catch {
      output = '';
    }
    expect(output.trim()).toBe('');
  });
});
