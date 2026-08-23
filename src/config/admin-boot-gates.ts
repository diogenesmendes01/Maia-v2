/**
 * Os gates de boot PRÓPRIOS do `admin-ui`, modelados onde o preflight alcança
 * (issue #572, review de PR #595 — achado [Alta] nº 1).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que este módulo existe
 * ─────────────────────────────────────────────────────────────────────────
 * O contrato (`src/config/contract.ts`) e o boot do console NÃO fazem a mesma
 * pergunta. O contrato cobra `NEXTAUTH_SECRET` com `min(8)` e de
 * `OIDC_CLIENT_SECRET` só a presença; `src/admin-ui/lib/auth-gating.ts` exige
 * 32 e 16 caracteres, e recusa padrões de placeholder. Um `.env.admin` pode,
 * portanto, passar no contrato inteiro e LANÇAR no boot do container — que é
 * exatamente o falso verde que `npm run config:preflight` existe para não ter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que os pisos são CÓPIA, e não import
 * ─────────────────────────────────────────────────────────────────────────
 * `src/admin-ui` está no `exclude` do `tsconfig.json` da raiz e a regra
 * permanente do repositório é que nada sob `src/` importa naquela direção (ver
 * `src/db/profile-risk.ts:9`). O console tem `node_modules` e compilação
 * próprios; importar através da fronteira arrastaria o contrato para dentro
 * dela.
 *
 * A cópia não pode derivar em silêncio: `tests/unit/config/admin-boot-gates.spec.ts`
 * LÊ `src/admin-ui/lib/auth-gating.ts` COMO TEXTO e reprova divergência de cada
 * piso e de cada padrão de placeholder. É o mesmo padrão que
 * `src/ops/doctor/checks/config.ts` (PR #598) usa para o mesmo problema — e a
 * razão de este módulo morar em `src/config/` e não dentro do preflight é
 * justamente que o doctor possa importá-lo em vez de manter uma TERCEIRA cópia.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que ele NÃO faz
 * ─────────────────────────────────────────────────────────────────────────
 * Não é o boot. Não abre conexão com o IdP, não descobre `/.well-known`, não
 * verifica se o client existe. Mede o que `resolveSecret()` e
 * `oidcProviderEnabled()` medem ANTES de qualquer I/O: presença, comprimento e
 * padrão de placeholder.
 *
 * PUREZA: nada aqui toca disco, rede ou `process.env` — o ambiente entra por
 * parâmetro. `tests/unit/config/contract-purity.spec.ts` cobre os módulos puros
 * de `src/config/`.
 *
 * SEGREDO NUNCA SAI: as mensagens citam NOME e COMPRIMENTO, nunca valor — a
 * mesma regra que `auth-gating.ts` aplica ("only its length is reported").
 */

/**
 * Piso do `NEXTAUTH_SECRET` no boot do console (`resolveSecret()`), contra o
 * `min(8)` do contrato. Espelha `secret.length < 32` em
 * `src/admin-ui/lib/auth-gating.ts`.
 */
export const MIN_NEXTAUTH_SECRET_LEN = 32;

/** Espelha `MIN_OIDC_CLIENT_SECRET_LEN` em `src/admin-ui/lib/auth-gating.ts`. */
export const MIN_OIDC_CLIENT_SECRET_LEN = 16;

/**
 * Espelha `KNOWN_PLACEHOLDER_PATTERNS` em `src/admin-ui/lib/auth-gating.ts`.
 * Valores que passam no piso de comprimento e ainda assim são PÚBLICOS: quem
 * lê o repositório forja a sessão.
 */
export const KNOWN_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^changeme-/i,
  /change-?me/i,
  /change_me/i,
  /__PLACEHOLDER/i,
  /__SET_ME__/i,
  /dev-secret-change-in-prod/i,
];

function isKnownPlaceholderSecret(value: string): boolean {
  return KNOWN_PLACEHOLDER_PATTERNS.some((rx) => rx.test(value));
}

export interface AdminBootGateProblem {
  /** Variável de origem, para o operador saber o que editar. */
  readonly variable: string;
  /** Identificador estável da regra, no mesmo estilo do contrato. */
  readonly rule: string;
  /** Mensagem SEM valor de segredo — nome, comprimento e motivo. */
  readonly message: string;
  readonly remediation: string;
}

/**
 * Os problemas que o boot do `admin-ui` LANÇARIA com este ambiente.
 *
 * Fiel ao gate real, inclusive na fronteira de profile: `resolveSecret()` e
 * `oidcProviderEnabled()` só LANÇAM quando `NODE_ENV === 'production'`. Fora
 * dali o console tolera secret curto (cai para o provider de dev) e trata
 * issuer inválido como "OIDC desligado". Reprovar um laptop aqui seria o
 * preflight mentindo sobre o que o container faz, então a fronteira é a mesma.
 *
 * `OIDC_ISSUER` vazio devolve lista vazia DE PROPÓSITO: é o estado esperado de
 * um deploy sem OIDC, e é o único ramo silencioso do gate real. Quem cobra as
 * quatro `OIDC_*` em production é o CONTRATO (`requiredIn`), no subset
 * `admin-ui` — e é por isso que o preflight roda os dois, não um ou outro.
 */
export function adminBootGateProblems(
  env: Readonly<Record<string, string | undefined>>,
): AdminBootGateProblem[] {
  if (env.NODE_ENV !== 'production') return [];

  const problems: AdminBootGateProblem[] = [];
  const nextauth = env.NEXTAUTH_SECRET ?? '';
  const issuer = env.OIDC_ISSUER ?? '';
  const clientId = env.OIDC_CLIENT_ID ?? '';
  const clientSecret = env.OIDC_CLIENT_SECRET ?? '';
  const tenantSlugs = (env.OIDC_TENANT_SLUGS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // ---- resolveSecret() ----
  if (nextauth.length < MIN_NEXTAUTH_SECRET_LEN) {
    problems.push({
      variable: 'NEXTAUTH_SECRET',
      rule: 'admin-boot/nextauth-secret-length',
      message:
        `tem ${nextauth.length} chars; o boot do admin-ui exige >= ${MIN_NEXTAUTH_SECRET_LEN} ` +
        '(o contrato pede só min(8), então esta reprova NÃO aparece em `config check`).',
      remediation:
        'Gere um novo NEXTAUTH_SECRET: `openssl rand -base64 48`. Sem isso o container do console LANÇA no boot.',
    });
  } else if (isKnownPlaceholderSecret(nextauth)) {
    problems.push({
      variable: 'NEXTAUTH_SECRET',
      rule: 'admin-boot/nextauth-secret-placeholder',
      message:
        'casa com um padrão de placeholder conhecido (changeme / __PLACEHOLDER / __SET_ME__ / ' +
        'dev-secret-change-in-prod). Placeholders são públicos: a sessão é forjável por quem lê o repositório.',
      remediation: 'Rotacione com `openssl rand -base64 48` antes do primeiro boot.',
    });
  }

  // ---- oidcProviderEnabled() ----
  // Issuer vazio = "este deploy não usa OIDC": silêncio, igual ao gate real.
  if (issuer === '') return problems;

  let url: URL | null = null;
  try {
    url = new URL(issuer);
  } catch {
    problems.push({
      variable: 'OIDC_ISSUER',
      rule: 'admin-boot/oidc-issuer-unparseable',
      message: 'está definido mas não é uma URL parseável; o boot em production LANÇA (issue #167).',
      remediation: 'Use uma URL https:// completa, ou deixe OIDC_ISSUER vazio para desligar o provider.',
    });
  }
  if (url !== null && url.protocol !== 'https:') {
    problems.push({
      variable: 'OIDC_ISSUER',
      rule: 'admin-boot/oidc-issuer-https',
      message:
        `usa ${url.protocol.replace(':', '')}://; production exige https:// e o boot LANÇA ` +
        '(cleartext vaza redirect URLs, ID tokens e credenciais de client).',
      remediation: 'Troque para https://, ou deixe OIDC_ISSUER vazio para desligar o provider.',
    });
  }
  if (clientId === '') {
    problems.push({
      variable: 'OIDC_CLIENT_ID',
      rule: 'admin-boot/oidc-client-id-required',
      message: 'está vazio com OIDC_ISSUER definido; o boot em production LANÇA.',
      remediation: 'Preencha o client id emitido pelo IdP, ou deixe OIDC_ISSUER vazio.',
    });
  }
  if (clientSecret.length < MIN_OIDC_CLIENT_SECRET_LEN) {
    problems.push({
      variable: 'OIDC_CLIENT_SECRET',
      rule: 'admin-boot/oidc-client-secret-length',
      message:
        `tem ${clientSecret.length} chars; o boot exige >= ${MIN_OIDC_CLIENT_SECRET_LEN} ` +
        '(o contrato só cobra presença, então esta reprova NÃO aparece em `config check`).',
      remediation:
        'Pegue o client secret real no IdP (tipicamente 32-64 chars aleatórios), ou deixe OIDC_ISSUER vazio.',
    });
  } else if (isKnownPlaceholderSecret(clientSecret)) {
    problems.push({
      variable: 'OIDC_CLIENT_SECRET',
      rule: 'admin-boot/oidc-client-secret-placeholder',
      message:
        'casa com um padrão de placeholder conhecido; um secret de client confidencial público é forjável.',
      remediation: 'Rotacione para o secret real emitido pelo IdP.',
    });
  }
  if (tenantSlugs.length === 0) {
    problems.push({
      variable: 'OIDC_TENANT_SLUGS',
      rule: 'admin-boot/oidc-tenant-slugs-required',
      message:
        'está vazia com OIDC_ISSUER definido; o boot em production LANÇA. Sem slugs, todo sign-in ' +
        'resolve para nenhuma linha de app_users e devolve AccessDenied.',
      remediation:
        'Liste os tenant slugs REAIS separados por vírgula (nunca o literal `default` — ver AGENTS.md §4).',
    });
  }

  return problems;
}
