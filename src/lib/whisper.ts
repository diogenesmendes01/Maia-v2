import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

export type Transcription = {
  texto: string;
  idioma: string;
  duracao_segundos: number;
  confianca: number;
};

/**
 * P0 audit chapter 4: takes the ALREADY-VALIDATED bytes + SNIFFED mime from
 * `readValidatedMedia` (src/lib/media-guard.ts). This module no longer reads
 * the filesystem — callers resolve an attachment_id and pass the buffer.
 */
export async function transcribeWhisper(input: { buf: Buffer; mime: string }): Promise<Transcription> {
  if (!config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing for Whisper');
  }
  const ext =
    input.mime === 'audio/mpeg'
      ? 'mp3'
      : input.mime === 'audio/mp4'
        ? 'm4a'
        : input.mime === 'audio/wav'
          ? 'wav'
          : 'ogg';
  // Copy into a plain Uint8Array<ArrayBuffer> — Buffer's ArrayBufferLike
  // backing store is not assignable to BlobPart under strict lib.dom typings.
  const blob = new Blob([new Uint8Array(input.buf)], { type: input.mime });
  const form = new FormData();
  form.append('file', blob, `audio.${ext}`);
  form.append('model', config.WHISPER_MODEL);
  form.append('language', 'pt');
  form.append('response_format', 'verbose_json');
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`whisper_failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as {
    text: string;
    language?: string;
    duration?: number;
  };
  logger.debug({ ms: Date.now() - t0, duration: data.duration }, 'whisper.transcribed');
  return {
    texto: data.text,
    idioma: data.language ?? 'pt',
    duracao_segundos: data.duration ?? 0,
    confianca: 0.9,
  };
}
