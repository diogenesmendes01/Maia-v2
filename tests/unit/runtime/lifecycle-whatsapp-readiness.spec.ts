/**
 * Issue #512 review round 1, P1 (`src/index.ts:189`) — WhatsApp readiness must
 * distinguish "never connected" from "reconnecting".
 *
 * The hole: `startBaileys()` returns as soon as the socket is armed, long
 * before `connection.update = open`. Marking the component `ready` right after
 * it meant a cold start — or a QR nobody ever scanned — showed up as
 * `degraded`, and with `READINESS_REQUIRE_WHATSAPP_LIVE=false` (the default)
 * `/readyz` answered **200** for an instance that had never been able to send
 * a single message.
 *
 * The fix: `ready` is set from the `open` handler. `degraded` is only reachable
 * AFTER the session was established once — before that the component stays
 * `starting`, which readiness treats as `unknown` and therefore fails closed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { baileysConnectedMock, memoryReadinessMock, schemaMock, probeDbMock } = vi.hoisted(() => ({
  baileysConnectedMock: vi.fn<[], boolean>(),
  memoryReadinessMock: vi.fn(),
  schemaMock: vi.fn(),
  probeDbMock: vi.fn<[], Promise<boolean>>(),
}));

vi.mock('../../../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../src/db/client.js', () => ({ probeDb: probeDbMock }));
vi.mock('../../../src/lib/redis.js', () => ({
  isRedisConnected: () => true,
  redis: { ping: vi.fn(async () => 'PONG') },
}));
vi.mock('../../../src/gateway/baileys.js', () => ({ isBaileysConnected: baileysConnectedMock }));
vi.mock('../../../src/lib/healthcheck.js', () => ({ checkReadiness: memoryReadinessMock }));
vi.mock('../../../src/runtime/lifecycle/schema-version.js', () => ({
  checkSchemaVersion: schemaMock,
}));

import { lifecycle } from '../../../src/runtime/lifecycle/controller.js';
import {
  checkRoleReadiness,
  _resetReadinessCacheForTests,
} from '../../../src/runtime/lifecycle/readiness.js';
import type { LifecycleComponent } from '../../../src/runtime/lifecycle/roles.js';

/** Everything healthy EXCEPT whatsapp_session, which each case drives. */
function healthyExceptWhatsApp(): void {
  probeDbMock.mockResolvedValue(true);
  memoryReadinessMock.mockResolvedValue({ ready: true, checks: {} });
  schemaMock.mockResolvedValue({ status: 'ok', expected: 'x', applied: 'x' });
  const others: LifecycleComponent[] = [
    'config',
    'db',
    'schema',
    'redis',
    'redis_memory',
    'queue',
    'agent_worker',
    'cron_scheduler',
    'http',
  ];
  for (const c of others) lifecycle.setComponent(c, 'ready');
  lifecycle.transitionTo('ready');
}

beforeEach(() => {
  vi.clearAllMocks();
  lifecycle._resetForTests();
  _resetReadinessCacheForTests();
});

describe('whatsapp_session readiness — never established vs reconnecting', () => {
  it('is NOT ready during a cold start: socket armed, never opened', async () => {
    healthyExceptWhatsApp();
    // Exactly what `startBaileys()` leaves behind now.
    lifecycle.setComponent('whatsapp_session', 'starting');
    baileysConnectedMock.mockReturnValue(false);

    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/whatsapp_session=unknown/);
    const wa = r.checks.find((c) => c.component === 'whatsapp_session')!;
    expect(wa.status).toBe('unknown');
    // Crucially NOT `degraded` — that would have been a 200.
    expect(wa.status).not.toBe('degraded');
  });

  it('is NOT ready when a QR was displayed but never scanned', async () => {
    healthyExceptWhatsApp();
    lifecycle.setComponent('whatsapp_session', 'starting');
    baileysConnectedMock.mockReturnValue(false);
    // Time passing changes nothing: readiness is about `open`, not about age.
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
  });

  it('becomes ready once the session actually opened', async () => {
    healthyExceptWhatsApp();
    lifecycle.setComponent('whatsapp_session', 'ready'); // what the `open` handler does
    baileysConnectedMock.mockReturnValue(true);

    const r = await checkRoleReadiness();
    expect(r.ready).toBe(true);
    expect(r.checks.find((c) => c.component === 'whatsapp_session')!.status).toBe('ok');
  });

  it('STAYS ready (degraded) across a transient reconnect — only after a real open', async () => {
    healthyExceptWhatsApp();
    lifecycle.setComponent('whatsapp_session', 'ready');
    // …then the socket drops; the close handler degrades an established session.
    lifecycle.setComponent('whatsapp_session', 'degraded', 'socket closed — reconnecting');
    baileysConnectedMock.mockReturnValue(false);

    const r = await checkRoleReadiness();
    expect(r.ready).toBe(true);
    expect(r.checks.find((c) => c.component === 'whatsapp_session')!.status).toBe('degraded');
  });

  it('is NOT ready after a logout — the pairing is gone, not merely flapping', async () => {
    healthyExceptWhatsApp();
    lifecycle.setComponent('whatsapp_session', 'ready');
    lifecycle.setComponent('whatsapp_session', 'failed', 'logged out — re-pairing required');
    baileysConnectedMock.mockReturnValue(false);

    const r = await checkRoleReadiness();
    expect(r.ready).toBe(false);
    expect(r.reason).toMatch(/whatsapp_session=down/);
  });

  it('a worker-role process is unaffected by any of this', async () => {
    lifecycle.setRole('worker');
    healthyExceptWhatsApp();
    lifecycle.setComponent('whatsapp_session', 'starting');
    const r = await checkRoleReadiness();
    expect(r.ready).toBe(true);
  });
});
