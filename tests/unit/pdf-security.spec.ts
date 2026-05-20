/**
 * Security test: renderPdfToBuffer must block arbitrary local file paths.
 *
 * The pdfmake `setLocalAccessPolicy` callback is called with the path string
 * for every local resource (fonts, images, attachments, files). The allowlist
 * must only permit the exact Helvetica built-in font names used by PDF_FONTS.
 * Any other path — including OS-readable paths like /etc/passwd — must throw
 * "Access to local file denied by resource access policy".
 *
 * Design intent: this test remains green after the fix and red with the
 * previous blanket `() => true` policy.
 */

import { describe, it, expect } from 'vitest';

describe('renderPdfToBuffer — local access policy', () => {
  it('rejects a docDefinition whose inline image references a local filesystem path', async () => {
    // We import the helper directly (not via the PDF report builders) so this
    // test stays isolated from the report domain logic.
    const { renderPdfToBuffer } = await import('../../src/lib/pdf/_helpers.js');

    // A docDefinition that tries to embed a local file via the `image` key.
    // In pdfmake 0.3, content[].image strings are passed to validateLocalFile()
    // which calls localAccessPolicy(path).  With the old `() => true` policy
    // this would proceed (and fail only because /etc/passwd is not a valid image).
    // With the correct allowlist the policy itself throws before any file read.
    const maliciousDoc = {
      content: [
        { image: '/etc/passwd' },
      ],
      defaultStyle: { font: 'Helvetica' },
    };

    await expect(renderPdfToBuffer(maliciousDoc)).rejects.toThrow(
      /access.*local.*denied|local.*access.*denied/i,
    );
  });

  it('rejects a docDefinition with a Windows-style local path in the images map', async () => {
    const { renderPdfToBuffer } = await import('../../src/lib/pdf/_helpers.js');

    const maliciousDoc = {
      content: [{ image: 'secret' }],
      images: { secret: 'C:\\Windows\\System32\\drivers\\etc\\hosts' },
      defaultStyle: { font: 'Helvetica' },
    };

    await expect(renderPdfToBuffer(maliciousDoc)).rejects.toThrow(
      /access.*local.*denied|local.*access.*denied/i,
    );
  });

  it('still produces a valid PDF when only text content is supplied (no local paths)', async () => {
    const { renderPdfToBuffer } = await import('../../src/lib/pdf/_helpers.js');

    const safeDoc = {
      content: [
        { text: 'Maia Security Test', style: 'header' },
        { text: 'Arquivo seguro, sem imagens locais.', fontSize: 12 },
      ],
      styles: {
        header: { fontSize: 18, bold: true },
      },
      defaultStyle: { font: 'Helvetica' },
    };

    const buf = await renderPdfToBuffer(safeDoc);
    expect(buf).toBeInstanceOf(Buffer);
    // A valid PDF starts with "%PDF"
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });
});
