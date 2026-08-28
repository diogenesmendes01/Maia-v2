/**
 * Issue #513 (fatia A) — POSSE EXCLUSIVA de uma sessão de canal, decidida pelo
 * PostgreSQL.
 *
 * O que este módulo fecha. `line-session-manager.ts` diz, na abertura:
 * "Topologia v1: in-process (N sockets)". A posse de uma linha vive num `Map`
 * local, e `startAdditionalLineSessions()` enumera TODAS as linhas ativas e as
 * abre, sem reivindicar nada de ninguém. Com uma réplica isso está certo por
 * ausência de adversário; com duas, ambas abrem o mesmo socket e escrevem no
 * mesmo auth state.
 *
 * POR QUE A POSSE MORA EM `channel_line_state`, e não numa tabela própria. A
 * migration 103 já guarda `session_owner_instance` +
 * `session_owner_lease_expires_at`, com um escritor vivo (o worker de pairing)
 * e um consumidor vivo (o endereçamento de `disable`/`repair` à réplica que
 * segura o socket). Uma tabela nova daria DOIS donos declarados do mesmo fato,
 * e eles divergiriam: o registro de posse anterior (`renewSessionLeases`) era
 * last-writer-wins por desenho declarado ("Não usa CAS por dono"), então a
 * réplica B se carimbaria como dona enquanto A segurasse a lease — e o comando
 * de `disable` voltaria a ser consumido pela réplica ERRADA, que é o P1 que a
 * review da PR #528 fechou. Hoje este módulo é o ÚNICO caminho de posse.
 *
 * O que faltava não era uma tabela: era o FENCE.
 *
 * Divisão de trabalho (a mesma de #504, de propósito):
 *   - AQUI ficam o vocabulário e os statements ATÔMICOS. Nada de timers, nada
 *     de sockets, nada de decidir se uma linha DEVE ser aberta.
 *   - Quem liga o heartbeat, fecha o socket ao perder a posse e reage ao
 *     takeover é a fatia B (`session-owner`), que consome estas funções.
 *
 * As três regras que o resto do sistema pode assumir:
 *
 *   1. **No máximo um dono por canal, sempre.** Não porque o código tome
 *      cuidado, mas porque `channel_id` é a PK de `channel_line_state`: não
 *      existe forma de gravar uma segunda posse da mesma linha, nem sob
 *      concorrência.
 *   2. **O fence só sobe.** `session_fencing_token` é incrementado a cada nova
 *      posse, e a row nunca é apagada (não há um só `DELETE` de
 *      `channel_line_state` no código), então um dono antigo que volta de uma
 *      partição traz um token estritamente menor que o corrente — e toda
 *      gravação fenced o recusa.
 *   3. **O relógio é o do banco.** Todo prazo é `now()` do PostgreSQL. Uma
 *      réplica com o relógio adiantado não consegue declarar vencida uma lease
 *      viva, porque a decisão não é dela.
 *
 * O que um fence NÃO resolve, e a issue diz isso explicitamente: o WhatsApp não
 * conhece fencing token. O banco pode recusar as gravações do dono antigo e
 * ainda assim o socket dele estar aberto. Por isso a regra da fatia B é FECHAR
 * ao perder a posse, e não apenas conferir o token depois de enviar.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  SESSION_LEASE_MS,
  fenceOnUpsert,
  sessionOwnershipClaimable,
} from '@/db/repositories/channel-line-state-repos.js';
import { logger } from '@/lib/logger.js';
import { incCounter } from '@/lib/metrics.js';
import { METRIC } from '@/observability/taxonomy.js';
import { runtimeInstanceId } from '@/runtime/instance-identity.js';

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

/**
 * Prazo default de uma posse. IMPORTADO, não declarado aqui: a definição vive
 * junto da coluna que ele governa (`SESSION_LEASE_MS` em
 * `channel-line-state-repos.ts`), e dois números para o mesmo prazo brigariam —
 * um caminho renovaria para 30s, o outro para 60s, e qual vale dependeria de
 * quem escreveu por último.
 */
export const CHANNEL_LEASE_TTL_MS = SESSION_LEASE_MS;

/**
 * Identidade DESTE processo como dono.
 *
 * É `runtimeInstanceId()` — `<hostname>:<pid>` —, a MESMA que o resto da casa
 * já usa para posse, e não uma identidade nova. Isso não é economia de código:
 * uma segunda identidade faria `acquireChannelLease` gravar um dono que
 * `releaseSessionOwnership(runtimeInstanceId(), ...)` nunca reconheceria, e o
 * shutdown ordenado passaria a deixar TODAS as linhas presas até a lease
 * vencer. Duas representações do mesmo fato divergem; aqui o fato é "qual
 * processo é este".
 *
 * Ela muda a cada restart de propósito (o pid muda), que é exatamente como uma
 * posse órfã se torna reconhecível.
 */
export function channelOwnerInstanceId(): string {
  return runtimeInstanceId();
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

/**
 * A row crua. `timestamptz` e `bigint` chegam como STRING neste caminho:
 * `db.execute` é SQL cru e não passa pelos parsers de coluna do Drizzle. O tipo
 * é honesto sobre as duas formas e tudo que sai daqui é normalizado.
 */
type LinhaPosse = {
  channel_id: string;
  session_owner_instance: string | null;
  session_fencing_token: string | number;
  session_owner_lease_expires_at: Date | string | null;
};

/** Normaliza o que o driver devolveu para `Date`, seja qual for a forma. */
function paraData(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

// ── Guardas ──────────────────────────────────────────────────────────────────

/**
 * O TTL tem piso e teto, e os dois têm motivo.
 *
 * O piso existe porque uma lease mais curta que o intervalo realista de
 * renovação produz takeover FALSO: o dono vivo perde a linha porque não teve
 * tempo de bater. O teto existe porque a lease é o tempo MÁXIMO que uma linha
 * fica indisponível depois de a réplica dona morrer sem devolver — e a issue
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
  // Espelha o CHECK de tenant/agente de `channel_line_state`. O banco é a
  // última linha; esta é a primeira, e nomeia o campo em vez de devolver um
  // 23514 opaco.
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
 * Adquire — ou renova — a posse de um canal, em UM statement.
 *
 * A atomicidade é o ponto inteiro. `INSERT ... ON CONFLICT DO UPDATE ... WHERE`
 * é avaliado sob o lock da row em conflito, então duas réplicas que chamam isto
 * no mesmo instante são serializadas pelo PostgreSQL: uma satisfaz o `WHERE` e
 * recebe a row no `RETURNING`, a outra não satisfaz e recebe ZERO rows. Não
 * existe janela entre "olhei" e "peguei" porque não há dois passos.
 *
 * O `WHERE` autoriza a tomada em exatamente três situações:
 *   - a posse está LIVRE (`session_owner_instance IS NULL`) — ninguém a tem, ou
 *     o dono anterior a devolveu num shutdown ordenado;
 *   - a lease VENCEU — o dono sumiu sem devolver;
 *   - sou EU — é uma renovação, não uma tomada.
 *
 * `session_fencing_token` sobe nos dois primeiros casos e NÃO sobe no terceiro:
 * renovar não é uma nova posse, e incrementar ali invalidaria o token que o
 * próprio dono está usando para enviar naquele instante.
 *
 * O UPSERT (e não UPDATE) é deliberado, e herdado do registro de posse que
 * existia antes: a row de estado pode ainda não existir — um canal ativado
 * fora do fluxo do console nunca passou por `requestCommand`. Como UPDATE
 * puro, a escrita não pegaria nada, a posse ficaria NULL em silêncio, e o
 * `disable` voltaria a ser endereçado à réplica errada.
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
    const res = await db.execute<LinhaPosse & { token_antes: string | number | null }>(sql`
      -- O CTE le' o estado ANTERIOR para poder ROTULAR a posse (renovacao vs
      -- tomada). Ele NAO decide nada: a decisao inteira esta' no WHERE do ON
      -- CONFLICT, avaliado sob o lock da row. O snapshot do CTE e' o do
      -- statement, entao sob concorrencia real ele pode estar
      -- microssegundos velho -- e o pior efeito possivel disso e' um rotulo de
      -- METRICA trocado, nunca uma posse concedida a quem nao a tem.
      WITH antes AS (
        SELECT session_fencing_token AS token_antes
          FROM channel_line_state
         WHERE channel_id = ${scope.channel_id}::uuid
      )
      INSERT INTO channel_line_state
        (channel_id, tenant_id, agent_id,
         session_owner_instance, session_fencing_token, session_owner_lease_expires_at,
         updated_at)
      VALUES
        (${scope.channel_id}::uuid, ${scope.tenant_id}, ${scope.agent_id},
         ${dono}, 1, now() + make_interval(secs => ${ttlSegundos}),
         now())
      ON CONFLICT (channel_id) DO UPDATE SET
        session_owner_instance = EXCLUDED.session_owner_instance,
        -- As duas regras vem do REPO, declaradas uma unica vez: renovacao
        -- preserva o token, posse nova incrementa; e so' e' tomavel o que esta'
        -- livre, vencido ou ja' e' meu. Duas copias divergiriam na primeira vez
        -- que alguem ajustasse uma delas, e o sintoma seria duas replicas donas
        -- da mesma linha.
        session_fencing_token = ${fenceOnUpsert(dono)},
        session_owner_lease_expires_at = EXCLUDED.session_owner_lease_expires_at,
        updated_at = now()
      WHERE ${sessionOwnershipClaimable(dono)}
      RETURNING
        channel_line_state.channel_id,
        channel_line_state.session_owner_instance,
        channel_line_state.session_fencing_token,
        channel_line_state.session_owner_lease_expires_at,
        (SELECT token_antes FROM antes) AS token_antes
    `);

    const linha = res.rows[0];
    if (!linha) {
      // Zero rows = o `WHERE` não passou = a posse é de outro e está viva.
      // Só AQUI se faz a segunda leitura, e ela é puramente informativa (para o
      // log do operador): a decisão — não sou o dono — já está tomada.
      const atual = await db.execute<LinhaPosse>(sql`
        SELECT session_owner_instance, session_owner_lease_expires_at
          FROM channel_line_state
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
        held_by: dela?.session_owner_instance ?? null,
        lease_expires_at: dela?.session_owner_lease_expires_at
          ? paraData(dela.session_owner_lease_expires_at)
          : null,
      };
    }

    const token = Number(linha.session_fencing_token);
    const result = classificarPosse(
      token,
      linha.token_antes === null || linha.token_antes === undefined
        ? null
        : Number(linha.token_antes),
    );

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
      lease_expires_at: paraData(linha.session_owner_lease_expires_at!),
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
 * Que TIPO de posse foi esta — derivado só do que o banco devolveu.
 *
 * Puro de propósito: é a única aritmética do módulo, e não precisa de Postgres
 * para ser exercida.
 *
 * `tokenAntes` é `null` quando não havia row nenhuma — a linha nunca teve dono,
 * então é uma aquisição, não uma tomada de ninguém. Quando o token NÃO mudou, o
 * `CASE` do UPSERT escolheu o ramo "sou eu, com lease viva": renovação. Quando
 * subiu, a posse recomeçou — e só é `taken_over` se havia mesmo um dono antes
 * (token > 0); um `0 -> 1` é a primeira posse de uma row que existia por outro
 * motivo (o pairing cria a row antes de qualquer socket).
 */
export function classificarPosse(
  token: number,
  tokenAntes: number | null,
): ChannelLeaseHeld['result'] {
  if (tokenAntes === null) return 'acquired';
  if (token === tokenAntes) return 'renewed';
  return tokenAntes > 0 ? 'taken_over' : 'acquired';
}

/**
 * Renova a posse. O fence é parte do `WHERE`, não uma checagem prévia.
 *
 * Um `SELECT` que confere o token e um `UPDATE` que renova seriam dois passos
 * com uma janela entre eles — e é exatamente nessa janela que o takeover
 * acontece. Aqui token, dono e prazo são condições do mesmo `UPDATE`: ou as
 * três valem no instante da gravação, ou zero rows mudam.
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
      UPDATE channel_line_state
         SET session_owner_lease_expires_at = now() + make_interval(secs => ${ttl / 1000}),
             updated_at = now()
       WHERE channel_id = ${scope.channel_id}::uuid
         AND session_owner_instance = ${dono}
         AND session_fencing_token = ${fencing_token}
         AND session_owner_lease_expires_at > now()
      RETURNING session_fencing_token
    `);
    if ((res.rowCount ?? 0) > 0) {
      incCounter(METRIC.CHANNEL_LEASE_HEARTBEAT, {
        result: 'renewed',
        tenant_id: scope.tenant_id,
        agent_id: scope.agent_id,
      });
      return 'renewed';
    }

    // Zero rows. A renovação falhou, e o processo já sabe que perdeu a posse —
    // o diagnóstico abaixo serve só para NOMEAR a perda ao operador, e é lido
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
  const res = await db.execute<LinhaPosse>(sql`
    SELECT session_owner_instance, session_fencing_token, session_owner_lease_expires_at
      FROM channel_line_state
     WHERE channel_id = ${scope.channel_id}::uuid
  `);
  const linha = res.rows[0];
  if (!linha || linha.session_owner_instance !== dono) return 'not_owner';
  if (Number(linha.session_fencing_token) !== fencing_token) return 'fence_rejected';
  return 'expired';
}

/**
 * Devolve a linha de propósito (shutdown ordenado).
 *
 * Zera o DONO e o prazo — nunca o TOKEN. Se zerasse, a próxima posse
 * recomeçaria em 1 e um dono antigo, voltando de uma partição com o token
 * velho na mão, o reapresentaria válido.
 *
 * O fence também guarda esta operação: um processo que já perdeu a posse não
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
      UPDATE channel_line_state
         SET session_owner_instance = NULL,
             session_owner_lease_expires_at = NULL,
             updated_at = now()
       WHERE channel_id = ${scope.channel_id}::uuid
         AND session_owner_instance = ${dono}
         AND session_fencing_token = ${fencing_token}
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
 * não conhece fence, então esta checagem ESTREITA a janela, não a elimina. O
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
        FROM channel_line_state
       WHERE channel_id = ${scope.channel_id}::uuid
         AND session_owner_instance = ${dono}
         AND session_fencing_token = ${fencing_token}
         AND session_owner_lease_expires_at > now()
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
 * Varredura CROSS-TENANT de posses órfãs — a pergunta do operador da
 * instalação, não de um tenant ("quais linhas ficaram sem dono vivo?").
 *
 * É lida FORA de contexto de tenant de propósito, como a varredura de lease
 * vencida de turnos (114) e a de takeover do outbound (131): um dono que morreu
 * não deixa ninguém para perguntar em nome dele. Cada row devolvida carrega seu
 * tenant/agente, então quem age sobre ela reentra no escopo certo.
 */
export async function listarPossesOrfas(limite = 100): Promise<
  ReadonlyArray<{
    channel_id: string;
    tenant_id: string;
    agent_id: string;
    owner_instance_id: string;
    fencing_token: number;
    lease_expires_at: Date;
  }>
> {
  const res = await db.execute<{
    channel_id: string;
    tenant_id: string;
    agent_id: string;
    session_owner_instance: string;
    session_fencing_token: string | number;
    session_owner_lease_expires_at: Date | string;
  }>(sql`
    SELECT channel_id, tenant_id, agent_id,
           session_owner_instance, session_fencing_token, session_owner_lease_expires_at
      FROM channel_line_state
     WHERE session_owner_instance IS NOT NULL
       AND session_owner_lease_expires_at <= now()
     ORDER BY session_owner_lease_expires_at ASC
     LIMIT ${limite}
  `);
  return res.rows.map((r) => ({
    channel_id: r.channel_id,
    tenant_id: r.tenant_id,
    agent_id: r.agent_id,
    owner_instance_id: r.session_owner_instance,
    fencing_token: Number(r.session_fencing_token),
    lease_expires_at: paraData(r.session_owner_lease_expires_at),
  }));
}
