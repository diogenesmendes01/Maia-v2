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
 * Cada serviço declara em `COMPOSE_SERVICE_CONTRACT` a LISTA de subsets que o
 * PROCESSO daquele container avalia no boot, e o preflight roda todos — mais
 * os gates de boot PRÓPRIOS do console (`src/config/admin-boot-gates.ts`):
 * `NEXTAUTH_SECRET` >= 32 chars onde o contrato pede `min(8)`,
 * `OIDC_CLIENT_SECRET` >= 16 chars onde o contrato só cobra presença, e recusa
 * de placeholders. Sem eles, um `.env.admin` podia passar no contrato inteiro
 * e LANÇAR no boot.
 *
 * A LISTA existe porque entre a #572 e a #596 o `admin-ui` avaliava DOIS
 * subsets: ele importava `src/config/env.ts` (nos dois routers de tools e
 * transitivamente por `@/db/client.ts`), e aquele singleton chama
 * `validateConfig({ service: 'runtime' })`. Tirar do `.env.admin` uma chave
 * EXCLUSIVA de `runtime` (`BACKUP_S3_BUCKET`, por exemplo) deixava este
 * preflight VERDE e derrubava o container no boot — o único modo de falha que
 * um gate de bring-up não pode ter (review de PR #595, [Alta] 1).
 *
 * A #596 removeu a causa: os módulos compartilhados leem o contrato por
 * `src/config/contract-env.ts`, nenhum import do console alcança
 * `src/config/env.ts`, e o console valida o subset `admin-ui` no boot
 * (`src/admin-ui/instrumentation.ts`). `COMPOSE_SERVICE_CONTRACT['admin-ui']`
 * voltou a ser `['admin-ui']` — e a estrutura de lista fica, porque é ela que
 * torna a pergunta "quais validadores este container roda?" respondível em vez
 * de presumida.
 *
 * ISTO AQUI NÃO É MAIS A ÚNICA CHECAGEM DO SUBSET `admin-ui`, e a diferença
 * entre as duas é o motivo de as duas existirem: o preflight mede os ARQUIVOS
 * (`env_file` + `environment:` interpolado) ANTES de existir container; o boot
 * mede o ambiente que o processo REALMENTE recebeu. Um `docker compose up`
 * feito sem rodar o preflight agora também reprova — no boot, com o container
 * recusando-se a servir — em vez de subir e entregar "no providers configured".
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
 * parâmetro, e toda variável referenciada por interpolação cujo valor no shell
 * DIFIRA do `.env.infra` vira falha nomeada, com a instrução de desexportá-la
 * ou de alinhar o arquivo. Nenhum valor aparece na mensagem, só o nome.
 *
 * REFERENCIADA inclui os `env_file`, não só o YAML: o Compose interpola
 * `${VAR}` dentro deles e o ambiente do projeto vence as chaves do próprio
 * arquivo, então um `DOMAIN` que só apareça no `.env.admin` é igualmente
 * sequestrável. Contar só o YAML deixava esse caso verde — é o achado [Média]
 * da rodada 2 do review de PR #595, e `detectShellDivergence` documenta a
 * união.
 *
 * PUREZA: nada aqui toca disco, rede ou `process.env`. Quem lê arquivo e quem
 * captura o shell é `scripts/config.ts`.
 */
import { adminBootGateProblems, type AdminBootGateProblem } from '@/config/admin-boot-gates.js';
import {
  composeEnvFileInterpolationRefs,
  composeEnvFileNames,
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
 * Só as REFERENCIADAS entram na conta — o shell tem centenas de variáveis e
 * nenhuma delas importa aqui. Valor igual ao do `.env.infra` não é divergência:
 * o `up` produziria o mesmo ambiente.
 *
 * REFERENCIADAS ONDE: a UNIÃO do YAML com os `env_file`. A primeira versão
 * olhava só `composeInterpolationRefs(compose)`, e isso reabria pelo outro lado
 * o falso verde que ela fechava (review de PR #595, rodada 2). O ambiente
 * efetivo também interpola `${VAR}` dentro de cada `env_file`, com o mapa do
 * projeto (`--env-file` + shell) VENCENDO as chaves do próprio arquivo — ver
 * `parseComposeEnvFile`. Um `.env.admin` com `NEXTAUTH_URL=https://${DOMAIN}` e
 * um `DOMAIN` exportado diferente do `.env.infra` fazia o `up` materializar
 * outra URL, e como `DOMAIN` não aparece no YAML nada era reportado.
 *
 * Os `env_file` são lidos SÓ para colher nomes: `composeEnvFileInterpolationRefs`
 * não interpola e não devolve valor algum, e a mensagem continua sendo o nome
 * da variável e mais nada — nem o valor do shell, nem o do `.env.infra`.
 *
 * Um `env_file` declarado e ausente é ignorado AQUI de propósito: ele já vira
 * `failure` nomeada no relatório do serviço (e o `docker compose up` também
 * aborta). Lançar neste ponto trocaria aquela falha nomeada por um crash do
 * preflight inteiro, que é uma mensagem pior para o mesmo problema.
 */
function detectShellDivergence(
  input: PreflightInput,
  compose: Record<string, ComposeNode>,
  infra: Readonly<Record<string, string>>,
): ShellDivergence[] {
  const shell = input.shellEnv;
  if (shell === undefined) return [];
  const refs = composeInterpolationRefs(compose);
  for (const name of composeEnvFileNames(compose)) {
    let text: string;
    try {
      text = input.readEnvFile(name);
    } catch {
      continue;
    }
    composeEnvFileInterpolationRefs(text, refs);
  }
  const out: ShellDivergence[] = [];
  for (const name of [...refs].sort()) {
    const fromShell = shell[name];
    if (fromShell === undefined) continue;
    const fromInfra = infra[name];
    if (fromInfra === fromShell) continue;
    out.push({ variable: name, absentFromInfra: fromInfra === undefined });
  }
  return out;
}
