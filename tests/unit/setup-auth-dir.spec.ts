import { describe, it, expect } from 'vitest';
import { resolve, sep } from 'node:path';
import { assertSafeAuthDir } from '../../src/setup/auth-dir.js';

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
