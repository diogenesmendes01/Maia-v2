import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  db: {},
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

describe('dashboard — escape helper', () => {
  it('escapes &, <, >, ", and apostrophes', async () => {
    const { escape } = await import('../../src/dashboard/index.js');
    expect(escape('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(escape('a & b')).toBe('a &amp; b');
    expect(escape('"x"')).toBe('&quot;x&quot;');
    expect(escape("'y'")).toBe('&#39;y&#39;');
  });

  it('preserves safe characters', () => {
    return import('../../src/dashboard/index.js').then(({ escape }) => {
      expect(escape('Diógenes Mendes')).toBe('Diógenes Mendes');
      expect(escape('Pessoa 123')).toBe('Pessoa 123');
    });
  });
});

describe('dashboard — renderDashboard XSS resistance', () => {
  it('does NOT emit a literal <script> tag for a script payload in nome', async () => {
    const { renderDashboard } = await import('../../src/dashboard/index.js');
    const html = await renderDashboard('<script>alert(1)</script>', [], [], false);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('does NOT allow attribute-injection via embedded quote', async () => {
    const { renderDashboard } = await import('../../src/dashboard/index.js');
    const payload = '" onload="alert(1)';
    const html = await renderDashboard(payload, [], [], false);
    // The double-quote must be escaped; attribute injection requires raw `"`.
    expect(html).not.toContain('" onload="alert(1)');
    expect(html).toContain('&quot; onload=&quot;alert(1)');
  });
});
