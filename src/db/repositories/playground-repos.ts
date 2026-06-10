/**
 * Playground sandbox repos (issue #464 — migration 087).
 *
 * Every method takes EXPLICIT tenant_id + agent_id (no AsyncLocalStorage
 * dependency) so it is callable from both the admin-ui tRPC context and the
 * runtime worker. All reads/writes are scoped by (tenant_id, agent_id) —
 * invariant 1; a session id alone never grants access across tenants.
 *
 * The `playground_turns.status` column doubles as the work queue
 * (Postgres-as-queue): `claimNextQueuedTurn` uses FOR UPDATE SKIP LOCKED so
 * multiple worker replicas never double-process a turn.
 */
import { and, asc, desc, eq, lt, sql } from 'drizzle-orm';
import { db, withTx } from '../client.js';
import {
  playground_sessions,
  playground_turns,
  type PlaygroundSession,
  type PlaygroundTurn,
} from '../schema.js';

export const playgroundRepo = {
  async createSession(args: {
    tenant_id: string;
    agent_id: string;
    profile_version_id: string | null;
    created_by: string;
  }): Promise<PlaygroundSession> {
    const [row] = await db
      .insert(playground_sessions)
      .values({
        tenant_id: args.tenant_id,
        agent_id: args.agent_id,
        profile_version_id: args.profile_version_id,
        created_by: args.created_by,
      })
      .returning();
    return row!;
  },

  async findSession(args: {
    tenant_id: string;
    agent_id: string;
    session_id: string;
  }): Promise<PlaygroundSession | null> {
    const rows = await db
      .select()
      .from(playground_sessions)
      .where(
        and(
          eq(playground_sessions.id, args.session_id),
          eq(playground_sessions.tenant_id, args.tenant_id),
          eq(playground_sessions.agent_id, args.agent_id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Insert the operator's message as a `queued` turn. The worker picks it up
   * and appends the matching `agent` turn when done.
   */
  async enqueueUserTurn(args: {
    tenant_id: string;
    agent_id: string;
    session_id: string;
    content: string;
  }): Promise<PlaygroundTurn> {
    const [row] = await db
      .insert(playground_turns)
      .values({
        session_id: args.session_id,
        tenant_id: args.tenant_id,
        agent_id: args.agent_id,
        role: 'user',
        content: args.content,
        status: 'queued',
      })
      .returning();
    return row!;
  },

  async listTurns(args: {
    tenant_id: string;
    agent_id: string;
    session_id: string;
  }): Promise<PlaygroundTurn[]> {
    return db
      .select()
      .from(playground_turns)
      .where(
        and(
          eq(playground_turns.session_id, args.session_id),
          eq(playground_turns.tenant_id, args.tenant_id),
          eq(playground_turns.agent_id, args.agent_id),
        ),
      )
      .orderBy(asc(playground_turns.created_at));
  },

  /* ------------------------------------------------------------------ */
  /* Worker side                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Atomically claim the oldest `queued` user turn (any tenant — the worker
   * re-derives tenant context from the row). SKIP LOCKED makes concurrent
   * workers cooperate instead of colliding. Returns the claimed turn already
   * flipped to `running`, plus its session (for profile_version_id), or null
   * when the queue is empty.
   */
  async claimNextQueuedTurn(): Promise<{
    turn: PlaygroundTurn;
    session: PlaygroundSession;
  } | null> {
    return await withTx(async (tx) => {
      const claimed = await tx.execute<{ id: string }>(sql`
        UPDATE playground_turns
           SET status = 'running'
         WHERE id = (
           SELECT id FROM playground_turns
            WHERE status = 'queued' AND role = 'user'
            ORDER BY created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1
         )
        RETURNING id
      `);
      const claimedId = claimed.rows[0]?.id;
      if (!claimedId) return null;

      const turnRows = await tx
        .select()
        .from(playground_turns)
        .where(eq(playground_turns.id, claimedId))
        .limit(1);
      const turn = turnRows[0];
      if (!turn) return null;

      const sessionRows = await tx
        .select()
        .from(playground_sessions)
        .where(eq(playground_sessions.id, turn.session_id))
        .limit(1);
      const session = sessionRows[0];
      if (!session) {
        // Session swept between enqueue and claim — fail the turn in place.
        await tx
          .update(playground_turns)
          .set({
            status: 'error',
            error_detail: 'session_expired',
            completed_at: new Date(),
          })
          .where(eq(playground_turns.id, claimedId));
        return null;
      }
      return { turn, session };
    });
  },

  /**
   * Write the agent's reply: marks the user turn `done` and appends the
   * `agent` turn with decision_meta, in one transaction.
   */
  async completeTurn(args: {
    user_turn_id: string;
    session_id: string;
    tenant_id: string;
    agent_id: string;
    reply: string;
    decision_meta: Record<string, unknown>;
  }): Promise<void> {
    await withTx(async (tx) => {
      const now = new Date();
      await tx
        .update(playground_turns)
        .set({ status: 'done', completed_at: now })
        .where(eq(playground_turns.id, args.user_turn_id));
      await tx.insert(playground_turns).values({
        session_id: args.session_id,
        tenant_id: args.tenant_id,
        agent_id: args.agent_id,
        role: 'agent',
        content: args.reply,
        decision_meta: args.decision_meta,
        status: 'done',
        completed_at: now,
      });
    });
  },

  async failTurn(args: { user_turn_id: string; error_detail: string }): Promise<void> {
    await db
      .update(playground_turns)
      .set({
        status: 'error',
        // Bounded: error strings can carry provider payloads.
        error_detail: args.error_detail.slice(0, 2000),
        completed_at: new Date(),
      })
      .where(eq(playground_turns.id, args.user_turn_id));
  },

  /**
   * Recent prior turns of a session for conversational context, oldest
   * first, capped — the sandbox keeps context lightweight by design.
   */
  async recentCompletedTurns(args: {
    session_id: string;
    limit?: number;
  }): Promise<PlaygroundTurn[]> {
    const rows = await db
      .select()
      .from(playground_turns)
      .where(
        and(
          eq(playground_turns.session_id, args.session_id),
          eq(playground_turns.status, 'done'),
        ),
      )
      .orderBy(desc(playground_turns.created_at))
      .limit(args.limit ?? 20);
    return rows.reverse();
  },

  /** TTL sweep — sessions cascade-delete their turns. Returns rows removed. */
  async deleteExpiredSessions(now = new Date()): Promise<number> {
    const deleted = await db
      .delete(playground_sessions)
      .where(lt(playground_sessions.expires_at, now))
      .returning({ id: playground_sessions.id });
    return deleted.length;
  },
};
