import { describe, it, expect, vi } from 'vitest';
import { resolve, sep, join } from 'node:path';

// Config mock: os helpers derivados (resolve*/assertIsDirectChildOfAuthRoot)
// leem a raiz da config; assertSafeAuthDir continua puro (parâmetro).
const ROOT = '/tmp/maia-baileys-authdir-helpers-test';
vi.mock('../../src/config/env.js', () => ({
  config: { BAILEYS_AUTH_DIR: '/tmp/maia-baileys-authdir-helpers-test' },
}));

import {
  assertSafeAuthDir,
  assertIsDirectChildOfAuthRoot,
  isReservedRootEntry,
  resolveControlDir,
  resolveLineAuthDir,
  resolvePairingAuthDir,
  resolvePrimaryAuthDir,
} from '../../src/setup/auth-dir.js';

describe('assertSafeAuthDir', () => {
  it('returns absolute path for the default ./.baileys-auth', () => {
    const out = assertSafeAuthDir('./.baileys-auth');
    expect(out).toBe(resolve('./.baileys-auth'));
    expect(out.endsWith(`${sep}.baileys-auth`)).toBe(true);
  });

  it('accepts a typical absolute deploy path', () => {
    const out = assertSafeAuthDir('/app/.baileys-auth');
    expect(out).toBe(resolve('/app/.baileys-auth'));
  });

  it('rejects empty string', () => {
    expect(() => assertSafeAuthDir('')).toThrow(/empty/i);
  });

  it('rejects whitespace-only string', () => {
    expect(() => assertSafeAuthDir('   ')).toThrow(/empty/i);
  });

  it('rejects POSIX root /', () => {
    expect(() => assertSafeAuthDir('/')).toThrow(/filesystem root/i);
  });

  it('rejects /etc', () => {
    expect(() => assertSafeAuthDir('/etc')).toThrow(/system path/i);
  });

  it('rejects /home', () => {
    expect(() => assertSafeAuthDir('/home')).toThrow(/system path/i);
  });

  it('rejects /var', () => {
    expect(() => assertSafeAuthDir('/var')).toThrow(/system path/i);
  });

  it('rejects /usr', () => {
    expect(() => assertSafeAuthDir('/usr')).toThrow(/system path/i);
  });

  it('rejects /root', () => {
    expect(() => assertSafeAuthDir('/root')).toThrow(/system path/i);
  });

  it('rejects the current working directory', () => {
    expect(() => assertSafeAuthDir(process.cwd())).toThrow(/CWD/);
  });

  it('rejects "." (resolves to CWD)', () => {
    expect(() => assertSafeAuthDir('.')).toThrow(/CWD/);
  });

  it('rejects a path without "baileys" segment', () => {
    expect(() => assertSafeAuthDir('/etc/maia')).toThrow(/baileys/i);
    expect(() => assertSafeAuthDir('/home/maia')).toThrow(/baileys/i);
    expect(() => assertSafeAuthDir('/opt/data')).toThrow(/baileys/i);
  });

  it('accepts case-insensitive baileys segment', () => {
    expect(() => assertSafeAuthDir('/app/Baileys-auth')).not.toThrow();
    expect(() => assertSafeAuthDir('/app/BAILEYS-DATA')).not.toThrow();
  });
});

describe('layout multi-linha (cap. 7) — helpers derivados da raiz', () => {
  const UUID = '0b0e8a1c-1111-4222-8333-444455556666';

  it('resolvePrimaryAuthDir/resolveControlDir são filhos diretos da raiz validada', () => {
    expect(resolvePrimaryAuthDir()).toBe(resolve(ROOT, 'primary'));
    expect(resolveControlDir()).toBe(resolve(ROOT, 'control'));
  });

  it('resolveLineAuthDir/resolvePairingAuthDir derivam <raiz>/<bucket>/<uuid>', () => {
    expect(resolveLineAuthDir(UUID)).toBe(resolve(ROOT, 'lines', UUID));
    expect(resolvePairingAuthDir(UUID)).toBe(resolve(ROOT, 'pairing', UUID));
  });

  it.each([
    ['traversal relativo', '../evil'],
    ['descida além de um nível', 'a/b'],
    ['parent puro', '..'],
    ['self (vazio após resolve)', '.'],
    ['string vazia', ''],
    ['path absoluto', '/etc/passwd'],
  ])('resolveLineAuthDir rejeita channelId com %s', (_label, channelId) => {
    expect(() => resolveLineAuthDir(channelId)).toThrowError(
      expect.objectContaining({ code: 'auth_dir_escape' }),
    );
  });

  it('isReservedRootEntry protege lines/pairing/control/media/setup-token.txt', () => {
    for (const name of ['lines', 'pairing', 'control', 'media', 'setup-token.txt']) {
      expect(isReservedRootEntry(name)).toBe(true);
    }
    expect(isReservedRootEntry('primary')).toBe(false);
    expect(isReservedRootEntry('creds.json')).toBe(false);
  });
});

describe('assertIsDirectChildOfAuthRoot — rm da raiz impossível por construção', () => {
  it('aceita primary/, entradas legadas soltas e lines/pairing por-canal', () => {
    expect(assertIsDirectChildOfAuthRoot(join(ROOT, 'primary'))).toBe(join(ROOT, 'primary'));
    expect(assertIsDirectChildOfAuthRoot(join(ROOT, 'creds.json'))).toBe(join(ROOT, 'creds.json'));
    expect(assertIsDirectChildOfAuthRoot(join(ROOT, 'lines', 'ch-1'))).toBe(
      join(ROOT, 'lines', 'ch-1'),
    );
    expect(assertIsDirectChildOfAuthRoot(join(ROOT, 'pairing', 'ch-1'))).toBe(
      join(ROOT, 'pairing', 'ch-1'),
    );
  });

  it('rejeita a PRÓPRIA raiz (o bug original: rm recursivo da raiz)', () => {
    expect(() => assertIsDirectChildOfAuthRoot(ROOT)).toThrowError(
      expect.objectContaining({ code: 'auth_root_removal_forbidden' }),
    );
  });

  it('rejeita paths fora da raiz', () => {
    expect(() => assertIsDirectChildOfAuthRoot('/etc/passwd')).toThrowError(
      expect.objectContaining({ code: 'auth_root_removal_forbidden' }),
    );
    expect(() => assertIsDirectChildOfAuthRoot(join(ROOT, '..', 'sibling'))).toThrowError(
      expect.objectContaining({ code: 'auth_root_removal_forbidden' }),
    );
  });

  it('rejeita os buckets compartilhados inteiros (lines/, pairing/, control/, media/)', () => {
    for (const bucket of ['lines', 'pairing', 'control', 'media']) {
      expect(() => assertIsDirectChildOfAuthRoot(join(ROOT, bucket))).toThrowError(
        expect.objectContaining({ code: 'auth_root_removal_forbidden' }),
      );
    }
  });

  it('rejeita profundidade > 2 e profundidade 2 fora de lines/pairing', () => {
    expect(() => assertIsDirectChildOfAuthRoot(join(ROOT, 'lines', 'ch-1', 'creds.json'))).toThrowError(
      expect.objectContaining({ code: 'auth_root_removal_forbidden' }),
    );
    expect(() => assertIsDirectChildOfAuthRoot(join(ROOT, 'control', 'setup-token.txt'))).toThrowError(
      expect.objectContaining({ code: 'auth_root_removal_forbidden' }),
    );
  });
});
