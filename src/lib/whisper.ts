import { readFile } from 'node:fs/promises';
import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

export type Transcription = {
  texto: string;
  idioma: string;
  duracao_segundos: number;
  confianca: number;
};

export async function transcribeWhisper(localPath: string): Promise<Transcription> {
  if (!config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing for Whisper');
  }
  const buf = await readFile(localPath);
  const blob = new Blob([buf]);
  const form = new FormData();
  form.append('file', blob, 'audio.ogg');
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
