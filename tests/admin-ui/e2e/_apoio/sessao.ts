/**
 * Sessão autenticada para as jornadas do console (issue #623).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O problema que este arquivo resolve
 * ─────────────────────────────────────────────────────────────────────────
 *
 * As dez jornadas de `tests/admin-ui/e2e/` navegam para telas atrás de
 * sessão: `src/admin-ui/middleware.ts` redireciona TODA rota não pública para
 * /auth/signin. O `smoke` não precisa disso; elas precisam.
 *
 * Contra o ARTEFATO DE PRODUÇÃO o único profile satisfazível é `staging`
 * (`server.js` do standalone força `NODE_ENV=production` na linha 5 — ver o
 * bloco do passo de E2E em `.github/workflows/ci.yml`), e nesse profile o
 * console registra APENAS o provider OIDC: `devCredentialsProviderEnabled()`
 * exige `NODE_ENV !== 'production'` (`src/admin-ui/lib/auth-gating.ts`).
 * Sobravam três caminhos:
 *
 *   1. subir um IdP OIDC de verdade no job — infra nova, e o `smoke` já
 *      documenta que o issuer do CI é um host `.invalid` de propósito;
 *   2. ligar o magic-link (`ALLOW_DEV_AUTH`) no CI — seria ENFRAQUECER o
 *      gate: um provider de credenciais passaria a existir num processo que
 *      se declara de produção, exatamente o que `lib/auth.ts` proíbe;
 *   3. MINTAR o cookie de sessão no teste, com o mesmo `NEXTAUTH_SECRET` do
 *      processo, usando o `encode()` do próprio Auth.js.
 *
 * Escolha: (3). Ela não toca uma linha de código de produção e não afrouxa
 * nada — o cookie emitido é o MESMO artefato que um sign-in real emitiria
 * (JWE A256CBC-HS512, `session: { strategy: 'jwt' }`), e continuam valendo,
 * de verdade: o middleware, o `auth()` do route handler, o `createTRPCContext`
 * (tenant + papel), o `assertRole` de cada procedure e o gate de papel da UI.
 * O que o teste pula é o handshake com o IdP — que é justamente a parte que
 * NÃO é do console.
 *
 * `encode()` vem do `next-auth` instalado em `src/admin-ui/node_modules`
 * (a raiz não depende dele — ver o comentário de `lib/auth-resolver.ts`).
 * Resolver via `createRequire` a partir do `package.json` do console é
 * deliberado: assim o teste assina com a MESMA implementação que o servidor
 * usa para decifrar. Reimplementar o JWE aqui seria um segundo formato,
 * livre para divergir na próxima major do Auth.js.
 */
import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { BrowserContext } from '@playwright/test';

const AQUI = dirname(fileURLToPath(import.meta.url));
/** `tests/admin-ui/e2e/_apoio` -> raiz do repositório. */
const RAIZ = resolvePath(AQUI, '../../../..');

/** Papéis que as jornadas exercitam. Espelham `KNOWN_ROLES` do console. */
export type PapelE2E = 'founder' | 'owner' | 'compliance_officer' | 'analyst' | 'viewer';

/**
 * Tenant das jornadas: o tenant reservado do runtime single-tenant, o mesmo
 * que `OIDC_TENANT_SLUGS` declara no job. NUNCA `default` — o slug É o
 * `tenant_id` num caminho dinâmico (regra `admin-ui/tenant-slugs-default-literal`).
 */
export const TENANT_E2E = 'primary';

/** Agente dono das fixtures — o único agente semeado pelas migrations. */
export const AGENTE_E2E = 'primary';

/**
 * Usuários das jornadas. Os mesmos que `scripts/seed-admin-ui-e2e-fixtures.ts`
 * grava em `app_users`: o id vai para `proposal_approvals.approver_user_id` e
 * para `admin_audit_log.actor_id`, e `debug_snapshot_grants` tem FK para a
 * tabela — um id inventado aqui produziria erro de FK no meio da jornada.
 */
export const USUARIOS_E2E: Record<PapelE2E, { id: string; email: string; nome: string }> = {
  founder: { id: 'e2e-user-founder', email: 'founder.e2e@maia.test', nome: 'E2E Founder' },
  owner: { id: 'e2e-user-owner', email: 'owner.e2e@maia.test', nome: 'E2E Owner' },
  compliance_officer: {
    id: 'e2e-user-compliance',
    email: 'compliance.e2e@maia.test',
    nome: 'E2E Compliance',
  },
  analyst: { id: 'e2e-user-analyst', email: 'analyst.e2e@maia.test', nome: 'E2E Analyst' },
  viewer: { id: 'e2e-user-viewer', email: 'viewer.e2e@maia.test', nome: 'E2E Viewer' },
};

interface EncodeParams {
  token: Record<string, unknown>;
  secret: string;
  salt: string;
  maxAge?: number;
}
type Encode = (p: EncodeParams) => Promise<string>;

let encodeCache: Encode | null = null;

async function carregarEncode(): Promise<Encode> {
  if (encodeCache) return encodeCache;
  const requireDoConsole = createRequire(resolvePath(RAIZ, 'src/admin-ui/package.json'));
  const modulo = (await import(
    pathToFileURL(requireDoConsole.resolve('next-auth/jwt')).href
  )) as { encode: Encode };
  encodeCache = modulo.encode;
  return encodeCache;
}

/** Base do console sob teste — a mesma que `playwright.config.ts` usa. */
export function baseDoConsole(): string {
  return process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4000';
}

/**
 * Nomes possíveis do cookie de sessão, na ordem em que o console pode
 * escolhê-los.
 *
 * O Auth.js decide o prefixo `__Secure-` pelo PROTOCOLO DA URL que ele
 * resolve para si (`config.useSecureCookies ?? url.protocol === 'https:'`, em
 * `@auth/core/lib/init.js`) — e essa URL vem de `NEXTAUTH_URL`/`AUTH_URL`
 * quando ela está declarada, não do endereço que o navegador digitou. No job
 * do CI `NEXTAUTH_URL` é `https://localhost:4000` enquanto o servidor atende
 * em `http://localhost:4000` (é `AUTH_TRUST_HOST=true` que reconcilia os
 * dois), então o nome esperado ali é `__Secure-authjs.session-token`.
 *
 * MEDIDO nesta árvore, com o artefato standalone e o bloco `env:` do job:
 *   `authjs.session-token`            -> /api/auth/session responde `null`
 *   `__Secure-authjs.session-token`   -> responde a sessão completa
 *
 * O `salt` do JWE é o PRÓPRIO nome do cookie, então errar o nome é errar a
 * chave: não existe "quase certo" aqui. Por isso os dois nomes são emitidos,
 * cada um assinado com o seu salt, e `autenticarComo` CONFERE o resultado
 * contra /api/auth/session antes de devolver o controle ao teste — uma
 * jornada que medisse a tela de login por cookie errado seria exatamente o
 * tipo de verde mentiroso que a #623 foi aberta para tirar da suíte.
 */
const NOMES_DE_COOKIE = [
  '__Secure-authjs.session-token',
  'authjs.session-token',
] as const;

function segredoDoConsole(): string {
  const segredo = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  if (!segredo || segredo.length < 32) {
    throw new Error(
      'NEXTAUTH_SECRET ausente (ou < 32 chars) no processo do Playwright. ' +
        'A jornada precisa assinar a sessão com o MESMO segredo do console — ' +
        'sem ele o cookie não decifra e o middleware devolve /auth/signin. ' +
        'É o mesmo bloco `env:` do passo de E2E do job `admin-ui`.',
    );
  }
  return segredo;
}

/**
 * Autentica o contexto do navegador como `papel`.
 *
 * Chame ANTES do primeiro `goto` da jornada (num `beforeEach`): sem o cookie
 * o middleware responde 307 para /auth/signin e a asserção seguinte mediria a
 * tela de login.
 */
export async function autenticarComo(
  context: BrowserContext,
  papel: PapelE2E = 'owner',
): Promise<void> {
  const encode = await carregarEncode();
  const usuario = USUARIOS_E2E[papel];
  const base = baseDoConsole();
  const segredo = segredoDoConsole();

  // As claims são as que `callbacks.jwt` grava no primeiro sign-in e
  // `callbacks.session` lê depois (`src/admin-ui/lib/auth.ts`): id, role e
  // tenant_id. `sub`/`email`/`name` são o payload padrão do Auth.js.
  const claims = {
    sub: usuario.id,
    id: usuario.id,
    email: usuario.email,
    name: usuario.nome,
    role: papel,
    tenant_id: TENANT_E2E,
  };

  await context.clearCookies();
  for (const nome of NOMES_DE_COOKIE) {
    const value = await encode({ token: claims, secret: segredo, salt: nome, maxAge: 60 * 60 });
    await context.addCookies([
      {
        name: nome,
        value,
        // `domain`/`path` e NÃO `url`: com `url` o Playwright deriva
        // `secure` do protocolo e RECUSA um cookie `__Secure-` sobre http
        // ("Invalid cookie fields"). O Chromium, por outro lado, aceita
        // cookie seguro em `localhost` — a origem é tratada como confiável.
        // MEDIDO: pela forma `domain`/`path`, /api/auth/session devolve a
        // sessão; pela forma `url`, o `addCookies` nem chega a executar.
        domain: new URL(base).hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: nome.startsWith('__Secure-'),
      },
    ]);
  }

  // Conferência, não decoração: se o console não reconhecer a sessão, o teste
  // seguinte mediria a tela de login e reprovaria com "elemento não
  // encontrado" — a mensagem errada, três camadas depois da causa.
  const resposta = await context.request.get(`${base}/api/auth/session`);
  const sessao = (await resposta.json()) as { user?: { id?: string; role?: string } } | null;
  if (sessao?.user?.id !== usuario.id || sessao.user.role !== papel) {
    throw new Error(
      `o console não reconheceu a sessão sintética de ${papel}: ` +
        `/api/auth/session respondeu ${JSON.stringify(sessao)}. ` +
        `Confira se NEXTAUTH_SECRET é o MESMO do processo do console e se o ` +
        `nome do cookie ainda é um de [${NOMES_DE_COOKIE.join(', ')}] ` +
        `(o Auth.js o deriva do protocolo de NEXTAUTH_URL).`,
    );
  }
}
