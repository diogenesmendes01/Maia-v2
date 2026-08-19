/**
 * `maia doctor` — configuration checks (issue #517 §3, "Configuração").
 *
 * ───────────────────────────────────────────────────────────────────────────
 * The boundary with `config preflight` (#572), stated where it can be enforced
 * ───────────────────────────────────────────────────────────────────────────
 * These two commands ask DIFFERENT questions about the same contract, and the
 * difference is not "one is nicer":
 *
 *   - `config preflight` reads `compose.prod.yml` and the `.env.*` FILES on the
 *     operator's machine, reconstructs what each container WOULD receive, and
 *     validates that. It runs before `docker compose up` and its whole value is
 *     that it catches the problem before a container exists.
 *   - `maia doctor` runs INSIDE the container and validates what the process
 *     ACTUALLY received. That is a different snapshot: an orchestrator
 *     substitution that silently produced an empty string, a secret mounted at
 *     the wrong path, a `docker run -e` that the compose file never mentioned,
 *     a stale container started from a previous `.env` — none of those are
 *     visible from the files, and all of them are visible from here.
 *
 * So this check does NOT reimplement contract validation. It CALLS
 * `validateConfig()` — the one validator both commands share — with `env` bound
 * to the live process environment. If the two ever disagree, the disagreement
 * IS the finding: the files say one thing and the container got another.
 *
 * (`config preflight` is issue #572, in flight at the time of writing. It is
 * referenced here by BEHAVIOUR, not by file path, precisely because it is not
 * merged yet — a comment that names a file this tree does not contain rots on
 * arrival. The boundary above holds regardless of where that code lands.)
 *
 * `config.admin_boot_gates` covers the one class of problem NEITHER the
 * contract nor the preflight sees, and #572 says so itself: the admin-ui
 * applies its OWN, stricter gates at boot
 * (`src/admin-ui/lib/auth-gating.ts`) — `NEXTAUTH_SECRET` >= 32 chars where
 * the contract asks `min(8)`, `OIDC_CLIENT_SECRET` >= 16 chars where the
 * contract only asks for presence. A green contract is not a promise that the
 * console boots.
 */
import { validateConfig } from '@/config/validate.js';
import { notApplicable, pass, type DoctorCheck, type DoctorContext, type DoctorResult } from '../types.js';

/**
 * The admin-ui's OWN boot floors, mirrored here.
 *
 * They are COPIES, not imports, and that is forced rather than lazy:
 * `src/admin-ui` is `exclude`d from the root `tsconfig.json` and the repo's
 * standing rule is that nothing under `src/` imports in that direction (see
 * `src/db/profile-risk.ts:9`). The console has its own `node_modules` and its
 * own compilation; importing across the boundary would pull the doctor into it.
 *
 * `tests/unit/ops/doctor-checks.spec.ts` READS `src/admin-ui/lib/auth-gating.ts`
 * as text and reproves divergence, so the copy cannot silently drift from the
 * gate it claims to predict.
 *
 * `MIN_NEXTAUTH_SECRET_LEN` (32) is the floor NextAuth itself needs and the
 * console enforces; the contract asks only `min(8)`, so a 12-character
 * `NEXTAUTH_SECRET` passes `config check` and still fails to boot.
 */
export const MIN_NEXTAUTH_SECRET_LEN = 32;

/** Mirrors `MIN_OIDC_CLIENT_SECRET_LEN` in `src/admin-ui/lib/auth-gating.ts`. */
export const MIN_OIDC_CLIENT_SECRET_LEN = 16;

/**
 * How many problems to name in the evidence before truncating. The point of
 * the doctor is that the operator fixes everything in ONE pass, so this is
 * generous — but a 40-problem dump is noise, and the count is always exact.
 */
const MAX_LISTED_PROBLEMS = 12;

/**
 * Render one problem for the report.
 *
 * Uses the problem's MESSAGE, not just `problem.variable`, and that is
 * deliberate. Some cross-field rules are about a PAIR of variables and report
 * only one of them in `variable` (`backup/encryption-key` files itself under
 * `BACKUP_ENCRYPTION_KEYRING`, and `BACKUP_ENCRYPTION_ACTIVE_KEY_ID` appears
 * nowhere in the structured field). Listing by variable alone would silently
 * omit the second key and leave the operator fixing one half in a loop. The
 * message names both.
 */
function describeProblem(p: {
  readonly variable: string | null;
  readonly rule: string;
  readonly message: string;
}): string {
  return `${p.variable ?? '<config>'} [${p.rule}] ${p.message}`;
}

export const configContractCheck: DoctorCheck = {
  id: 'config.contract',
  category: 'config',
  criticality: 'blocker',
  describes:
    'o ambiente que ESTE processo realmente recebeu satisfaz o contrato do seu serviço',
  deadlineMs: 2_000,
  requiresNetwork: false,
  run(ctx: DoctorContext): Promise<DoctorResult> {
    const result = validateConfig({
      env: ctx.env as Record<string, string | undefined>,
      profile: ctx.profile,
      service: ctx.service,
    });

    const base = {
      service: ctx.service,
      profile: result.profile,
      contract_version: result.contractVersion,
      config_hash: result.configHash,
      errors: result.errors.length,
      warnings: result.warnings.length,
    };

    if (result.errors.length > 0) {
      const listed = result.errors.slice(0, MAX_LISTED_PROBLEMS).map(describeProblem);
      return Promise.resolve({
        status: 'fail',
        summary: `${result.errors.length} problema(s) de configuração no ambiente deste container`,
        evidence: {
          ...base,
          problems: listed.join(' | '),
          truncated: result.errors.length > MAX_LISTED_PROBLEMS,
        },
        remediation: [
          'Corrija TODAS as variáveis listadas de uma vez — a lista acima é completa até o limite de exibição, não a primeira falha.',
          'Se os arquivos `.env.*` estiverem corretos, o container está rodando com um ambiente antigo: recrie-o (`docker compose up -d --force-recreate`).',
          'Antes do próximo `up`, valide os arquivos com o preflight de configuração — ele responde a pergunta ANTES de existir container.',
        ],
      });
    }

    if (result.warnings.length > 0) {
      return Promise.resolve({
        status: 'warn',
        summary: `contrato satisfeito com ${result.warnings.length} aviso(s)`,
        evidence: {
          ...base,
          problems: result.warnings.slice(0, MAX_LISTED_PROBLEMS).map(describeProblem).join(' | '),
        },
        remediation: result.warnings.map((w) => w.remediation),
      });
    }

    return Promise.resolve(pass(`contrato ${result.contractVersion} satisfeito`, base));
  },
};

export const adminBootGatesCheck: DoctorCheck = {
  id: 'config.admin_boot_gates',
  category: 'config',
  criticality: 'blocker',
  describes:
    'os gates de boot PRÓPRIOS do admin-ui, mais estritos que o contrato, estão satisfeitos',
  deadlineMs: 1_000,
  requiresNetwork: false,
  run(ctx: DoctorContext): Promise<DoctorResult> {
    const nextauth = ctx.env.NEXTAUTH_SECRET ?? '';
    const issuer = ctx.env.OIDC_ISSUER ?? '';
    const clientSecret = ctx.env.OIDC_CLIENT_SECRET ?? '';

    // "OIDC não configurado" is a legitimate deployment shape (the dev
    // credentials provider covers it), and `NEXTAUTH_SECRET` is only read by
    // the console. With neither present there is nothing to assert — and `skip`
    // says that, instead of a `pass` that would read as "the console boots".
    //
    // This is the ONE `not_applicable` skip in the registry, and it earns the
    // exemption: there is no console in this environment, so no console gate
    // was left unproven. Every OTHER skip on a blocker makes the run
    // INCOMPLETO (`DoctorSkipKind`) — including this same check if the
    // variables were present and we failed to evaluate them.
    if (nextauth === '' && issuer === '') {
      return Promise.resolve(
        notApplicable('nenhuma variável do admin-ui presente neste ambiente — nada a afirmar sobre o console', {
          nextauth_secret_present: false,
          oidc_issuer_present: false,
        }),
      );
    }

    const failures: string[] = [];
    const remediation: string[] = [];

    if (nextauth !== '' && nextauth.length < MIN_NEXTAUTH_SECRET_LEN) {
      failures.push(
        `NEXTAUTH_SECRET tem ${nextauth.length} chars; o boot do admin-ui exige >= ${MIN_NEXTAUTH_SECRET_LEN}`,
      );
      remediation.push(
        `Gere um novo NEXTAUTH_SECRET com >= ${MIN_NEXTAUTH_SECRET_LEN} chars (\`openssl rand -base64 48\`) e recrie o container do console.`,
      );
    }

    if (issuer !== '' && clientSecret.length < MIN_OIDC_CLIENT_SECRET_LEN) {
      failures.push(
        `OIDC_ISSUER está configurado mas OIDC_CLIENT_SECRET tem ${clientSecret.length} chars; o boot exige >= ${MIN_OIDC_CLIENT_SECRET_LEN}`,
      );
      remediation.push(
        'Pegue o client secret real no IdP. Com o issuer setado e o secret fraco, o admin-ui LANÇA no boot em produção — não cai para a tela "no providers configured".',
      );
    }

    const evidence = {
      nextauth_secret_length: nextauth.length,
      oidc_issuer_present: issuer !== '',
      oidc_client_secret_length: clientSecret.length,
      min_nextauth_secret: MIN_NEXTAUTH_SECRET_LEN,
      min_oidc_client_secret: MIN_OIDC_CLIENT_SECRET_LEN,
    };

    if (failures.length > 0) {
      // `resolveSecret()` and `oidcProviderEnabled()` only THROW when
      // `NODE_ENV === 'production'`; in development the console tolerates a
      // short secret and falls back to the dev credentials provider. Reporting
      // a hard `fail` on a developer's laptop would be the doctor lying about
      // what the console will do, so the verdict follows the same profile
      // boundary the gate itself uses.
      return Promise.resolve({
        status: ctx.profile === 'development' ? 'warn' : 'fail',
        summary: failures.join('; '),
        evidence: { ...evidence, enforced_at_boot: ctx.profile !== 'development' },
        remediation,
      });
    }

    return Promise.resolve(
      pass('os gates de boot do admin-ui estão satisfeitos (comprimentos, não valores)', evidence),
    );
  },
};

export const CONFIG_CHECKS: readonly DoctorCheck[] = [configContractCheck, adminBootGatesCheck];
