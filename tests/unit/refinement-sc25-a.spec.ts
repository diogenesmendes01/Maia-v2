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
  INFERENCE_REQUEST_HEADER_PREFIXES,
  INFERENCE_REQUEST_HEADERS_ALLOWED,
  PINNED_SDK_AUX_ROUTES_ALLOWED_OUTSIDE_RELAY,
  PINNED_SDK_DEFAULT_OUTPUT_LIMIT_FIELD,
  PINNED_SDK_FAMILIES,
  PINNED_SDK_MESSAGE_ROLES,
  PINNED_SDK_OUTPUT_LIMIT_FIELDS,
  PINNED_SDK_REQUEST_HEADERS,
  PINNED_SDK_TOP_LEVEL_FIELDS,
  PinnedSdkSurfaceDriftError,
  assertPinnedSdkSurfaceReady,
  checkInferenceRequestHeaders,
  checkPinnedSdkSurface,
} from '@/integrations/hermes/inference-sdk-surface.js';
import { validate } from '../helpers/json-schema-validator.js';

const REPO = resolve(process.cwd());
const FIXTURE = resolve(REPO, 'tests/fixtures/d09-sdk-requests.json');
const PYTHON = process.env.MAIA_HERMES_WORKER_PYTHON;
const UPSTREAM = process.env.MAIA_HERMES_UPSTREAM;
const d = PYTHON && UPSTREAM ? describe : describe.skip;

type Call = {
  class: string;
  top_level_fields: string[];
  message_roles: string[];
  output_limit_field: string | null;
  headers: string[];
  messages: Array<{ role: string; fields: string[]; types: Record<string, string[]> }>;
  tool_object_fields: string[];
  tool_function_fields: string[];
  tool_call_fields: string[];
  tool_call_function_fields: string[];
  stream_options_fields: string[];
};
type Fixture = {
  version: number;
  hermes_sha: string;
  calls: Call[];
  headers: {
    observed: string[];
    allowed: string[];
    allowed_prefixes: string[];
  };
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

/**
 * Reconstrução ESTRUTURAL de um corpo a partir da captura redigida: preenche os
 * campos que a fixture guardou (topo, mensagens por papel, tools, tool_calls,
 * stream_options) com valores do TIPO observado. Não é o corpo original — o
 * original tem texto de conversa e não é guardado —, mas tem a mesma FORMA, que
 * é o que o `request_schema` describe.
 */
function corpoDaCall(call: Call): Record<string, unknown> {
  const porCampo: Record<string, unknown> = {
    model: 'maia-stub-model',
    stream: true,
    max_tokens: 64,
    max_completion_tokens: 64,
    stream_options: Object.fromEntries((call.stream_options_fields ?? []).map((f) => [f, true])),
  };
  const body: Record<string, unknown> = {};
  for (const campo of call.top_level_fields) body[campo] = porCampo[campo] ?? {};
  body.messages = call.messages.map((m) => {
    const msg: Record<string, unknown> = { role: m.role };
    for (const campo of m.fields) {
      if (campo === 'role') continue;
      const tipo = m.types[campo]?.[0];
      if (campo === 'tool_calls') {
        msg.tool_calls = [
          { id: 'call_1', type: 'function', function: { name: 'fixture_echo', arguments: '{}' } },
        ];
      } else if (campo === 'tool_call_id') msg.tool_call_id = 'call_1';
      else msg[campo] = tipo === 'string' ? 'texto redigido' : tipo === 'null' ? null : {};
    }
    return msg;
  });
  if (call.top_level_fields.includes('tools')) {
    const fn: Record<string, unknown> = {};
    for (const campo of call.tool_function_fields) {
      fn[campo] = campo === 'parameters' ? {} : campo === 'name' ? 'fixture_echo' : 'Ecoa o texto.';
    }
    body.tools = [{ type: 'function', function: fn }];
  }
  return body;
}

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

  it('AC04 — o `request_schema` da fixture ACEITA os corpos que ela capturou', () => {
    // Reconstrução ESTRUTURAL de cada corpo a partir da própria fixture: o
    // schema não pode recusar o que ele descreve (era exatamente o defeito:
    // `messages.items` fechado em `{role}` recusava `content`/`tool_calls`).
    for (const call of fixture.calls) {
      const corpo = corpoDaCall(call);
      const resultado = validate(fixture.request_schema, corpo);
      expect(resultado.errors, `request_schema recusou a chamada ${call.class} #${call.top_level_fields.length}`).toEqual(
        [],
      );
    }
    // E o schema MORDE: campo a mais em cada nível fechado REPROVA.
    const base = corpoDaCall(fixture.calls[0]!);
    expect(validate(fixture.request_schema, { ...base, response_format: { type: 'json_object' } }).valid).toBe(false);
    const mensagemMagra = {
      ...base,
      messages: [{ role: 'assistant', content: 'x', tool_call_id: 'call_1' }],
    };
    expect(validate(fixture.request_schema, mensagemMagra).valid).toBe(false);
    const funcaoMagra = {
      ...base,
      tools: [{ type: 'function', function: { name: 'fixture_echo', parameters: {} } }],
    };
    expect(validate(fixture.request_schema, funcaoMagra).valid).toBe(false);
    expect(
      validate(fixture.request_schema, { ...base, messages: [{ role: 'orchestrator', content: 'x' }] }).valid,
    ).toBe(false);
  });

  it('AC03 — a lista de headers é fechada, cobre o cliente pinado e RECUSA o resto', () => {
    // A lista commitada é a do código: as duas não podem drifar sozinhas.
    expect(fixture.headers.allowed).toEqual([...INFERENCE_REQUEST_HEADERS_ALLOWED].sort());
    expect(fixture.headers.allowed_prefixes).toEqual([...INFERENCE_REQUEST_HEADER_PREFIXES].sort());
    // TODO header observado no cliente pinado é admitido (nome exato ou prefixo).
    const apresentados = Object.fromEntries(fixture.headers.observed.map((h) => [h, 'x']));
    expect(checkInferenceRequestHeaders(apresentados)).toEqual({ ok: true, refused: [] });
    expect(fixture.headers.observed).toContain('authorization');
    expect(fixture.headers.observed.some((h) => h.startsWith('x-stainless-'))).toBe(true);
    // O contrato ESTÁTICO (medido e commitado) é IGUAL ao que a captura guardou:
    // o par de `PINNED_SDK_TOP_LEVEL_FIELDS`, agora para headers.
    expect(fixture.headers.observed).toEqual([...PINNED_SDK_REQUEST_HEADERS].sort());
    // Os headers que a QA usou para reprovar a AC03 são RECUSADOS — todos, e
    // com o nome relatado (o achado é nomeado, não genérico).
    const proibidos = ['x-maia-tenant', 'x-provider-base-url', 'x-model', 'openai-organization', 'x-session-id'];
    const veredito = checkInferenceRequestHeaders({
      'content-type': 'application/json',
      authorization: 'Bearer x',
      ...Object.fromEntries(proibidos.map((h) => [h, 'v'])),
    });
    expect(veredito.ok).toBe(false);
    expect(veredito.refused).toEqual([...proibidos].sort());
    // E o drift do cliente (header que a rota recusaria) entra no MESMO veredito.
    expect(checkPinnedSdkSurface({ hermes_sha: HERMES_PINNED_SDK_SHA, observed_headers: ['x-model'] })).toEqual({
      ok: false,
      findings: [{ kind: 'observed_header_not_allowed', header: 'x-model' }],
    });
    expect(
      checkPinnedSdkSurface({ hermes_sha: HERMES_PINNED_SDK_SHA, observed_headers: fixture.headers.observed }),
    ).toEqual({ ok: true, checked_requests: 0 });
  });

  it('readiness: REPROVA quando um header do cliente pinado cai da lista fechada', () => {
    expect(() => assertPinnedSdkSurfaceReady()).not.toThrow();
    const estreitada = (INFERENCE_REQUEST_HEADERS_ALLOWED as readonly string[]).filter(
      (h) => h !== 'user-agent',
    );
    let erro: unknown;
    try {
      assertPinnedSdkSurfaceReady({ admitted_headers: estreitada });
    } catch (err) {
      erro = err;
    }
    expect(erro).toBeInstanceOf(PinnedSdkSurfaceDriftError);
    expect((erro as PinnedSdkSurfaceDriftError).findings).toEqual([
      { kind: 'observed_header_not_allowed', header: 'user-agent' },
    ]);
    // Tirar a FAMÍLIA do SDK reprova os NOVE nomes `x-stainless-*` medidos.
    let erroPrefixo: unknown;
    try {
      assertPinnedSdkSurfaceReady({ admitted_header_prefixes: [] });
    } catch (err) {
      erroPrefixo = err;
    }
    expect(erroPrefixo).toBeInstanceOf(PinnedSdkSurfaceDriftError);
    const findings = (erroPrefixo as PinnedSdkSurfaceDriftError).findings;
    expect(findings).toHaveLength(9);
    expect(findings.every((f) => f.kind === 'observed_header_not_allowed')).toBe(true);
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