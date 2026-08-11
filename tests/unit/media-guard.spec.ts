/**
 * P0 audit chapter 4 — media-guard: containment + caps + magic sniffing +
 * sha recomputation. Uses REAL tmpdir fixtures (files, symlinks, traversal
 * paths) — this module is the last line of defense against arbitrary-file
 * reads, so the tests exercise the actual filesystem semantics.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  MAX_IMAGE_BYTES,
  MAX_AUDIO_BYTES,
  MAX_DOCUMENT_BYTES,
  MediaValidationError,
  assertContainedRegularFile,
  readValidatedMedia,
  sniffMime,
  extensionForMime,
} from '../../src/lib/media-guard.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-body-bytes'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16, 1)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16, 2)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(16, 3)]);

let base: string;
let root: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'maia-media-guard-'));
  root = join(base, 'media');
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(MediaValidationError);
    return (err as MediaValidationError).code;
  }
}

describe('media-guard — constants', () => {
  it('caps are 10MB / 25MB / 15MB', () => {
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_AUDIO_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_DOCUMENT_BYTES).toBe(15 * 1024 * 1024);
  });
});

describe('media-guard — containment (assertContainedRegularFile)', () => {
  it('rejects a ../ traversal that escapes the media root', async () => {
    writeFileSync(join(base, 'secret.env'), 'API_KEY=leak');
    const code = await codeOf(
      assertContainedRegularFile(root, join(root, '..', 'secret.env')),
    );
    expect(code).toBe('outside_media_root');
  });

  it('rejects an absolute path outside the root (e.g. auth/env files)', async () => {
    const outside = join(base, 'creds.json');
    writeFileSync(outside, '{"noiseKey":"secret"}');
    const code = await codeOf(assertContainedRegularFile(root, outside));
    expect(code).toBe('outside_media_root');
  });

  it('rejects a symlink inside the root pointing outside (code: symlink, pre-resolution)', async () => {
    const target = join(base, 'target.png');
    writeFileSync(target, PNG);
    const link = join(root, 'evil.png');
    symlinkSync(target, link);
    const code = await codeOf(assertContainedRegularFile(root, link));
    expect(code).toBe('symlink');
  });

  it('rejects a directory (not_regular_file)', async () => {
    const dir = join(root, 'somedir');
    mkdirSync(dir);
    const code = await codeOf(assertContainedRegularFile(root, dir));
    expect(code).toBe('not_regular_file');
  });

  it('rejects a missing file (not_found)', async () => {
    const code = await codeOf(assertContainedRegularFile(root, join(root, 'nope.png')));
    expect(code).toBe('not_found');
  });

  it('accepts a regular file nested under the root (legacy un-tenanted monthly dir)', async () => {
    // Legacy rows point at `<MEDIA_ROOT>/<month>/<sha>.<ext>` (no tenant
    // segment). Containment is against MEDIA_ROOT, so they must STILL resolve.
    const legacyDir = join(root, '2026-01');
    mkdirSync(legacyDir);
    const p = join(legacyDir, 'abc.png');
    writeFileSync(p, PNG);
    await expect(assertContainedRegularFile(root, p)).resolves.toBeTruthy();
  });
});

describe('media-guard — readValidatedMedia', () => {
  it('rejects an oversized file BEFORE reading (fstat cap)', async () => {
    const p = join(root, 'big.png');
    writeFileSync(p, Buffer.concat([PNG, Buffer.alloc(64, 0)]));
    const code = await codeOf(readValidatedMedia(root, p, { maxBytes: 16, kind: 'image' }));
    expect(code).toBe('too_large');
  });

  it('rejects magic mismatch: PNG bytes declared as audio kind', async () => {
    const p = join(root, 'note.ogg');
    writeFileSync(p, PNG); // png content behind an audio extension
    const code = await codeOf(
      readValidatedMedia(root, p, { maxBytes: MAX_AUDIO_BYTES, kind: 'audio' }),
    );
    expect(code).toBe('bad_magic');
  });

  it('rejects unknown magic for the image kind (fail-closed, extension is irrelevant)', async () => {
    const p = join(root, 'fake.jpg');
    writeFileSync(p, Buffer.from('#!/bin/sh\necho pwned\n'));
    const code = await codeOf(
      readValidatedMedia(root, p, { maxBytes: MAX_IMAGE_BYTES, kind: 'image' }),
    );
    expect(code).toBe('bad_magic');
  });

  it('happy path: returns buf + SNIFFED mime + RECOMPUTED sha256', async () => {
    const p = join(root, 'ok.bin'); // wrong extension on purpose — sniffing wins
    writeFileSync(p, PNG);
    const out = await readValidatedMedia(root, p, { maxBytes: MAX_IMAGE_BYTES, kind: 'image' });
    expect(out.mime).toBe('image/png');
    expect(out.buf.equals(PNG)).toBe(true);
    const expectedSha = createHash('sha256').update(PNG).digest('hex');
    expect(out.sha256).toBe(expectedSha);
  });

  it('audio happy path (ogg) and document happy path (pdf)', async () => {
    const a = join(root, 'voice.ogg');
    writeFileSync(a, OGG);
    const audio = await readValidatedMedia(root, a, { maxBytes: MAX_AUDIO_BYTES, kind: 'audio' });
    expect(audio.mime).toBe('audio/ogg');

    const d = join(root, 'doc.pdf');
    writeFileSync(d, PDF);
    const doc = await readValidatedMedia(root, d, {
      maxBytes: MAX_DOCUMENT_BYTES,
      kind: 'document',
    });
    expect(doc.mime).toBe('application/pdf');
  });

  it('symlink is rejected even when its target is INSIDE the root', async () => {
    const target = join(root, 'real.png');
    writeFileSync(target, PNG);
    const link = join(root, 'alias.png');
    symlinkSync(target, link);
    const code = await codeOf(
      readValidatedMedia(root, link, { maxBytes: MAX_IMAGE_BYTES, kind: 'image' }),
    );
    expect(code).toBe('symlink');
  });
});

describe('media-guard — sniffMime / extensionForMime', () => {
  it('sniffs the supported magics', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(OGG)).toBe('audio/ogg');
    expect(sniffMime(PDF)).toBe('application/pdf');
    expect(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))).toBe('audio/wav');
    expect(sniffMime(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]))).toBe('audio/mpeg');
    expect(sniffMime(Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(16)]))).toBe('audio/mpeg');
    expect(sniffMime(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(8)]))).toBe('audio/mp4');
    expect(sniffMime(Buffer.from('plain text that is long enough'))).toBeNull();
  });

  it('maps mimes to safe extensions', () => {
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('audio/ogg')).toBe('ogg');
    expect(extensionForMime('application/pdf')).toBe('pdf');
    expect(extensionForMime('application/x-evil')).toBeNull();
  });
});
