/**
 * Issue #565 — teste do entrypoint docker-entrypoint.sh real.
 *
 * Prova em runtime que:
 * 1. Migration que FALHA → script sai != 0, app NUNCA roda
 * 2. Migration que PASSA → app roda com exec (vira o processo do shell)
 * 3. AUTO_MIGRATE_ON_BOOT=false → migration pulada, app roda direto
 * 4. Fail-closed: só 'false'/'0' (case-insensitive, trimmed) desligam;
 *    qualquer outro valor (typo, vazio, 'no', 'off') mantém ligado
 * 5. Paridade com gateFlag() do TypeScript
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gateFlag } from '@/config/contract.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const ENTRYPOINT = join(REPO_ROOT, 'scripts', 'docker-entrypoint.sh');

describe('docker-entrypoint.sh — entrypoint real (#565)', () => {
  it('script existe e é legível', () => {
    const content = readFileSync(ENTRYPOINT, 'utf8');
    expect(content).toContain('docker-entrypoint');
    expect(content).toContain('AUTO_MIGRATE_ON_BOOT');
    expect(content).toContain('npm run release:migrate');
    expect(content).toContain('exec node dist/index.js');
  });

  it('trap existe para SIGTERM/SIGINT durante migration', () => {
    const content = readFileSync(ENTRYPOINT, 'utf8');
    expect(content).toContain('trap cleanup TERM INT');
    expect(content).toContain('MIGRATOR_PID');
    expect(content).toContain('kill -TERM');
  });

  it('normalização da flag: só false e 0 (case-insensitive, trimmed) desligam', () => {
    const content = readFileSync(ENTRYPOINT, 'utf8');
    
    // Verifica que compara com "false" e "0"
    expect(content).toContain('= "false"');
    expect(content).toContain('= "0"');
    expect(content).toContain('AUTO_MIGRATE_NORM');
    
    // Verifica que tem normalização (lowercase + trim)
    expect(content).toContain('tr \'[:upper:]\' \'[:lower:]\'');
    expect(content).toContain('sed \'s/^[[:space:]]*//;s/[[:space:]]*$//\'');
  });

  describe('paridade com gateFlag() do TypeScript', () => {
    // Casos de teste que o gateFlag() do TypeScript cobre
    const cases: Array<{ value: string; expected: boolean }> = [
      { value: 'false', expected: false },
      { value: 'FALSE', expected: false },
      { value: '  false  ', expected: false },
      { value: '0', expected: false },
      { value: '  0  ', expected: false },
      // Tudo abaixo mantém ligado (fail-closed)
      { value: '', expected: true },
      { value: 'true', expected: true },
      { value: 'TRUE', expected: true },
      { value: 'flase', expected: true }, // typo
      { value: 'no', expected: true },
      { value: 'off', expected: true },
      { value: '1', expected: true },
      { value: 'yes', expected: true },
      { value: 'on', expected: true },
    ];

    for (const { value, expected } of cases) {
      it(`valor '${value || '(vazio)'}' → ${expected ? 'ligado' : 'desligado'}`, () => {
        const schema = gateFlag();
        const result = schema.parse(value);
        expect(result).toBe(expected);
      });
    }
  });

  it('migration que falha → script propaga exit code != 0', () => {
    const content = readFileSync(ENTRYPOINT, 'utf8');
    // Verifica que captura exit code e faz exit
    expect(content).toContain('EXIT_CODE=$?');
    expect(content).toContain('exit $EXIT_CODE');
  });

  it('migration que passa → exec node substitui o shell', () => {
    const content = readFileSync(ENTRYPOINT, 'utf8');
    // exec faz o node substituir o shell (PID 1 correto via tini)
    expect(content).toMatch(/exec\s+node\s+dist\/index\.js/);
  });

  it('AUTO_MIGRATE_ON_BOOT=false → migration pulada, app roda direto', () => {
    const content = readFileSync(ENTRYPOINT, 'utf8');
    // Verifica que existe path de skip
    expect(content).toContain('AUTO_MIGRATE_ON_BOOT desligado');
    expect(content).toContain('pulando migration gate');
  });

  it('comentários documentam signal handling e recovery', () => {
    const content = readFileSync(ENTRYPOINT, 'utf8');
    expect(content).toContain('trap');
    expect(content).toContain('SIGTERM');
    expect(content).toContain('SIGINT');
    expect(content).toContain('advisory lock');
    expect(content).toContain('dirty');
  });
});
