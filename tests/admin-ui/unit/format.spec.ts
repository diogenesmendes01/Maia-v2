/**
 * P8.5 — format/redaction helper tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ageBucket, redactValue, redactPacket } from '@/admin-ui/lib/format.js';

describe('ageBucket', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-15T12:00:00Z'));
  });
  afterAll(() => vi.useRealTimers());

  it('returns lt_1h for a 30-min-old date', () => {
    expect(ageBucket(new Date('2026-05-15T11:30:00Z'))).toBe('lt_1h');
  });
  it('returns lt_24h for a 5-hour-old date', () => {
    expect(ageBucket(new Date('2026-05-15T07:00:00Z'))).toBe('lt_24h');
  });
  it('returns lt_7d for a 3-day-old date', () => {
    expect(ageBucket(new Date('2026-05-12T12:00:00Z'))).toBe('lt_7d');
  });
  it('returns lt_30d for a 15-day-old date', () => {
    expect(ageBucket(new Date('2026-04-30T12:00:00Z'))).toBe('lt_30d');
  });
  it('returns older for >30 days', () => {
    expect(ageBucket(new Date('2026-01-01T12:00:00Z'))).toBe('older');
  });
});

describe('redactValue', () => {
  it('redacts emails', () => {
    expect(redactValue('user_email', 'a@b.com')).toBe('[REDACTED]');
  });
  it('redacts tokens', () => {
    expect(redactValue('auth_token', 'xyz123')).toBe('[REDACTED]');
  });
  it('redacts api keys (kebab case)', () => {
    expect(redactValue('api-key', 'sk_test_123')).toBe('[REDACTED]');
  });
  it('does not redact non-sensitive keys', () => {
    expect(redactValue('username', 'alice')).toBe('alice');
  });
  it('truncates long strings', () => {
    const long = 'x'.repeat(500);
    const result = redactValue('description', long);
    expect(typeof result).toBe('string');
    expect((result as string).endsWith('... [truncated]')).toBe(true);
  });
});

describe('redactPacket', () => {
  it('recursively redacts nested objects', () => {
    const input = {
      user: { email: 'a@b.com', name: 'Alice' },
      meta: { api_key: 'k1', size: 100 },
    };
    const out = redactPacket(input);
    expect(out).toEqual({
      user: { email: '[REDACTED]', name: 'Alice' },
      meta: { api_key: '[REDACTED]', size: 100 },
    });
  });
});
