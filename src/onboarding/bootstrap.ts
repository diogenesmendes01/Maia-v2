import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, withTx } from '@/db/client.js';
import { bootstrap_credentials, bootstrap_completions } from '@/db/schema.js';
import { OnboardingError } from './errors.js';

/**
 * Bootstrap global — issue #519.
 *
 * O PROBLEMA QUE ISTO SUBSTITUI. `docs/admin-ui-deploy.md` mandava criar o
 * primeiro operador com `INSERT INTO app_users ... VALUES (..., 'default',
 * ...)` no `psql`. Isso viola dois pontos escritos na propria issue: "nada de
 * INSERT manual" e o invariante "nenhum fallback `default` em path dinamico".
 *
 * POR QUE NAO REUSAR `src/setup/token.ts`. Aquele modulo ja' faz token de uso
 * unico muito bem — 128 bits, `timingSafeEqual`, criacao atomica por
 * `flag: 'wx'`, arquivo 0600. Mas ele guarda o token EM CLARO, porque o caso
 * dele exige que o operador LEIA o token para parear a linha. Aqui o segredo
 * e' entregue uma unica vez na criacao e nunca mais pode ser lido — nem por
 * quem tem o disco. E as garantias de corrida sao entre REPLICAS, que nao
 * compartilham filesystem de forma confiavel.
 *
 * ONDE CADA GARANTIA MORA. Nenhuma delas esta' nesta camada por escolha: todas
 * estao no banco, porque uma checagem de aplicacao pode ser feita por uma
 * replica ANTES do commit da outra.
 *
 *   - no maximo UMA credencial viva -> unique parcial
 *     `bootstrap_credentials_unconsumed_uq WHERE consumed_at IS NULL`;
 *   - invalidacao atomica -> `UPDATE ... WHERE consumed_at IS NULL`, cujo
 *     rowCount decide quem venceu;
 *   - bloqueio definitivo -> PK de `bootstrap_completions.singleton`;
 *   - expiracao e lockout -> comparados com `now()` do BANCO, nunca com
 *     `Date.now()` de replica (mesma razao da janela de debounce da 130).
 */

/** 128 bits em hex, igual ao formato de `src/setup/token.ts`. */
const SECRET_BYTES = 16;
const VALID_SECRET_PATTERN = /^[0-9a-f]{32}$/;

/** Tentativas erradas antes do lockout. */
export const MAX_FAILED_ATTEMPTS = 5;
/** Duracao do lockout apos estourar o limite. */
export const LOCKOUT_MS = 15 * 60 * 1000;
/** Validade padrao da credencial. */
export const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * sha256 do segredo. Nao ha' salt de propósito: o segredo tem 128 bits de
 * entropia real vindos de `randomBytes`, entao nao existe dicionario a
 * proteger — salt defende senha ESCOLHIDA por humano, que nao e' o caso.
 * Um KDF lento (scrypt/argon) tambem nao se aplica: ele existe para encarecer
 * brute force sobre entropia baixa, e aqui a entropia e' o proprio segredo.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Comparacao timing-safe entre dois hashes hex. Mesma disciplina de
 * `src/setup/token.ts:verifyToken`: comprimento zero e' recusado
 * explicitamente para que um valor vazio vazado nao case com buffer vazio, e
 * a diferenca de comprimento sai antes porque `timingSafeEqual` lanca nela.
 */
export function hashesMatch(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** `true` quando o marcador monotonico de bootstrap concluido existe. */
export async function isBootstrapCompleted(): Promise<boolean> {
  const linhas = await db.select({ s: bootstrap_completions.singleton }).from(bootstrap_completions).limit(1);
  return linhas.length > 0;
}

export type IssuedCredential = {
  id: string;
  /**
   * O segredo EM CLARO. Devolvido uma unica vez, aqui. Quem chama tem a
   * responsabilidade de entrega-lo ao operador e nao persisti-lo, nao
   * loga-lo e nao pô-lo em URL.
   */
  secret: string;
  expires_at: Date;
};

/**
 * Emite a credencial de bootstrap. Recusa fechado se o bootstrap ja' foi
 * concluido, ou se ja' existe credencial viva.
 *
 * A recusa por credencial viva vem do BANCO (violacao do unique parcial),
 * nao de um `SELECT` antes do `INSERT`: entre o select e o insert cabe a
 * outra replica.
 */
export async function issueBootstrapCredential(input: {
  created_by: string;
  ttl_ms?: number;
}): Promise<IssuedCredential> {
  if (await isBootstrapCompleted()) {
    throw new OnboardingError(
      'bootstrap_already_completed',
      'bootstrap global já foi concluído neste sistema',
    );
  }

  const secret = randomBytes(SECRET_BYTES).toString('hex');
  const ttl = input.ttl_ms ?? DEFAULT_TTL_MS;

  try {
    const [linha] = await db
      .insert(bootstrap_credentials)
      .values({
        id: randomBytes(16).toString('hex'),
        secret_hash: hashSecret(secret),
        created_by: input.created_by,
        // Expiracao derivada do relogio do BANCO: `now() + interval`, nunca
        // um Date calculado nesta replica.
        expires_at: sql`now() + make_interval(secs => ${ttl / 1000})` as unknown as Date,
      })
      .returning({ id: bootstrap_credentials.id, expires_at: bootstrap_credentials.expires_at });

    if (!linha) {
      // `returning()` sem linha depois de um insert que nao lancou seria
      // incoerencia do driver, nao caminho de negocio. Falha fechado.
      throw new OnboardingError(
        'bootstrap_credential_exists',
        'credencial de bootstrap não pôde ser emitida',
      );
    }
    return { id: linha.id, secret, expires_at: linha.expires_at };
  } catch (err) {
    // 23505 = unique_violation. E' o `..._unconsumed_uq` dizendo que ja' existe
    // credencial viva — o que e' uma recusa legitima, nao um erro interno.
    if ((err as { code?: string }).code === '23505') {
      throw new OnboardingError(
        'bootstrap_credential_exists',
        'já existe uma credencial de bootstrap viva; consuma ou aguarde a expiração',
      );
    }
    throw err;
  }
}

export type RedeemOutcome = { credential_id: string };

/**
 * Valida e CONSOME a credencial, atomicamente.
 *
 * A ordem importa e e' deliberada:
 *   1. bootstrap ja' concluido -> recusa definitiva (antes de tocar em
 *      credencial, para nao dar sinal sobre existencia dela);
 *   2. formato do segredo -> recusa sem ir ao banco;
 *   3. carrega a credencial viva; ausencia e' recusa generica;
 *   4. lockout e expiracao pelo relogio do banco;
 *   5. comparacao timing-safe;
 *   6. consumo por compare-and-swap.
 *
 * Toda recusa usa a MESMA mensagem generica onde o detalhe pudesse ajudar um
 * atacante a distinguir "credencial errada" de "credencial inexistente".
 */
export async function redeemBootstrapCredential(input: {
  presented_secret: string;
}): Promise<RedeemOutcome> {
  if (await isBootstrapCompleted()) {
    throw new OnboardingError(
      'bootstrap_already_completed',
      'bootstrap global já foi concluído neste sistema',
    );
  }

  if (!VALID_SECRET_PATTERN.test(input.presented_secret)) {
    throw new OnboardingError('bootstrap_credential_invalid', 'credencial de bootstrap inválida');
  }

  return withTx(async (tx) => {
    // `FOR UPDATE` serializa duas tentativas simultaneas sobre a MESMA
    // credencial: a segunda espera e enxerga o consumo da primeira.
    // As duas janelas temporais sao computadas AQUI, na mesma leitura, contra
    // `now()` do BANCO. Fazê-las numa segunda query abriria uma janela entre
    // as duas leituras; fazê-las em JS usaria o relogio da REPLICA, que e'
    // exatamente o que a issue proibe.
    const [cred] = await tx
      .select({
        id: bootstrap_credentials.id,
        secret_hash: bootstrap_credentials.secret_hash,
        failed_attempts: bootstrap_credentials.failed_attempts,
        locked_until: bootstrap_credentials.locked_until,
        locked: sql<boolean>`${bootstrap_credentials.locked_until} IS NOT NULL AND ${bootstrap_credentials.locked_until} > now()`,
        expired: sql<boolean>`${bootstrap_credentials.expires_at} <= now()`,
      })
      .from(bootstrap_credentials)
      .where(isNull(bootstrap_credentials.consumed_at))
      .for('update')
      .limit(1);

    if (!cred) {
      throw new OnboardingError('bootstrap_credential_invalid', 'credencial de bootstrap inválida');
    }

    if (cred.locked) {
      throw new OnboardingError(
        'bootstrap_locked_out',
        'credencial de bootstrap temporariamente bloqueada por excesso de tentativas',
      );
    }
    if (cred.expired) {
      throw new OnboardingError('bootstrap_credential_expired', 'credencial de bootstrap expirada');
    }

    if (!hashesMatch(hashSecret(input.presented_secret), cred.secret_hash)) {
      const tentativas = cred.failed_attempts + 1;
      await tx
        .update(bootstrap_credentials)
        .set({
          failed_attempts: tentativas,
          locked_until:
            tentativas >= MAX_FAILED_ATTEMPTS
              ? (sql`now() + make_interval(secs => ${LOCKOUT_MS / 1000})` as unknown as Date)
              : cred.locked_until,
        })
        .where(eq(bootstrap_credentials.id, cred.id));
      throw new OnboardingError('bootstrap_credential_invalid', 'credencial de bootstrap inválida');
    }

    // O COMPARE-AND-SWAP. `WHERE consumed_at IS NULL` e' o que faz duas
    // tentativas simultaneas com o segredo CERTO produzirem um consumo e um
    // perdedor — mesmo que o `FOR UPDATE` acima fosse removido.
    const consumida = await tx
      .update(bootstrap_credentials)
      .set({ consumed_at: sql`now()` as unknown as Date })
      .where(
        and(eq(bootstrap_credentials.id, cred.id), isNull(bootstrap_credentials.consumed_at)),
      )
      .returning({ id: bootstrap_credentials.id });

    if (consumida.length !== 1) {
      throw new OnboardingError(
        'bootstrap_credential_consumed',
        'credencial de bootstrap já consumida',
      );
    }

    return { credential_id: cred.id };
  });
}

/**
 * Grava o marcador DENTRO de uma transacao ja' aberta.
 *
 * Esta variante existe porque o marcador e a criacao do founder TEM de ser
 * atomicos entre si. Se fossem duas transacoes, um crash entre elas deixaria
 * o sistema num de dois estados incoerentes: founder criado sem marcador (o
 * bloqueio definitivo nunca engata, e uma segunda credencial pode ser
 * emitida), ou marcador sem founder (o bootstrap fica bloqueado para sempre
 * sem nunca ter produzido identidade administrativa).
 */
export async function markBootstrapCompletedTx(
  tx: Parameters<Parameters<typeof withTx>[0]>[0],
  input: { credential_id: string; tenant_id: string; founder_user_id: string },
): Promise<void> {
  try {
    await tx.insert(bootstrap_completions).values({
      credential_id: input.credential_id,
      tenant_id: input.tenant_id,
      founder_user_id: input.founder_user_id,
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new OnboardingError(
        'bootstrap_already_completed',
        'bootstrap global já foi concluído neste sistema',
      );
    }
    throw err;
  }
}

/**
 * Grava o marcador monotonico de bootstrap concluido. Um segundo bootstrap
 * viola a PK de `singleton` — e' o banco recusando, nao esta funcao.
 */
export async function markBootstrapCompleted(input: {
  credential_id: string;
  tenant_id: string;
  founder_user_id: string;
}): Promise<void> {
  try {
    await db.insert(bootstrap_completions).values({
      credential_id: input.credential_id,
      tenant_id: input.tenant_id,
      founder_user_id: input.founder_user_id,
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new OnboardingError(
        'bootstrap_already_completed',
        'bootstrap global já foi concluído neste sistema',
      );
    }
    throw err;
  }
}
