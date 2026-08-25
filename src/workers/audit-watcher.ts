import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { audit_log } from '@/db/schema.js';
import type { AuditAction } from '@/governance/audit-actions.js';
import { REPLICA_METADATA_KEY } from '@/lib/llm/circuit-audit.js';
import { sendAlert } from '@/lib/alerts.js';
import { logger } from '@/lib/logger.js';
import { runWithSystemContext } from '@/db/tenant-context.js';

/**
 * Audit-driven anomaly watcher. Runs every minute via the worker registry
 * (see src/workers/index.ts). Reads from `audit_log` and emits alerts via
 * `sendAlert` when a rule trips. Throttled to 30 min per rule to avoid spam.
 *
 * Two rule shapes:
 *  - ThresholdRule: count of `acao` in the last `window_min` minutes >= threshold
 *  - StuckRule: an `acao` (within last 24h) emitted more than `window_min`
 *    minutes ago with no matching `mate_acao` after it FOR THE SAME INSTANCE —
 *    see `correlate_by`.
 *
 * Throttle is in-memory (Map). Process restart resets it — acceptable: the
 * next tick will re-detect and re-alert if the condition is still true.
 */
type Severity = 'critical' | 'urgent' | 'info';

type ThresholdRule = {
  kind: 'threshold';
  id: string;
  acao: AuditAction;
  threshold: number;
  window_min: number;
  severity: Severity;
};

type StuckRule = {
  kind: 'stuck';
  id: string;
  acao: AuditAction;
  mate_acao: AuditAction;
  window_min: number;
  severity: Severity;
  /**
   * Chaves de `audit_log.metadata` (JSONB) que identificam a INSTÂNCIA do par
   * `acao`/`mate_acao` — achado 4 da re-review do owner na PR #541.
   *
   * Sem elas a regra casa QUALQUER `mate_acao` posterior com QUALQUER `acao`,
   * o que só é correto quando o evento é um singleton global. Quando não é —
   * e nenhum dos dois casos aqui é —, um par que abriu e fechou normalmente
   * desarma o alerta de outro que continua preso: a regra fica cega
   * exatamente no cenário que existe para pegar.
   *
   * OBRIGATÓRIO, e `[]` é uma resposta válida (declara "isto É singleton").
   * Campo opcional viraria o default silencioso errado: quem adicionasse uma
   * regra nova herdaria a correlação cruzada sem escolher nada.
   *
   * Os valores viram identificador legível no corpo do alerta, na ordem em
   * que aparecem aqui. Cada chave é validada contra `IDENTIFIER_RE` antes de
   * entrar na SQL.
   */
  correlate_by: readonly string[];
};

type Rule = ThresholdRule | StuckRule;

const RULES: Rule[] = [
  // 3+ token-mismatch responses in 5 min — someone is farming the bootstrap
  // token. Critical because successful guess === full /setup access.
  {
    kind: 'threshold',
    id: 'setup_unauthorized_farm',
    acao: 'setup_unauthorized_access',
    threshold: 3,
    window_min: 5,
    severity: 'critical',
  },
  // NOTE: a setup_csrf_attack rule (acao: 'setup_csrf_mismatch') is the
  // natural twin of the rule above and was prototyped here, but the
  // `setup_csrf_mismatch` action is introduced on `chore/setup-hardening`,
  // not on main. To keep this PR mergeable directly against main without a
  // born-dead rule, the CSRF rule will be added in the same PR that ships
  // the action emission.
  // Recovery started but not completed within 1 min — recovery normally
  // takes ~3 s, anything over a minute means the rm/rotateToken/sendAlert
  // chain is wedged and operator must SSH.
  {
    kind: 'stuck',
    id: 'pairing_recovery_stuck',
    acao: 'pairing_recovery_started',
    mate_acao: 'pairing_recovery_completed',
    window_min: 1,
    severity: 'urgent',
    // `src/setup/recovery.ts` audita os dois com `metadata.target`
    // (`'primary'` ou o id do canal) e recuperações de alvos diferentes
    // correm em paralelo (`_state.recoveries` é um Map por alvo). Sem esta
    // chave, a recuperação de uma linha que termina desarma o alerta da
    // primária que ficou pendurada.
    correlate_by: ['target'],
  },
  // LLM circuit open for >5 min — the breaker auto-resets after a window;
  // 5+ min without a `closed` event means the upstream is down at length.
  {
    kind: 'stuck',
    id: 'llm_circuit_long_open',
    acao: 'llm_circuit_opened',
    mate_acao: 'llm_circuit_closed',
    window_min: 5,
    severity: 'urgent',
    /**
     * O estado do disjuntor é por `(provider, workload)` — `keyOf` em
     * `src/lib/llm/circuit-breaker.ts` — e, além disso, por RÉPLICA: a janela
     * deslizante de amostras vive na memória de cada processo e nada a
     * compartilha. Duas réplicas podem, ao mesmo tempo, discordar sobre o
     * mesmo par, e as duas estão certas sobre o que enxergam.
     *
     * As três chaves são gravadas por `src/lib/llm/circuit-audit.ts`;
     * `replica` é `REPLICA_METADATA_KEY` de lá, importada e não redigitada
     * justamente para que renomear a chave no produtor quebre o typecheck em
     * vez de cegar o alerta em silêncio.
     */
    correlate_by: ['provider', 'workload', REPLICA_METADATA_KEY],
  },
  /**
   * UMA recusa do guarda de locator já é sinal (issue #536).
   *
   * O caminho feliz da varredura do TTL não produz esta ação NENHUMA vez: um
   * locator recusado significa que `privacy_requests.export_locator` carrega
   * algo que não é um artefato desta árvore — escrita defeituosa, restore
   * torto, ou linha plantada. Threshold 1, e não 3: agrupar por volume um
   * evento cuja taxa normal é zero esconderia o primeiro, que é justamente o
   * que importa. O throttle de 30 min já impede que uma varredura com muitas
   * recusas vire uma enxurrada de alertas.
   *
   * `urgent` e não `critical`: nada foi apagado (o guarda recusou ANTES da
   * remoção), então não há dano consumado — há uma linha de banco a
   * investigar antes que alguém a "conserte" no braço.
   */
  {
    kind: 'threshold',
    id: 'privacy_export_locator_refused',
    acao: 'privacy_export_purge_refused',
    threshold: 1,
    window_min: 60,
    severity: 'urgent',
  },
  // 3+ anomalous-volume blocks in 1 h — multiple bots within an hour.
  {
    kind: 'threshold',
    id: 'bot_volume_burst',
    acao: 'auto_blocked_anomalous_volume',
    threshold: 3,
    window_min: 60,
    severity: 'info',
  },
];

const THROTTLE_MS = 30 * 60 * 1000;
const lastAlertedAt = new Map<string, number>();

async function checkThreshold(rule: ThresholdRule): Promise<void> {
  const cutoff = new Date(Date.now() - rule.window_min * 60_000);
  const r = await db.execute<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c FROM ${audit_log}
    WHERE acao = ${rule.acao} AND created_at > ${cutoff}
  `);
  const count = (r.rows[0]?.c as number | undefined) ?? 0;
  if (count >= rule.threshold) {
    await maybeAlert(
      rule,
      `${count} \`${rule.acao}\` events in the last ${rule.window_min} min (threshold ${rule.threshold}).`,
    );
  }
}

/**
 * Chave de metadado aceita numa SQL literal. `correlate_by` só recebe
 * constantes deste arquivo, mas a chave entra na consulta como LITERAL (e não
 * como parâmetro) por uma razão técnica: `metadata->>$1` deixa o Postgres sem
 * tipo para resolver o operador `->>`, e a consulta estoura em runtime — que
 * neste worker vira um `audit_watcher.check_failed` no log e um alerta que
 * silenciosamente nunca dispara. O gate abaixo é o que mantém "literal" e
 * "seguro" compatíveis.
 */
const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

function metadataKey(alias: string, key: string): SQL {
  if (!IDENTIFIER_RE.test(key)) {
    throw new Error(`audit_watcher: chave de correlação inválida: ${JSON.stringify(key)}`);
  }
  return sql.raw(`${alias}.metadata->>'${key}'`);
}

/**
 * Predicado que amarra o `mate_acao` (b) à MESMA instância do `acao` (a).
 *
 * `IS NOT DISTINCT FROM` e não `=`: uma chave ausente nos dois lados é NULL, e
 * com `=` a comparação daria NULL (nem verdadeiro nem falso), o `NOT EXISTS`
 * passaria a valer sempre e a regra alertaria para TODA linha antiga. Falhar
 * para o lado do alarme falso permanente é tão ruim quanto falhar para o lado
 * do silêncio.
 */
function correlationPredicate(rule: StuckRule): SQL {
  if (rule.correlate_by.length === 0) return sql``;
  return sql.join(
    rule.correlate_by.map(
      (k) => sql` AND ${metadataKey('b', k)} IS NOT DISTINCT FROM ${metadataKey('a', k)}`,
    ),
    sql``,
  );
}

/** Identidade legível da instância, para o corpo do alerta. */
function identityExpr(rule: StuckRule): SQL {
  if (rule.correlate_by.length === 0) return sql`'(global)'`;
  return sql.join(
    rule.correlate_by.map((k) => sql`COALESCE(${metadataKey('a', k)}, '?')`),
    sql` || '/' || `,
  );
}

type StuckGroup = { identity: string; n: number; oldest: Date | string | null };

/**
 * O carimbo do grupo, ou `unknown`. Defensivo de propósito: `new Date(x)` com
 * `x` nulo ou fora de forma devolve Invalid Date e `.toISOString()` LANÇA. Aqui
 * dentro, lançar significa perder o alerta inteiro — o `catch` de
 * `runAuditWatcher` engoliria a regra como `check_failed`, e o plantão veria
 * silêncio no lugar de um circuito preso. Formatação nunca pode custar o
 * alerta que ela formata.
 */
function isoOrUnknown(v: Date | string | null): string {
  if (v == null) return 'unknown';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString();
}

async function checkStuck(rule: StuckRule): Promise<void> {
  const olderThan = new Date(Date.now() - rule.window_min * 60_000);
  // Agrupado por identidade, e não `COUNT(*)` cru: um disjuntor preso reabre a
  // cada janela de sonda que falha (`half_open` → `open`, cooldown de até 60 s),
  // então a mesma indisponibilidade produz dezenas de aberturas sem par. Contar
  // LINHAS diria "47 eventos presos" para UM circuito; contar identidades diz
  // quantos circuitos estão presos, que é a pergunta do plantão.
  const r = await db.execute<StuckGroup>(sql`
    SELECT ${identityExpr(rule)} AS identity,
           COUNT(*)::int AS n,
           MIN(a.created_at) AS oldest
      FROM ${audit_log} a
     WHERE a.acao = ${rule.acao}
       AND a.created_at < ${olderThan}
       AND a.created_at > NOW() - INTERVAL '1 day'
       AND NOT EXISTS (
         SELECT 1 FROM ${audit_log} b
          WHERE b.acao = ${rule.mate_acao}
            AND b.created_at >= a.created_at${correlationPredicate(rule)}
       )
     GROUP BY 1
     ORDER BY MIN(a.created_at) ASC
     LIMIT 20
  `);
  const groups = r.rows ?? [];
  if (groups.length === 0) return;

  // O corpo NOMEIA quem está preso. Antes ele dizia só "N eventos", e o
  // plantão abria o alerta sem saber qual provider/workload/réplica olhar.
  const shape = rule.correlate_by.length > 0 ? rule.correlate_by.join('/') : 'global';
  const lines = groups
    .map((g) => `  - ${g.identity} (${g.n} event(s), oldest ${isoOrUnknown(g.oldest)})`)
    .join('\n');
  await maybeAlert(
    rule,
    `${groups.length} instance(s) with \`${rule.acao}\` older than ${rule.window_min} min ` +
      `and no matching \`${rule.mate_acao}\`.\nIdentity is \`${shape}\`:\n${lines}`,
  );
}

async function maybeAlert(rule: Rule, detail: string): Promise<void> {
  const last = lastAlertedAt.get(rule.id) ?? 0;
  if (Date.now() - last < THROTTLE_MS) {
    logger.debug(
      { rule: rule.id, throttle_remaining_s: Math.round((THROTTLE_MS - (Date.now() - last)) / 1000) },
      'audit_watcher.throttled',
    );
    return;
  }
  lastAlertedAt.set(rule.id, Date.now());
  const subject = `[${rule.severity.toUpperCase()}] audit_watcher: ${rule.id}`;
  const body = `Audit watcher rule "${rule.id}" tripped.\n\n${detail}\n\nReview the audit log around the indicated window.`;
  await sendAlert({ subject, body }).catch((err) =>
    logger.warn(
      { err: (err as Error).message, rule: rule.id },
      'audit_watcher.alert_send_failed',
    ),
  );
  logger.warn({ rule: rule.id, severity: rule.severity, detail }, 'audit_watcher.alerted');
}

export async function runAuditWatcher(): Promise<void> {
  // Genuinely-GLOBAL maintenance (issue #323 phase 2): every rule query
  // aggregates `audit_log` filtered ONLY by `acao` + `created_at` (no
  // tenant_id/agent_id predicate), so it is a cross-tenant anomaly watcher by
  // design — the rows it reads are identical under any context. Re-homed from
  // the legacy `default/default` literal to the reserved `system` sentinel.
  await runWithSystemContext(async () => {
    for (const rule of RULES) {
      try {
        if (rule.kind === 'threshold') await checkThreshold(rule);
        else await checkStuck(rule);
      } catch (err) {
        logger.error(
          { err: (err as Error).message, rule: rule.id },
          'audit_watcher.check_failed',
        );
      }
    }
  });
}

/** Test-only export so unit tests can read/clear the throttle map. */
export const _internal = { lastAlertedAt, RULES };
