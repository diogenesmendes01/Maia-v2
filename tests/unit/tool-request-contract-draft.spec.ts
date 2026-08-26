/**
 * #636 (fatia A da épica #471) — o rascunho de contrato Zod, e a MARCAÇÃO que
 * impede confundi-lo com contrato vigente.
 *
 * O que estes casos protegem, em ordem de importância:
 *
 *  1. a marcação (`spec_kind` + `contract_status` + o cabeçalho literal de
 *     `zod_source`) é OBRIGATÓRIA — tirar qualquer uma reprova aqui;
 *  2. os campos do rascunho são DERIVADOS de evidência, nunca imaginados;
 *  3. a derivação é determinística (mesma evidência, mesmo rascunho).
 */
import { describe, it, expect } from 'vitest';
import {
  construirRascunhoDeContrato,
  derivarCampos,
  inferirZod,
  renderizarZodSource,
} from '@/cognition/tool-request/contract-draft.js';
import {
  MARCADOR_DE_RASCUNHO,
  TOOL_REQUEST_CONTRACT_STATUS,
  TOOL_REQUEST_GUARDRAIL,
  ToolRequestSpecSchema,
  eRascunhoDeProposta,
} from '@/cognition/tool-request/types.js';
import type { AgentCapabilityGapObservation } from '@/db/schema.js';

const GAP_ID = '11111111-1111-4111-8111-111111111111';

function obs(
  over: Partial<AgentCapabilityGapObservation> = {},
): AgentCapabilityGapObservation {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    tenant_id: 't1',
    agent_id: 'a1',
    gap_id: GAP_ID,
    intent: 'consultar estoque do produto',
    detail: null,
    conversa_id: null,
    root_trace_id: null,
    trace_id: null,
    attempted_args: {},
    expected_output: {},
    observed_at: new Date('2026-08-01T00:00:00Z'),
    created_at: new Date('2026-08-01T00:00:00Z'),
    ...over,
  } as AgentCapabilityGapObservation;
}

/** Um spec completo e válido, para que cada caso mexa em UMA coisa só. */
function specValido() {
  return {
    spec_kind: 'tool_request' as const,
    spec_version: 1 as const,
    contract_status: TOOL_REQUEST_CONTRACT_STATUS,
    guardrail: TOOL_REQUEST_GUARDRAIL,
    gap_id: GAP_ID,
    intent: 'consultar estoque do produto',
    situations: [],
    frequency: {
      occurrences: 2,
      window_days: 3,
      first_observed_at: '2026-08-01T00:00:00.000Z',
      last_observed_at: '2026-08-04T00:00:00.000Z',
      gap_frequency_score: 5,
      gap_severity_score: 6,
    },
    contract_draft: construirRascunhoDeContrato({
      proposed_tool_name: 'consultar_estoque',
      gap_id: GAP_ID,
      observacoes: [obs()],
    }),
  };
}

describe('#636 — inferência de tipo Zod a partir do valor observado', () => {
  it('mapeia os tipos JSON sem apertar o contrato além da evidência', () => {
    expect(inferirZod('abc')).toBe('z.string()');
    expect(inferirZod(3)).toBe('z.number().int()');
    expect(inferirZod(3.5)).toBe('z.number()');
    expect(inferirZod(true)).toBe('z.boolean()');
    expect(inferirZod(null)).toBe('z.unknown().nullable()');
    expect(inferirZod([1, 2])).toBe('z.array(z.unknown())');
    expect(inferirZod({ a: 1 })).toBe('z.object({}).passthrough()');
  });
});

describe('#636 — campos derivados de evidência', () => {
  it('required só quando a chave aparece em TODAS as ocorrências', () => {
    const campos = derivarCampos([
      { produto_id: 'p1', deposito: 'sp' },
      { produto_id: 'p2' },
    ]);
    const porNome = new Map(campos.map((c) => [c.name, c]));
    expect(porNome.get('produto_id')).toMatchObject({ required: true, observed_in: 2 });
    expect(porNome.get('deposito')).toMatchObject({ required: false, observed_in: 1 });
  });

  it('tipo conflitante entre ocorrências vira z.unknown(), não a última vista', () => {
    const campos = derivarCampos([{ qtd: 3 }, { qtd: 'tres' }]);
    expect(campos[0]).toMatchObject({ name: 'qtd', zod: 'z.unknown()' });
  });

  it('ordem determinística: mais observadas primeiro, empate por nome', () => {
    const a = derivarCampos([{ z: 1, a: 1 }, { a: 1 }]);
    const b = derivarCampos([{ a: 1, z: 1 }, { a: 1 }]);
    expect(a.map((c) => c.name)).toEqual(['a', 'z']);
    expect(b.map((c) => c.name)).toEqual(a.map((c) => c.name));
  });

  it('sem argumentos observados NÃO inventa campos', () => {
    expect(derivarCampos([{}, {}])).toEqual([]);
  });

  it('nenhum campo carrega VALOR observado (attempted_args vem de turno real)', () => {
    const campos = derivarCampos([{ cpf: '123.456.789-00' }]);
    expect(JSON.stringify(campos)).not.toContain('123.456.789-00');
    expect(Object.keys(campos[0]!).sort()).toEqual([
      'name',
      'observed_in',
      'required',
      'zod',
    ]);
  });
});

describe('#636 — o rascunho declara o que sabe', () => {
  it('sem evidência de argumentos: completeness=name_only e o texto DIZ isso', () => {
    const d = construirRascunhoDeContrato({
      proposed_tool_name: 'consultar_estoque',
      gap_id: GAP_ID,
      observacoes: [obs(), obs()],
    });
    expect(d.completeness).toBe('name_only');
    expect(d.inputs).toEqual([]);
    expect(d.zod_source).toContain('entradas NÃO OBSERVADAS');
  });

  it('com evidência dos dois lados: inputs_and_outputs_observed', () => {
    const d = construirRascunhoDeContrato({
      proposed_tool_name: 'consultar_estoque',
      gap_id: GAP_ID,
      observacoes: [
        obs({ attempted_args: { produto_id: 'p1' }, expected_output: { quantidade: 4 } }),
      ],
    });
    expect(d.completeness).toBe('inputs_and_outputs_observed');
    expect(d.inputs.map((i) => i.name)).toEqual(['produto_id']);
    expect(d.outputs.map((o) => o.name)).toEqual(['quantidade']);
  });

  it('é determinístico: mesma evidência, mesmo rascunho', () => {
    const args = {
      proposed_tool_name: 'consultar_estoque',
      gap_id: GAP_ID,
      observacoes: [obs({ attempted_args: { b: 1, a: 'x' } }), obs({ attempted_args: { a: 'y' } })],
    };
    expect(construirRascunhoDeContrato(args)).toEqual(construirRascunhoDeContrato(args));
  });
});

describe('#636 — a MARCAÇÃO de rascunho', () => {
  it('zod_source abre com o marcador e diz que nada foi registrado', () => {
    const fonte = renderizarZodSource({
      proposed_tool_name: 'consultar_estoque',
      inputs: [],
      outputs: [],
      ocorrencias: 3,
      gap_id: GAP_ID,
    });
    expect(fonte.startsWith(MARCADOR_DE_RASCUNHO)).toBe(true);
    expect(fonte).toContain('NENHUMA tool foi registrada');
  });

  it('o schema RECUSA um zod_source sem o marcador no topo', () => {
    const spec = specValido();
    spec.contract_draft.zod_source = spec.contract_draft.zod_source.replace(
      MARCADOR_DE_RASCUNHO,
      '// contrato',
    );
    expect(ToolRequestSpecSchema.safeParse(spec).success).toBe(false);
  });

  it('o schema RECUSA um spec sem contract_status de rascunho', () => {
    const spec = { ...specValido(), contract_status: 'active' };
    expect(ToolRequestSpecSchema.safeParse(spec).success).toBe(false);
  });

  it('o schema RECUSA chave desconhecida (.strict em todos os níveis)', () => {
    const spec = { ...specValido(), instalar: true };
    expect(ToolRequestSpecSchema.safeParse(spec).success).toBe(false);
  });

  it('o spec bem formado passa, e eRascunhoDeProposta o reconhece', () => {
    const spec = specValido();
    expect(ToolRequestSpecSchema.safeParse(spec).success).toBe(true);
    expect(eRascunhoDeProposta(spec)).toBe(true);
  });

  it('eRascunhoDeProposta NÃO se deixa convencer só pelo spec_kind', () => {
    expect(eRascunhoDeProposta({ spec_kind: 'tool_request', contract_status: 'active' })).toBe(
      false,
    );
    expect(eRascunhoDeProposta(null)).toBe(false);
    expect(eRascunhoDeProposta('tool_request')).toBe(false);
  });
});
