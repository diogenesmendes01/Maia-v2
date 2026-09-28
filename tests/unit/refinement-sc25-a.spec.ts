/**
 * SC25-A — contrato D09 (request efetivo do cliente pinado), lista auxiliar
 * permitida/negada e o gate de readiness.
 *
 * ─── O que só este arquivo cobre ────────────────────────────────────────────
 *
 * O spike `hermes-inference-d09-capture` MEDE o cliente real e escreve a
 * fixture; o teste de integração `refinement-sc25-a-real-db` prova o envelope
 * contra Postgres real. Aqui ficam as regras puras que os dois usam:
 *
 *  1. o contrato em `src/integrations/hermes/inference-sdk-surface.ts` é IGUAL
 *     ao que a fixture capturou — nenhum dos dois pode drifar sozinho;
 *  2. o gate RECUSA quando o gateway não admite um campo que o cliente envia
 *     (o cenário que a AC04 chama de "drift bloqueia readiness") e quando uma
 *     rota auxiliar aparece habilitada fora do relay;
 *  3. a lista auxiliar é a do PRÓPRIO worker Python, e o gate de lá devolve o
 *     mesmo veredito que o gate de readiness do worker (exit 2).
 *
 * ─── O que este teste NÃO é ────────────────────────────────────────────────
 *
 * Não é prova de integração: não há Postgres nem cliente real aqui. Os casos
 * que exigem o checkout pinado pulam sem `MAIA_HERMES_WORKER_PYTHON` e estão
 * marcados como pulados no relatório — pular não é passar.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INFERENCE_ADMITTED_FIELDS } from '@/integrations/hermes/inference-gateway.js';
import {
  HERMES_PINNED_SDK_SHA,
  PINNED_SDK_AUX_ROUTES_ALLOWED_OUTSIDE_RELAY,
  PINNED_SDK_DEFAULT_OUTPUT_LIMIT_FIELD,
  PINNED_SDK_FAMILIES,
  PINNED_SDK_MESSAGE_ROLES,
  PINNED_SDK_OUTPUT_LIMIT_FIELDS,
  PINNED_SDK_TOP_LEVEL_FIELDS,
  PinnedSdkSurfaceDriftError,
  assertPinnedSdkSurfaceReady,
  checkPinnedSdkSurface,
} from '@/integrations/hermes/inference-sdk-surface.js';

const REPO = resolve(process.cwd());
const FIXTURE = resolve(REPO, 'tests/hermes-spike/fixtures/d09-sdk-requests.json');
const PYTHON = process.env.MAIA_HERMES_WORKER_PYTHON;
const UPSTREAM = process.env.MAIA_HERMES_UPSTREAM;
const d = PYTHON && UPSTREAM ? describe : describe.skip;

type Call = { class: string; top_level_fields: string[]; message_roles: string[]; output_limit_field: string | null };
type Fixture = {
  version: number;
  hermes_sha: string;
  calls: Call[];
  request_schema: { additionalProperties: boolean; required: string[]; properties: Record<string, unknown> };
  aux_routes: {
    allowed: unknown[];
    denied: Array<{
      route: string;
      posture: string;
      path: string[];
      closed_value: unknown;
      off_literals: unknown[];
    }>;
  };
  aux_calls_observed: number;
  families: Record<string, { output_limit_field: string; system_role: string }>;
};

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

/** Executa o worker Python e devolve `{status, stdout, stderr}` sem lançar. */
function runWorkerCli(args: string[], stdin?: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(PYTHON as string, ['-m', 'services.hermes_worker.main', ...args], {
      cwd: REPO,
      encoding: 'utf8',
      input: stdin,
      env: { PATH: process.env.PATH ?? '', PYTHONPATH: `${UPSTREAM}:${REPO}`, PYTHONIOENCODING: 'utf-8' },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('SC25-A — contrato D09 e lista auxiliar (puro)', () => {
  it('o contrato pinado é IGUAL ao que a captura guardou', () => {
    const observados = Array.from(
      new Set(fixture.calls.flatMap((c) => c.top_level_fields)),
    ).sort();
    expect(observados).toEqual([...PINNED_SDK_TOP_LEVEL_FIELDS].sort());
    expect(Object.keys(fixture.request_schema.properties).sort()).toEqual(observados);
    expect(fixture.request_schema.required.sort()).toEqual(observados);
    expect(fixture.request_schema.additionalProperties).toBe(false);
    expect(fixture.hermes_sha).toBe(HERMES_PINNED_SDK_SHA);
    // Papéis: tudo que a captura viu está no vocabulário pinado.
    const papeis = Array.from(new Set(fixture.calls.flatMap((c) => c.message_roles))).sort();
    expect(papeis.every((p) => (PINNED_SDK_MESSAGE_ROLES as readonly string[]).includes(p))).toBe(true);
    // A família medida é a que o contrato declara.
    expect(fixture.families['gpt-5']!.output_limit_field).toBe(
      PINNED_SDK_FAMILIES['gpt-5']!.output_limit_field,
    );
    expect(fixture.families['gpt-5']!.system_role).toBe(PINNED_SDK_FAMILIES['gpt-5']!.system_role);
    // O teto default observado é `max_tokens` e os dois nomes são admitidos.
    const tetos = new Set(fixture.calls.map((c) => c.output_limit_field));
    expect(tetos.has(PINNED_SDK_DEFAULT_OUTPUT_LIMIT_FIELD)).toBe(true);
    for (const nome of PINNED_SDK_OUTPUT_LIMIT_FIELDS) {
      expect(INFERENCE_ADMITTED_FIELDS as readonly string[]).toContain(nome);
    }
    // Nenhuma rota auxiliar habilitada; a lista negada é a do worker.
    expect(fixture.aux_routes.allowed).toEqual([]);
    expect(PINNED_SDK_AUX_ROUTES_ALLOWED_OUTSIDE_RELAY).toEqual([]);
    expect(fixture.aux_calls_observed).toBe(0);
    expect(fixture.aux_routes.denied.map((r) => r.route)).toContain('compression');
    expect(fixture.aux_routes.denied.every((r) => r.posture === 'disabled')).toBe(true);
  });

  it('TODO campo que o cliente pinado envia é admitido pelo gateway', () => {
    const verdict = checkPinnedSdkSurface({ hermes_sha: HERMES_PINNED_SDK_SHA, requests: fixture.calls });
    expect(verdict).toEqual({ ok: true, checked_requests: fixture.calls.length });
    for (const field of PINNED_SDK_TOP_LEVEL_FIELDS) {
      expect(INFERENCE_ADMITTED_FIELDS as readonly string[]).toContain(field);
    }
  });

  it('drift: gateway que deixou de admitir um campo do cliente REPROVA com achado nomeado', () => {
    const estreitado = (INFERENCE_ADMITTED_FIELDS as readonly string[]).filter(
      (f) => f !== 'max_completion_tokens',
    );
    const verdict = checkPinnedSdkSurface({
      hermes_sha: HERMES_PINNED_SDK_SHA,
      requests: [
        { top_level_fields: ['model', 'messages', 'max_completion_tokens'], output_limit_field: 'max_completion_tokens' },
      ],
      admitted_fields: estreitado,
    });
    expect(verdict).toEqual({
      ok: false,
      findings: [{ kind: 'gateway_cannot_admit_field', field: 'max_completion_tokens' }],
    });
  });

  it('drift: campo que o contrato não pinou, teto com nome desconhecido e papel fora do vocabulário', () => {
    const verdict = checkPinnedSdkSurface({
      hermes_sha: HERMES_PINNED_SDK_SHA,
      requests: [
        {
          top_level_fields: ['model', 'response_format'],
          message_roles: ['orchestrator'],
          output_limit_field: 'max_new_tokens',
        },
      ],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('inesperado');
    expect(verdict.findings).toEqual([
      { kind: 'gateway_cannot_admit_field', field: 'response_format' },
      { kind: 'field_not_pinned', field: 'response_format' },
      { kind: 'role_not_admitted', role: 'orchestrator' },
      { kind: 'unpinned_output_limit_field', field: 'max_new_tokens' },
    ]);
  });

  it('drift: rota auxiliar habilitada fora do relay e SHA de outro checkout', () => {
    const verdict = checkPinnedSdkSurface({
      hermes_sha: 'f'.repeat(40),
      aux_allowed_outside_relay: ['compression'],
    });
    expect(verdict).toEqual({
      ok: false,
      findings: [
        { kind: 'hermes_sha_mismatch', observed: 'f'.repeat(40), pinned: HERMES_PINNED_SDK_SHA },
        { kind: 'aux_route_outside_relay', route: 'compression' },
      ],
    });
  });

  it('readiness: passa com o pin atual e REPROVA quando um campo do cliente cai da lista admitida', () => {
    expect(() => assertPinnedSdkSurfaceReady()).not.toThrow();
    let erro: unknown;
    try {
      assertPinnedSdkSurfaceReady({
        requests: [{ top_level_fields: ['model', 'response_format'], output_limit_field: 'max_tokens' }],
      });
    } catch (err) {
      erro = err;
    }
    expect(erro).toBeInstanceOf(PinnedSdkSurfaceDriftError);
    const findings = (erro as PinnedSdkSurfaceDriftError).findings;
    expect(findings.map((f) => f.kind)).toEqual(['gateway_cannot_admit_field', 'field_not_pinned']);
    // A mensagem é sanitizada: tipo de achado e nome de campo, nunca conteúdo.
    expect((erro as Error).message).toContain('pinned_sdk_surface_drift');
    expect((erro as Error).message).toContain('response_format');
  });
});

d('SC25-A — lista auxiliar do worker (checkout pinado)', () => {
  it('o dump da política é o MESMO que a fixture guarda', () => {
    const out = runWorkerCli(['--print-aux-policy']);
    expect(out.status).toBe(0);
    const policy = JSON.parse(out.stdout) as Fixture['aux_routes'];
    expect(policy.allowed).toEqual([]);
    expect(policy.denied).toEqual(fixture.aux_routes.denied);
    expect(policy.denied.every((r) => r.posture === 'disabled')).toBe(true);
    // E a ÂNCORA do gate: o valor declarado como fechado tem de estar entre os
    // valores de BLOQUEIO da rota. É o que impede que editar `closed_value`
    // (intencionalmente ou por acidente) reescreva o próprio gate.
    // Comparação por VALOR (`JSON.stringify`), não por identidade: `mcp_servers`
    // fecha com `{}`, e dois `{}` distintos não são `===`.
    const mesmoValor = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    expect(policy.denied.every((r) => r.off_literals.some((v) => mesmoValor(v, r.closed_value)))).toBe(
      true,
    );
    expect(
      policy.denied.every((r) => r.off_literals.length > 0 && r.route.length > 0),
    ).toBe(true);
  });

  it('o gate de auxiliares recusa config com rota aberta (exit 2) e aceita a fechada', () => {
    const fechada = {
      model: { context_length: 64000 },
      compression: { enabled: false },
      context: { engine: 'compressor' },
      tools: { tool_search: { enabled: 'off' } },
      memory: { memory_enabled: false, user_profile_enabled: false },
      mcp_servers: {},
    };
    expect(runWorkerCli(['--check-aux-config'], JSON.stringify(fechada)).status).toBe(0);

    const aberta = { ...fechada, compression: { enabled: true } };
    const recusa = runWorkerCli(['--check-aux-config'], JSON.stringify(aberta));
    expect(recusa.status).toBe(2);
    expect(recusa.stderr).toContain("rota auxiliar 'compression' fora do relay");

    // Chave ausente também recusa: ausência não é promessa de bloqueio.
    const semChave = { ...fechada } as Record<string, unknown>;
    delete semChave.compression;
    expect(runWorkerCli(['--check-aux-config'], JSON.stringify(semChave)).status).toBe(2);

    // Flag inventada não segue como se não existisse.
    expect(runWorkerCli(['--bogus']).status).toBe(4);
  });
});