/**
 * P0 security audit — chapter 4 (attachment IDs + media protection).
 *
 * Central guard for every read of gateway-persisted media. Tools no longer
 * accept an LLM-declared filesystem path + sha; they resolve an opaque
 * `attachment_id` (a `mensagens.id`) and then read the stored file THROUGH
 * this module, which enforces:
 *
 *   1. CONTAINMENT — the resolved (realpath'd) file must live strictly inside
 *      the gateway media root. Symlinks are rejected outright (lstat), and
 *      `..`/absolute escapes die on the realpath prefix check. This closes the
 *      arbitrary-file-read/exfiltration vector (.env, Baileys auth state,
 *      arbitrary host files shipped to the Anthropic/OpenAI upload endpoints).
 *   2. SIZE CAPS — fstat BEFORE reading; an oversized file is rejected without
 *      ever being buffered in memory.
 *   3. CONTENT-SNIFFED MIME — the media type comes from magic bytes, NEVER
 *      from the file extension or an attacker-controlled `mimetype` field.
 *      Unknown magic for the requested kind is fail-closed (`bad_magic`).
 *   4. RECOMPUTED SHA — the caller gets the sha256 of the bytes actually
 *      read; consumers key caches/idempotency on THIS value, closing the
 *      cache-poisoning vector of an LLM-declared `file_sha256`.
 *
 * IMPORTANT: this module must NOT import `@/gateway/baileys.js` statically —
 * that module is import-side-effect-sensitive (see
 * tests/unit/baileys-no-import-side-effects.spec.ts) and baileys itself
 * imports THIS module for ingest-time sniffing/caps. The media root is either
 * passed in (pure API) or lazy-imported (`readStoredMedia`).
 */
import { lstat, open, realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { sha256 } from '@/lib/utils.js';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

export type MediaKind = 'image' | 'audio' | 'document';

export type MediaValidationCode =
  | 'outside_media_root'
  | 'not_found'
  | 'too_large'
  | 'bad_magic'
  | 'symlink'
  | 'not_regular_file';

export class MediaValidationError extends Error {
  constructor(
    public code: MediaValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

/**
 * Content sniffing over magic bytes. Deliberately small: only the formats the
 * gateway actually ingests (WhatsApp images/voice notes/documents). Returns
 * null for anything unrecognized — callers decide whether that is fatal
 * (tool reads: yes) or a fallback (ingest extension: 'bin').
 */
export function sniffMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // Images
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  const riff = buf.toString('latin1', 0, 4) === 'RIFF';
  if (riff && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  // Audio
  if (buf.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  if (buf.toString('latin1', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buf.toString('latin1', 4, 8) === 'ftyp') return 'audio/mp4';
  if (riff && buf.toString('latin1', 8, 12) === 'WAVE') return 'audio/wav';
  // Documents
  if (buf.toString('latin1', 0, 4) === '%PDF') return 'application/pdf';
  return null;
}

const KIND_MIMES: Record<MediaKind, readonly string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  audio: ['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav'],
  document: ['application/pdf'],
};

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
};

/** Safe filename extension for a sniffed mime, or null when unknown. */
export function extensionForMime(mime: string): string | null {
  return MIME_EXTENSIONS[mime] ?? null;
}

/**
 * Validate that `p` is a REGULAR FILE strictly inside `mediaRoot`:
 *   - lstat rejects a symlink at the final component (before any resolution);
 *   - realpath(root) + realpath(p) resolve every intermediate link/`..`, and
 *     the resolved file must be strictly inside the resolved root.
 * Returns the resolved (real) path for the subsequent open.
 */
export async function assertContainedRegularFile(mediaRoot: string, p: string): Promise<string> {
  let st;
  try {
    st = await lstat(p);
  } catch {
    throw new MediaValidationError('not_found', 'media file not found');
  }
  if (st.isSymbolicLink()) {
    throw new MediaValidationError('symlink', 'symlinks are not allowed under the media root');
  }
  if (!st.isFile()) {
    throw new MediaValidationError('not_regular_file', 'media path is not a regular file');
  }
  let rootReal: string;
  try {
    rootReal = await realpath(mediaRoot);
  } catch {
    // No root ⇒ nothing can be contained in it. Fail-closed.
    throw new MediaValidationError('outside_media_root', 'media root does not exist');
  }
  let real: string;
  try {
    real = await realpath(p);
  } catch {
    throw new MediaValidationError('not_found', 'media file not found');
  }
  if (!real.startsWith(rootReal + sep)) {
    throw new MediaValidationError('outside_media_root', 'media path escapes the media root');
  }
  return real;
}

export type ValidatedMedia = {
  buf: Buffer;
  /** sha256 of the bytes ACTUALLY read — never a declared value. */
  sha256: string;
  /** mime sniffed from magic bytes — never from extension/declared mimetype. */
  mime: string;
};

/**
 * Containment + size cap + magic sniff + sha recompute, in that order. The
 * size check runs on the OPEN file descriptor (fstat) BEFORE any read, so an
 * oversized file is never buffered.
 */
export async function readValidatedMedia(
  mediaRoot: string,
  p: string,
  opts: { maxBytes: number; kind: MediaKind },
): Promise<ValidatedMedia> {
  const real = await assertContainedRegularFile(mediaRoot, p);
  let fh;
  try {
    fh = await open(real, 'r');
  } catch {
    throw new MediaValidationError('not_found', 'media file not found');
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new MediaValidationError('not_regular_file', 'media path is not a regular file');
    }
    if (st.size > opts.maxBytes) {
      throw new MediaValidationError(
        'too_large',
        `media file is ${st.size} bytes (cap ${opts.maxBytes})`,
      );
    }
    const buf = await fh.readFile();
    // Defense in depth: a file that grew between fstat and read still respects the cap.
    if (buf.length > opts.maxBytes) {
      throw new MediaValidationError(
        'too_large',
        `media file is ${buf.length} bytes (cap ${opts.maxBytes})`,
      );
    }
    const mime = sniffMime(buf);
    if (!mime || !KIND_MIMES[opts.kind].includes(mime)) {
      throw new MediaValidationError(
        'bad_magic',
        `media content does not match the expected kind '${opts.kind}'`,
      );
    }
    return { buf, sha256: sha256(buf), mime };
  } finally {
    await fh.close();
  }
}

/**
 * Convenience wrapper for the tool handlers: reads a stored attachment path
 * against the GATEWAY media root. Lazy-imports the baileys module so this
 * module stays statically independent of it (no import cycle, no
 * import-side-effect surface in unit tests that mock this module).
 */
export async function readStoredMedia(
  p: string,
  opts: { maxBytes: number; kind: MediaKind },
): Promise<ValidatedMedia> {
  const { MEDIA_ROOT } = await import('@/gateway/baileys.js');
  return readValidatedMedia(MEDIA_ROOT, p, opts);
}
