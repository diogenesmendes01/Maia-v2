/**
 * `maia doctor` — per-check behaviour, and the parity guards for the two
 * constants this module DUPLICATES on purpose (issue #517 §3).
 *
 * Duplication is a real risk and it is answered here rather than in a comment:
 * the Node floor and the admin-ui boot floors live in files the doctor cannot
 * import (a dependency-free `.mjs` guard, and `src/admin-ui`, which the root
 * `tsconfig.json` excludes). So the copies are read back from their sources as
 * TEXT and compared.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MINIMUM_NODE_VERSION,
  compareSemver,
  nodeVersionCheck,
  parseSemver,
} from '@/ops/doctor/checks/runtime.js';
import {
  MIN_NEXTAUTH_SECRET_LEN,
  MIN_OIDC_CLIENT_SECRET_LEN,
  adminBootGatesCheck,
  configContractCheck,
} from '@/ops/doctor/checks/config.js';
import { classifyEvictionPolicy, evictionPolicyCheck } from '@/ops/doctor/checks/redis.js';
import {
  DOCTOR_REDIS_ALLOWED,
  RedisCommandNotAllowedError,
  allowlistKey,
  assertRedisCommandAllowed,
  parseRedisInfo,
  readOnlyRedis,
} from '@/ops/doctor/redis.js';
import { DOCTOR_CATEGORIES, DOCTOR_CHECKS, checksForCategories } from '@/ops/doctor/registry.js';
import type { DoctorContext, DoctorRedis } from '@/ops/doctor/types.js';

const ROOT = process.cwd();

function ctx(over: Partial<DoctorContext> = {}): DoctorContext {
  return {
    env: {},
    profile: 'production',
    service: 'runtime',
    online: true,
    migrationsDir: join(ROOT, 'migrations'),
    postgres: null,
    redis: null,
    schemaReadiness: null,
    ...over,
  };
}

const never = new AbortController().signal;

describe('maia doctor · registry', () => {
  it('every check has a deadline, a description and a unique id', () => {
    const ids = DOCTOR_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of DOCTOR_CHECKS) {
      expect(c.deadlineMs, c.id).toBeGreaterThan(0);
      expect(c.describes.length, c.id).toBeGreaterThan(0);
      expect(DOCTOR_CATEGORIES).toContain(c.category);
    }
  });

  it('every declared dependency exists in the registry', () => {
    const ids = new Set(DOCTOR_CHECKS.map((c) => c.id));
    for (const c of DOCTOR_CHECKS) {
      for (const dep of c.dependsOn ?? []) expect(ids, `${c.id} → ${dep}`).toContain(dep);
    }
  });

  it('every check that touches a socket is marked requiresNetwork', () => {
    // The offline guarantee is only worth as much as this flag: a networked
    // check that forgets it would open a connection in `--offline`.
    for (const c of DOCTOR_CHECKS) {
      if (c.category === 'postgres' || c.category === 'redis') {
        expect(c.requiresNetwork, c.id).toBe(true);
      } else {
        expect(c.requiresNetwork, c.id).toBe(false);
      }
    }
  });

  it('--only narrows to the requested categories; empty means everything', () => {
    expect(checksForCategories([])).toHaveLength(DOCTOR_CHECKS.length);
    expect(checksForCategories(['redis']).every((c) => c.category === 'redis')).toBe(true);
  });
});

describe('maia doctor · runtime.node_version', () => {
  it('the mirrored floor matches `engines.node` in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toContain(MINIMUM_NODE_VERSION);
  });

  it('the mirrored floor matches the guard in scripts/check-node.mjs', () => {
    const guard = readFileSync(join(ROOT, 'scripts/check-node.mjs'), 'utf8');
    expect(guard).toContain(`var MINIMUM_VERSION = '${MINIMUM_NODE_VERSION}';`);
  });

  it('parses and compares release versions', () => {
    expect(parseSemver('v22.13.0')).toEqual([22, 13, 0]);
    expect(parseSemver('not-a-version')).toBeNull();
    expect(compareSemver([22, 12, 0], [22, 13, 0])).toBeLessThan(0);
    expect(compareSemver([22, 13, 0], [22, 13, 0])).toBe(0);
    expect(compareSemver([23, 0, 0], [22, 13, 0])).toBeGreaterThan(0);
  });

  it('passes on the Node actually running the suite', async () => {
    const result = await nodeVersionCheck.run(ctx(), never);
    expect(result.status).toBe('pass');
  });
});

describe('maia doctor · config.admin_boot_gates', () => {
  it('mirrors MIN_OIDC_CLIENT_SECRET_LEN from src/admin-ui/lib/auth-gating.ts', () => {
    const gating = readFileSync(join(ROOT, 'src/admin-ui/lib/auth-gating.ts'), 'utf8');
    expect(gating).toContain(`export const MIN_OIDC_CLIENT_SECRET_LEN = ${MIN_OIDC_CLIENT_SECRET_LEN};`);
  });

  it('mirrors the NEXTAUTH_SECRET floor enforced by resolveSecret()', () => {
    const gating = readFileSync(join(ROOT, 'src/admin-ui/lib/auth-gating.ts'), 'utf8');
    expect(gating).toContain(`secret.length < ${MIN_NEXTAUTH_SECRET_LEN}`);
  });

  it('SKIPS — never passes — when no admin-ui variable is present', async () => {
    const result = await adminBootGatesCheck.run(ctx(), never);
    expect(result.status).toBe('skip');
  });

  it('catches the secret the CONTRACT accepts and the console rejects', async () => {
    // 12 chars: satisfies the contract's `min(8)`, fails NextAuth's floor of 32.
    const result = await adminBootGatesCheck.run(
      ctx({ env: { NEXTAUTH_SECRET: 'a'.repeat(12) } }),
      never,
    );
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('NEXTAUTH_SECRET');
    expect(result.evidence?.nextauth_secret_length).toBe(12);
    // The length is evidence; the value never is.
    expect(JSON.stringify(result)).not.toContain('a'.repeat(12));
  });

  it('fails when OIDC_ISSUER is set but the client secret is below the boot floor', async () => {
    const result = await adminBootGatesCheck.run(
      ctx({
        env: {
          NEXTAUTH_SECRET: 'n'.repeat(40),
          OIDC_ISSUER: 'https://idp.example.com/realms/maia',
          OIDC_CLIENT_SECRET: 'short',
        },
      }),
      never,
    );
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('OIDC_CLIENT_SECRET');
  });

  it('degrades to WARN in development, where the console does not enforce the gate', async () => {
    const result = await adminBootGatesCheck.run(
      ctx({ profile: 'development', env: { NEXTAUTH_SECRET: 'a'.repeat(12) } }),
      never,
    );
    expect(result.status).toBe('warn');
    expect(result.evidence?.enforced_at_boot).toBe(false);
  });

  it('passes when both floors are met', async () => {
    const result = await adminBootGatesCheck.run(
      ctx({
        env: {
          NEXTAUTH_SECRET: 'n'.repeat(48),
          OIDC_ISSUER: 'https://idp.example.com/realms/maia',
          OIDC_CLIENT_SECRET: 'c'.repeat(24),
        },
      }),
      never,
    );
    expect(result.status).toBe('pass');
  });
});

describe('maia doctor · config.contract', () => {
  it('reports EVERY problem at once, not the first one', async () => {
    const result = await configContractCheck.run(ctx({ env: {} }), never);
    expect(result.status).toBe('fail');
    expect(Number(result.evidence?.errors)).toBeGreaterThan(3);
    // Named variables, so the operator fixes the whole file in one pass.
    expect(String(result.evidence?.problems)).toContain('DATABASE_URL');
  });

  it('never echoes a secret VALUE, only the variable name and the rule', async () => {
    const env = { DATABASE_URL: 'postgres://u:canario-canario@h:5432/d' };
    const result = await configContractCheck.run(ctx({ env }), never);
    expect(JSON.stringify(result)).not.toContain('canario-canario');
  });
});

describe('maia doctor · redis policy', () => {
  it('classifies eviction policies by the runbook, not by taste', () => {
    expect(classifyEvictionPolicy('noeviction')).toBe('safe');
    expect(classifyEvictionPolicy('volatile-lru')).toBe('acceptable');
    expect(classifyEvictionPolicy('volatile-ttl')).toBe('acceptable');
    expect(classifyEvictionPolicy('allkeys-lru')).toBe('unsafe');
    expect(classifyEvictionPolicy('allkeys-random')).toBe('unsafe');
  });

  function fakeRedis(conf: Record<string, string>): DoctorRedis {
    return {
      ping: () => Promise.resolve('PONG'),
      info: () => Promise.resolve(''),
      configGet: () => Promise.resolve(conf),
      lastErrorClass: () => null,
    };
  }

  it('BLOCKS on allkeys-*, which is a cross-tenant eviction vector', async () => {
    const result = await evictionPolicyCheck.run(
      ctx({ redis: fakeRedis({ 'maxmemory-policy': 'allkeys-lru', maxmemory: '2147483648' }) }),
      never,
    );
    expect(result.status).toBe('fail');
    expect(evictionPolicyCheck.criticality).toBe('blocker');
    expect(result.remediation?.join(' ')).toContain('noeviction');
  });

  it('warns on volatile-*, which BullMQ keys are invisible to', async () => {
    const result = await evictionPolicyCheck.run(
      ctx({ redis: fakeRedis({ 'maxmemory-policy': 'volatile-lru', maxmemory: '2147483648' }) }),
      never,
    );
    expect(result.status).toBe('warn');
  });

  it('warns when the policy is safe but there is no cap at all', async () => {
    const result = await evictionPolicyCheck.run(
      ctx({ redis: fakeRedis({ 'maxmemory-policy': 'noeviction', maxmemory: '0' }) }),
      never,
    );
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('SEM cap');
  });

  it('passes on the production pin: noeviction with a cap', async () => {
    const result = await evictionPolicyCheck.run(
      ctx({ redis: fakeRedis({ 'maxmemory-policy': 'noeviction', maxmemory: '2147483648' }) }),
      never,
    );
    expect(result.status).toBe('pass');
  });
});

describe('maia doctor · redis read-only allowlist', () => {
  it('the allowlist contains no write command', () => {
    for (const entry of DOCTOR_REDIS_ALLOWED) {
      expect(['PING', 'INFO', 'DBSIZE', 'CONFIG|GET']).toContain(entry);
    }
  });

  it('keys CONFIG by SUBCOMMAND, so CONFIG SET is a different thing from CONFIG GET', () => {
    expect(allowlistKey('CONFIG', ['GET', 'maxmemory'])).toBe('CONFIG|GET');
    expect(allowlistKey('CONFIG', ['SET', 'maxmemory', '0'])).toBe('CONFIG|SET');
  });

  it('REFUSES every write, and nothing reaches the client when it does', () => {
    for (const [command, args] of [
      ['SET', ['k', 'v']],
      ['DEL', ['k']],
      ['FLUSHALL', []],
      ['EVAL', ['return 1', '0']],
      ['CONFIG', ['SET', 'maxmemory', '0']],
      ['CONFIG', ['RESETSTAT']],
    ] as [string, string[]][]) {
      expect(() => assertRedisCommandAllowed(command, args), command).toThrow(
        RedisCommandNotAllowedError,
      );
    }
  });

  it('the handle only ever issues allowlisted commands to the underlying client', async () => {
    const issued: string[] = [];
    const handle = readOnlyRedis({
      call: (command: string, ...args: string[]) => {
        issued.push([command, ...args].join(' '));
        return Promise.resolve(command === 'CONFIG' ? ['maxmemory', '0'] : 'PONG');
      },
    });
    await handle.ping();
    await handle.info('memory');
    await handle.configGet('maxmemory*');
    expect(issued).toEqual(['PING', 'INFO memory', 'CONFIG GET maxmemory*']);
  });

  it('parses an INFO payload, dropping section headers', () => {
    const parsed = parseRedisInfo('# Memory\r\nused_memory:123\r\nmaxmemory:456\r\n\r\n');
    expect(parsed).toEqual({ used_memory: '123', maxmemory: '456' });
  });
});
