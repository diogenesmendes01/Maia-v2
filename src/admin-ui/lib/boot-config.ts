/**
 * O gate de configuração do BOOT do console (issue #596).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que estava errado
 * ─────────────────────────────────────────────────────────────────────────
 * O contrato tem um subset por serviço. As quatro `OIDC_*` são
 * `services: ['admin-ui']` com `requiredIn: ['staging','production']`, e existe
 * uma regra dedicada `admin-ui/tenant-slugs-default-literal`
 * (`src/config/rules.ts`). NENHUMA das duas era avaliada quando o console
 * subia: o processo importava `src/config/env.ts`, e aquele singleton valida
 * com `service: 'runtime'` — chave fora do subset `runtime` não tem
 * `requiredIn` avaliado, e regra que só dispara no subset `admin-ui` não roda.
 *
 * As duas consequências eram concretas:
 *   1. com as quatro `OIDC_*` ausentes o console SUBIA e entregava a tela "no
 *      providers configured" — sem erro de boot, descoberto por quem tentava
 *      entrar;
 *   2. `OIDC_TENANT_SLUGS=default` passava, e cada slug vai direto para
 *      `appUsersRepo.getByEmail(tenant, email)` / `tenantsRepo.findById(tenant)`
 *      em `./auth-resolver.ts` — o slug É o `tenant_id`, num caminho dinâmico,
 *      que é onde AGENTS.md §4 (regras 2 e 8) proíbe o literal.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que roda aqui, e por que estes três
 * ─────────────────────────────────────────────────────────────────────────
 * `loadAdminConfig()` (`src/config/admin-config.ts`) valida o subset `admin-ui`
 * do contrato: schema, `requiredIn` por profile, regras cross-field (incluindo
 * a do literal `default`), tombstones e chave desconhecida. Ele LANÇA
 * `ConfigValidationError` com TODOS os problemas de uma vez — o operador
 * conserta o `.env.admin` numa passada só.
 *
 * `resolveSecret()` e `oidcProviderEnabled()` (`./auth-gating.ts`) são os gates
 * PRÓPRIOS do console, mais estritos que o contrato em dois pontos
 * (`NEXTAUTH_SECRET` >= 32 onde o contrato pede `min(8)`; `OIDC_CLIENT_SECRET`
 * >= 16 onde ele só cobra presença) e com recusa de placeholder conhecido.
 * Eles já existiam — mas rodavam quando `./auth.ts` fosse carregado, ou seja,
 * no PRIMEIRO REQUEST. Trazê-los para o boot é o que torna "o container subiu"
 * uma afirmação sobre a configuração inteira.
 *
 * São chamados AQUI os originais, não o espelho: `src/config/admin-boot-gates.ts`
 * existe porque `npm run config:preflight` roda FORA do console (`src/` não
 * pode importar `src/admin-ui/`, ver `src/db/profile-risk.ts:9`) e precisa
 * medir os mesmos pisos sem atravessar a fronteira. Dentro do console a
 * fronteira não existe, e usar a cópia onde o original está a um import de
 * distância seria trocar o gate real por um espelho dele.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que este gate NÃO faz
 * ─────────────────────────────────────────────────────────────────────────
 * Não abre conexão com Postgres, Redis ou IdP: é validação de CONFIGURAÇÃO,
 * não de liveness (liveness é `npm run doctor`, #517). E não substitui
 * `npm run config:preflight`: aquele mede os ARQUIVOS do bring-up ANTES de
 * existir container, compondo `env_file` + `environment:` do compose. Os dois
 * coexistem de propósito — um responde "o `up` vai produzir um ambiente
 * válido?", o outro "o processo que subiu está com um ambiente válido?".
 */
import { loadAdminConfig } from '@/config/admin-config.js';
import { oidcProviderEnabled, resolveSecret } from './auth-gating.js';

/**
 * Valida a configuração do console. LANÇA quando o ambiente não serve — o
 * chamador é `src/admin-ui/instrumentation.ts`, e um throw ali impede o
 * servidor de aceitar o primeiro request (fail-closed, AGENTS.md §4.2).
 *
 * Lê `process.env` e mais nada, sem parâmetro de ambiente: é o que
 * `resolveSecret()` e `oidcProviderEnabled()` fazem, e uma spec que medisse um
 * ambiente injetado aqui estaria medindo um caminho que o boot não tem. As
 * specs trocam `process.env` in-process, como `tests/admin-ui/unit/auth-gating.spec.ts`
 * já faz.
 */
export function assertAdminBootConfig(): void {
  // Mesma escotilha do runtime (`src/config/env.ts`): env-only, sem redeploy,
  // e RUIDOSA de propósito — uma escotilha silenciosa é a que ninguém lembra
  // de fechar. Ver docs/runbooks/config-contract.md.
  if (process.env.MAIA_CONFIG_STRICT_BOOT === 'false') {
    console.warn(
      '[config] MAIA_CONFIG_STRICT_BOOT=false — validação de contrato do admin-ui ' +
        'DESLIGADA (as quatro OIDC_* e a regra admin-ui/tenant-slugs-default-literal ' +
        'não são checadas). Rollback temporário; ver docs/runbooks/config-contract.md.',
    );
  } else {
    loadAdminConfig();
  }

  // Os gates próprios do console rodam SEMPRE: são anteriores ao contrato
  // (issues #167/#176) e não são o que a escotilha acima desliga.
  resolveSecret();
  oidcProviderEnabled();
}
