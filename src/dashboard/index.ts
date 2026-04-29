import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@/db/client.js';
import { dashboard_sessions, pessoas, entidades, contas_bancarias, transacoes, audit_log } from '@/db/schema.js';
import type { Pessoa } from '@/db/schema.js';
import { eq, and, gt, isNull, inArray, desc, sql } from 'drizzle-orm';
import { sha256, uuid } from '@/lib/utils.js';
import { resolveScope, isOwnerType, profileAllows, type ResolvedPermission } from '@/governance/permissions.js';
import type { ActionKey } from '@/governance/audit-actions.js';
import { audit } from '@/governance/audit.js';
import { config } from '@/config/env.js';
import { formatBRL, fmtBR } from '@/lib/brazilian.js';

const SESSION_TTL_HOURS = 8;
const SESSION_TTL_MS = SESSION_TTL_HOURS * 3600 * 1000;
const MAGIC_LINK_TTL_MS = 5 * 60 * 1000;

type Scope = { entidades: string[]; byEntity: Map<string, ResolvedPermission> };

function entitiesAllowing(scope: Scope, action: ActionKey): string[] {
  return scope.entidades.filter((eid) => {
    const r = scope.byEntity.get(eid);
    return Boolean(r && profileAllows(r.profile, action));
  });
}

function entityAllows(scope: Scope, entId: string, action: ActionKey): boolean {
  const r = scope.byEntity.get(entId);
  return Boolean(r && profileAllows(r.profile, action));
}

function hasAnyAction(scope: Scope, action: ActionKey): boolean {
  for (const r of scope.byEntity.values()) {
    if (profileAllows(r.profile, action)) return true;
  }
  return false;
}

async function getSessionFromCookie(cookie: string | undefined): Promise<{ pessoa_id: string } | null> {
  if (!cookie) return null;
  const m = cookie.match(/maia_session=([^;]+)/);
  if (!m) return null;
  const token = m[1] ?? '';
  const hash = sha256(token);
  const rows = await db
    .select()
    .from(dashboard_sessions)
    .where(
      and(
        eq(dashboard_sessions.token_hash, hash),
        gt(dashboard_sessions.expira_em, new Date()),
        isNull(dashboard_sessions.revoked_at),
      ),
    )
    .limit(1);
  return rows[0] ? { pessoa_id: rows[0].pessoa_id } : null;
}

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  if (!config.FEATURE_DASHBOARD) return;

  app.get('/dashboard', async (req, reply) => {
    const session = await getSessionFromCookie(req.headers.cookie);
    if (!session) {
      reply.type('text/html').send(loginHTML());
      return;
    }
    const pessoa = await db.select().from(pessoas).where(eq(pessoas.id, session.pessoa_id)).limit(1);
    const p = pessoa[0];
    if (!p) {
      reply.type('text/html').send(loginHTML());
      return;
    }
    const scope = await resolveScope(p);
    // Spec 15: only show entities whose profile authorizes `read_balance`.
    const visibleIds = entitiesAllowing(scope, 'read_balance');
    const ents = visibleIds.length
      ? await db.select().from(entidades).where(inArray(entidades.id, visibleIds))
      : [];
    const canSeeAudit = isOwnerType(p) && hasAnyAction(scope, 'read_audit');
    const html = await renderDashboard(p.nome, ents, visibleIds, canSeeAudit);
    reply.type('text/html').send(html);
  });

  app.post<{ Body: { token: string } }>('/dashboard/login/redeem', async (req, reply) => {
    const token = (req.body as { token?: string })?.token ?? '';
    const hash = sha256(token);
    const rows = await db
      .select()
      .from(dashboard_sessions)
      .where(
        and(
          eq(dashboard_sessions.token_hash, hash),
          gt(dashboard_sessions.expira_em, new Date()),
          isNull(dashboard_sessions.used_at),
        ),
      )
      .limit(1);
    const sess = rows[0];
    if (!sess) {
      reply.code(401).send({ error: 'invalid_or_expired_token' });
      return;
    }
    // Magic-link TTL (5min) is for redemption only. After redeem, extend to
    // SESSION_TTL_HOURS so the cookie's Max-Age and the DB row agree.
    const sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db
      .update(dashboard_sessions)
      .set({ used_at: new Date(), expira_em: sessionExpiresAt })
      .where(eq(dashboard_sessions.id, sess.id));
    reply
      .header(
        'set-cookie',
        `maia_session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_HOURS * 3600}; SameSite=Strict`,
      )
      .send({ ok: true });
  });

  app.get('/dashboard/health', async () => ({ ok: true, feature: 'dashboard', enabled: true }));

  app.get<{ Querystring: { entidade?: string; mes?: string } }>(
    '/dashboard/entity',
    async (req, reply) => {
      const ctx = await requireScope(req, reply);
      if (!ctx) return;
      const { p, scope } = ctx;
      const entId = (req.query as { entidade?: string }).entidade;
      if (!entId || !scope.entidades.includes(entId)) {
        reply.code(403).type('text/html').send(`<h1>Entidade fora do escopo</h1>`);
        return;
      }
      // Spec 15: profile must authorize the data being shown. read_balance
      // covers KPIs/contas. Transactions render only when read_transactions
      // is also granted — otherwise we hide that section.
      if (!entityAllows(scope, entId, 'read_balance')) {
        reply.code(403).type('text/html').send(`<h1>Sem permissão de leitura para essa entidade</h1>`);
        return;
      }
      const includeTxns = entityAllows(scope, entId, 'read_transactions');
      const month = parseMonth((req.query as { mes?: string }).mes);
      reply.type('text/html').send(await renderEntityView(p.nome, entId, month, includeTxns));
    },
  );

  app.get('/dashboard/audit', async (req, reply) => {
    const ctx = await requireScope(req, reply);
    if (!ctx) return;
    // Spec 15: audit view requires owner type AND `read_audit` action on at
    // least one permission. The two checks are belt-and-suspenders since
    // an owner profile typically grants `*`, but a non-standard profile
    // could omit `read_audit` and we'd rather 403 than leak.
    if (!isOwnerType(ctx.p) || !hasAnyAction(ctx.scope, 'read_audit')) {
      reply.code(403).type('text/html').send(`<h1>Apenas donos com read_audit veem auditoria</h1>`);
      return;
    }
    reply.type('text/html').send(await renderAuditView(ctx.p.nome));
  });

  app.post('/dashboard/logout', async (req, reply) => {
    const cookie = req.headers.cookie;
    const token = cookie?.match(/maia_session=([^;]+)/)?.[1];
    let pessoa_id: string | null = null;
    if (token) {
      const hash = sha256(token);
      // Read the pessoa_id off the row before revoking, so we can audit it.
      const sess = (
        await db
          .select({ pessoa_id: dashboard_sessions.pessoa_id })
          .from(dashboard_sessions)
          .where(eq(dashboard_sessions.token_hash, hash))
          .limit(1)
      )[0];
      pessoa_id = sess?.pessoa_id ?? null;
      await db
        .update(dashboard_sessions)
        .set({ revoked_at: new Date() })
        .where(eq(dashboard_sessions.token_hash, hash));
    }
    if (pessoa_id) {
      await audit({ acao: 'dashboard_session_ended', pessoa_id });
    }
    reply
      .header('set-cookie', 'maia_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict')
      .send({ ok: true });
  });
}

async function requireScope(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ p: Pessoa; scope: Scope } | null> {
  const session = await getSessionFromCookie(req.headers.cookie);
  if (!session) {
    reply.type('text/html').send(loginHTML());
    return null;
  }
  const rows = await db.select().from(pessoas).where(eq(pessoas.id, session.pessoa_id)).limit(1);
  const p = rows[0];
  if (!p) {
    reply.type('text/html').send(loginHTML());
    return null;
  }
  const scope = await resolveScope(p);
  return { p, scope };
}

function parseMonth(input: string | undefined): { from: string; to: string; label: string } {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;
  if (input && /^\d{4}-\d{2}$/.test(input)) {
    const [y, m] = input.split('-');
    year = Number(y);
    month = Number(m);
  }
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from, to, label: `${String(month).padStart(2, '0')}/${year}` };
}

function loginHTML(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Maia — Dashboard</title>
<style>body{font:14px/1.5 system-ui;max-width:480px;margin:60px auto;padding:0 20px}</style>
</head><body>
<h1>Maia — Dashboard</h1>
<p>Para entrar, mande <code>login dashboard</code> para a Maia no WhatsApp.
Ela vai te enviar um link único de acesso.</p>
</body></html>`;
}

async function renderDashboard(
  nome: string,
  ents: Array<{ id: string; nome: string }>,
  entIds: string[],
  canSeeAudit: boolean,
): Promise<string> {
  if (entIds.length === 0) return `<html><body><h1>Olá, ${nome}</h1><p>Sem entidades acessíveis.</p></body></html>`;
  const contas = await db.select().from(contas_bancarias).where(inArray(contas_bancarias.entidade_id, entIds));
  const txns = await db
    .select()
    .from(transacoes)
    .where(inArray(transacoes.entidade_id, entIds))
    .orderBy(desc(transacoes.data_competencia))
    .limit(20);
  const sums = ents.map((e) => {
    const total = contas
      .filter((c) => c.entidade_id === e.id)
      .reduce((s, c) => s + Number(c.saldo_atual), 0);
    return { id: e.id, nome: e.nome, total };
  });
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Maia — ${nome}</title>
<style>
body{font:14px/1.5 system-ui;max-width:960px;margin:30px auto;padding:0 20px}
table{width:100%;border-collapse:collapse;margin:1em 0}
th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left}
th{background:#fafafa}
.r{text-align:right}
</style></head><body>
<h1>Olá, ${nome}</h1>
<h2>Saldos por entidade</h2>
<table><tr><th>Entidade</th><th class="r">Saldo</th></tr>
${sums.map((s) => `<tr><td><a href="/dashboard/entity?entidade=${s.id}">${escape(s.nome)}</a></td><td class="r">${formatBRL(s.total)}</td></tr>`).join('')}
</table>
<h2>Últimas 20 transações</h2>
<table><tr><th>Data</th><th>Descrição</th><th>Natureza</th><th class="r">Valor</th></tr>
${txns
  .map(
    (t) =>
      `<tr><td>${fmtBR(new Date(t.data_competencia))}</td><td>${escape(t.descricao)}</td><td>${t.natureza}</td><td class="r">${formatBRL(Number(t.valor))}</td></tr>`,
  )
  .join('')}
</table>
<p>
  ${canSeeAudit ? `<a href="/dashboard/audit">Auditoria</a> ·` : ''}
  <form method="post" action="/dashboard/logout" style="display:inline"><button type="submit">Sair</button></form>
</p>
<p><small>read-only. Tudo que aparece aqui está auditado.</small></p>
</body></html>`;
}

async function renderEntityView(
  pessoaNome: string,
  entId: string,
  month: { from: string; to: string; label: string },
  includeTxns: boolean,
): Promise<string> {
  const ent = (await db.select().from(entidades).where(eq(entidades.id, entId)).limit(1))[0];
  if (!ent) return `<html><body><h1>Entidade não encontrada</h1></body></html>`;
  const contas = await db
    .select()
    .from(contas_bancarias)
    .where(eq(contas_bancarias.entidade_id, entId));
  // Only fetch transactions when the profile authorizes `read_transactions`.
  // Without it we still show KPIs / contas (which need read_balance only).
  const txns = includeTxns
    ? await db
        .select()
        .from(transacoes)
        .where(
          and(
            eq(transacoes.entidade_id, entId),
            sql`data_competencia >= ${month.from}`,
            sql`data_competencia <= ${month.to}`,
          ),
        )
        .orderBy(desc(transacoes.data_competencia))
        .limit(500)
    : [];
  const receita = txns.filter((t) => t.natureza === 'receita').reduce((s, t) => s + Number(t.valor), 0);
  const despesa = txns
    .filter((t) => t.natureza === 'despesa')
    .reduce((s, t) => s + Number(t.valor), 0);
  const saldo = contas.reduce((s, c) => s + Number(c.saldo_atual), 0);

  const prevMonth = shiftMonth(month, -1);
  const nextMonth = shiftMonth(month, +1);

  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${escape(ent.nome)} — ${month.label}</title>
${baseStyle()}</head><body>
<p><a href="/dashboard">← Voltar</a></p>
<h1>${escape(ent.nome)} <small style="color:#777">${month.label}</small></h1>
<p>
  <a href="/dashboard/entity?entidade=${entId}&mes=${prevMonth}">← ${prevMonth}</a> ·
  <a href="/dashboard/entity?entidade=${entId}&mes=${nextMonth}">${nextMonth} →</a>
</p>
<div class="kpis">
  <div class="kpi"><div class="lbl">Saldo total</div><div class="v">${formatBRL(saldo)}</div></div>
  <div class="kpi"><div class="lbl">Receita do mês</div><div class="v">${formatBRL(receita)}</div></div>
  <div class="kpi"><div class="lbl">Despesa do mês</div><div class="v">${formatBRL(despesa)}</div></div>
  <div class="kpi"><div class="lbl">Resultado</div><div class="v">${formatBRL(receita - despesa)}</div></div>
</div>
<h2>Contas (${contas.length})</h2>
<table><tr><th>Apelido</th><th>Banco</th><th class="r">Saldo</th></tr>
${contas.map((c) => `<tr><td>${escape(c.apelido)}</td><td>${escape(c.banco)}</td><td class="r">${formatBRL(Number(c.saldo_atual))}</td></tr>`).join('')}
</table>
${
  includeTxns
    ? `<h2>Transações (${txns.length})</h2>
<table><tr><th>Data</th><th>Descrição</th><th>Natureza</th><th class="r">Valor</th></tr>
${txns
  .map(
    (t) =>
      `<tr><td>${fmtBR(new Date(t.data_competencia))}</td><td>${escape(t.descricao)}</td><td>${t.natureza}</td><td class="r">${formatBRL(Number(t.valor))}</td></tr>`,
  )
  .join('')}
</table>`
    : `<p><em>Transações não disponíveis (perfil não autoriza read_transactions).</em></p>`
}
<p><small>Sessão: ${escape(pessoaNome)}. Read-only.</small></p>
</body></html>`;
}

async function renderAuditView(pessoaNome: string): Promise<string> {
  const events = await db
    .select()
    .from(audit_log)
    .orderBy(desc(audit_log.created_at))
    .limit(200);
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Auditoria — Maia</title>
${baseStyle()}</head><body>
<p><a href="/dashboard">← Voltar</a></p>
<h1>Auditoria <small>(últimos 200)</small></h1>
<table><tr><th>Quando</th><th>Ação</th><th>Pessoa</th><th>Alvo</th><th>Metadata</th></tr>
${events
  .map(
    (e) =>
      `<tr><td>${e.created_at?.toISOString() ?? ''}</td><td>${escape(e.acao)}</td><td>${e.pessoa_id ?? '-'}</td><td>${e.alvo_id ?? '-'}</td><td><code>${escape(JSON.stringify(e.metadata).slice(0, 120))}</code></td></tr>`,
  )
  .join('')}
</table>
<p><small>Sessão: ${escape(pessoaNome)}.</small></p>
</body></html>`;
}

function shiftMonth(m: { from: string }, delta: number): string {
  const [y, mo] = m.from.split('-').map(Number);
  const d = new Date(Date.UTC(y!, mo! - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function baseStyle(): string {
  return `<style>
body{font:14px/1.5 system-ui;max-width:960px;margin:30px auto;padding:0 20px;color:#222}
h1{margin-bottom:.2em} h2{margin-top:1.5em}
table{width:100%;border-collapse:collapse;margin:1em 0}
th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left}
th{background:#fafafa}
.r{text-align:right}
a{color:#0a66c2}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:1em 0}
.kpi{padding:12px;background:#f7f7f7;border-radius:6px}
.kpi .lbl{font-size:11px;text-transform:uppercase;color:#666}
.kpi .v{font-size:18px;font-weight:600}
code{font:12px/1.4 ui-monospace,monospace}
</style>`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}

export async function generateMagicLink(pessoa_id: string): Promise<{ token: string; expira_em: Date }> {
  const target = await db.select().from(pessoas).where(eq(pessoas.id, pessoa_id)).limit(1);
  const p = target[0];
  if (!p || !isOwnerType(p)) throw new Error('only_owners_allowed');
  const token = uuid();
  const hash = sha256(token);
  // Magic-link TTL is the redemption window. After redeem, `expira_em` is
  // bumped to a full session TTL so the cookie's Max-Age and the DB row stay
  // consistent.
  const expira_em = new Date(Date.now() + MAGIC_LINK_TTL_MS);
  await db.insert(dashboard_sessions).values({
    pessoa_id,
    token_hash: hash,
    expira_em,
  });
  await audit({ acao: 'dashboard_session_started', pessoa_id });
  return { token, expira_em };
}
