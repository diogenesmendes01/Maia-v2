/**
 * P06 (spec §9.1, §6.10 itens 6-7; K-09; T18) — o CONTRATO do gateway de
 * inferência e a POLÍTICA de validação de grant.
 *
 * `src/integrations/hermes/inference-gateway.ts` é a fatia PURA do §9.1: o
 * schema fechado do pedido, o vocabulário de erro do §9.1 e a validação de
 * grant. Nenhum servidor, nenhuma rota, nenhum repositório — por isso tudo
 * abaixo é respondível sem Postgres, sem Redis e sem provider.
 *
 * O que este arquivo cobra, e que nenhum compilador cobra:
 *
 *   1. o schema é FECHADO — parâmetro desconhecido falha com
 *      `unsupported_parameter` ANTES de encaminhar (§9.1 "Campos admitidos"),
 *      e não é ignorado. K-09: este é o ÚNICO HTTP novo do filho, então um
 *      campo tolerado aqui é superfície de egresso tolerada;
 *   2. nenhum campo do CORPO escolhe tenant/autoridade. O §9.1 e o §6.10 item 7
 *      nomeiam `user`, `metadata` e session ID em letras; o schema os recusa em
 *      vez de ignorá-los, como `protocol.ts` já faz com `api_key`;
 *   3. conteúdo é TEXTO — imagem, áudio, upload e URL remota ficam fora do
 *      piloto textual (§9.1), e ficar "fora" tem de ser recusa, não silêncio;
 *   4. T18: grant ausente, com audience errada ou expirado produz recusa
 *      autenticada SANITIZADA e INDISTINGUÍVEL — o corpo não pode dizer qual
 *      dos três foi, porque isso responderia "este run existe?" a quem não
 *      apresentou credencial válida;
 *   5. a recusa não consulta nada: o tipo de entrada NÃO CONSEGUE EXPRESSAR
 *      pessoa/conversa/business, então nenhum call site consegue consultá-las
 *      antes de autenticar ("nenhuma consulta business", T18);
 *   6. o módulo é PURO de verdade — verificado lendo o fonte como TEXTO, como
 *      o contrato de `poison-policy`/`recovery` já faz nesta casa.
 *
 * Puro: nenhum caso toca banco, fila, rede ou provider.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  INFERENCE_GATEWAY_BASE_PATH,
  INFERENCE_GATEWAY_COMPLETIONS_PATH,
  INFERENCE_ADMITTED_FIELDS,
  INFERENCE_RESERVED_AUTHORITY_FIELDS,
  INFERENCE_ERROR_STATUS,
  INFERENCE_LIMITS,
  parseInferenceRequest,
  toWireError,
  validateInferenceGrant,
  type InferenceGrantV1,
  type InferenceRequestContextV1,
} from '@/integrations/hermes/inference-gateway.js';

const raiz = resolve(__dirname, '../..');
const fonte = readFileSync(
  resolve(raiz, 'src/integrations/hermes/inference-gateway.ts'),
  'utf8',
);

/** Pedido MÍNIMO e válido: só os campos que o §9.1 admite. */
function req(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-4o-mini-pinned',
    messages: [
      { role: 'system', content: 'você é um agente de teste' },
      { role: 'user', content: 'olá' },
    ],
    ...over,
  };
}

const AGORA = '2026-09-16T12:00:00.000Z';
const RUN = '11111111-1111-4111-8111-111111111111';
const AUDIENCE = `maia.hermes.inference.v1:${RUN}`;

/** Grant VIVO, com audience correta. */
function grant(over: Partial<InferenceGrantV1> = {}): InferenceGrantV1 {
  return {
    run_id: RUN,
    tenant_id: 'tenant-a',
    agent_id: 'agente-a',
    control_epoch: '7',
    audience: AUDIENCE,
    model: 'gpt-4o-mini-pinned',
    manifest_digest: 'a'.repeat(64),
    allowed_tool_names: [],
    expires_at: '2026-09-16T12:30:00.000Z',
    revoked_at: null,
    max_inference_calls: 10,
    ...over,
  };
}

/** Contexto do request: o que o transporte apresentou, e nada de business. */
function ctx(over: Partial<InferenceRequestContextV1> = {}): InferenceRequestContextV1 {
  return {
    presented_audience: AUDIENCE,
    now: AGORA,
    run_phase: 'running',
    calls_so_far: 0,
    model_requested: 'gpt-4o-mini-pinned',
    manifest_digest_effective: 'a'.repeat(64),
    tool_names_requested: [],
    ...over,
  };
}

describe('P06 — rota e campos admitidos (§9.1)', () => {
  it('1. a base URL e o path são os do contrato, não inventados', () => {
    expect(INFERENCE_GATEWAY_BASE_PATH).toBe('/internal/hermes-inference/v1');
    expect(INFERENCE_GATEWAY_COMPLETIONS_PATH).toBe(
      '/internal/hermes-inference/v1/chat/completions',
    );
    expect(INFERENCE_GATEWAY_COMPLETIONS_PATH.startsWith(INFERENCE_GATEWAY_BASE_PATH)).toBe(
      true,
    );
  });

  it('2. a lista de campos admitidos é EXATAMENTE a do §9.1', () => {
    expect([...INFERENCE_ADMITTED_FIELDS].sort()).toEqual(
      [
        'max_tokens',
        'messages',
        'model',
        'stream',
        'stream_options',
        'temperature',
        'tool_choice',
        'tools',
        'top_p',
      ].sort(),
    );
  });

  it('3. pedido mínimo válido passa', () => {
    expect(parseInferenceRequest(req()).kind).toBe('ok');
  });

  it('4. todos os campos admitidos, juntos, passam', () => {
    const r = parseInferenceRequest(
      req({
        tools: [
          {
            type: 'function',
            function: { name: 'consultar_saldo', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'auto',
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 1024,
        stream: false,
        stream_options: { include_usage: true },
      }),
    );
    expect(r.kind).toBe('ok');
  });
});

describe('P06 — passthrough irrestrito é recusado (K-09, §9.1)', () => {
  it('5. parâmetro desconhecido é `unsupported_parameter`, não ignorado', () => {
    const r = parseInferenceRequest(req({ frequency_penalty: 0.5 }));
    expect(r).toMatchObject({ kind: 'invalid', code: 'unsupported_parameter' });
  });

  it('6. o campo recusado é nomeado no diagnóstico, sem ecoar o valor', () => {
    const r = parseInferenceRequest(req({ seed: 42 }));
    if (r.kind !== 'invalid') throw new Error('esperava recusa');
    expect(r.field).toBe('seed');
    expect(JSON.stringify(r)).not.toContain('42');
  });

  it('7. CADA campo de autoridade nomeado pelo §9.1/§6.10 é recusado', () => {
    for (const campo of INFERENCE_RESERVED_AUTHORITY_FIELDS) {
      const r = parseInferenceRequest(req({ [campo]: 'tenant-b' }));
      // O `reason` é o que torna a lista de autoridade LOAD-BEARING: sem ele,
      // apagar a checagem de campo reservado passaria despercebida, porque a
      // checagem de campo desconhecido devolve o mesmo código.
      expect(
        r.kind === 'invalid' &&
          r.code === 'unsupported_parameter' &&
          r.reason === 'reserved_authority',
        `campo de autoridade aceito ou não classificado: ${campo}`,
      ).toBe(true);
    }
  });

  it('8. a lista de autoridade cobre os nomes que a spec cita em letras', () => {
    for (const nome of ['user', 'metadata', 'session_id', 'tenant_id']) {
      expect(INFERENCE_RESERVED_AUTHORITY_FIELDS as readonly string[]).toContain(nome);
    }
  });

  it('9. nenhum campo de autoridade está também na lista de admitidos', () => {
    for (const campo of INFERENCE_RESERVED_AUTHORITY_FIELDS) {
      expect(INFERENCE_ADMITTED_FIELDS as readonly string[]).not.toContain(campo);
    }
  });

  it('10. corpo que não é objeto JSON é `invalid_request`', () => {
    for (const lixo of [null, 'texto', 42, [], true]) {
      expect(parseInferenceRequest(lixo).kind).toBe('invalid');
    }
  });
});

describe('P06 — o piloto é TEXTUAL (§9.1)', () => {
  it('11. content em blocos (imagem/áudio/URL) é recusado', () => {
    const r = parseInferenceRequest(
      req({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://exemplo/x.png' } }],
          },
        ],
      }),
    );
    expect(r).toMatchObject({ kind: 'invalid', code: 'invalid_request' });
  });

  it('12. role fora do vocabulário do chat completions é recusada', () => {
    expect(parseInferenceRequest(req({ messages: [{ role: 'developer', content: 'x' }] })).kind).toBe(
      'invalid',
    );
  });

  it('13. par tool_call/tool_result textual é aceito', () => {
    const r = parseInferenceRequest(
      req({
        messages: [
          { role: 'user', content: 'qual o saldo?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'consultar_saldo', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{"saldo":10}' },
        ],
      }),
    );
    expect(r.kind).toBe('ok');
  });

  it('14. lista de mensagens vazia é recusada', () => {
    expect(parseInferenceRequest(req({ messages: [] })).kind).toBe('invalid');
  });

  it('15. chave desconhecida DENTRO de uma mensagem também é recusada', () => {
    const r = parseInferenceRequest(
      req({ messages: [{ role: 'user', content: 'oi', name: 'quem' }] }),
    );
    expect(r.kind).toBe('invalid');
  });
});

describe('P06 — limites são recusa determinística, nunca truncamento', () => {
  it('16. excesso de mensagens é `payload_too_large`', () => {
    const muitas = Array.from({ length: INFERENCE_LIMITS.max_messages + 1 }, () => ({
      role: 'user' as const,
      content: 'x',
    }));
    expect(parseInferenceRequest(req({ messages: muitas }))).toMatchObject({
      kind: 'invalid',
      code: 'payload_too_large',
    });
  });

  it('17. excesso de bytes totais é `payload_too_large`', () => {
    const gigante = 'x'.repeat(INFERENCE_LIMITS.max_total_bytes);
    expect(
      parseInferenceRequest(req({ messages: [{ role: 'user', content: gigante }] })),
    ).toMatchObject({ kind: 'invalid', code: 'payload_too_large' });
  });

  it('18. `max_tokens` acima do teto de saída é recusado', () => {
    expect(
      parseInferenceRequest(req({ max_tokens: INFERENCE_LIMITS.max_output_tokens + 1 })).kind,
    ).toBe('invalid');
  });

  it('19. o pedido no limite exato passa (a fronteira é verificada nos DOIS lados)', () => {
    expect(
      parseInferenceRequest(req({ max_tokens: INFERENCE_LIMITS.max_output_tokens })).kind,
    ).toBe('ok');
    const noLimite = Array.from({ length: INFERENCE_LIMITS.max_messages }, () => ({
      role: 'user' as const,
      content: 'x',
    }));
    expect(parseInferenceRequest(req({ messages: noLimite })).kind).toBe('ok');
  });

  it('20. excesso de tools é recusado', () => {
    const tools = Array.from({ length: INFERENCE_LIMITS.max_tools + 1 }, (_, i) => ({
      type: 'function',
      function: { name: `t${i}`, parameters: { type: 'object' } },
    }));
    // O CÓDIGO importa: sem ele, apagar o teto de tools passaria despercebido,
    // porque o `.max()` do Zod recusaria com `invalid_request` e o caso ainda
    // veria "invalid".
    expect(parseInferenceRequest(req({ tools }))).toMatchObject({
      kind: 'invalid',
      code: 'payload_too_large',
    });
  });
});

describe('P06 — vocabulário de erro do §9.1', () => {
  it('21. cada código tem o status HTTP que a spec fixa', () => {
    expect(INFERENCE_ERROR_STATUS.invalid_request).toBe(400);
    expect(INFERENCE_ERROR_STATUS.unsupported_parameter).toBe(400);
    expect(INFERENCE_ERROR_STATUS.invalid_inference_grant).toBe(401);
    expect(INFERENCE_ERROR_STATUS.run_revoked).toBe(403);
    expect(INFERENCE_ERROR_STATUS.model_not_allowed).toBe(403);
    expect(INFERENCE_ERROR_STATUS.tool_surface_mismatch).toBe(403);
    expect(INFERENCE_ERROR_STATUS.run_not_active).toBe(409);
    expect(INFERENCE_ERROR_STATUS.payload_too_large).toBe(413);
    expect(INFERENCE_ERROR_STATUS.budget_exhausted).toBe(429);
    expect(INFERENCE_ERROR_STATUS.inference_limit_exceeded).toBe(429);
    expect(INFERENCE_ERROR_STATUS.admission_unavailable).toBe(503);
    expect(INFERENCE_ERROR_STATUS.provider_unavailable).toBe(503);
  });

  it('22. o mapa não tem código a mais nem a menos que o §9.1', () => {
    expect(Object.keys(INFERENCE_ERROR_STATUS).sort()).toEqual(
      [
        'admission_unavailable',
        'budget_exhausted',
        'inference_limit_exceeded',
        'invalid_inference_grant',
        'invalid_request',
        'model_not_allowed',
        'payload_too_large',
        'provider_unavailable',
        'run_not_active',
        'run_revoked',
        'tool_surface_mismatch',
        'unsupported_parameter',
      ].sort(),
    );
  });
});

describe('T18 — grant ausente/expirado/audience errada: recusa sanitizada', () => {
  it('23. grant VIVO com audience correta é admitido', () => {
    expect(validateInferenceGrant(grant(), ctx())).toMatchObject({ kind: 'ok' });
  });

  it('24. grant AUSENTE é recusado com `invalid_inference_grant`', () => {
    expect(validateInferenceGrant(null, ctx())).toMatchObject({
      kind: 'refused',
      code: 'invalid_inference_grant',
    });
  });

  it('25. audience ERRADA é recusada', () => {
    expect(
      validateInferenceGrant(grant(), ctx({ presented_audience: 'maia.hermes.inference.v1:outro' })),
    ).toMatchObject({ kind: 'refused', code: 'invalid_inference_grant' });
  });

  it('26. audience AUSENTE é recusada (string vazia não autentica)', () => {
    expect(validateInferenceGrant(grant(), ctx({ presented_audience: '' }))).toMatchObject({
      kind: 'refused',
      code: 'invalid_inference_grant',
    });
  });

  it('26b. grant com audience VAZIA não autentica credencial vazia', () => {
    // Sem a guarda de vazio, duas AUSÊNCIAS seriam iguais entre si e um grant
    // malformado autenticaria quem não apresentou audience nenhuma.
    expect(
      validateInferenceGrant(grant({ audience: '' }), ctx({ presented_audience: '' })),
    ).toMatchObject({ kind: 'refused', code: 'invalid_inference_grant' });
  });

  it('27. grant EXPIRADO é recusado — inclusive por 1ms', () => {
    expect(
      validateInferenceGrant(grant({ expires_at: '2026-09-16T11:59:59.999Z' }), ctx()),
    ).toMatchObject({ kind: 'refused', code: 'invalid_inference_grant' });
  });

  it('28. grant que vence no instante EXATO ainda não venceu', () => {
    expect(validateInferenceGrant(grant({ expires_at: AGORA }), ctx())).toMatchObject({
      kind: 'ok',
    });
  });

  it('29. a recusa dos TRÊS casos do T18 é INDISTINGUÍVEL no fio', () => {
    const casos = [
      validateInferenceGrant(null, ctx()),
      validateInferenceGrant(grant(), ctx({ presented_audience: 'maia.hermes.inference.v1:outro' })),
      validateInferenceGrant(grant({ expires_at: '2026-09-16T11:00:00.000Z' }), ctx()),
    ];
    const fio = casos.map((r) => {
      if (r.kind !== 'refused') throw new Error('esperava recusa');
      return JSON.stringify(toWireError(r.code));
    });
    expect(new Set(fio).size).toBe(1);
  });

  it('30. o MOTIVO interno existe para auditoria, e NÃO viaja no corpo', () => {
    const expirado = validateInferenceGrant(
      grant({ expires_at: '2026-09-16T11:00:00.000Z' }),
      ctx(),
    );
    if (expirado.kind !== 'refused') throw new Error('esperava recusa');
    expect(expirado.audit_reason).toBe('expired');
    expect(JSON.stringify(toWireError(expirado.code))).not.toContain('expired');
  });

  it('31. os três casos têm motivos de auditoria DIFERENTES entre si', () => {
    const motivos = [
      validateInferenceGrant(null, ctx()),
      validateInferenceGrant(grant(), ctx({ presented_audience: 'maia.hermes.inference.v1:outro' })),
      validateInferenceGrant(grant({ expires_at: '2026-09-16T11:00:00.000Z' }), ctx()),
    ].map((r) => (r.kind === 'refused' ? r.audit_reason : 'ok'));
    expect(new Set(motivos).size).toBe(3);
  });

  it('32. o corpo sanitizado não carrega ids, audience nem instante', () => {
    const corpo = JSON.stringify(toWireError('invalid_inference_grant'));
    for (const vazamento of ['tenant-a', 'agente-a', RUN, 'maia.hermes.inference.v1', AGORA]) {
      expect(corpo).not.toContain(vazamento);
    }
  });
});

describe('T18 — revogação, estado do run, modelo e superfície', () => {
  it('33. grant REVOGADO é `run_revoked` (403), não 401', () => {
    expect(
      validateInferenceGrant(grant({ revoked_at: '2026-09-16T11:30:00.000Z' }), ctx()),
    ).toMatchObject({ kind: 'refused', code: 'run_revoked' });
  });

  it('34. revogação vence o estado do run', () => {
    expect(
      validateInferenceGrant(
        grant({ revoked_at: '2026-09-16T11:30:00.000Z' }),
        ctx({ run_phase: 'closed' }),
      ),
    ).toMatchObject({ kind: 'refused', code: 'run_revoked' });
  });

  it('35. run fora de `running` é `run_not_active` (409)', () => {
    for (const fase of ['prepared', 'submitting', 'result_ready', 'blocked', 'closed'] as const) {
      expect(
        validateInferenceGrant(grant(), ctx({ run_phase: fase })),
        `fase ${fase} não deveria liberar inferência`,
      ).toMatchObject({ kind: 'refused', code: 'run_not_active' });
    }
  });

  it('36. modelo diferente do aprovado é `model_not_allowed`', () => {
    expect(
      validateInferenceGrant(grant(), ctx({ model_requested: 'modelo-mais-caro' })),
    ).toMatchObject({ kind: 'refused', code: 'model_not_allowed' });
  });

  it('37. manifest digest divergente é `tool_surface_mismatch`', () => {
    expect(
      validateInferenceGrant(grant(), ctx({ manifest_digest_effective: 'b'.repeat(64) })),
    ).toMatchObject({ kind: 'refused', code: 'tool_surface_mismatch' });
  });

  it('38. tool fora do manifest é `tool_surface_mismatch`', () => {
    expect(
      validateInferenceGrant(
        grant({ allowed_tool_names: ['consultar_saldo'] }),
        ctx({ tool_names_requested: ['consultar_saldo', 'terminal_exec'] }),
      ),
    ).toMatchObject({ kind: 'refused', code: 'tool_surface_mismatch' });
  });

  it('39. subconjunto do manifest é aceito', () => {
    expect(
      validateInferenceGrant(
        grant({ allowed_tool_names: ['consultar_saldo', 'listar_contas'] }),
        ctx({ tool_names_requested: ['consultar_saldo'] }),
      ),
    ).toMatchObject({ kind: 'ok' });
  });

  it('40. teto de chamadas de inferência é `inference_limit_exceeded`', () => {
    expect(
      validateInferenceGrant(grant({ max_inference_calls: 3 }), ctx({ calls_so_far: 3 })),
    ).toMatchObject({ kind: 'refused', code: 'inference_limit_exceeded' });
  });

  it('41. a AUTENTICAÇÃO vem antes de tudo: grant ausente com modelo errado ainda é 401', () => {
    // Se a ordem invertesse, o corpo diria "modelo não permitido" a quem não
    // apresentou credencial — e isso é informação sobre o run.
    expect(
      validateInferenceGrant(null, ctx({ model_requested: 'modelo-errado', run_phase: 'closed' })),
    ).toMatchObject({ kind: 'refused', code: 'invalid_inference_grant' });
  });
});

describe('P06 — a ausência é o mecanismo', () => {
  it('42. o contexto do request NÃO CONSEGUE EXPRESSAR business (T18)', () => {
    const chaves = Object.keys(ctx());
    for (const proibida of ['pessoa_id', 'conversa_id', 'channel_id', 'remote_jid']) {
      expect(chaves).not.toContain(proibida);
    }
  });

  it('43. o módulo é PURO: nenhum import de banco, cache, config, log ou métrica', () => {
    for (const p of [
      '@/db/',
      '@/lib/redis',
      '@/config/',
      '@/lib/logger',
      '@/lib/metrics',
      'drizzle',
      'ioredis',
    ]) {
      expect(fonte.includes(`from '${p}`), `import proibido: ${p}`).toBe(false);
    }
  });

  it('44. o módulo não lê relógio próprio: `now` entra como parâmetro', () => {
    // Um `Date.now()` aqui dentro faria todo teste de expiração medir o
    // relógio do processo de teste em vez da regra.
    expect(fonte).not.toContain('Date.now()');
    expect(fonte).not.toContain('new Date()');
  });
});
