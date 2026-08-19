/**
 * Os gates de boot do `admin-ui`, espelhados em `src/config/admin-boot-gates.ts`
 * (review de PR #595, achado [Alta] nº 1).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O que este arquivo tem de provar, e por quê
 * ─────────────────────────────────────────────────────────────────────────
 * Os pisos são CÓPIA — `src/admin-ui` está no `exclude` do `tsconfig.json` da
 * raiz e a regra do repositório proíbe importar naquela direção. Uma cópia sem
 * teste de paridade é uma cópia que deriva: alguém sobe
 * `MIN_OIDC_CLIENT_SECRET_LEN` para 24 no console, o preflight continua
 * afirmando 16, e o falso verde volta pela porta dos fundos.
 *
 * Então os casos de paridade LEEM `src/admin-ui/lib/auth-gating.ts` COMO TEXTO
 * e exigem a substring exata. É o mesmo padrão de
 * `src/ops/doctor/checks/config.ts` (PR #598) — e a razão de o módulo espelhado
 * morar em `src/config/` é justamente que o doctor possa importá-lo em vez de
 * manter uma TERCEIRA cópia.
 *
 * Ler texto é grosseiro de propósito: um `expect` sobre o comportamento exigiria
 * importar o módulo do console, que é o que não se pode fazer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  adminBootGateProblems,
  KNOWN_PLACEHOLDER_PATTERNS,
  MIN_NEXTAUTH_SECRET_LEN,
  MIN_OIDC_CLIENT_SECRET_LEN,
} from '@/config/admin-boot-gates.js';

const REPO_ROOT = resolve(__dirname, '../../..');
const GATING = readFileSync(resolve(REPO_ROOT, 'src/admin-ui/lib/auth-gating.ts'), 'utf8');

/** Um ambiente de produção que passa em todos os gates, para partir dele. */
function prodOk(over: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    NODE_ENV: 'production',
    NEXTAUTH_SECRET: 'n'.repeat(MIN_NEXTAUTH_SECRET_LEN + 8),
    OIDC_ISSUER: 'https://idp.example.com/realms/maia',
    OIDC_CLIENT_ID: 'maia-admin',
    OIDC_CLIENT_SECRET: 'c'.repeat(MIN_OIDC_CLIENT_SECRET_LEN + 8),
    OIDC_TENANT_SLUGS: 'primary',
    ...over,
  };
}

describe('admin boot gates — paridade com src/admin-ui/lib/auth-gating.ts', () => {
  it('espelha MIN_OIDC_CLIENT_SECRET_LEN', () => {
    expect(GATING).toContain(`export const MIN_OIDC_CLIENT_SECRET_LEN = ${MIN_OIDC_CLIENT_SECRET_LEN};`);
  });

  it('espelha o piso do NEXTAUTH_SECRET aplicado por resolveSecret()', () => {
    expect(GATING).toContain(`secret.length < ${MIN_NEXTAUTH_SECRET_LEN}`);
  });

  it('espelha cada padrão de placeholder, com a MESMA fonte de regex', () => {
    // O `.env.admin.prod.example` traz `__SET_ME__…` em NEXTAUTH_SECRET e em
    // OIDC_CLIENT_SECRET: sem os padrões, um operador que só alongasse o
    // placeholder passaria aqui e cairia no boot.
    for (const rx of KNOWN_PLACEHOLDER_PATTERNS) {
      expect(GATING, `padrão ${rx} não está mais em auth-gating.ts`).toContain(rx.source);
    }
  });

  it('não sobra padrão do lado do console que este módulo não conheça', () => {
    const bloco = GATING.slice(
      GATING.indexOf('const KNOWN_PLACEHOLDER_PATTERNS = ['),
      GATING.indexOf('];', GATING.indexOf('const KNOWN_PLACEHOLDER_PATTERNS = [')),
    );
    const noConsole = [...bloco.matchAll(/^\s*\/(.+)\/i,$/gm)].map((m) => m[1]!);
    expect(noConsole.length).toBeGreaterThan(0);
    expect(noConsole.sort()).toEqual(KNOWN_PLACEHOLDER_PATTERNS.map((r) => r.source).sort());
  });
});

describe('admin boot gates — a fronteira de profile é a do gate real', () => {
  it('fora de production não afirma nada: o console tolera e cai no provider de dev', () => {
    expect(adminBootGateProblems({ NODE_ENV: 'development', NEXTAUTH_SECRET: 'n'.repeat(4) })).toEqual([]);
  });

  it('em production, um ambiente completo e forte não tem problema algum', () => {
    expect(adminBootGateProblems(prodOk())).toEqual([]);
  });

  it('OIDC_ISSUER vazio é silêncio — é o estado de um deploy sem OIDC', () => {
    const problems = adminBootGateProblems(
      prodOk({ OIDC_ISSUER: '', OIDC_CLIENT_ID: '', OIDC_CLIENT_SECRET: '', OIDC_TENANT_SLUGS: '' }),
    );
    expect(problems).toEqual([]);
  });
});

describe('admin boot gates — a fresta entre o contrato e o boot', () => {
  it('pega o NEXTAUTH_SECRET que o contrato aceita (min(8)) e o console recusa', () => {
    const curto = 'n'.repeat(12);
    const problems = adminBootGateProblems(prodOk({ NEXTAUTH_SECRET: curto }));
    expect(problems.map((p) => p.variable)).toEqual(['NEXTAUTH_SECRET']);
    expect(problems[0]!.message).toContain('12');
    // Comprimento é evidência; valor nunca é.
    expect(JSON.stringify(problems)).not.toContain(curto);
  });

  it('pega o OIDC_CLIENT_SECRET que o contrato aceita (só presença) e o console recusa', () => {
    const curto = 'c'.repeat(8);
    const problems = adminBootGateProblems(prodOk({ OIDC_CLIENT_SECRET: curto }));
    expect(problems.map((p) => p.variable)).toEqual(['OIDC_CLIENT_SECRET']);
    expect(JSON.stringify(problems)).not.toContain(curto);
  });

  it('pega o placeholder que passa no piso de comprimento', () => {
    const problems = adminBootGateProblems(
      prodOk({ NEXTAUTH_SECRET: `__SET_ME__${'x'.repeat(40)}` }),
    );
    expect(problems.map((p) => p.rule)).toEqual(['admin-boot/nextauth-secret-placeholder']);
  });

  it('pega issuer cleartext, client id vazio e lista de slugs vazia', () => {
    expect(
      adminBootGateProblems(prodOk({ OIDC_ISSUER: 'http://idp.example.com' })).map((p) => p.rule),
    ).toEqual(['admin-boot/oidc-issuer-https']);
    expect(adminBootGateProblems(prodOk({ OIDC_CLIENT_ID: '' })).map((p) => p.rule)).toEqual([
      'admin-boot/oidc-client-id-required',
    ]);
    expect(adminBootGateProblems(prodOk({ OIDC_TENANT_SLUGS: ' , ' })).map((p) => p.rule)).toEqual([
      'admin-boot/oidc-tenant-slugs-required',
    ]);
  });

  it('não para no primeiro: o operador conserta tudo numa passada', () => {
    const problems = adminBootGateProblems(
      prodOk({ NEXTAUTH_SECRET: 'n'.repeat(4), OIDC_CLIENT_SECRET: 'c'.repeat(2), OIDC_CLIENT_ID: '' }),
    );
    expect(problems.map((p) => p.variable).sort()).toEqual([
      'NEXTAUTH_SECRET',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
    ]);
  });
});
