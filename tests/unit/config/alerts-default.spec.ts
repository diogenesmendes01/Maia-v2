/**
 * Issue #515, evidência citada — `ALERT_CHANNELS` tem default `email`, e o
 * refinamento exige `ALERT_EMAIL_TO` quando `email` está na lista. O
 * `.env.example` antigo comentava AS DUAS, então um `.env` copiado do exemplo
 * simplesmente não subia: o operador só descobria no boot.
 *
 * Duas garantias fixadas aqui:
 *   1. o exemplo gerado declara `ALERT_CHANNELS` EXPLICITAMENTE (não comentado);
 *   2. omitir a variável produz um aviso identificável, em vez de um default
 *      silencioso que puxa uma dependência escondida.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnvFile } from '@/config/generate.js';
import { validateConfig } from '@/config/validate.js';
import { buildFixture } from '@/config/generate.js';

const REPO_ROOT = resolve(__dirname, '../../..');

describe('ALERT_CHANNELS — default implícito (#515)', () => {
  it('.env.example declara ALERT_CHANNELS explicitamente', () => {
    const env = parseEnvFile(readFileSync(join(REPO_ROOT, '.env.example'), 'utf8'));
    expect(env.ALERT_CHANNELS).toBe('log');
  });

  it('.env.example não fica com email ligado e ALERT_EMAIL_TO comentado', () => {
    const env = parseEnvFile(readFileSync(join(REPO_ROOT, '.env.example'), 'utf8'));
    const channels = (env.ALERT_CHANNELS ?? 'email').split(',').map((s) => s.trim());
    if (channels.includes('email')) {
      expect(env.ALERT_EMAIL_TO, 'email ligado exige destinatário').toBeTruthy();
    }
  });

  it('omitir ALERT_CHANNELS gera aviso identificável', () => {
    const env = { ...buildFixture('production') };
    delete env.ALERT_CHANNELS;
    const result = validateConfig({ env, profile: 'production' });
    const warning = result.warnings.find((p) => p.rule === 'alerts/implicit-default');
    expect(warning?.message).toContain('ALERT_EMAIL_TO');
  });

  it('o default email sem ALERT_EMAIL_TO continua sendo erro de boot', () => {
    const env = { ...buildFixture('production'), ALERT_CHANNELS: 'email' };
    delete env.ALERT_EMAIL_TO;
    const result = validateConfig({ env, profile: 'production' });
    expect(result.errors.some((p) => p.rule === 'alerts/email-destination')).toBe(true);
  });
});
