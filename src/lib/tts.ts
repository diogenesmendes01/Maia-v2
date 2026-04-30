import { config } from '@/config/env.js';
import { logger } from '@/lib/logger.js';

/**
 * Hard cap on agent-text length that triggers the B4 voice branch.
 * Replies above this fall through to text. NOT env-configurable (YAGNI):
 * if 400 needs adjusting, change the constant + test, ship a code change.
 */
export const OUTBOUND_VOICE_MAX_CHARS = 400;

/**
 * Synthesize Brazilian-Portuguese speech via OpenAI TTS. Returns OGG-Opus
 * binary as a Buffer. The output format is exactly what WhatsApp/Baileys
 * expects for voice notes (`ptt: true` + `mimetype: 'audio/ogg; codecs=opus'`),
 * so no ffmpeg conversion is needed.
 *
 * Caller is responsible for delivering the buffer via Baileys
 * (`sendOutboundVoice` in `gateway/baileys.ts`).
 *
 * Throws on HTTP error, missing API key, or empty body. Caller catches and
 * falls back to the text path.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  if (!config.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing for TTS');
  }
  const t0 = Date.now();
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice: 'nova',
      input: text,
      response_format: 'opus',
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`tts_failed: ${res.status} ${errText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  // Defensive: OpenAI rarely (but conceivably) returns 200 with an empty body.
  // Treat as failure so the caller routes through the text-fallback path.
  if (buf.length === 0) {
    throw new Error('tts_empty_body');
  }
  logger.debug({ ms: Date.now() - t0, bytes: buf.length }, 'tts.synthesized');
  return buf;
}
