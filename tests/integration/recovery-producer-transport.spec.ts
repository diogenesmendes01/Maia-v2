import { beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { agentTurnJobId } from '@/runtime/turns/job.js';
import { recoveryRedisTransport } from '../helpers/recovery-redis-transport.js';

const d = process.env.TEST_DB_URL ? describe : describe.skip;
d('recovery producer real TCP command timeout', () => {
  let gateway: typeof import('@/gateway/queue.js');
  beforeAll(async () => {
    gateway = await import('@/gateway/queue.js');
  });
  it('lost add ACK destroys IO; restart/retry leaves exactly one deterministic job', async () => {
    const transport = await recoveryRedisTransport(process.env.REDIS_URL!);
    transport.recover();
    const data = { turn_id: randomUUID(), mensagem_id: randomUUID() };
    const id = agentTurnJobId(data.turn_id);
    const original = Queue.prototype.add;
    const fault = vi.spyOn(Queue.prototype, 'add').mockImplementation(function (
      this: Queue,
      ...args: Parameters<typeof original>
    ) {
      if (args[2]?.jobId === id) transport.loseReplies();
      return original.apply(this, args);
    });
    try {
      const began = Date.now();
      await expect(
        gateway.enqueueAgentForRecovery(data, { redisUrl: transport.url, timeoutMs: 300 }),
      ).rejects.toThrow();
      expect(Date.now() - began).toBeLessThan(1500);
      await expect.poll(() => transport.sockets).toBe(0);
      // Server committed the Lua add; only its acknowledgement was lost.
      expect((await gateway.agentQueue.getJob(id))?.id).toBe(id);
      fault.mockRestore();
      transport.recover();
      await gateway.enqueueAgentForRecovery(data, { redisUrl: transport.url });
      await gateway.enqueueAgentForRecovery(data, { redisUrl: transport.url });
      expect(
        (await gateway.agentQueue.getJobs(['waiting'])).filter((job) => job.id === id),
      ).toHaveLength(1);
      await expect.poll(() => transport.sockets).toBe(0);
    } finally {
      fault.mockRestore();
      await (await gateway.agentQueue.getJob(id))?.remove();
      await transport.close();
    }
  });
});
