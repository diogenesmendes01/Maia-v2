/**
 * Exclusão mútua entre as specs que exercitam a FILA de `channel_line_state`.
 *
 * ### Por que isto existe
 *
 * `claimNextCommand(owner)` e `renewOwnerLeases(owner)` são, de propósito,
 * **globais**: uma réplica do runtime reivindica o próximo comando pendente de
 * QUALQUER tenant e renova todas as leases que possui. Isso é o desenho certo
 * — a fila é do processo, não do tenant — e `src/db/repositories/channel-line-state-repos.ts`
 * documenta o porquê.
 *
 * A consequência é que uma spec que assere "reivindiquei 1" ou "renovei 1" está
 * implicitamente afirmando **ser a única escritora daquela tabela no banco**
 * durante a sua execução. Isso valeu enquanto só a #518 escrevia ali.
 *
 * A saga de onboarding (#519) passou a enfileirar `start_pairing` pela mesma
 * tabela, usando-a como outbox dentro da transação de ativação. Como o vitest
 * roda arquivos em paralelo contra UM banco, um `claimNextCommand('replica-A')`
 * da spec de line-state passou a poder reivindicar um comando que a spec de
 * onboarding acabou de criar — e aí `renewOwnerLeases('replica-A')` devolve 2
 * onde a spec espera 1.
 *
 * Isso **não é um defeito de produção**: em produção, uma réplica reivindicar o
 * pareamento enfileirado pelo onboarding é exatamente o comportamento desejado.
 * É o modelo de isolamento da spec que quebrou.
 *
 * ### Por que um advisory lock, e não um truncate
 *
 * Truncar a tabela no `beforeEach` não resolve: as duas specs rodam em
 * PROCESSOS diferentes, então uma truncaria a linha que a outra acabou de
 * inserir e ainda vai ler. O que falta é serialização entre processos, e o
 * `pg_advisory_lock` de sessão é o mecanismo que Postgres oferece para isso —
 * o mesmo que `src/migrations/` já usa para serializar dois migradores.
 *
 * O lock é de SESSÃO, então precisa de uma conexão dedicada: o pool entrega
 * conexões diferentes a cada query, e um lock adquirido numa e liberado noutra
 * não é lock nenhum.
 */
import { afterAll, beforeAll } from 'vitest';
import pg from 'pg';

/**
 * Chave derivada por `hashtextextended` para não colidir com o lock de
 * migrations (`maia_schema_migrations`). O segundo argumento é o seed.
 */
const LOCK_KEY = "hashtextextended('maia_channel_line_state_queue', '51805180')";

/**
 * Registra os hooks que dão a esta spec posse exclusiva da fila de
 * `channel_line_state` enquanto ela roda. Chame no corpo do `describe`.
 *
 * Sem `TEST_DB_URL` vira no-op: as specs que usam isto já se auto-pulam nesse
 * caso, e adquirir lock num banco que não existe só produziria um erro pior.
 */
export function useExclusivePairingQueue(): void {
  let pool: pg.Pool | null = null;
  let client: pg.PoolClient | null = null;

  beforeAll(async () => {
    const url = process.env.TEST_DB_URL;
    if (!url) return;
    pool = new pg.Pool({ connectionString: url, max: 1 });
    client = await pool.connect();
    // Bloqueia até que a spec anterior solte. Sem timeout de propósito: o
    // timeout do hook do vitest é o teto, e falhar por "não consegui o lock"
    // seria um falso vermelho tão ruim quanto a corrida que isto conserta.
    await client.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => undefined);
      client.release();
      client = null;
    }
    await pool?.end().catch(() => undefined);
    pool = null;
  });
}
