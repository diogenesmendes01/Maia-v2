/**
 * Issue #565 — o subset `migrator` do contrato, travado pela ORIGEM da chave.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que este arquivo trava, e o que ele deliberadamente NÃO faz
 * ─────────────────────────────────────────────────────────────────────────
 * Já existia um caso em `tests/unit/config/contract.spec.ts` afirmando que o
 * migrator não recebe `ANTHROPIC_API_KEY`, `BAILEYS_AUTH_DIR`,
 * `BACKUP_S3_SECRET_KEY` e mais quatro nomes. Ele continua lá e continua
 * útil — mas ele congela a LISTA DE HOJE. A `WHATSAPP_*` que for criada na
 * semana que vem passa por ele sem tocar em nada: ninguém volta para
 * acrescentá-la à lista, e o teste segue verde enquanto o job de DDL passa a
 * carregar a chave que fala com o cliente.
 *
 * Aqui a afirmação é sobre a CATEGORIA, lida do contrato real:
 *
 *   - `group` — o domínio de onde a variável vem. Só `core` (processo) e
 *     `database` (o destino do DDL) são domínios do migrator. Um grupo NOVO
 *     em `GROUP_ORDER` nasce proibido sem ninguém editar este arquivo;
 *   - `MAIA_KEY_PREFIXES` — os namespaces da Maia. Todos são de domínio de
 *     aplicação menos `MAIA_`, que é da plataforma. Um prefixo novo naquela
 *     lista também nasce proibido aqui;
 *   - `secret` — segredo no subset do migrator só pode ser credencial de
 *     banco.
 *
 * ARMADILHA DO ESPELHO, e como ela é evitada: nada abaixo reconstrói o
 * subset. `migratorSubsetViolations()` sem argumento lê
 * `entriesForService('migrator')` do contrato de verdade — o mesmo módulo
 * que `loadMigrationConfig()` consome no boot. O parâmetro só é usado nos
 * canários, cujo trabalho é provar que o guard ACUSA quando há o que acusar
 * (um guard vacuoso passa exatamente igual a um guard correto).
 *
 * E o `.env.migrator.prod.example` é lido do DISCO, não descrito aqui: o
 * arquivo que o runbook manda copiar é o artefato, não uma cópia dele.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CONTRACT_ENTRIES, entriesForService } from '@/config/contract.js';
import { parseEnvFile } from '@/config/env-file.js';
import { ConfigValidationError } from '@/config/load.js';
import { loadMigrationConfig } from '@/config/migration-config.js';
import {
  MIGRATOR_DOMAINS,
  MIGRATOR_FLOOR,
  MIGRATOR_PLATFORM_PREFIX,
  MigratorSubsetError,
  assertMigratorSubsetMinimal,
  migratorSubsetViolations,
} from '@/config/migrator-subset.js';
import { manifestForService } from '@/config/services.js';
import type { EnvVarSpec } from '@/config/metadata.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const EXEMPLO = '.env.migrator.prod.example';

/** Uma chave de APLICAÇÃO fabricada, para os canários. Nunca entra no contrato. */
const CHAVE_DE_APLICACAO: EnvVarSpec = {
  name: 'WHATSAPP_FIXTURE_DO_CANARIO',
  description: 'Chave fabricada só para provar que o guard acusa.',
  group: 'whatsapp',
  secret: true,
  services: ['migrator'],
  schema: z.string().optional(),
  restartRequired: true,
};

describe('subset `migrator` — a invariante, sobre o contrato REAL (#565)', () => {
  it('não carrega nenhuma variável fora dos domínios de processo e de banco', () => {
    const foraDoDominio = entriesForService('migrator').filter(
      (s) => !MIGRATOR_DOMAINS.includes(s.group),
    );
    expect(
      foraDoDominio.map((s) => `${s.name} (${s.group})`),
      'uma variável de domínio de aplicação entrou no subset `migrator` — um job que só ' +
        'aplica DDL não tem motivo para carregar configuração de aplicação',
    ).toEqual([]);
  });

  it('não carrega namespace da Maia que não seja o da plataforma', () => {
    const foraDoNamespace = entriesForService('migrator')
      .map((s) => s.name)
      .filter((name) => /^[A-Z]+_/.test(name))
      .filter((name) => {
        const violacoes = migratorSubsetViolations(
          entriesForService('migrator').filter((s) => s.name === name),
        );
        return violacoes.some((p) => p.rule === 'migrator/namespace-foreign');
      });
    expect(
      foraDoNamespace,
      `só "${MIGRATOR_PLATFORM_PREFIX}" é namespace de plataforma; todo o resto de ` +
        'MAIA_KEY_PREFIXES nomeia um domínio de aplicação',
    ).toEqual([]);
  });

  it('não carrega segredo que não seja credencial de banco', () => {
    const segredos = entriesForService('migrator').filter((s) => s.secret);
    expect(
      segredos.filter((s) => s.group !== 'database').map((s) => s.name),
      'o único segredo que um job de DDL justifica é a credencial do banco em que ele ' +
        'aplica o DDL',
    ).toEqual([]);
    // Não vacuoso: o subset TEM segredos (DATABASE_URL, POSTGRES_PASSWORD).
    expect(segredos.length).toBeGreaterThan(0);
  });

  it('mantém o PISO: o migrator não pode perder o que ele comprovadamente lê', () => {
    const nomes = entriesForService('migrator').map((s) => s.name);
    for (const required of MIGRATOR_FLOOR) {
      expect(nomes, `${required} saiu do subset — sem ela o migrator não migra nada`).toContain(
        required,
      );
    }
  });

  it('o veredito único do guard: zero violações no contrato de hoje', () => {
    // A asserção que fica VERMELHA para qualquer uma das quatro classes acima,
    // e que é a MESMA chamada que `loadMigrationConfig()` faz no boot.
    expect(migratorSubsetViolations()).toEqual([]);
    expect(() => assertMigratorSubsetMinimal()).not.toThrow();
  });
});

describe('subset `migrator` — canários: o guard acusa quando há o que acusar', () => {
  it('acusa uma chave de aplicação acrescentada ao subset', () => {
    // Filtrado pela variável fabricada de propósito: o trabalho deste caso é
    // "o guard DETECTA", e ele não pode virar um segundo relatório sobre a
    // saúde do contrato — quem afirma isso é o bloco anterior.
    const regras = migratorSubsetViolations([...entriesForService('migrator'), CHAVE_DE_APLICACAO])
      .filter((p) => p.variable === CHAVE_DE_APLICACAO.name)
      .map((p) => p.rule);
    // Os TRÊS eixos acusam a mesma chave, e cada um sozinho já bastaria: são
    // independentes de propósito (um grupo mal declarado ainda cai no
    // namespace; um nome sem prefixo Maia ainda cai no grupo e no segredo).
    expect(regras).toContain('migrator/domain-foreign');
    expect(regras).toContain('migrator/namespace-foreign');
    expect(regras).toContain('migrator/secret-not-database');
  });

  it('a mensagem nomeia a variável e a regra, e nunca um valor', () => {
    let capturado: unknown;
    try {
      assertMigratorSubsetMinimal([...entriesForService('migrator'), CHAVE_DE_APLICACAO]);
    } catch (err) {
      capturado = err;
    }
    expect(capturado).toBeInstanceOf(MigratorSubsetError);
    const msg = (capturado as MigratorSubsetError).message;
    expect(msg).toContain(CHAVE_DE_APLICACAO.name);
    expect(msg).toContain('migrator/domain-foreign');
    expect(msg).toContain('src/config/contract.ts');
  });

  it('acusa a REMOÇÃO de uma chave do piso — falha fechado, não silenciosa', () => {
    const semDsn = entriesForService('migrator').filter((s) => !MIGRATOR_FLOOR.includes(s.name));
    const violacoes = migratorSubsetViolations(semDsn);
    expect(violacoes.map((p) => p.rule)).toContain('migrator/floor-missing');
    expect(violacoes.map((p) => p.variable)).toContain('DATABASE_URL');
  });

  it('acusa um piso que virou opcional — um DSN ausente tem de recusar o boot', () => {
    const dsnOpcional = entriesForService('migrator').map((s) =>
      s.name === 'DATABASE_URL' ? { ...s, requiredIn: undefined } : s,
    );
    expect(migratorSubsetViolations(dsnOpcional).map((p) => p.rule)).toContain(
      'migrator/floor-optional',
    );
  });
});

describe(`${EXEMPLO} — o arquivo que o recurso de migration separado recebe (#565)`, () => {
  const bruto = readFileSync(resolve(REPO_ROOT, EXEMPLO), 'utf8');
  const declarado = parseEnvFile(bruto);

  /** O que o operador preenche depois do `cp`. */
  const OPERADOR_PREENCHE: Readonly<Record<string, string>> = {
    DATABASE_URL: 'postgres://maia_prod:f4kepassw0rdf4ke@postgres:5432/maia',
    POSTGRES_USER: 'maia_prod',
    POSTGRES_PASSWORD: 'f4kepassw0rdf4ke',
  };

  it('não declara UMA chave sequer fora do subset `migrator`', () => {
    const permitido = new Set(entriesForService('migrator').map((s) => s.name));
    const foraDoSubset = Object.keys(declarado).filter((k) => !permitido.has(k));
    expect(
      foraDoSubset,
      `${EXEMPLO} declara variáveis que o migrator não pode ler: ${foraDoSubset.join(', ')}`,
    ).toEqual([]);
  });

  it('não menciona, nem comentada, nenhuma chave EXCLUSIVA de outro serviço', () => {
    // A prosa do cabeçalho lista categorias proibidas de propósito (é
    // documentação), então a busca é por linha de ATRIBUIÇÃO — comentada ou
    // não. Um `# ANTHROPIC_API_KEY=` no arquivo é um convite a descomentá-lo.
    const doMigrator = new Set(entriesForService('migrator').map((s) => s.name));
    const exclusivasDeOutros = CONTRACT_ENTRIES.filter((s) => !doMigrator.has(s.name)).map(
      (s) => s.name,
    );
    const atribuidas = [...bruto.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(
      (m) => m[1] as string,
    );
    const intrusas = exclusivasDeOutros.filter((n) => atribuidas.includes(n));
    expect(intrusas, `${EXEMPLO} traz linha de atribuição para: ${intrusas.join(', ')}`).toEqual([]);
  });

  it('declara TODA variável obrigatória no profile production', () => {
    const obrigatorias = manifestForService('migrator', 'production')
      .variables.filter((v) => v.required)
      .map((v) => v.name);
    expect(obrigatorias.length).toBeGreaterThan(0);
    for (const nome of obrigatorias) {
      expect(
        Object.keys(declarado),
        `${EXEMPLO} precisa declarar ${nome} sem comentário — ela é obrigatória em production`,
      ).toContain(nome);
    }
  });

  it('cru, ele REPROVA: os `__SET_ME__` são placeholders de verdade', () => {
    // Sem esta asserção o caso seguinte não significa nada: um exemplo que já
    // passasse cru seria um exemplo com credencial dentro.
    let capturado: unknown;
    try {
      loadMigrationConfig({ env: { ...declarado }, profile: 'production' });
    } catch (err) {
      capturado = err;
    }
    expect(capturado).toBeInstanceOf(ConfigValidationError);
    const regras = (capturado as ConfigValidationError).problems.map((p) => p.rule);
    expect(regras).toContain('secret/placeholder');
  });

  it('`cp` + preencher os `__SET_ME__` = migrator que sobe, com o subset e só ele', () => {
    const env: Record<string, string> = { ...declarado };
    for (const [k, v] of Object.entries(OPERADOR_PREENCHE)) {
      expect(env[k], `${k} deixou de ser um __SET_ME__ em ${EXEMPLO}`).toContain('__SET_ME__');
      env[k] = v;
    }
    const cfg = loadMigrationConfig({ env, profile: 'production' });
    expect(cfg.DATABASE_URL).toContain('postgres://');
    expect(cfg.POSTGRES_DB).toBe('maia');
    // Os tetos do runner chegam pelos defaults do contrato, sem o operador
    // precisar declarar nada.
    expect(cfg.MIGRATION_LOCK_WAIT_MS).toBe(30_000);
    // E nada de aplicação atravessa o loader.
    expect('ANTHROPIC_API_KEY' in cfg).toBe(false);
    expect('WHATSAPP_NUMBER_MAIA' in cfg).toBe(false);
    expect('BACKUP_S3_SECRET_KEY' in cfg).toBe(false);
    expect('NEXTAUTH_SECRET' in cfg).toBe(false);
  });
});
