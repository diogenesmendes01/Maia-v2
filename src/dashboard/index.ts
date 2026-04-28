import type { FastifyInstance } from 'fastify';
import { db } from '@/db/client.js';
import { dashboard_sessions, pessoas, entidades, contas_bancarias, transacoes } from '@/db/schema.js';
import { eq, and, gt, isNull, inArray, desc } from 'drizzle-orm';
import { sha256, uuid } from '@/lib/utils.js';
import { resolveScope, isOwnerType } from '@/governance/permissions.js';
import { audit } from '@/governance/audit.js';
import { config } from '@/config/env.js';
import { formatBRL, fmtBR } from '@/lib/brazilian.js';

const SESSION_TTL_HOURS = 8;

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
    const ents = await db.select().from(entidades).where(inArray(entidades.id, scope.entidades));
    const html = await renderDashboard(p.nome, ents, scope.entidades);
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
    await db
      .update(dashboard_sessions)
      .set({ used_at: new Date() })
      .where(eq(dashboard_sessions.id, sess.id));
    reply
      .header(
        'set-cookie',
        `maia_session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_HOURS * 3600}; SameSite=Strict`,
      )
      .send({ ok: true });
  });

  app.get('/dashboard/health', async () => ({ ok: true, feature: 'dashboard', enabled: true }));
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

async function renderDashboard(nome: string, ents: Array<{ id: string; nome: string }>, entIds: string[]): Promise<string> {
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
    return { nome: e.nome, total };
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
${sums.map((s) => `<tr><td>${s.nome}</td><td class="r">${formatBRL(s.total)}</td></tr>`).join('')}
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
<p><small>read-only. Tudo que aparece aqui está auditado.</small></p>
</body></html>`;
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
  const expira_em = new Date(Date.now() + 5 * 60 * 1000);
  await db.insert(dashboard_sessions).values({
    pessoa_id,
    token_hash: hash,
    expira_em,
  });
  await audit({ acao: 'dashboard_session_started', pessoa_id });
  return { token, expira_em };
}
