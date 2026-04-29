import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Cross-platform replacement for the previous `grep -rl` shell call.
 * Recursively walks `src/agent/` reading each `.ts` file and asserts that
 * none of the deprecated lightweight pending helpers are referenced.
 *
 * The shell version emitted "'true' is not recognized" noise on Windows
 * because of the `|| true` fall-through. Plain Node.js `fs` is portable.
 */
const FORBIDDEN = ['setLightweightPending', 'getActivePending', 'clearLightweightPending'];

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkTs(full);
    } else if (entry.endsWith('.ts')) {
      yield full;
    }
  }
}

describe('pending lifecycle — agent layer must use pendingQuestionsRepo, not lightweight helpers', () => {
  it('no callers of setLightweightPending/getActivePending/clearLightweightPending in src/agent/', () => {
    const offenders: Array<{ file: string; symbol: string }> = [];
    for (const file of walkTs('src/agent')) {
      const content = readFileSync(file, 'utf8');
      for (const symbol of FORBIDDEN) {
        if (content.includes(symbol)) offenders.push({ file, symbol });
      }
    }
    expect(offenders).toEqual([]);
  });
});
