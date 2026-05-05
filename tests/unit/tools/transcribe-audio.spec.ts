/**
 * transcribe_audio handler tests.
 *
 * Mocks `transcribeWhisper` so no real OpenAI call is made. Asserts:
 *   1. Happy path: handler returns the transcription verbatim.
 *   2. Whisper failure (e.g. file too large) → handler propagates the error.
 *   3. Empty transcription is reported as-is (texto: '', confianca preserved).
 *   4. Schema rejects empty paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const whisperMock = vi.fn();

vi.mock('../../../src/lib/whisper.js', () => ({
  transcribeWhisper: (...args: unknown[]) => whisperMock(...args),
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
}));

beforeEach(() => whisperMock.mockReset());

type HandlerCtx = Parameters<
  Awaited<typeof import('../../../src/tools/transcribe-audio.js')>['transcribeAudioTool']['handler']
>[1];
const fakeCtx = {} as HandlerCtx;

describe('transcribe_audio — handler', () => {
  it('happy path: returns the Whisper transcription', async () => {
    whisperMock.mockResolvedValueOnce({
      texto: 'pagar conta de luz amanhã',
      idioma: 'pt',
      duracao_segundos: 4.2,
      confianca: 0.9,
    });
    const { transcribeAudioTool } = await import('../../../src/tools/transcribe-audio.js');
    const out = await transcribeAudioTool.handler(
      { media_local_path: '/fake/audio.ogg', file_sha256: 'sha-audio' },
      fakeCtx,
    );
    expect(out.texto).toBe('pagar conta de luz amanhã');
    expect(out.idioma).toBe('pt');
    expect(out.duracao_segundos).toBe(4.2);
    expect(out.confianca).toBe(0.9);
    expect(whisperMock).toHaveBeenCalledWith('/fake/audio.ogg');
  });

  it('Whisper fails (e.g. file too large) → error propagates', async () => {
    whisperMock.mockRejectedValueOnce(new Error('whisper_failed: 413 file too large'));
    const { transcribeAudioTool } = await import('../../../src/tools/transcribe-audio.js');
    await expect(
      transcribeAudioTool.handler(
        { media_local_path: '/fake/huge.ogg', file_sha256: 'sha-big' },
        fakeCtx,
      ),
    ).rejects.toThrow(/whisper_failed/);
  });

  it('empty transcription is reported as texto: "" (no error)', async () => {
    whisperMock.mockResolvedValueOnce({
      texto: '',
      idioma: 'pt',
      duracao_segundos: 0.5,
      confianca: 0.9,
    });
    const { transcribeAudioTool } = await import('../../../src/tools/transcribe-audio.js');
    const out = await transcribeAudioTool.handler(
      { media_local_path: '/fake/silent.ogg', file_sha256: 'sha-silent' },
      fakeCtx,
    );
    expect(out.texto).toBe('');
    expect(out.duracao_segundos).toBe(0.5);
  });

  it('schema rejects empty media_local_path', async () => {
    const { transcribeAudioTool } = await import('../../../src/tools/transcribe-audio.js');
    const r = transcribeAudioTool.input_schema.safeParse({
      media_local_path: '',
      file_sha256: 'sha',
    });
    expect(r.success).toBe(false);
  });
});
