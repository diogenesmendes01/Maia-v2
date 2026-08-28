/**
 * Issue #513 (fatia A) — POSSE EXCLUSIVA de uma sessão de canal, decidida pelo
 * PostgreSQL.
 *
 * O que este módulo substitui. `line-session-manager.ts` diz, na abertura:
 * "Topologia v1: in-process (N sockets)". A posse de uma linha é um `Map`
 * local. Com uma réplica isso está certo por ausência de adversário; com duas,
 * ambas abrem o mesmo socket e escrevem no mesmo auth state. Este módulo é o
 * lugar onde "quem é o dono desta linha?" passa a ter UMA resposta para a
 * frota inteira.
 *
 * Divisão de trabalho (mesma de #504, de propósito):
 *   - AQUI ficam o vocabulário e os statements ATÔMICOS. Nada de timers, nada
 *     de sockets, nada de decidir se uma linha DEVE ser aberta.
 *   - Quem liga o heartbeat, fecha o socket ao perder a posse e reage ao
 *     takeover é a fatia B (`session-owner`), que consome estas funções.
 *
 * As três regras que o resto do sistema pode assumir:
 *
 *   1. **No máximo um dono por canal, sempre.** Não porque o código tome
 *      cuidado, mas porque `channel_id` é a PK de `channel_session_leases`.
 *   2. **O fence só sobe.** `fencing_token` é incrementado a cada nova posse e
 *      a linha nunca é apagada, então um dono antigo que volta de uma partição
 *      traz um token estritamente menor que o corrente — e toda gravação
 *      fenced o recusa.
 *   3. **O relógio é o do banco.** Todo prazo é `now()` do PostgreSQL. Uma
 *      réplica com o relógio adiantado não consegue declarar vencida uma lease
 *      viva, porque a decisão não é dela.
 *
 * O que um fence NÃO resolve, e a issue diz isso explicitamente: o WhatsApp
 * não conhece fencing token. O banco pode recusar as gravações do dono antigo
 * e ainda assim o socket dele estar aberto. Por isso a regra da fatia B é
 * FECHAR ao perder a posse, e não apenas conferir o token depois de enviar.
 */
import { sql } from 'drizzle-orm';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { db } from '@/db/client.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import { METRIC } from '@/observability/taxonomy.js';

// ── Vocabulário ──────────────────────────────────────────────────────────────

/**
 * Resultado de uma tentativa de aquisição.
 *
 * `acquired` e `taken_over` são separados de propósito: o primeiro é pegar uma
 * linha livre, o segundo é pegar uma linha cujo dono anterior sumiu. Colapsar
 * os dois esconderia justamente o evento que o operador precisa ver.
 */
export const CHANNEL_LEASE_ACQUIRE_RESULTS = [
  'acquired',
  'renewed',
  'taken_over',
  'held_by_other',
  'db_error',
] as const;
export type ChannelLeaseAcquireResult = (typeof CHANNEL_LEASE_ACQUIRE_RESULTS)[number];

/** Resultado de uma renovação. Qualquer coisa != `renewed` = perdi a posse. */
export const CHANNEL_LEASE_HEARTBEAT_RESULTS = [
  'renewed',
  'fence_rejected',
  'expired',
  'not_owner',
  'db_error',
] as const;
export type ChannelLeaseHeartbeatResult = (typeof CHANNEL_LEASE_HEARTBEAT_RESULTS)[number];

/** Por que a posse mudou de dono. */
export const CHANNEL_LEASE_TAKEOVER_REASONS = ['lease_expired', 'released_by_owner'] as const;
export type ChannelLeaseTakeoverReason = (typeof CHANNEL_LEASE_TAKEOVER_REASONS)[number];

/** Operações que apresentam um fence e podem ser recusadas por ele. */
export const CHANNEL_FENCE_OPERATIONS = ['heartbeat', 'release', 'send'] as const;
export type ChannelFenceOperation = (typeof CHANNEL_FENCE_OPERATIONS)[number];

/** Prazo default de uma lease. Ver `assertLeaseTiming` para o porquê do teto. */
export const CHANNEL_LEASE_TTL_MS = 30_000;

/**
 * Identidade DESTE processo como dono. Sorteada uma vez por processo, não
 * derivada só do host: duas réplicas no mesmo host são dois donos distintos, e
 * um `hostname` compartilhado faria uma renovar a lease da outra.
 *
 * O `hostname` entra como prefixo porque é o que o operador reconhece ao ler a
 * tabela às três da manhã; o uuid é o que garante a distinção.
 */
let instanciaCorrente: string | null = null;
export function channelOwnerInstanceId(): string {
  instanciaCorrente ??= `${hostname()}:${randomUUID()}`;
  return instanciaCorrente;
}

/** Só para teste: força uma identidade, simulando outra réplica. */
export function __setChannelOwnerInstanceIdForTest(id: string | null): void {
  instanciaCorrente = id;
}

// ── Tipos de retorno ─────────────────────────────────────────────────────────

export type ChannelLeaseScope = {
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly channel_id: string;
};

/** Posse CONFIRMADA. Só existe quando o banco disse que sim. */
export type ChannelLeaseHeld = {
  readonly held: true;
  readonly result: Extract<ChannelLeaseAcquireResult, 'acquired' | 'renewed' | 'taken_over'>;
  readonly scope: ChannelLeaseScope;
  readonly owner_instance_id: string;
  readonly fencing_token: number;
  readonly lease_expires_at: Date;
};

/** Posse NEGADA. Fail-closed: quem recebe isto não abre socket. */
export type ChannelLeaseDenied = {
  readonly held: false;
  readonly result: Extract<ChannelLeaseAcquireResult, 'held_by_other' | 'db_error'>;
  readonly scope: ChannelLeaseScope;
  /** Quem está com a linha, quando sabemos. `null` em `db_error`. */
  readonly held_by: string | null;
  readonly lease_expires_at: Date | null;
};

export type ChannelLeaseOutcome = ChannelLeaseHeld | ChannelLeaseDenied;

// ── Guardas ──────────────────────────────────────────────────────────────────

/**
 * O TTL tem piso e teto, e os dois têm motivo.
 *
 * O piso existe porque uma lease mais curta que o intervalo realista de
 * renovação produz takeover FALSO: o dono vivo perde a linha porque não teve
 * tempo de bater. O teto existe porque a lease é o tempo MÁXIMO que uma linha
 * fica indisponível depois de a réplica dona morrer sem devolver — a issue
 * pede failover em até 45 segundos.
 */
export function assertChannelLeaseTtl(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < 5_000 || ttlMs > 45_000) {
    throw new Error(
      `TTL de lease de canal fora da faixa [5000, 45000]: ${ttlMs}. ` +
        'Abaixo do piso o dono vivo perde a linha por não conseguir renovar a tempo; ' +
        'acima do teto o failover estoura o SLA de 45s da issue #513.',
    );
  }
}

function assertEscopo(scope: ChannelLeaseScope): void {
  // Espelha o CHECK da migration 137. O banco é a última linha; esta é a
  // primeira, e devolve um erro que nomeia o campo em vez de um 23514 opaco.
  for (const [campo, valor] of [
    ['tenant_id', scope.tenant_id],
    ['agent_id', scope.agent_id],
  ] as const) {
    if (typeof valor !== 'string' || valor.length === 0) {
      throw new Error(`posse de canal sem ${campo}`);
    }
    if (valor === 'default') {
      throw new Error(
        `posse de canal com ${campo}='default' — o literal reservado nunca é dono de linha ` +
          '(invariante 8 do AGENTS.md: uma posse sob `default` é posse global disfarçada)',
      );
    }
  }
  if (typeof scope.channel_id !== 'string' || scope.channel_id.length === 0) {
    throw new Error('posse de canal sem channel_id');
  }
}

// ── Operações ────────────────────────────────────────────────────────────────

/**
 * A linha crua. `fencing_token` chega como `string` do driver (`bigint` do
 * PostgreSQL não cabe em `number` por definição do protocolo), então todo uso
 * passa por `Number()` — seguro aqui porque o token conta TAKEOVERS de um
 * canal, não ids externos.
 */
type LinhaLease = {
  channel_id: string;
  tenant_id: string;
  agent_id: string;
  owner_instance_id: string;
  fencing_token: string | number;
  /**
   * `timestamptz` chega como STRING neste caminho: `db.execute` é SQL cru e
   * não passa pelos parsers de coluna do Drizzle. Por isso o tipo é honesto
   * sobre as duas formas possíveis e tudo que sai daqui passa por `paraData`.
   */
  lease_expires_at: Date | string;
  status: string;
};

/** Normaliza o que o driver devolveu para `Date`, seja qual for a forma. */
function paraData(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/**
 * Adquire — ou renova — a posse de um canal, em UM statement.
 *
 * A atomicidade é o ponto inteiro. `INSERT ... ON CONFLICT DO UPDATE ... WHERE`
 * é avaliado sob o lock da linha em conflito, então duas réplicas que chamam
 * isto no mesmo instante são serializadas pelo PostgreSQL: uma satisfaz o
 * `WHERE` e recebe a linha no `RETURNING`, a outra não satisfaz e recebe ZERO
 * linhas. Não existe janela entre "olhei" e "peguei" porque não há dois passos.
 *
 * O `WHERE` autoriza a tomada em exatamente três situações:
 *   - a lease VENCEU (`lease_expires_at <= now()`) — o dono sumiu;
 *   - a linha foi DEVOLVIDA (`status = 'released'`) — deploy ordenado, a linha
 *     é reivindicável na hora, sem esperar o prazo;
 *   - sou EU (`owner_instance_id` bate) — é uma renovação, não uma tomada.
 *
 * `fencing_token` sobe nos dois primeiros casos e NÃO sobe no terceiro:
 * renovar não é uma nova posse, e incrementar ali invalidaria o token que o
 * próprio dono está usando para enviar.
 */
export async function acquireChannelLease(
  scope: ChannelLeaseScope,
  opts: { ttlMs?: number; ownerInstanceId?: string } = {},
): Promise<ChannelLeaseOutcome> {
  assertEscopo(scope);
  const ttl = opts.ttlMs ?? CHANNEL_LEASE_TTL_MS;
  assertChannelLeaseTtl(ttl);
  const dono = opts.ownerInstanceId ?? channelOwnerInstanceId();
  const ttlSegundos = ttl / 1000;

  try {
    const res = await db.execute<LinhaLease & { renovacao: boolean }>(sql`
      INSERT INTO channel_session_leases
        (channel_id, tenant_id, agent_id, owner_instance_id, fencing_token,
         acquired_at, heartbeat_at, lease_expires_at, status, updated_at)
      VALUES
        (${scope.channel_id}::uuid, ${scope.tenant_id}, ${scope.agent_id}, ${dono}, 1,
         now(), now(), now() + make_interval(secs => ${ttlSegundos}), 'active', now())
      ON CONFLICT (channel_id) DO UPDATE SET
        -- O tenant/agente da linha é reafirmado a cada posse: um canal que
        -- mudou de dono de negócio não pode continuar auditado no tenant velho.
        tenant_id = EXCLUDED.tenant_id,
        agent_id = EXCLUDED.agent_id,
        owner_instance_id = EXCLUDED.owner_instance_id,
        -- Renovação do MESMO dono preserva o token; toda posse NOVA incrementa.
        -- Sem esta distinção, um heartbeat invalidaria o próprio fence de quem
        -- está enviando naquele instante.
        fencing_token = CASE
          WHEN channel_session_leases.owner_instance_id = EXCLUDED.owner_instance_id
            AND channel_session_leases.status = 'active'
            AND channel_session_leases.lease_expires_at > now()
          THEN channel_session_leases.fencing_token
          ELSE channel_session_leases.fencing_token + 1
        END,
        acquired_at = CASE
          WHEN channel_session_leases.owner_instance_id = EXCLUDED.owner_instance_id
            AND channel_session_leases.status = 'active'
            AND channel_session_leases.lease_expires_at > now()
          THEN channel_session_leases.acquired_at
          ELSE now()
        END,
        heartbeat_at = now(),
        lease_expires_at = now() + make_interval(secs => ${ttlSegundos}),
        status = 'active',
        updated_at = now()
      WHERE channel_session_leases.lease_expires_at <= now()
         OR channel_session_leases.status = 'released'
         OR channel_session_leases.owner_instance_id = EXCLUDED.owner_instance_id
      RETURNING
        channel_session_leases.*,
        -- O discriminador e' calculado no BANCO, sobre a linha que acabou de
        -- ser gravada. Faze-lo em TypeScript exigiria confiar em como o driver
        -- tipa timestamptz num db.execute cru -- e ele devolve string, nao
        -- Date, porque nao passa pelos parsers do Drizzle. Uma comparacao de
        -- datas que depende da forma do driver e' uma armadilha calada.
        (acquired_at < heartbeat_at) AS renovacao
    `);

    const linha = res.rows[0];
    if (!linha) {
      // Zero linhas = o `WHERE` não passou = a lease é de outro e está viva.
      // Só AQUI se faz a segunda leitura, e ela é puramente informativa (para o
      // log do operador): a decisão — não sou o dono — já está tomada.
      const atual = await db.execute<LinhaLease>(sql`
        SELECT owner_instance_id, lease_expires_at
          FROM channel_session_leases
         WHERE channel_id = ${scope.channel_id}::uuid
      `);
      const dela = atual.rows[0];
      incCounter(METRIC.CHANNEL_LEASE_ACQUIRE, {
        result: 'held_by_other',
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
      });
      return {
        held: false,
        result: 'held_by_other',
        scope,
        held_by: dela?.owner_instance_id ?? null,
        lease_expires_at: dela ? paraData(dela.lease_expires_at) : null,
      };
    }

    const token = Number(linha.fencing_token);
    // Que TIPO de posse foi esta, derivado só do que o banco devolveu — nunca
    // de uma leitura anterior, que já estaria velha:
    //
    //   - `acquired_at < heartbeat_at` ⇒ RENOVAÇÃO. Os dois só divergem quando
    //     o `CASE` preservou o `acquired_at` antigo, e ele só preserva no ramo
    //     "sou eu, com lease viva".
    //   - senão, a posse recomeçou agora (`acquired_at = heartbeat_at = now()`),
    //     e o token diz se a linha é nova (1) ou se foi TOMADA de alguém (≥2).
    //
    // A ordem importa: uma renovação da primeira posse também tem token 1.
    const result: ChannelLeaseHeld['result'] = linha.renovacao
      ? 'renewed'
      : token === 1
        ? 'acquired'
        : 'taken_over';

    incCounter(METRIC.CHANNEL_LEASE_ACQUIRE, {
      result,
      tenant_id: scope.tenant_id,
      agent_id: scope.agent_id,
    });
    if (result === 'taken_over') {
      incCounter(METRIC.CHANNEL_LEASE_TAKEOVER, {
        reason: 'lease_expired',
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
      });
    }

    return {
      held: true,
      result,
      scope,
      owner_instance_id: dono,
      fencing_token: token,
      lease_expires_at: paraData(linha.lease_expires_at),
    };
  } catch (err) {
    // Fail-closed: erro de banco NUNCA vira posse. Quem não sabe se é dono não
    // abre socket — é a diferença entre uma linha parada e duas réplicas
    // enviando pela mesma linha.
    logger.error({ err, channel_id: scope.channel_id }, 'channel_lease.acquire_failed');
    incCounter(METRIC.CHANNEL_LEASE_ACQUIRE, {
      result: 'db_error',
      tenant_id: scope.tenant_id,
      agent_id: scope.agent_id,
    });
    return { held: false, result: 'db_error', scope, held_by: null, lease_expires_at: null };
  }
}

/**
 * Renova a posse. O fence é parte do `WHERE`, não uma checagem prévia.
 *
 * Um `SELECT` que confere o token e um `UPDATE` que renova seriam dois passos
 * com uma janela entre eles — e é exatamente nessa janela que o takeover
 * acontece. Aqui o token, o dono e o prazo são todos condições do mesmo
 * `UPDATE`: ou as três valem no instante da gravação, ou zero linhas mudam.
 */
export async function heartbeatChannelLease(
  scope: ChannelLeaseScope,
  fencing_token: number,
  opts: { ttlMs?: number; ownerInstanceId?: string } = {},
): Promise<ChannelLeaseHeartbeatResult> {
  assertEscopo(scope);
  const ttl = opts.ttlMs ?? CHANNEL_LEASE_TTL_MS;
  assertChannelLeaseTtl(ttl);
  const dono = opts.ownerInstanceId ?? channelOwnerInstanceId();

  try {
    const res = await db.execute(sql`
      UPDATE channel_session_leases
         SET heartbeat_at = now(),
             lease_expires_at = now() + make_interval(secs => ${ttl / 1000}),
             updated_at = now()
       WHERE channel_id = ${scope.channel_id}::uuid
         AND owner_instance_id = ${dono}
         AND fencing_token = ${fencing_token}
         AND status = 'active'
         AND lease_expires_at > now()
      RETURNING fencing_token
    `);
    if ((res.rowCount ?? 0) > 0) {
      incCounter(METRIC.CHANNEL_LEASE_HEARTBEAT, {
        result: 'renewed',
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
      });
      return 'renewed';
    }

    // Zero linhas. A renovação falhou, e o processo já sabe que perdeu a posse
    // — o diagnóstico abaixo serve só para NOMEAR a perda ao operador, e é lido
    // depois da decisão, nunca antes dela.
    const motivo = await diagnosticarPerda(scope, fencing_token, dono);
    incCounter(METRIC.CHANNEL_LEASE_HEARTBEAT, {
      result: motivo,
      tenant_id: scope.tenant_id,
      agent_id: scope.agent_id,
    });
    if (motivo === 'fence_rejected') {
      incCounter(METRIC.CHANNEL_FENCE_REJECTED, {
        operation: 'heartbeat',
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
      });
    }
    logger.warn(
      { channel_id: scope.channel_id, owner_instance_id: dono, fencing_token, motivo },
      'channel_lease.heartbeat_lost',
    );
    return motivo;
  } catch (err) {
    logger.error({ err, channel_id: scope.channel_id }, 'channel_lease.heartbeat_failed');
    incCounter(METRIC.CHANNEL_LEASE_HEARTBEAT, {
      result: 'db_error',
      tenant_id: scope.tenant_id,
      agent_id: scope.agent_id,
    });
    // Fail-closed: não conseguir CONFIRMAR a posse é perdê-la. A issue é
    // explícita ("Falha de DB/heartbeat impede novos envios"), e a razão é que
    // o outro lado da partição pode já ter tomado a linha.
    return 'db_error';
  }
}

/** Por que a renovação não pegou. Puramente diagnóstico — ver o call site. */
async function diagnosticarPerda(
  scope: ChannelLeaseScope,
  fencing_token: number,
  dono: string,
): Promise<Extract<ChannelLeaseHeartbeatResult, 'fence_rejected' | 'expired' | 'not_owner'>> {
  const res = await db.execute<LinhaLease>(sql`
    SELECT owner_instance_id, fencing_token, status, lease_expires_at
      FROM channel_session_leases
     WHERE channel_id = ${scope.channel_id}::uuid
  `);
  const linha = res.rows[0];
  if (!linha || linha.owner_instance_id !== dono) return 'not_owner';
  if (Number(linha.fencing_token) !== fencing_token) return 'fence_rejected';
  return 'expired';
}

/**
 * Devolve a linha de propósito (shutdown ordenado).
 *
 * `status = 'released'` e NÃO `DELETE`: apagar zeraria o contador e um dono
 * antigo voltando com o token 1 na mão o reapresentaria válido. A linha por
 * canal é permanente; o que muda é o estado.
 *
 * O fence também guarda esta operação — um processo que já perdeu a posse não
 * pode "devolver" a linha do sucessor.
 */
export async function releaseChannelLease(
  scope: ChannelLeaseScope,
  fencing_token: number,
  opts: { ownerInstanceId?: string } = {},
): Promise<boolean> {
  assertEscopo(scope);
  const dono = opts.ownerInstanceId ?? channelOwnerInstanceId();
  try {
    const res = await db.execute(sql`
      UPDATE channel_session_leases
         SET status = 'released', updated_at = now()
       WHERE channel_id = ${scope.channel_id}::uuid
         AND owner_instance_id = ${dono}
         AND fencing_token = ${fencing_token}
         AND status = 'active'
      RETURNING channel_id
    `);
    const ok = (res.rowCount ?? 0) > 0;
    if (!ok) {
      incCounter(METRIC.CHANNEL_FENCE_REJECTED, {
        operation: 'release',
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
      });
    } else {
      incCounter(METRIC.CHANNEL_LEASE_TAKEOVER, {
        reason: 'released_by_owner',
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
      });
    }
    return ok;
  } catch (err) {
    logger.error({ err, channel_id: scope.channel_id }, 'channel_lease.release_failed');
    return false;
  }
}

/**
 * "Eu ainda sou o dono, AGORA?" — a pergunta feita imediatamente antes de um
 * envio.
 *
 * A issue pede isto explicitamente ("Outbound valida token imediatamente antes
 * de enviar") e diz por quê: não basta conferir o token DEPOIS de enviar, já
 * que a mensagem duplicada já saiu. E ressalva o limite honesto — o WhatsApp
 * não conhece fence, então esta checagem estreita a janela, não a elimina. O
 * que a fecha de verdade é fechar o socket ao perder a posse (fatia B).
 */
export async function assertChannelFence(
  scope: ChannelLeaseScope,
  fencing_token: number,
  operation: ChannelFenceOperation = 'send',
  opts: { ownerInstanceId?: string } = {},
): Promise<boolean> {
  assertEscopo(scope);
  const dono = opts.ownerInstanceId ?? channelOwnerInstanceId();
  try {
    const res = await db.execute(sql`
      SELECT 1
        FROM channel_session_leases
       WHERE channel_id = ${scope.channel_id}::uuid
         AND owner_instance_id = ${dono}
         AND fencing_token = ${fencing_token}
         AND status = 'active'
         AND lease_expires_at > now()
    `);
    const ok = (res.rowCount ?? 0) > 0;
    if (!ok) {
      incCounter(METRIC.CHANNEL_FENCE_REJECTED, {
        operation,
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
      });
    }
    return ok;
  } catch (err) {
    // Fail-closed, e este é o caso mais importante dos três: não conseguir
    // provar a posse é NÃO ter posse. Devolver `true` aqui autorizaria um envio
    // sob dúvida, que é a duplicata que a issue existe para impedir.
    logger.error({ err, channel_id: scope.channel_id }, 'channel_lease.fence_check_failed');
    incCounter(METRIC.CHANNEL_FENCE_REJECTED, {
      operation,
      tenant_id: scope.tenant_id,
      agent_id: scope.agent_id,
    });
    return false;
  }
}

/**
 * Varredura CROSS-TENANT de leases órfãs — a pergunta do operador da
 * instalação, não de um tenant ("quais linhas ficaram sem dono?").
 *
 * É lida FORA de contexto de tenant de propósito, como a varredura de lease
 * vencida de turnos (114) e a de takeover do outbound (131): um dono que morreu
 * não deixa ninguém para perguntar em nome dele. Cada linha devolvida carrega
 * seu tenant/agente, então quem age sobre ela reentra no escopo certo.
 */
export async function listarLeasesOrfas(limite = 100): Promise<
  ReadonlyArray<{
    channel_id: string;
    tenant_id: string;
    agent_id: string;
    owner_instance_id: string;
    fencing_token: number;
    lease_expires_at: Date;
  }>
> {
  const res = await db.execute<LinhaLease>(sql`
    SELECT channel_id, tenant_id, agent_id, owner_instance_id, fencing_token, lease_expires_at
      FROM channel_session_leases
     WHERE status = 'active'
       AND lease_expires_at <= now()
     ORDER BY lease_expires_at ASC
     LIMIT ${limite}
  `);
  return res.rows.map((r) => ({
    channel_id: r.channel_id,
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    owner_instance_id: r.owner_instance_id,
    fencing_token: Number(r.fencing_token),
    lease_expires_at: paraData(r.lease_expires_at),
  }));
}
