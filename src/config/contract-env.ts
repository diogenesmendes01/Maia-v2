/**
 * `contractEnv` — a leitura de UMA variável do contrato, sob demanda, SEM
 * validar o subset de nenhum serviço (issue #596).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O problema que este módulo existe para resolver
 * ─────────────────────────────────────────────────────────────────────────
 * `src/config/env.ts` é o singleton do RUNTIME: no import ele chama
 * `validateConfig({ service: 'runtime' })` e reprova o processo inteiro se
 * qualquer variável do subset `runtime` faltar. Isso é exatamente o que se
 * quer no container `app` — e é uma catástrofe num container que não é o
 * `app`.
 *
 * O console (`src/admin-ui/`) carregava `src/config/env.ts` por seis módulos
 * COMPARTILHADOS (`src/db/client.ts`, `src/lib/logger.ts`,
 * `src/lib/llm-settings.ts`, `src/governance/idempotency.ts`,
 * `src/control-plane/runtime-trace/lib/hmac.ts`,
 * `src/gateway/staging-crypto.ts`) e por `src/config/feature-flags.ts`. Com
 * isso ele validava o subset `runtime` no boot e EXIGIA segredo que não usa —
 * as seis `BACKUP_*`, inclusive credencial de S3, num container que nunca roda
 * backup (issue #596, e o custo que a #572 aceitou temporariamente).
 *
 * Um módulo compartilhado não pertence a um serviço só. Ele não pode, portanto,
 * arrastar o boot de UM serviço para dentro de TODOS os processos que o
 * carregam. O que ele precisa é do valor de uma variável, com o schema do
 * contrato — e é isso, e só isso, que este módulo entrega.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Fidelidade ao `config` de `src/config/env.ts`
 * ─────────────────────────────────────────────────────────────────────────
 * `objectSchemaForService(s)` monta `z.object({ NOME: spec.schema, ... })` e
 * parseia `process.env`. Para cada chave, o zod entrega ao campo exatamente
 * `process.env[NOME]` — inclusive `undefined` quando ausente e `''` quando
 * vazia. Aqui é `spec.schema.safeParse(process.env[NOME])`, chave a chave: o
 * MESMO schema, sobre o MESMO valor bruto. `tests/unit/config/contract-env.spec.ts`
 * compara os dois lado a lado, variável por variável, para que a equivalência
 * não dependa desta frase.
 *
 * O que muda é QUANDO e O QUE reprova:
 *   - `config` reprova no IMPORT, e reprova o subset `runtime` INTEIRO;
 *   - `contractEnv` reprova na LEITURA, e só a variável lida.
 * Nenhum dos dois cai para default silencioso: uma variável cujo schema recusa
 * o valor (ou a ausência) LANÇA, nomeando a variável — nunca o valor.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que este módulo NÃO é
 * ─────────────────────────────────────────────────────────────────────────
 * Não é o boot de ninguém. Cada container continua com o seu:
 *   - `app` / scripts → `src/config/env.ts` (subset `runtime`, fail-closed no
 *     import; `src/index.ts` e os entrypoints de `scripts/` importam-no
 *     diretamente, e `tests/unit/config/admin-import-boundary.spec.ts` fixa por
 *     nome quais continuam a alcançá-lo);
 *   - `migrate` → `loadMigrationConfig()`;
 *   - `admin-ui` → `src/admin-ui/instrumentation.ts`, que roda ANTES do
 *     primeiro request e chama `assertAdminBootConfig()` (subset `admin-ui` +
 *     os gates reais de `src/admin-ui/lib/auth-gating.ts`).
 *
 * `dotenv/config` continua aqui, e é deliberado: antes da #596 estes módulos
 * carregavam `.env` de graça, por importarem `src/config/env.ts`. Um script
 * que só importa `@/lib/logger.js` teria perdido o `.env` em silêncio — que é
 * o tipo de regressão que ninguém descobre com teste verde. `dotenv` não
 * sobrescreve variável já presente no ambiente, então o container (onde não há
 * `.env`) não muda de comportamento.
 */
import 'dotenv/config';
import { CONTRACT_ENTRIES, type ContractValues } from '@/config/contract.js';
import type { EnvVarSpec } from '@/config/metadata.js';

/**
 * Memo por variável. O ambiente de um processo não muda em produção; nos
 * testes, `_resetContractEnvCacheForTests()` derruba o memo.
 */
const cache = new Map<string, unknown>();

function valueOf(spec: EnvVarSpec): unknown {
  const cached = cache.get(spec.name);
  if (cached !== undefined || cache.has(spec.name)) return cached;
  const parsed = spec.schema.safeParse(process.env[spec.name]);
  if (!parsed.success) {
    // NOME e restrição, nunca o valor — a mesma garantia de
    // `src/config/redact.ts`. As mensagens do zod citam a restrição.
    const detail = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(
      `config: ${spec.name} é inválida para o contrato (${detail}). ` +
        'Corrija-a conforme src/config/contract.ts, ou rode ' +
        '`npm run config:check -- --env-file .env` para ver o ambiente inteiro de uma vez.',
    );
  }
  cache.set(spec.name, parsed.data);
  return parsed.data;
}

function build(): ContractValues {
  const target = {} as Record<string, unknown>;
  for (const spec of CONTRACT_ENTRIES) {
    Object.defineProperty(target, spec.name, {
      enumerable: true,
      configurable: false,
      get: () => valueOf(spec),
    });
  }
  return target as ContractValues;
}

/**
 * O contrato inteiro, parseado sob demanda a partir de `process.env`.
 *
 * Para módulos COMPARTILHADOS por mais de um container. Código que pertence a
 * UM serviço deve continuar usando o loader daquele serviço
 * (`loadServiceConfig` / `loadAdminConfig` / `loadMigrationConfig`), que é
 * quem sabe o que aquele container precisa ter.
 */
export const contractEnv: ContractValues = build();

/** Test seam: derruba o memo para uma spec poder trocar `process.env` in-process. */
export function _resetContractEnvCacheForTests(): void {
  cache.clear();
}
