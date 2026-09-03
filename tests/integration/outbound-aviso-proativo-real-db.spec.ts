/**
 * Issue #506 — o AVISO PROATIVO existe no PostgreSQL antes de existir no
 * telefone. Contra Postgres REAL, entrando pela função de produção.
 *
 * ## O que esta suíte prova, e por que ela precisa de banco
 *
 * Quatro rotas de egresso saíram do inventário de exceções de #634
 * (`workers.briefings`, `workflows.dual_approval`, `workflows.engine`,
 * `tools.approval_notification`) porque pararam de chamar `line.sendText` e
 * passaram a comprometer a saída em `outbox_messages` via
 * `enqueueProactiveNotice`.
 *
 * A suíte unitária (`tests/unit/runtime/outbound-proactive-notice.spec.ts`)
 * prova a FORMA da chamada contra um duplo de repositório. Ela não pode provar
 * as duas propriedades que fazem a migração valer alguma coisa, porque as duas
 * são do PostgreSQL e não do TypeScript:
 *
 *  1. **a linha existe, com a ALS certa.** Um `enqueue` que gravasse sob outro
 *     tenant, ou que violasse um CHECK da 007/090, passaria no unitário e
 *     falharia em produção. O que grava é o repositório real, sob a ALS real;
 *  2. **a idempotência é do BANCO.** `idx_outbox_dedup` é UNIQUE PARCIAL sobre
 *     `dedup_key` (migração 007) e é ele quem recusa o segundo aviso — não um
 *     `if` em JavaScript. Um teste com store em memória que "lembra" as chaves
 *     é a armadilha do espelho: ele fica verde com o índice DERRUBADO.
 *
 * ## Controle, e por que ele não é decoração
 *
 * O caso da dedupe carrega uma chave DIFERENTE no mesmo passe. Sem ele, "o
 * segundo enqueue não criou linha" ficaria verde com o `enqueue` inteiro
 * quebrado, com a ALS errada, ou com a conexão caída. As duas asserções juntas
 * dizem "gravou E discriminou".
 *
 * ## ARMADILHA DO `retry: 1`
 *
 * `vitest.config.ts` tem `retry: 1`. Toda asserção aqui é invariante ABSOLUTA
 * sobre linhas criadas no PRÓPRIO caso (o `beforeEach` apaga as do tenant da
 * sonda), nunca um delta antes×depois sobre estado compartilhado — uma segunda
 * tentativa recomeça do mesmo zero.
 *
 * Pulado sem `TEST_DB_URL` — e `pulado` NÃO é `passou`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

import { runWithTenantContext } from '@/db/tenant-context.js';
import { enqueueProactiveNotice } from '@/runtime/outbound/proactive-notice.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = 't506p';
const AGENT = 'a506p';
/** Segundo agente do MESMO tenant — o controle de isolamento por tupla. */
const AGENT_VIZINHO = 'a506pv';

let pool: pg.Pool;
let canalId: string;

type Linha = {
  id: string;
  tenant_id: string;
  agent_id: string;
  kind: string;
  status: string;
  channel_id: string | null;
  occurrence_id: string | null;
  task_id: string | null;
  dedup_key: string | null;
  attempts: number;
  max_attempts: number;
  payload: { jid?: string; text?: string };
};

async function linhas(agent_id = AGENT): Promise<Linha[]> {
  const { rows } = await pool.query<Linha>(
    `SELECT id, tenant_id, agent_id, kind, status, channel_id, occurrence_id, task_id,
            dedup_key, attempts, max_attempts, payload
       FROM outbox_messages
      WHERE tenant_id = $1 AND agent_id = $2
      ORDER BY created_at ASC`,
    [TENANT, agent_id],
  );
  return rows;
}

d('#506 — o aviso proativo é comprometido no ledger (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 5 });
    const c = await pool.connect();
    try {
      await c.query(
        `INSERT INTO tenants(id, nome) VALUES ($1,'sonda 506 proativo') ON CONFLICT (id) DO NOTHING`,
        [TENANT],
      );
      for (const a of [AGENT, AGENT_VIZINHO]) {
        await c.query(
          `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,'sonda 506 proativo')
           ON CONFLICT (id) DO NOTHING`,
          [a, TENANT],
        );
      }
      // Canal ÚNICO ativo por agente: é o que `resolveOutboxChannelId` procura
      // quando o chamador não passa canal (proativo sem conversa). Dois canais
      // ativos fariam o enqueue lançar `channel_ambiguous`, que é o
      // comportamento fail-closed correto e não o que estes casos medem.
      const ch = await c.query<{ id: string }>(
        `INSERT INTO channels(tenant_id, agent_id, external_id, channel_type, active)
         VALUES ($1,$2,$3,'whatsapp',true)
         ON CONFLICT (tenant_id, channel_type, external_id) DO UPDATE SET active = true
         RETURNING id`,
        [TENANT, AGENT, `sonda-506-${TENANT}-${AGENT}`],
      );
      canalId = ch.rows[0]!.id;
      await c.query(
        `INSERT INTO channels(tenant_id, agent_id, external_id, channel_type, active)
         VALUES ($1,$2,$3,'whatsapp',true)
         ON CONFLICT (tenant_id, channel_type, external_id) DO UPDATE SET active = true`,
        [TENANT, AGENT_VIZINHO, `sonda-506-${TENANT}-${AGENT_VIZINHO}`],
      );
    } finally {
      c.release();
    }
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM outbox_messages WHERE tenant_id = $1`, [TENANT]);
  });

  afterAll(async () => {
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM outbox_messages WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM channels WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM agents WHERE tenant_id = $1`, [TENANT]);
      await c.query(`DELETE FROM tenants WHERE id = $1`, [TENANT]);
    } finally {
      c.release();
      await pool.end();
    }
  });

  it('grava a linha durável, escopada pela ALS, com o canal ÚNICO resolvido', async () => {
    const outcome = await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, () =>
      enqueueProactiveNotice({
        jid: '5511988887777@s.whatsapp.net',
        text: 'Solicitação AP-abcdef expirou.',
        dedupe_key: 'sonda506:approval:expired:1',
      }),
    );
    expect(outcome).toBe('enqueued');

    const rows = await linhas();
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.tenant_id).toBe(TENANT);
    expect(r.agent_id).toBe(AGENT);
    expect(r.kind).toBe('whatsapp_text');
    // NASCE `pending`: o drain ainda não rodou. É esta a propriedade que as
    // quatro rotas não tinham — antes, entre "vou avisar" e "avisei" não havia
    // estado nenhum no banco.
    expect(r.status).toBe('pending');
    expect(r.attempts).toBe(0);
    expect(r.max_attempts).toBeGreaterThan(0);
    expect(r.channel_id).toBe(canalId);
    // Sem ocorrência nem task: um aviso de governança não pode fechar uma
    // ocorrência de agendamento como efeito colateral.
    expect(r.occurrence_id).toBeNull();
    expect(r.task_id).toBeNull();
    expect(r.payload.jid).toBe('5511988887777@s.whatsapp.net');
    expect(r.payload.text).toBe('Solicitação AP-abcdef expirou.');
  });

  it('a MESMA chave não rende um segundo aviso — quem recusa é o UNIQUE do banco', async () => {
    const primeiro = await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, () =>
      enqueueProactiveNotice({ jid: 'j@s.whatsapp.net', text: 'um', dedupe_key: 'sonda506:dup' }),
    );
    const segundo = await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, () =>
      enqueueProactiveNotice({
        // Destinatário e texto DIFERENTES de propósito: a identidade do aviso é
        // a chave, não o conteúdo. Se a dedupe dependesse do texto, este caso
        // criaria a segunda linha.
        jid: 'outro@s.whatsapp.net',
        text: 'dois',
        dedupe_key: 'sonda506:dup',
      }),
    );
    // CONTROLE, no MESMO passe: chave diferente PRECISA criar linha. Sem ele,
    // "só uma linha" ficaria verde com o enqueue quebrado.
    const controle = await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, () =>
      enqueueProactiveNotice({ jid: 'j@s.whatsapp.net', text: 'três', dedupe_key: 'sonda506:outra' }),
    );

    expect(primeiro).toBe('enqueued');
    expect(segundo).toBe('already_enqueued');
    expect(controle).toBe('enqueued');

    const rows = await linhas();
    expect(rows.map((r) => r.dedup_key)).toEqual(['sonda506:dup', 'sonda506:outra']);
    // O conteúdo é o do PRIMEIRO: o segundo nunca chegou a existir.
    expect(rows[0]!.payload.text).toBe('um');
  });

  it('o aviso de um agente não aparece no ledger do agente vizinho', async () => {
    await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, () =>
      enqueueProactiveNotice({ jid: 'a@s.whatsapp.net', text: 'do agente A', dedupe_key: 'sonda506:iso:a' }),
    );
    await runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT_VIZINHO }, () =>
      enqueueProactiveNotice({ jid: 'v@s.whatsapp.net', text: 'do vizinho', dedupe_key: 'sonda506:iso:v' }),
    );

    const doAgente = await linhas(AGENT);
    const doVizinho = await linhas(AGENT_VIZINHO);
    expect(doAgente).toHaveLength(1);
    expect(doVizinho).toHaveLength(1);
    expect(doAgente[0]!.payload.text).toBe('do agente A');
    expect(doVizinho[0]!.payload.text).toBe('do vizinho');
    // O drain reivindica por (tenant, agent): a linha do vizinho é invisível
    // para o passe do agente A, e é isso que impede o aviso de um agente de
    // sair pela linha do outro.
    expect(doAgente[0]!.channel_id).toBe(canalId);
    expect(doVizinho[0]!.channel_id).not.toBe(canalId);
  });
});
