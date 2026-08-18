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
 * E ele vê só o contrato. O `admin-ui` tem um SEGUNDO validador no seu próprio
 * boot (`resolveSecret` / `oidcProviderEnabled` em
 * `src/admin-ui/lib/auth-gating.ts`) que é mais estrito em pelo menos dois
 * pontos — `NEXTAUTH_SECRET` >= 32 chars (o contrato pede `min(8)`) e
 * `OIDC_CLIENT_SECRET` >= 16 chars (o contrato só cobra presença). Um verde
 * aqui não é promessa de que o admin-ui sobe; é a garantia de que o CONTRATO
 * está satisfeito. A lista completa está em `docs/runbooks/deploy-prod.md` §1.
 *
 * PUREZA: nada aqui toca disco, rede ou `process.env`. Quem lê arquivo é
 * `scripts/config.ts`.
 */
import {
  effectiveServiceEnv,
  parseComposeText,
  preflightTargets,
  type PreflightTarget,
} from '@/config/compose-env.js';
import { parseEnvFile } from '@/config/env-file.js';
import type { MaiaProfile } from '@/config/metadata.js';
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
}

export interface PreflightServiceReport {
  readonly target: PreflightTarget;
  /** `null` quando o ambiente efetivo nem pôde ser montado (ver `failure`). */
  readonly result: ValidateConfigResult | null;
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
}

/**
 * Monta o ambiente efetivo de cada serviço do compose e valida cada um contra
 * o subset do seu loader. Nunca para no primeiro problema: o operador conserta
 * os dois arquivos numa passada só.
 */
export function runPreflight(input: PreflightInput): PreflightReport {
  const compose = parseComposeText(input.composeText, input.composeLabel);
  const infra = parseEnvFile(input.infraText);
  const services: PreflightServiceReport[] = [];

  for (const target of preflightTargets(compose)) {
    let env: Record<string, string>;
    try {
      env = effectiveServiceEnv(compose, target.compose, {
        envFileContents: target.envFiles.map((name) => input.readEnvFile(name)),
        infra,
      });
    } catch (err) {
      services.push({
        target,
        result: null,
        failure: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    services.push({
      target,
      result: validateConfig({ env, service: target.contract, profile: input.profile }),
    });
  }

  return {
    ok: services.every((s) => s.failure === undefined && s.result?.ok === true),
    services,
  };
}
