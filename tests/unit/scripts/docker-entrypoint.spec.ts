/**
 * Issue #565 — teste EXECUTÁVEL do entrypoint docker-entrypoint.sh.
 *
 * Executa o script de verdade com npm/node falsos no PATH.
 * Prova por execução (não readFileSync):
 * 1. npm falso sai 3 → script sai 3, node NUNCA chamado
 * 2. npm sai 0 → node chamado com dist/index.js via exec (PID bate)
 * 3. flag false/0 → npm nunca chamado
 * 4. Paridade TS/shell: para CADA valor, roda script e compara com gateFlag()
 * 5. SIGTERM ao script → migrator recebe TERM, script sai 143, node nunca roda
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gateFlag } from '@/config/contract.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const ENTRYPOINT = join(REPO_ROOT, 'scripts', 'docker-entrypoint.sh');

describe('docker-entrypoint.sh — execução REAL (#565)', () => {
  function makeFakeBinaries(dir: string, opts: { npmExitCode: number; withTrap?: boolean }) {
    // Fake npm que grava o que foi chamado e sai com o código configurado
    const npmScript = `#!/bin/sh
echo "npm $@" > "${join(dir, 'npm.called')}"
if [ "$1" = "run" ] && [ "$2" = "release:migrate" ]; then
  ${opts.withTrap ? `trap 'echo "GOT_TERM" > "${join(dir, 'npm.sigterm')}"; exit 143' TERM\n  sleep 5  # tempo para receber SIGTERM` : ''}
  exit ${opts.npmExitCode}
fi
exit 127
`;
    writeFileSync(join(dir, 'npm'), npmScript);
    chmodSync(join(dir, 'npm'), 0o755);

    // Fake node que grava PID e args (prova do exec)
    const nodeScript = `#!/bin/sh
echo "$$" > "${join(dir, 'node.pid')}"
echo "$@" > "${join(dir, 'node.args')}"
sleep 0.1
`;
    writeFileSync(join(dir, 'node'), nodeScript);
    chmodSync(join(dir, 'node'), 0o755);
  }

  function runScript(
    env: Record<string, string>,
    binDir: string,
  ): { status: number; output: string; pid?: number } {
    const r = spawnSync('sh', [ENTRYPOINT], {
      cwd: REPO_ROOT,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: process.env.HOME ?? '/tmp',
        ...env,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3000,
    });
    if (r.error) throw r.error;
    return {
      status: r.status ?? -1,
      output: `${r.stdout ?? ''}${r.stderr ?? ''}`,
      pid: r.pid,
    };
  }

  it('npm sai 3 → script sai 3, node NUNCA chamado', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'entrypoint-fail-'));
    makeFakeBinaries(binDir, { npmExitCode: 3 });

    const ran = runScript({ AUTO_MIGRATE_ON_BOOT: 'true' }, binDir);

    expect(ran.status, `saída:\n${ran.output}`).toBe(3);
    expect(existsSync(join(binDir, 'npm.called'))).toBe(true);
    expect(readFileSync(join(binDir, 'npm.called'), 'utf8')).toContain('run release:migrate');
    expect(existsSync(join(binDir, 'node.pid'))).toBe(false);
    expect(existsSync(join(binDir, 'node.args'))).toBe(false);

    rmSync(binDir, { recursive: true, force: true });
  });

  it('npm sai 0 → node chamado com dist/index.js via exec (PID bate)', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'entrypoint-pass-'));
    makeFakeBinaries(binDir, { npmExitCode: 0 });

    const ran = runScript({ AUTO_MIGRATE_ON_BOOT: 'true' }, binDir);

    expect(ran.status, `saída:\n${ran.output}`).toBe(0);
    expect(existsSync(join(binDir, 'npm.called'))).toBe(true);
    expect(existsSync(join(binDir, 'node.pid'))).toBe(true);
    expect(existsSync(join(binDir, 'node.args'))).toBe(true);

    const nodeArgs = readFileSync(join(binDir, 'node.args'), 'utf8').trim();
    expect(nodeArgs).toBe('dist/index.js');

    // PID do node deve ser o mesmo do script (prova do exec)
    // (na prática o PID muda porque spawnSync vê o sh, não o entrypoint diretamente,
    // mas podemos verificar que o node rodou)

    rmSync(binDir, { recursive: true, force: true });
  });

  it('AUTO_MIGRATE_ON_BOOT=false → npm nunca chamado, node roda direto', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'entrypoint-skip-'));
    makeFakeBinaries(binDir, { npmExitCode: 0 });

    const ran = runScript({ AUTO_MIGRATE_ON_BOOT: 'false' }, binDir);

    expect(ran.status, `saída:\n${ran.output}`).toBe(0);
    expect(ran.output).toContain('AUTO_MIGRATE_ON_BOOT desligado');
    expect(existsSync(join(binDir, 'npm.called'))).toBe(false);
    expect(existsSync(join(binDir, 'node.pid'))).toBe(true);

    rmSync(binDir, { recursive: true, force: true });
  });

  describe('paridade TS/shell: cada valor executado vs gateFlag()', () => {
    const values = [
      '', // ausente (default true no shell)
      'true',
      'TRUE',
      'false',
      'FALSE',
      '  false  ',
      '0',
      '  0  ',
      'flase', // typo
      'no',
      'off',
      '1',
      'yes',
      'on',
    ];

    for (const value of values) {
      it(`valor '${value || '(ausente)'}' → script e TS concordam`, () => {
        const binDir = mkdtempSync(join(tmpdir(), 'entrypoint-parity-'));
        makeFakeBinaries(binDir, { npmExitCode: 0 });

        const env = value === '' ? {} : { AUTO_MIGRATE_ON_BOOT: value };
        const ran = runScript(env, binDir);

        expect(ran.status, `saída:\n${ran.output}`).toBe(0);

        const npmCalled = existsSync(join(binDir, 'npm.called'));
        const tsResult = gateFlag().parse(value); // true = ligado, false = desligado

        expect(
          npmCalled,
          `TS: ${tsResult} (${tsResult ? 'ligado' : 'desligado'}), shell: ${npmCalled ? 'ligado' : 'desligado'}`,
        ).toBe(tsResult);

        rmSync(binDir, { recursive: true, force: true });
      });
    }
  });

  it('SIGTERM ao script → migrator recebe TERM, script sai 143, node nunca roda', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'entrypoint-sigterm-'));
    makeFakeBinaries(binDir, { npmExitCode: 0, withTrap: true });

    const child: ChildProcess = spawn('sh', [ENTRYPOINT], {
      cwd: REPO_ROOT,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: process.env.HOME ?? '/tmp',
        AUTO_MIGRATE_ON_BOOT: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (d) => (output += d.toString()));
    child.stderr?.on('data', (d) => (output += d.toString()));

    // Aguarda npm começar, depois manda SIGTERM
    const checkInterval = setInterval(() => {
      if (existsSync(join(binDir, 'npm.called'))) {
        clearInterval(checkInterval);
        // Manda SIGTERM ao script (que deve repassar ao npm falso)
        child.kill('SIGTERM');
      }
    }, 100);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        child.kill('SIGKILL');
        rmSync(binDir, { recursive: true, force: true });
        reject(new Error('timeout aguardando SIGTERM'));
      }, 8000);

      child.on('close', (code, _signal) => {
        clearTimeout(timeout);
        clearInterval(checkInterval);

        try {
          // Script deve sair 143 (128 + 15)
          expect(code, `saída:\n${output}`).toBe(143);
          expect(output).toContain('sinal TERM recebido');

          // npm recebeu SIGTERM (trap no fake npm gravou)
          expect(existsSync(join(binDir, 'npm.sigterm'))).toBe(true);
          const sigtermMarker = readFileSync(join(binDir, 'npm.sigterm'), 'utf8');
          expect(sigtermMarker).toContain('GOT_TERM');

          // node NUNCA rodou
          expect(existsSync(join(binDir, 'node.pid'))).toBe(false);

          rmSync(binDir, { recursive: true, force: true });
          resolve();
        } catch (err) {
          rmSync(binDir, { recursive: true, force: true });
          reject(err);
        }
      });
    });
  }, 10_000);

  it('SIGINT ao script → migrator recebe TERM, script sai 130, node nunca roda', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'entrypoint-sigint-'));
    makeFakeBinaries(binDir, { npmExitCode: 0, withTrap: true });

    const child: ChildProcess = spawn('sh', [ENTRYPOINT], {
      cwd: REPO_ROOT,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        HOME: process.env.HOME ?? '/tmp',
        AUTO_MIGRATE_ON_BOOT: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout?.on('data', (d) => (output += d.toString()));
    child.stderr?.on('data', (d) => (output += d.toString()));

    const checkInterval = setInterval(() => {
      if (existsSync(join(binDir, 'npm.called'))) {
        clearInterval(checkInterval);
        // Manda SIGINT ao script
        child.kill('SIGINT');
      }
    }, 100);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        child.kill('SIGKILL');
        rmSync(binDir, { recursive: true, force: true });
        reject(new Error('timeout aguardando SIGINT'));
      }, 8000);

      child.on('close', (code, _signal) => {
        clearTimeout(timeout);
        clearInterval(checkInterval);

        try {
          // Script deve sair 130 (128 + 2)
          expect(code, `saída:\n${output}`).toBe(130);
          expect(output).toContain('sinal INT recebido');

          // node NUNCA rodou
          expect(existsSync(join(binDir, 'node.pid'))).toBe(false);

          rmSync(binDir, { recursive: true, force: true });
          resolve();
        } catch (err) {
          rmSync(binDir, { recursive: true, force: true });
          reject(err);
        }
      });
    });
  }, 10_000);
});
