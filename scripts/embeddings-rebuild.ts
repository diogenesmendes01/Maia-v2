import { db } from '@/db/client.js';
import { sql } from 'drizzle-orm';
import { getEmbeddingProvider } from '@/lib/embeddings.js';
import { config } from '@/config/env.js';

async function run() {
  const provider = getEmbeddingProvider();
  if (provider.dimensions !== config.EMBEDDING_DIMENSIONS) {
    console.error(`provider dim ${provider.dimensions} != config ${config.EMBEDDING_DIMENSIONS}`);
    process.exit(1);
  }
  console.log(`rebuilding embeddings with ${provider.name}/${provider.modelId} (${provider.dimensions}d)`);

  const total = await db.execute<{ count: string }>(sql`SELECT count(*)::text AS count FROM agent_memories`);
  const totalCount = Number((total.rows[0] as { count: string } | undefined)?.count ?? 0);
  console.log(`agent_memories rows: ${totalCount}`);

  const BATCH = 32;
  let offset = 0;
  let updated = 0;
  while (offset < totalCount) {
    const rows = await db.execute<{ id: string; conteudo: string }>(sql`
      SELECT id::text, conteudo FROM agent_memories
      WHERE embedding IS NULL OR vector_dims(embedding) != ${config.EMBEDDING_DIMENSIONS}
      ORDER BY created_at LIMIT ${BATCH}
    `);
    if (rows.rows.length === 0) break;
    const texts = rows.rows.map((r) => (r as { conteudo: string }).conteudo);
    const embs = await provider.embed(texts);
    for (let i = 0; i < rows.rows.length; i++) {
      const r = rows.rows[i] as { id: string };
      const v = `[${(embs[i] ?? []).join(',')}]`;
      await db.execute(sql`UPDATE agent_memories SET embedding = ${v}::vector WHERE id = ${r.id}::uuid`);
      updated++;
    }
    offset += rows.rows.length;
    console.log(`  ${offset}/${totalCount}`);
  }
  console.log(`done: ${updated} rows updated`);
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
