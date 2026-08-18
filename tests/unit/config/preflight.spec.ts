/**
 * `npm run config:preflight` — o passo que `docs/runbooks/deploy-prod.md` §1
 * manda rodar ANTES do `docker compose up` (issue #572).
 *
 * A propriedade central está no primeiro caso e vale a pena dizê-la em voz
 * alta: rodando o preflight sobre os `.prod.example` CRUS — sem nenhum
 * preenchimento — toda reprova é sobre uma chave que o próprio exemplo deixa
 * PARA O OPERADOR (vazia, `__SET_ME__` ou terminada em `...`). Nenhuma reprova
 * sobra sem dono. É essa a diferença entre o estado anterior e o atual: até a
 * #572, `BACKUP_S3_BUCKET` e as quatro `OIDC_*` reprovavam sem aparecer em
 * lugar nenhum do arquivo, e o operador só descobria no boot do container.
 *
 * O caso é escrito ASSIM — sobre o arquivo cru, e não sobre uma cópia
 * preenchida — de propósito: preencher exige uma tabela de valores escrita no
 * teste, e uma tabela dessas mascara justamente o defeito que se quer pegar
 * (uma chave ausente do exemplo entra pela tabela e some do vermelho). Sem
 * preenchimento não há o que mascarar.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runPreflight } from '@/config/preflight.js';
import { envFileNamesOf, parseComposeText } from '@/config/compose-env.js';
import { parseEnvFile } from '@/config/env-file.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const COMPOSE = resolve(REPO_ROOT, 'compose.prod.yml');
const COMPOSE_TEXT = readFileSync(COMPOSE, 'utf8');

/** O `.env.infra` do runbook §1 — só interpolação, nunca injetado. */
const INFRA_TEXT = [
  'POSTGRES_USER=maia_prod',
  'POSTGRES_PASSWORD=f4kepassw0rdf4ke',
  'POSTGRES_DB=maia',
  'REDIS_PASSWORD=f4keredispass',
  'MAIA_ENV=production',
  '',
].join('\n');

/** `.env.app` ⇒ `.env.app.prod.example`, exatamente como o runbook manda copiar. */
function readExampleFor(name: string): string {
  return readFileSync(resolve(REPO_ROOT, `${name}.prod.example`), 'utf8');
}

function preflightSobreOsExemplos(overrides: Readonly<Record<string, string>> = {}) {
  return runPreflight({
    composeText: COMPOSE_TEXT,
    composeLabel: 'compose.prod.yml',
    infraText: INFRA_TEXT,
    readEnvFile: (name) => {
      const text = readExampleFor(name);
      const extra = Object.entries(overrides)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
      return extra === '' ? text : `${text}\n${extra}\n`;
    },
  });
}

/** Chaves que o exemplo de um serviço deixa para o operador preencher. */
function operatorOwnedKeys(composeService: string): Set<string> {
  const compose = parseComposeText(COMPOSE_TEXT, 'compose.prod.yml');
  const out = new Set<string>();
  for (const name of envFileNamesOf(compose, composeService)) {
    for (const [key, value] of Object.entries(parseEnvFile(readExampleFor(name)))) {
      if (value === '' || value.includes('__SET_ME__') || value.endsWith('...')) out.add(key);
    }
  }
  return out;
}

describe('config preflight — os .prod.example não escondem nenhuma chave (issue #572)', () => {
  it('cobre os três serviços do compose, cada um com o loader dono', () => {
    const report = preflightSobreOsExemplos();
    expect(
      report.services.map((s) => ({
        compose: s.target.compose,
        contract: s.target.contract,
        envFiles: [...s.target.envFiles],
      })),
    ).toEqual([
      { compose: 'migrate', contract: 'migrator', envFiles: [] },
      { compose: 'app', contract: 'runtime', envFiles: ['.env.app'] },
      { compose: 'admin-ui', contract: 'admin-ui', envFiles: ['.env.admin'] },
    ]);
  });

  it('o migrator passa sem env_file nenhum — todo o ambiente dele vem do compose', () => {
    const migrate = preflightSobreOsExemplos().services.find((s) => s.target.compose === 'migrate')!;
    expect(migrate.failure).toBeUndefined();
    expect(migrate.result!.errors).toEqual([]);
  });

  it.each(['app', 'admin-ui'])(
    'em %s, TODA reprova sobre o exemplo cru é de uma chave que o exemplo deixa ao operador',
    (composeService) => {
      const doOperador = operatorOwnedKeys(composeService);
      const s = preflightSobreOsExemplos().services.find((t) => t.target.compose === composeService)!;
      expect(s.failure).toBeUndefined();
      // `variable: null` são regras cross-field cujo insumo é uma das chaves
      // acima (ex.: `embeddings/provider-key`, que dispara porque
      // VOYAGE_API_KEY está vazia no exemplo). Elas somem junto quando o
      // operador preenche, e não têm nome próprio para conferir aqui.
      const semDono = s
        .result!.errors.filter((e) => e.variable !== null && !doOperador.has(e.variable))
        .map((e) => `${e.variable} [${e.rule}]`)
        .sort();
      expect(
        semDono,
        `${composeService}: o preflight reprova em chave(s) que o .prod.example não menciona. ` +
          'Era exatamente esse o defeito da issue #572 (BACKUP_* e OIDC_*): o operador copia o ' +
          'exemplo, preenche tudo que vê, e o container reprova no boot mesmo assim.',
      ).toEqual([]);
      // E o exemplo tem que estar reprovando ALGO — senão este caso passaria
      // sobre um arquivo que não exige nada do operador, e não provaria nada.
      expect(s.result!.errors.length).toBeGreaterThan(0);
    },
  );

  it('OIDC_TENANT_SLUGS=default é reprovado pelo preflight, com a regra nomeada', () => {
    // O slug vai direto para `appUsersRepo.getByEmail(tenant, email)` em
    // src/admin-ui/lib/auth-resolver.ts — ele É o tenant_id (AGENTS.md §4).
    const s = preflightSobreOsExemplos({ OIDC_TENANT_SLUGS: 'default' }).services.find(
      (t) => t.target.compose === 'admin-ui',
    )!;
    expect(s.result!.errors.map((e) => e.rule)).toContain('admin-ui/tenant-slugs-default-literal');
  });

  it('um .env.infra sem MAIA_ENV falha ANTES da validação, nos três serviços', () => {
    // Mesmo ponto em que o `docker compose up` aborta, e pelo mesmo motivo:
    // `${MAIA_ENV:?…}` não tem default.
    const report = runPreflight({
      composeText: COMPOSE_TEXT,
      composeLabel: 'compose.prod.yml',
      infraText: INFRA_TEXT.replace('MAIA_ENV=production\n', ''),
      readEnvFile: readExampleFor,
    });
    expect(report.ok).toBe(false);
    expect(report.services.map((s) => s.failure !== undefined)).toEqual([true, true, true]);
    expect(report.services[0]!.failure).toMatch(/MAIA_ENV is required/);
  });

  it('um env_file declarado e ausente é FALHA, não ambiente vazio', () => {
    // Um `readEnvFile` que devolvesse '' faria o preflight reprovar por
    // "variável obrigatória ausente" — mensagem que manda o operador editar um
    // arquivo que ele nem criou. O `docker compose up` também aborta aqui.
    const report = runPreflight({
      composeText: COMPOSE_TEXT,
      composeLabel: 'compose.prod.yml',
      infraText: INFRA_TEXT,
      readEnvFile: (name) => {
        throw new Error(`env_file declarado no compose não existe: ${name}`);
      },
    });
    expect(report.ok).toBe(false);
    const app = report.services.find((s) => s.target.compose === 'app')!;
    expect(app.failure).toMatch(/\.env\.app/);
    expect(app.result).toBeNull();
  });

  it('um serviço novo, sem classificação, LANÇA em vez de sair do preflight em silêncio', () => {
    const comServicoNovo = `${COMPOSE_TEXT.replace(
      /\nservices:\n/,
      '\nservices:\n  relatorios:\n    image: exemplo/relatorios:1\n',
    )}`;
    expect(() =>
      runPreflight({
        composeText: comServicoNovo,
        composeLabel: 'compose.prod.yml',
        infraText: INFRA_TEXT,
        readEnvFile: readExampleFor,
      }),
    ).toThrow(/relatorios/);
  });
});
