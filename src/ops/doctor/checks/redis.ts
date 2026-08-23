/**
 * `maia doctor` — Redis checks (issue #517 §3, "Redis/BullMQ").
 *
 * Every command goes through `ctx.redis`, whose allowlist
 * (`src/ops/doctor/redis.ts`) contains four entries and no writes. In
 * particular there is no canary `SET`/`DEL` to "prove" connectivity — `PING`
 * proves it without touching the keyspace, which is what read-only means.
 *
 * The eviction-policy check is the one here that is a TENANT-ISOLATION check
 * wearing an ops hat, and it is a blocker for that reason. Under any
 * `allkeys-*` policy Redis evicts by idle time alone, so tenant B's write can
 * silently drop tenant A's working memory — key prefixes do not protect
 * against the evictor. `docs/runbooks/redis.md` §4 carries the full scenario
 * and is why `compose.prod.yml` pins `noeviction`.
 */
import { parseRedisInfo } from '../redis.js';
import { pass, skip, type DoctorCheck, type DoctorContext, type DoctorResult } from '../types.js';

/**
 * `--online` was asked for and there is no Redis handle — a FAILURE, not a
 * skip. See `noPostgresHandle()` in `./postgres.ts` for the full argument: the
 * runner already skips networked checks offline, so reaching this branch means
 * connected checks WERE requested and `REDIS_URL` is absent or empty. A `skip`
 * here would let the run exit 0 over a dependency nothing ever opened.
 */
function noRedisHandle(): DoctorResult {
  return {
    status: 'fail',
    summary: 'nenhum handle de Redis foi aberto: `--online` foi pedido e REDIS_URL está ausente ou vazia',
    evidence: { handle_open: false, requested_online: true },
    remediation: [
      'Defina REDIS_URL no ambiente DESTE container e rode de novo com `--online`.',
      'Redis é dependência OBRIGATÓRIA (fila BullMQ, dedup, debouncer, working memory, rate limit): não exercê-la não é o mesmo que aprová-la.',
    ],
  };
}

/** Server floor: `compose.prod.yml` runs `redis:7-alpine`. */
export const MINIMUM_REDIS_MAJOR = 7;

/** Used/maxmemory ratio above which the operator should already be looking. */
export const MEMORY_WARN_RATIO = 0.85;

/**
 * Verdict for a `maxmemory-policy` value, per `docs/runbooks/redis.md` §4.
 *
 *   - `noeviction` — writes FAIL loudly at the cap. Multi-tenant safe. The pin.
 *   - `volatile-*` — evicts only keys carrying an explicit TTL. Acceptable
 *     with care, but BullMQ keys carry no key-level TTL, so under pressure it
 *     degrades to "evict some, then fail anyway" — the worst of both.
 *   - `allkeys-*`  — evicts ANY key, including another tenant's. Cross-tenant
 *     eviction vector; blocks.
 */
export function classifyEvictionPolicy(policy: string): 'safe' | 'acceptable' | 'unsafe' {
  const normalized = policy.trim().toLowerCase();
  if (normalized === 'noeviction') return 'safe';
  if (normalized.startsWith('volatile-')) return 'acceptable';
  return 'unsafe';
}

export const redisConnectivityCheck: DoctorCheck = {
  id: 'redis.connectivity',
  category: 'redis',
  criticality: 'blocker',
  describes: 'o Redis responde PING dentro do deadline',
  deadlineMs: 5_000,
  requiresNetwork: true,
  async run(ctx: DoctorContext): Promise<DoctorResult> {
    if (!ctx.redis) return noRedisHandle();
    const started = performance.now();
    let reply: string;
    try {
      reply = await ctx.redis.ping();
    } catch (err) {
      // The transport class comes from the client's `error` event, because the
      // rejection ioredis hands us is a bare `Error: Connection is closed.`
      // See `DoctorRedis.lastErrorClass`.
      const cls =
        ctx.redis.lastErrorClass() ??
        (err instanceof Error ? err.constructor.name : 'UnknownError');
      return {
        status: 'fail',
        summary: `Redis inalcançável (${cls})`,
        evidence: {
          error_class: cls,
          latency_ms: Math.round(performance.now() - started),
        },
        remediation: [
          'Confirme que o serviço `redis` está de pé e que o host/porta de REDIS_URL são alcançáveis a partir deste container.',
          'Redis é dependência OBRIGATÓRIA (fila BullMQ, dedup de entrada, debouncer, working memory, rate limit): o boot falha fechado sem ele.',
        ],
      };
    }
    const latency = Math.round(performance.now() - started);
    if (reply.toUpperCase() !== 'PONG') {
      return {
        status: 'fail',
        summary: `PING respondeu "${reply}" em vez de PONG`,
        evidence: { latency_ms: latency },
        remediation: ['Confirme que REDIS_URL aponta para um Redis e não para outro serviço.'],
      };
    }
    return pass(`PONG em ${latency}ms`, { latency_ms: latency });
  },
};

export const redisVersionCheck: DoctorCheck = {
  id: 'redis.server_version',
  category: 'redis',
  criticality: 'advisory',
  describes: `o servidor é Redis >= ${MINIMUM_REDIS_MAJOR}`,
  deadlineMs: 3_000,
  requiresNetwork: true,
  dependsOn: ['redis.connectivity'],
  async run(ctx: DoctorContext): Promise<DoctorResult> {
    if (!ctx.redis) return noRedisHandle();
    const info = parseRedisInfo(await ctx.redis.info('server'));
    const version = info.redis_version ?? '';
    const major = Number(version.split('.')[0]);
    if (!Number.isFinite(major) || version === '') {
      return skip('INFO server não trouxe redis_version', { redis_version: version || 'unknown' });
    }
    if (major < MINIMUM_REDIS_MAJOR) {
      return {
        status: 'fail',
        summary: `Redis ${version} está abaixo da linha ${MINIMUM_REDIS_MAJOR} usada em produção`,
        evidence: { redis_version: version, minimum_major: MINIMUM_REDIS_MAJOR },
        remediation: ['Atualize a imagem para `redis:7-alpine`, a mesma de `compose.prod.yml`.'],
      };
    }
    return pass(`Redis ${version}`, { redis_version: version });
  },
};

export const evictionPolicyCheck: DoctorCheck = {
  id: 'redis.maxmemory_policy',
  category: 'redis',
  criticality: 'blocker',
  describes: 'a política de eviction não permite despejo cross-tenant',
  deadlineMs: 3_000,
  requiresNetwork: true,
  dependsOn: ['redis.connectivity'],
  async run(ctx: DoctorContext): Promise<DoctorResult> {
    if (!ctx.redis) return noRedisHandle();
    const conf = await ctx.redis.configGet('maxmemory*');
    const policy = conf['maxmemory-policy'] ?? '';
    const maxmemory = Number(conf.maxmemory ?? '0');
    if (policy === '') {
      return skip('CONFIG GET não devolveu maxmemory-policy (usuário sem permissão?)');
    }
    const verdict = classifyEvictionPolicy(policy);
    const evidence = {
      'maxmemory-policy': policy,
      maxmemory_bytes: Number.isFinite(maxmemory) ? maxmemory : 0,
      verdict,
    };
    if (verdict === 'unsafe') {
      return {
        status: 'fail',
        summary: `maxmemory-policy=${policy} evicta QUALQUER chave — vetor de despejo cross-tenant`,
        evidence,
        remediation: [
          'Troque para `noeviction` (`CONFIG SET maxmemory-policy noeviction` e o argumento correspondente no compose).',
          'Leia `docs/runbooks/redis.md` §4: sob `allkeys-*` a working memory de um tenant some para dar espaço a outro.',
        ],
      };
    }
    if (verdict === 'acceptable') {
      return {
        status: 'warn',
        summary: `maxmemory-policy=${policy}: aceitável, mas as chaves da BullMQ não têm TTL de chave`,
        evidence,
        remediation: [
          'Sob pressão, `volatile-*` evicta só o subset com TTL e ainda falha o write quando ele acaba. `noeviction` falha cedo e claro.',
        ],
      };
    }
    if (maxmemory === 0) {
      return {
        status: 'warn',
        summary: 'política segura (noeviction), mas SEM cap de memória (maxmemory=0)',
        evidence,
        remediation: [
          'Defina `--maxmemory` (produção usa 2gb). Sem cap, `noeviction` nunca dispara e o Redis cresce até o OOM killer do host.',
        ],
      };
    }
    return pass(`maxmemory-policy=${policy} com cap de ${maxmemory} bytes`, evidence);
  },
};

export const memoryPressureCheck: DoctorCheck = {
  id: 'redis.memory_pressure',
  category: 'redis',
  criticality: 'advisory',
  describes: 'a memória usada está longe do cap configurado',
  deadlineMs: 3_000,
  requiresNetwork: true,
  dependsOn: ['redis.connectivity'],
  async run(ctx: DoctorContext): Promise<DoctorResult> {
    if (!ctx.redis) return noRedisHandle();
    const info = parseRedisInfo(await ctx.redis.info('memory'));
    const used = Number(info.used_memory ?? '0');
    const max = Number(info.maxmemory ?? '0');
    if (!Number.isFinite(used)) return skip('INFO memory não trouxe used_memory');
    if (!Number.isFinite(max) || max === 0) {
      return skip('sem cap configurado (maxmemory=0) — não há razão contra a qual medir pressão', {
        used_memory: used,
      });
    }
    const ratio = used / max;
    const evidence = {
      used_memory: used,
      maxmemory: max,
      ratio: Number(ratio.toFixed(3)),
      threshold: MEMORY_WARN_RATIO,
    };
    if (ratio >= MEMORY_WARN_RATIO) {
      return {
        status: 'warn',
        summary: `Redis em ${(ratio * 100).toFixed(1)}% do cap de memória`,
        evidence,
        remediation: [
          'Sob `noeviction`, o próximo write acima do cap FALHA com OOM. Investigue antes de subir `maxmemory` — `docs/runbooks/redis.md` §2.',
        ],
      };
    }
    return pass(`${(ratio * 100).toFixed(1)}% do cap`, evidence);
  },
};

/**
 * Is RDB snapshotting actually ON?
 *
 * The ONLY honest source is `CONFIG GET save`: it returns the save rules as a
 * single space-separated string (`"3600 1 300 100 60 10000"`), and the empty
 * string is exactly how `save ""` / `--save ''` reports "snapshotting
 * disabled". `undefined` means the reply did not carry the parameter at all —
 * a permission problem, not an answer.
 */
export function rdbConfigured(save: string | undefined): boolean | null {
  if (save === undefined) return null;
  return save.trim() !== '';
}

export const persistenceCheck: DoctorCheck = {
  id: 'redis.persistence',
  category: 'redis',
  criticality: 'advisory',
  describes: 'há persistência configurada (AOF ou RDB) e o último save não falhou',
  deadlineMs: 3_000,
  requiresNetwork: true,
  dependsOn: ['redis.connectivity'],
  async run(ctx: DoctorContext): Promise<DoctorResult> {
    if (!ctx.redis) return noRedisHandle();
    const info = parseRedisInfo(await ctx.redis.info('persistence'));
    const aof = info.aof_enabled === '1';
    const lastBgsave = info.rdb_last_bgsave_status ?? 'unknown';
    const lastAofWrite = info.aof_last_write_status ?? 'unknown';

    // `rdb_last_bgsave_status` does NOT mean "RDB is configured". It reports
    // the outcome of the last background save ATTEMPT, and an instance running
    // `save ""` — snapshotting off — reports `ok` forever, because the last
    // attempt (a manual BGSAVE, a shutdown save, or nothing at all) did not
    // fail. Reading `ok` as "RDB" is how this check used to certify an
    // instance that persists nothing, which is false readiness for the BullMQ
    // queue after a restart. `CONFIG GET save` is the configuration; it is
    // already on the read-only allowlist and `CONFIG SET` is not.
    const saveConf = await ctx.redis.configGet('save');
    const saveRule = saveConf.save;
    const rdb = rdbConfigured(saveRule);

    const evidence = {
      aof_enabled: aof,
      rdb_save_rules: saveRule ?? 'unknown',
      rdb_enabled: rdb ?? 'unknown',
      rdb_last_bgsave_status: lastBgsave,
      aof_last_write_status: lastAofWrite,
    };

    if (aof) {
      if (lastAofWrite === 'err') {
        return {
          status: 'fail',
          summary: 'AOF habilitado mas a última escrita FALHOU',
          evidence,
          remediation: [
            'Verifique espaço em disco e permissões do volume do Redis. Com AOF quebrado, um restart perde a fila BullMQ inteira.',
          ],
        };
      }
      return pass('AOF habilitado', evidence);
    }

    if (rdb === null) {
      return skip('sem AOF, e `CONFIG GET save` não devolveu o parâmetro (usuário sem permissão?)', evidence);
    }

    if (!rdb) {
      return {
        status: 'warn',
        summary:
          'sem AOF e com snapshotting DESLIGADO (`save` vazio) — o keyspace não sobrevive a um restart',
        evidence,
        remediation: [
          'Produção liga `--appendonly yes` (`compose.prod.yml`). Sem persistência, jobs enfileirados somem no restart.',
          '`rdb_last_bgsave_status: ok` aqui não prova nada: sem regra `save`, nenhum snapshot é agendado.',
        ],
      };
    }

    if (lastBgsave === 'err') {
      return {
        status: 'fail',
        summary: `RDB configurado (save: ${saveRule ?? ''}) mas o último bgsave FALHOU`,
        evidence,
        remediation: [
          'Verifique espaço em disco e permissões do volume do Redis: o snapshot está agendado e não está sendo escrito.',
        ],
      };
    }

    return pass(`RDB configurado (save: ${saveRule ?? ''}; último bgsave: ${lastBgsave})`, evidence);
  },
};

export const REDIS_CHECKS: readonly DoctorCheck[] = [
  redisConnectivityCheck,
  redisVersionCheck,
  evictionPolicyCheck,
  memoryPressureCheck,
  persistenceCheck,
];
