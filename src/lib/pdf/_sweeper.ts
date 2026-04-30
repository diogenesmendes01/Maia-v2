import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { MEDIA_ROOT } from '@/gateway/baileys.js';
import { logger } from '@/lib/logger.js';

const TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Removes orphan PDF files in `<MEDIA_ROOT>/tmp/` whose mtime is older than
 * `TTL_MS`. Called once at process boot from `src/index.ts`. Idempotent —
 * runs cleanly on an empty or missing directory.
 *
 * Returns the number of files swept (for logging / observability). Errors
 * are logged but never thrown — sweeper failures must not crash startup.
 */
export async function sweepPdfTmp(): Promise<number> {
  const tmpDir = join(MEDIA_ROOT, 'tmp');
  let entries: string[];
  try {
    entries = await readdir(tmpDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    logger.warn({ err, tmpDir }, 'pdf.sweeper.readdir_failed');
    return 0;
  }

  const cutoff = Date.now() - TTL_MS;
  let swept = 0;
  for (const name of entries) {
    if (!name.endsWith('.pdf')) continue;
    const full = join(tmpDir, name);
    try {
      const s = await stat(full);
      if (s.mtimeMs < cutoff) {
        await unlink(full);
        swept++;
      }
    } catch (err) {
      logger.warn({ err, path: full }, 'pdf.sweeper.unlink_failed');
    }
  }

  if (swept > 0) {
    logger.info({ swept, tmpDir }, 'pdf.sweeper.completed');
  }
  return swept;
}
