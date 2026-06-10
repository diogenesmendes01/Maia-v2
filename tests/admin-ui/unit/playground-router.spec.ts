/**
 * Issue #464 — playgroundRouter unit tests.
 *
 * The sandbox surface is governance-adjacent: sessions pin profile versions
 * and turns become audited LLM calls. These tests cover the gates the router
 * owns — role, tenant/agent scoping, version-status validation, session
 * expiry — with the repo layer mocked (the repo's queue semantics are
 * exercised by integration tests / the worker).
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { playgroundRouter } from '@/admin-ui/trpc/routers/playground.js';

type SessionRow = {
  id: string;
  tenant_id: string;
  agent_id: string;
  profile_version_id: string | null;
  created_by: string;
  created_at: Date;
  expires_at: Date;
};

function makeCtx(
  role: string,
  opts?: {
    agent?: { id: string; tenant_id: string } | null;
    version?: { id: string; status: string } | null;
    session?: SessionRow | null;
  },
) {
  const created: Array<Record<string, unknown>> = [];
  const enqueued: Array<Record<string, unknown>> = [];

  const ctx = {
    session: { user: { id: 'user-1', role, tenant_id: 'tenant-A' } },
    userId: 'user-1',
    userRole: role,
    tenantId: 'tenant-A',
    repos: {
      agentsRepo: {
        async findById(_id: string) {
          return opts?.agent === undefined
            ? { id: 'agent-a', tenant_id: 'tenant-A' }
            : opts.agent;
        },
      },
      operationalProfileVersionsRepo: {
        async getById(_id: string) {
          return opts?.version === undefined
            ? { id: 'pv-1', status: 'proposed' }
            : opts.version;
        },
      },
      playgroundRepo: {
        async createSession(args: Record<string, unknown>) {
          created.push(args);
          return {
            id: 'sess-1',
            tenant_id: args.tenant_id,
            agent_id: args.agent_id,
            profile_version_id: args.profile_version_id,
            created_by: args.created_by,
            created_at: new Date(),
            expires_at: new Date(Date.now() + 86_400_000),
          };
        },
        async findSession(_args: Record<string, unknown>) {
          return opts?.session === undefined
            ? ({
                id: 'sess-1',
                tenant_id: 'tenant-A',
                agent_id: 'agent-a',
                profile_version_id: null,
                created_by: 'user-1',
                created_at: new Date(),
                expires_at: new Date(Date.now() + 86_400_000),
              } satisfies SessionRow)
            : opts.session;
        },
        async enqueueUserTurn(args: Record<string, unknown>) {
          enqueued.push(args);
          return { id: 'turn-1', status: 'queued' };
        },
        async listTurns(_args: Record<string, unknown>) {
          return [];
        },
      },
    } as unknown as typeof import('@/db/repositories.js'),
    assertTenant: () => {},
    assertRole: (...roles: string[]) => {
      if (!roles.includes(role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: `role ${role} not allowed` });
      }
    },
  };
  return { ctx, created, enqueued };
}

const SESSION_UUID = '11111111-1111-4111-8111-111111111111';
const VERSION_UUID = '22222222-2222-4222-8222-222222222222';

describe('playgroundRouter.createSession', () => {
  it('creates a session pinned to a proposed version (owner)', async () => {
    const { ctx, created } = makeCtx('owner');
    const caller = playgroundRouter.createCaller(ctx);
    const res = await caller.createSession({
      agentId: 'agent-a',
      profileVersionId: VERSION_UUID,
    });
    expect(res.id).toBe('sess-1');
    expect(created[0]).toMatchObject({
      tenant_id: 'tenant-A',
      agent_id: 'agent-a',
      profile_version_id: VERSION_UUID,
      created_by: 'user-1',
    });
  });

  it('rejects viewer/analyst (role gate)', async () => {
    const { ctx } = makeCtx('viewer');
    const caller = playgroundRouter.createCaller(ctx);
    await expect(
      caller.createSession({ agentId: 'agent-a' }),
    ).rejects.toThrowError(/FORBIDDEN|not allowed/);
  });

  it('rejects agent from another tenant as NOT_FOUND (no existence leak)', async () => {
    const { ctx } = makeCtx('owner', {
      agent: { id: 'agent-b', tenant_id: 'tenant-B' },
    });
    const caller = playgroundRouter.createCaller(ctx);
    await expect(caller.createSession({ agentId: 'agent-b' })).rejects.toThrowError(
      /Agent not found/,
    );
  });

  it('refuses to pin a rolled_back version (PRECONDITION_FAILED)', async () => {
    const { ctx } = makeCtx('founder', {
      version: { id: VERSION_UUID, status: 'rolled_back' },
    });
    const caller = playgroundRouter.createCaller(ctx);
    let thrown: unknown;
    try {
      await caller.createSession({
        agentId: 'agent-a',
        profileVersionId: VERSION_UUID,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe('PRECONDITION_FAILED');
  });

  it('refuses a missing version as NOT_FOUND', async () => {
    const { ctx } = makeCtx('owner', { version: null });
    const caller = playgroundRouter.createCaller(ctx);
    await expect(
      caller.createSession({ agentId: 'agent-a', profileVersionId: VERSION_UUID }),
    ).rejects.toThrowError(/Profile version not found/);
  });
});

describe('playgroundRouter.sendTurn', () => {
  it('enqueues a queued user turn on a live session', async () => {
    const { ctx, enqueued } = makeCtx('owner');
    const caller = playgroundRouter.createCaller(ctx);
    const res = await caller.sendTurn({
      agentId: 'agent-a',
      sessionId: SESSION_UUID,
      message: 'Olá, quero saber meu saldo',
    });
    expect(res.status).toBe('queued');
    expect(enqueued[0]).toMatchObject({
      tenant_id: 'tenant-A',
      agent_id: 'agent-a',
      content: 'Olá, quero saber meu saldo',
    });
  });

  it('rejects an expired session (PRECONDITION_FAILED)', async () => {
    const { ctx } = makeCtx('owner', {
      session: {
        id: 'sess-1',
        tenant_id: 'tenant-A',
        agent_id: 'agent-a',
        profile_version_id: null,
        created_by: 'user-1',
        created_at: new Date(Date.now() - 2 * 86_400_000),
        expires_at: new Date(Date.now() - 1000),
      },
    });
    const caller = playgroundRouter.createCaller(ctx);
    let thrown: unknown;
    try {
      await caller.sendTurn({
        agentId: 'agent-a',
        sessionId: SESSION_UUID,
        message: 'ainda dá?',
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TRPCError);
    expect((thrown as TRPCError).code).toBe('PRECONDITION_FAILED');
  });

  it('rejects unknown session as NOT_FOUND (tenant/agent scoped lookup)', async () => {
    const { ctx } = makeCtx('owner', { session: null });
    const caller = playgroundRouter.createCaller(ctx);
    await expect(
      caller.sendTurn({
        agentId: 'agent-a',
        sessionId: SESSION_UUID,
        message: 'oi',
      }),
    ).rejects.toThrowError(/session not found/i);
  });
});

describe('playgroundRouter.listTurns', () => {
  it('returns turns + session info for a scoped session', async () => {
    const { ctx } = makeCtx('owner');
    const caller = playgroundRouter.createCaller(ctx);
    const res = await caller.listTurns({ agentId: 'agent-a', sessionId: SESSION_UUID });
    expect(res.items).toEqual([]);
    expect(res.session.id).toBe('sess-1');
  });

  it('rejects unknown session as NOT_FOUND', async () => {
    const { ctx } = makeCtx('owner', { session: null });
    const caller = playgroundRouter.createCaller(ctx);
    await expect(
      caller.listTurns({ agentId: 'agent-a', sessionId: SESSION_UUID }),
    ).rejects.toThrowError(/session not found/i);
  });
});
