import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config/env.js', () => ({
  config: { OPENAI_API_KEY: 'sk-test-key' },
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => {
  fetchMock.mockReset();
});

describe('synthesizeSpeech', () => {
  it('exports OUTBOUND_VOICE_MAX_CHARS = 400', async () => {
    const { OUTBOUND_VOICE_MAX_CHARS } = await import('../../src/lib/tts.js');
    expect(OUTBOUND_VOICE_MAX_CHARS).toBe(400);
  });

  it('POSTs the right payload and returns a Buffer on success', async () => {
    const fakeBytes = Buffer.from([0x4F, 0x67, 0x67, 0x53]); // 'OggS' magic for OGG
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeBytes.buffer.slice(fakeBytes.byteOffset, fakeBytes.byteOffset + fakeBytes.byteLength),
    });
    const { synthesizeSpeech } = await import('../../src/lib/tts.js');
    const buf = await synthesizeSpeech('Olá mundo');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toEqual({
      model: 'tts-1',
      voice: 'nova',
      input: 'Olá mundo',
      response_format: 'opus',
    });
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer sk-test-key');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBe(4);
  });

  it('throws tts_failed on non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    });
    const { synthesizeSpeech } = await import('../../src/lib/tts.js');
    await expect(synthesizeSpeech('x')).rejects.toThrow(/tts_failed: 500/);
  });

  it('throws tts_empty_body when 2xx returns 0 bytes', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    const { synthesizeSpeech } = await import('../../src/lib/tts.js');
    await expect(synthesizeSpeech('x')).rejects.toThrow(/tts_empty_body/);
  });

  it('strips null bytes from input before sending to OpenAI', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(4),
    });
    const { synthesizeSpeech } = await import('../../src/lib/tts.js');
    await synthesizeSpeech('hello\0world');
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.input).toBe('helloworld');
  });

  it('caps input length at OUTBOUND_VOICE_MAX_CHARS (defense-in-depth)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(4),
    });
    const { synthesizeSpeech, OUTBOUND_VOICE_MAX_CHARS } = await import('../../src/lib/tts.js');
    const oversized = 'a'.repeat(OUTBOUND_VOICE_MAX_CHARS + 100);
    await synthesizeSpeech(oversized);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.input.length).toBe(OUTBOUND_VOICE_MAX_CHARS);
  });

  it('throws tts_empty_input when sanitization yields empty string', async () => {
    const { synthesizeSpeech } = await import('../../src/lib/tts.js');
    await expect(synthesizeSpeech('\0\0\0')).rejects.toThrow(/tts_empty_input/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // KEEP LAST: this test calls vi.resetModules() + vi.doMock, which contaminates
  // subsequent tests in the file (the empty-key mock persists in the module cache).
  it('throws when OPENAI_API_KEY is missing', async () => {
    vi.resetModules();
    vi.doMock('../../src/config/env.js', () => ({
      config: { OPENAI_API_KEY: '' },
    }));
    const { synthesizeSpeech } = await import('../../src/lib/tts.js');
    await expect(synthesizeSpeech('x')).rejects.toThrow(/OPENAI_API_KEY missing/);
  });
});
