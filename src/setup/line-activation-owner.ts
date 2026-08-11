/**
 * Re-review do PR #541, achado 1 [High] — QUEM é o dono da ATIVAÇÃO de uma
 * linha cuja posse acabou de ser provada.
 *
 * O pareamento de #518 e a saga de onboarding (#519) provam a mesma coisa
 * (a linha declarada é mesmo esta) mas respondem a governanças diferentes:
 *
 *   - FORA do onboarding (`/setup` legado, console Admin), provar posse é o
 *     último passo que faltava: o backend revalida a readiness da LINHA
 *     (`line-readiness.ts`) e ativa. Esse caminho continua exatamente como
 *     estava.
 *
 *   - DENTRO do onboarding, provar posse é o passo `start_pairing` — o sétimo
 *     de onze. Depois dele ainda vêm `confirm_channel_ready`,
 *     `evaluate_readiness` e `activate`, e é `activate` que revalida schema,
 *     grants, packs, governance e o conjunto EXATO de canais ativáveis sob os
 *     locks da run. Ativar o canal no fim do pareamento ANTECIPAVA o veredito
 *     dessa revalidação: `channels.active = true` com a run ainda em
 *     `pairing_pending`/`channel_ready` e `agents.status = 'provisioning'`.
 *     Como o resolver de canal confia em `channels.active`, entrava TRÁFEGO
 *     REAL num agente que a saga ainda não deixou operar.
 *
 * A regra, então: enquanto existir uma run de onboarding VIVA para o
 * (tenant, agente), a ativação do canal é DELA. O pareamento verifica posse,
 * deixa a linha em `verified_offline` e para aí.
 *
 * ─── Por que "run viva" e não `agents.status` ────────────────────────────────
 * `agents.status = 'provisioning'` é consequência, não causa: ele descreve o
 * agente, e a decisão de que precisamos é sobre QUEM manda na ativação. Uma run
 * viva é a existência do processo de governança que reivindica essa decisão —
 * é ela que termina em `activate`. Estados TERMINAIS (`active`, `cancelled`,
 * `failed_terminal`) não reivindicam nada: a run acabou e o pareamento volta a
 * ser o dono — que é exatamente o caminho de RECOVERY de uma linha de um agente
 * já ativo (#518), o caso que não pode quebrar.
 *
 * `readiness_failed` e `failed_retryable` são deliberadamente NÃO-terminais: a
 * run pode ser retomada e ainda vai passar por `activate`. Ativar por fora
 * enquanto ela existe é o mesmo defeito.
 *
 * ─── Fail-closed ─────────────────────────────────────────────────────────────
 * Este módulo não engole erro. Se a consulta falhar, quem chama NÃO SABE se há
 * uma saga viva — e "não sei" nunca pode virar "pode rotear". O caller trata a
 * exceção como impedimento de ativação (ver `line-readiness.ts`).
 */
import { and, eq, notInArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { onboarding_runs } from '@/db/schema.js';
import { TERMINAL_STATES } from '@/onboarding/state-machine.js';

export type LineActivationOwner =
  /** Ninguém reivindicou: o gate de readiness da linha decide (#518). */
  | { owner: 'line_pairing' }
  /** Uma saga de onboarding viva — só o passo `activate` dela ativa. */
  | { owner: 'onboarding_saga'; run_id: string; run_state: string };

/** Executor injetável só para o teste unitário; produção usa sempre `db`. */
type Executor = Pick<typeof db, 'select'>;

export async function resolveLineActivationOwner(
  scope: { tenant_id: string; agent_id: string },
  executor: Executor = db,
): Promise<LineActivationOwner> {
  const rows = await executor
    .select({ id: onboarding_runs.id, state: onboarding_runs.state })
    .from(onboarding_runs)
    .where(
      and(
        eq(onboarding_runs.tenant_id, scope.tenant_id),
        eq(onboarding_runs.agent_id, scope.agent_id),
        notInArray(onboarding_runs.state, [...TERMINAL_STATES]),
      ),
    )
    .limit(1);

  const live = rows[0];
  if (!live) return { owner: 'line_pairing' };
  return { owner: 'onboarding_saga', run_id: live.id, run_state: live.state };
}
