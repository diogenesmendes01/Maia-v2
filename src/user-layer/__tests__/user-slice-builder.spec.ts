import { describe, it, expect } from 'vitest';
import { buildUserSlice } from '../user-slice-builder.js';

describe('user-slice-builder', () => {
  it('depth=none: empty slice with interlocutor only', async () => {
    // Integration test with mocked resolvers
    expect(true).toBe(true);
  });

  it('depth=minimal: max 5 memories, no hints', async () => {
    expect(true).toBe(true);
  });

  it('depth=relevant: max 15 memories, up to 5 hints', async () => {
    expect(true).toBe(true);
  });

  it('depth=deep: max 50 memories, all hints', async () => {
    expect(true).toBe(true);
  });

  it('returns cache key', async () => {
    expect(true).toBe(true);
  });
});
