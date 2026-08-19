/**
 * Preflight de bring-up: o ambiente EFETIVO de cada container do Compose,
 * validado contra o contrato ANTES do `up` (issue #572).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O falso positivo que este módulo existe para não ter
 * ─────────────────────────────────────────────────────────────────────────
 * `npm run config:check -- --env-file .env.app` responde "está tudo certo" a
 * uma pergunta que ninguém fez. O container `app` não recebe só o `.env.app`:
 * `compose.prod.yml` injeta `DATABASE_URL`, `REDIS_URL`, `POSTGRES_*`,
 * `NODE_ENV` e `MAIA_ENV` pelo `environment:`, interpolados do `.env.infra`.
 * Checar UMA das duas fontes erra dos dois lados — acusa como ausente o que o
 * compose injeta, e não vê o que o compose sobrescreve.
 *
 * Além disso `config check` valida o contrato INTEIRO. O `migrate` não tem
 * `env_file` de propósito (subset `migrator`, issue #515/#516) e reprovaria por
 * variáveis que ele nunca deve receber. Aqui cada serviço é validado com o
 * subset do SEU loader — o mesmo que `loadServiceConfig` usa no boot.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que ele NÃO responde
 * ─────────────────────────────────────────────────────────────────────────
 * Isto é validação de CONFIGURAÇÃO, não de liveness: nada aqui abre conexão
 * com Postgres, Redis, S3 ou IdP. Um `BACKUP_S3_BUCKET` sintaticamente válido
 * que aponta para um bucket inexistente passa. Liveness é `maia doctor` (#517).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TODOS os validadores que o container roda — não "o loader nominal dele"
 * ─────────────────────────────────────────────────────────────────────────
 * O `admin-ui` era validado só contra o subset `admin-ui`. Isso descrevia o
 * loader que o container DEVERIA usar, não o que ele usa, e o próprio
 * cabeçalho anterior documentava a divergência sem modelá-la — o container do
 * console importa `src/config/env.ts` transitivamente
 * (`src/admin-ui/trpc/tool-enablement.ts` e
 * `src/admin-ui/trpc/routers/tools-catalog.ts` importam `@/config/env.js`
 * diretamente; `@/db/client.ts` também), e aquele singleton chama
 * `validateConfig({ service: 'runtime' })`. Tirar do `.env.admin` uma chave
 * EXCLUSIVA de `runtime` (`BACKUP_S3_BUCKET`, por exemplo) deixava este
 * preflight e os testes VERDES e derrubava o container no boot — o único modo
 * de falha que um gate de bring-up não pode ter (review de PR #595, [Alta] 1).
 *
 * Agora cada serviço declara em `COMPOSE_SERVICE_CONTRACT` a LISTA de subsets
 * efetivamente avaliados (`admin-ui` → `runtime` + `admin-ui`) e o preflight
 * roda todos, mais os gates de boot PRÓPRIOS do console
 * (`src/config/admin-boot-gates.ts`): `NEXTAUTH_SECRET` >= 32 chars onde o
 * contrato pede `min(8)`, `OIDC_CLIENT_SECRET` >= 16 chars onde o contrato só
 * cobra presença, e recusa de placeholders. Sem eles, um `.env.admin` podia
 * passar no contrato inteiro e LANÇAR no boot.
 *
 * NA OUTRA DIREÇÃO, e é o motivo mais forte para este comando existir: para o
 * subset `admin-ui` do contrato, ISTO AQUI É A ÚNICA CHECAGEM QUE RODA. As
 * `OIDC_*` são `services: ['admin-ui']` e ficam fora do subset `runtime`, então
 * nem o `requiredIn` delas nem a regra `admin-ui/tenant-slugs-default-literal`
 * são avaliados no boot. `loadAdminConfig()` existe e ninguém o chama. Sem
 * preflight, um `.env.admin` com as quatro `OIDC_*` ausentes SOBE, e entrega a
 * tela "no providers configured".
 *
 * Isso continua sendo disciplina de runbook, e é honesto dizê-lo: fazer o BOOT
 * do console chamar `loadAdminConfig()` é a **issue #596**, e não está feito
 * aqui. Até lá, pular `npm run config:preflight` continua permitindo subir sem
 * o subset OIDC/fail-closed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HERMÉTICO, e explícito sobre isso
 * ─────────────────────────────────────────────────────────────────────────
 * A interpolação sai do `.env.infra` e de mais nada. O `docker compose`, porém,
 * dá PRECEDÊNCIA ao ambiente exportado no shell sobre o `--env-file`: uma
 * `MAIA_ENV=staging` exportada vence o arquivo, e o `up` produziria um ambiente
 * diferente do que foi certificado aqui (review de PR #595, [Média]).
 *
 * A saída não é "ler o shell": um preflight cujo veredito depende do shell de
 * quem o roda não é reproduzível, e o operador não teria como saber disso. A
 * saída é ser hermético E REPROVAR a divergência — `shellEnv` entra por
 * parâmetro, e toda variável referenciada pelo compose cujo valor no shell
 * DIFIRA do `.env.infra` vira falha nomeada, com a instrução de desexportá-la
 * ou de alinhar o arquivo. Nenhum valor aparece na mensagem, só o nome.
 *
 * PUREZA: nada aqui toca disco, rede ou `process.env`. Quem lê arquivo e quem
 * captura o shell é `scripts/config.ts`.
 */
import { adminBootGateProblems, type AdminBootGateProblem } from '@/config/admin-boot-gates.js';
import {
  composeInterpolationRefs,
  effectiveServiceEnv,
  parseComposeText,
  preflightTargets,
  type ComposeNode,
  type PreflightTarget,
} from '@/config/compose-env.js';
import { parseEnvFile } from '@/config/env-file.js';
import type { MaiaProfile, MaiaService } from '@/config/metadata.js';
import { validateConfig, type ValidateConfigResult } from '@/config/validate.js';

export interface PreflightInput {
  /** Conteúdo do arquivo de Compose. */
  readonly composeText: string;
  /** Rótulo do compose nas mensagens de erro (normalmente o caminho lido). */
  readonly composeLabel: string;
  /** Conteúdo do `.env.infra` — só interpolação, nunca injetado em container. */
  readonly infraText: string;
  /**
   * Lê um `env_file` declarado no compose, pelo nome EXATO como está lá
   * (`.env.app`). Deve LANÇAR quando o arquivo não existe: um `env_file`
   * declarado e ausente é uma falha de bring-up, não um ambiente vazio.
   */
  readonly readEnvFile: (name: string) => string;
  /** Força um profile em vez de resolvê-lo do ambiente efetivo de cada serviço. */
  readonly profile?: MaiaProfile;
  /**
   * O ambiente do shell de quem rodará o `docker compose`. NÃO é usado para
   * interpolar (a execução é hermética — ver o cabeçalho): serve só para
   * DETECTAR que ele sequestraria uma variável do `.env.infra`. Omitido = o
   * chamador afirma que não há shell a considerar.
   */
  readonly shellEnv?: Readonly<Record<string, string | undefined>>;
}

/** Uma variável que o shell sobrescreveria, com o nome — nunca com o valor. */
export interface ShellDivergence {
  readonly variable: string;
  /** `true` quando o `.env.infra` sequer declara a variável. */
  readonly absentFromInfra: boolean;
}

/** O veredito de UM subset do contrato para um serviço. */
export interface PreflightContractReport {
  readonly contract: MaiaService;
  readonly result: ValidateConfigResult;
}

export interface PreflightServiceReport {
  readonly target: PreflightTarget;
  /**
   * Um veredito por subset que o container avalia no boot, na ordem de
   * `target.contracts`. VAZIO quando o ambiente efetivo nem pôde ser montado
   * (ver `failure`).
   */
  readonly contracts: readonly PreflightContractReport[];
  /**
   * Os gates de boot PRÓPRIOS do serviço (hoje só o console). Vazio quando o
   * serviço não tem gates, ou quando todos passaram.
   */
  readonly bootGateProblems: readonly AdminBootGateProblem[];
  /**
   * Falha ANTES da validação: `env_file` ausente, ou interpolação `${VAR:?…}`
   * sem valor no `.env.infra` (o mesmo caso em que o `docker compose up` aborta
   * sem criar container algum).
   */
  readonly failure?: string;
}

export interface PreflightReport {
  readonly ok: boolean;
  readonly services: readonly PreflightServiceReport[];
  /**
   * Variáveis exportadas no shell que o `docker compose` faria vencer o
   * `.env.infra`. Não vazio ⇒ `ok === false`: o ambiente que este relatório
   * certifica NÃO é o que o `up` produziria.
   */
  readonly shellDivergence: readonly ShellDivergence[];
}

/**
 * Monta o ambiente efetivo de cada serviço do compose e valida cada um contra
 * TODOS os subsets que o processo daquele container avalia, mais os gates de
 * boot próprios dele. Nunca para no primeiro problema: o operador conserta os
 * arquivos numa passada só.
 */
export function runPreflight(input: PreflightInput): PreflightReport {
  const compose = parseComposeText(input.composeText, input.composeLabel);
  const infra = parseEnvFile(input.infraText);
  const shellDivergence = detectShellDivergence(input, compose, infra);
  const services: PreflightServiceReport[] = [];

  for (const target of preflightTargets(compose)) {
    let env: Record<string, string>;
    try {
      env = effectiveServiceEnv(compose, target.compose, {
        envFileContents: target.envFiles.map((name) => input.readEnvFile(name)),
        envFileNames: target.envFiles,
        infra,
      });
    } catch (err) {
      services.push({
        target,
        contracts: [],
        bootGateProblems: [],
        failure: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    services.push({
      target,
      contracts: target.contracts.map((contract) => ({
        contract,
        result: validateConfig({ env, service: contract, profile: input.profile }),
      })),
      bootGateProblems: target.adminBootGates ? adminBootGateProblems(env) : [],
    });
  }

  return {
    ok:
      shellDivergence.length === 0 &&
      services.every(
        (s) =>
          s.failure === undefined &&
          s.bootGateProblems.length === 0 &&
          s.contracts.length > 0 &&
          s.contracts.every((c) => c.result.ok),
      ),
    services,
    shellDivergence,
  };
}

/**
 * As variáveis de interpolação que o shell sequestraria.
 *
 * Só as REFERENCIADAS pelo compose entram na conta — o shell tem centenas de
 * variáveis e nenhuma delas importa aqui. Valor igual ao do `.env.infra` não é
 * divergência: o `up` produziria o mesmo ambiente.
 */
function detectShellDivergence(
  input: PreflightInput,
  compose: Record<string, ComposeNode>,
  infra: Readonly<Record<string, string>>,
): ShellDivergence[] {
  const shell = input.shellEnv;
  if (shell === undefined) return [];
  const out: ShellDivergence[] = [];
  for (const name of [...composeInterpolationRefs(compose)].sort()) {
    const fromShell = shell[name];
    if (fromShell === undefined) continue;
    const fromInfra = infra[name];
    if (fromInfra === fromShell) continue;
    out.push({ variable: name, absentFromInfra: fromInfra === undefined });
  }
  return out;
}
