import { dlqRepo } from '@/db/repositories.js';
import { agentQueue } from '@/gateway/queue.js';

async function listOpen() {
  const items = await dlqRepo.listOpen(50);
  if (items.length === 0) {
    console.log('DLQ vazia.');
    return;
  }
  for (const it of items) {
    console.log(`- ${it.id}  queue=${it.queue_name}  job=${it.job_id}  attempts=${it.attempts}`);
    console.log(`  error: ${it.error.slice(0, 200)}`);
    console.log(`  created_at: ${it.created_at}`);
  }
}

async function retry(id: string) {
  const items = await dlqRepo.listOpen(1000);
  const item = items.find((x) => x.id === id);
  if (!item) {
    console.error(`not found: ${id}`);
    process.exit(1);
  }
  await agentQueue.add('process-message', item.payload as { mensagem_id: string }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
  });
  await dlqRepo.resolve(id);
  console.log(`re-enqueued and resolved ${id}`);
}

async function resolve(id: string) {
  await dlqRepo.resolve(id);
  console.log(`resolved ${id}`);
}

const cmd = process.argv[2];
const arg = process.argv[3];

(async () => {
  if (cmd === 'list') await listOpen();
  else if (cmd === 'retry' && arg) await retry(arg);
  else if (cmd === 'resolve' && arg) await resolve(arg);
  else {
    console.log('usage: tsx scripts/dlq.ts list | retry <id> | resolve <id>');
    process.exit(2);
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
