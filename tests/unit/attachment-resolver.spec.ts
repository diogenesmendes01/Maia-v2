/**
 * P0 audit chapter 4 — attachment-resolver: the opaque attachment_id →
 * media-row resolution used by parse_image / parse_receipt / parse_boleto /
 * transcribe_audio / receipt_validate. Repos are mocked (no ALS needed);
 * `mensagensRepo.findById` itself is tenant/agent-scoped in production.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findByIdMock = vi.fn();

vi.mock('../../src/db/repositories.js', () => ({
  mensagensRepo: { findById: (...args: unknown[]) => findByIdMock(...args) },
}));

import { resolveAttachmentById } from '../../src/lib/attachment-resolver.js';

function row(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'att-1',
    conversa_id: 'c1',
    tipo: 'imagem',
    conteudo: 'comprovante do aluguel',
    midia_url: '/media/tenant/2026-07/abc.png',
    metadata: { media_mime: 'image/png', media_sha256: 'stored-sha-NOT-trusted' },
    ...over,
  };
}

beforeEach(() => {
  findByIdMock.mockReset();
});

describe('resolveAttachmentById — fail-closed scoping', () => {
  it('happy path: returns path/mime/tipo/caption for an in-conversation media row', async () => {
    findByIdMock.mockResolvedValueOnce(row());
    const out = await resolveAttachmentById('c1', 'att-1');
    expect(findByIdMock).toHaveBeenCalledWith('att-1');
    expect(out).toEqual({
      message_id: 'att-1',
      path: '/media/tenant/2026-07/abc.png',
      mime: 'image/png',
      tipo: 'imagem',
      caption: 'comprovante do aluguel',
    });
  });

  it('does NOT expose the stored metadata sha (consumer recomputes)', async () => {
    findByIdMock.mockResolvedValueOnce(row());
    const out = await resolveAttachmentById('c1', 'att-1');
    expect(JSON.stringify(out)).not.toContain('stored-sha-NOT-trusted');
  });

  it('cross-conversation id ⇒ null (row belongs to another conversation)', async () => {
    findByIdMock.mockResolvedValueOnce(row({ conversa_id: 'OTHER-conversa' }));
    await expect(resolveAttachmentById('c1', 'att-1')).resolves.toBeNull();
  });

  it('row with conversa_id null (unattached inbound) ⇒ null', async () => {
    findByIdMock.mockResolvedValueOnce(row({ conversa_id: null }));
    await expect(resolveAttachmentById('c1', 'att-1')).resolves.toBeNull();
  });

  it('missing midia_url ⇒ null (text message id is not an attachment)', async () => {
    findByIdMock.mockResolvedValueOnce(row({ midia_url: null }));
    await expect(resolveAttachmentById('c1', 'att-1')).resolves.toBeNull();
  });

  it('unknown id ⇒ null', async () => {
    findByIdMock.mockResolvedValueOnce(null);
    await expect(resolveAttachmentById('c1', 'nope')).resolves.toBeNull();
  });

  it('empty conversa scope ⇒ null without touching the repo', async () => {
    await expect(resolveAttachmentById('', 'att-1')).resolves.toBeNull();
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('missing/garbage metadata mime degrades to null mime (never throws)', async () => {
    findByIdMock.mockResolvedValueOnce(row({ metadata: { media_mime: 42 } }));
    const out = await resolveAttachmentById('c1', 'att-1');
    expect(out?.mime).toBeNull();
  });
});
