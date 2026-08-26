/**
 * #637 (fatia B da épica #471) — A POLÍTICA DE FUSÃO DE RASCUNHOS, testada.
 *
 * A issue põe três saídas na mesa (um vence / os dois viram variantes / o
 * contrato é remarcado como indefinido) e avisa do risco: fundir dois contratos
 * incompatíveis produz uma spec que não descreve nenhum dos dois casos.
 *
 * O que este arquivo afirma:
 *
 *   1. NENHUM VENCE, nunca — nem o representante, nem o primeiro, nem o maior;
 *   2. compatíveis → UNIÃO, sem descartar campo nenhum;
 *   3. INCOMPATÍVEIS → `divergent`, SEM rascunho fundido, com o conflito
 *      NOMEADO (campo, lado, as duas expressões Zod, e de quem vieram);
 *   4. em nenhum caso um rascunho original é perdido: `variantes` traz todos.
 *
 * Os rascunhos aqui são RICOS de propósito. Em produção, hoje, `completeness` é
 * quase sempre `'name_only'` (o único produtor de ocorrências ligado não
 * conhece `attempted_args`), então a divergência quase não aparece — e é
 * exatamente por isso que ela é testada aqui, à mão, em vez de deixada para
 * quando começar a acontecer sozinha.
 */
import { describe, it, expect } from 'vitest';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';
import { MARCADOR_DE_RASCUNHO, type ContratoRascunho } from '@/cognition/tool-request/types.js';

const dm = moduloDeProducao(() => import('@/cognition/tool-request/draft-merge.js'));

const GAP = '11111111-1111-4111-8111-111111111111';

function rascunho(args: {
  nome: string;
  inputs?: Array<{ name: string; zod: string; required?: boolean; observed_in?: number }>;
  outputs?: Array<{ name: string; zod: string; required?: boolean; observed_in?: number }>;
}): ContratoRascunho {
  const inputs = (args.inputs ?? []).map((c) => ({
    name: c.name,
    zod: c.zod,
    required: c.required ?? true,
    observed_in: c.observed_in ?? 1,
  }));
  const outputs = (args.outputs ?? []).map((c) => ({
    name: c.name,
    zod: c.zod,
    required: c.required ?? true,
    observed_in: c.observed_in ?? 1,
  }));
  return {
    proposed_tool_name: args.nome,
    completeness:
      inputs.length > 0 && outputs.length > 0
        ? 'inputs_and_outputs_observed'
        : inputs.length > 0 || outputs.length > 0
          ? 'partially_observed'
          : 'name_only',
    inputs,
    outputs,
    zod_source: `${MARCADOR_DE_RASCUNHO}\n// original de ${args.nome}`,
  };
}

describe('#637 — fusão de rascunhos: um pedido só', () => {
  it('um membro é `single` e o contrato é o dele, byte a byte', () => {
    const r = rascunho({ nome: 'emitir_guia', inputs: [{ name: 'competencia', zod: 'z.string()' }] });
    const f = dm().fundirRascunhos({
      membros: [{ origem: 'm1', rascunho: r }],
      gap_id_do_representante: GAP,
    });
    expect(f.estado).toBe('single');
    expect(f.rascunho).toBe(r);
    expect(f.conflitos).toEqual([]);
    expect(f.variantes).toHaveLength(1);
  });
});

describe('#637 — rascunhos COMPATÍVEIS: união, e nada descartado', () => {
  it('a união soma `observed_in` e mantém TODOS os campos dos dois lados', () => {
    const a = rascunho({
      nome: 'emitir_guia',
      inputs: [
        { name: 'competencia', zod: 'z.string()', observed_in: 3 },
        { name: 'cnpj', zod: 'z.string()', observed_in: 3 },
      ],
      outputs: [{ name: 'url', zod: 'z.string()', observed_in: 3 }],
    });
    const b = rascunho({
      nome: 'gerar_guia_recolhimento',
      inputs: [
        { name: 'competencia', zod: 'z.string()', observed_in: 2 },
        { name: 'municipio', zod: 'z.string()', observed_in: 2 },
      ],
      outputs: [{ name: 'url', zod: 'z.string()', observed_in: 2 }],
    });
    const f = dm().fundirRascunhos({
      membros: [
        { origem: 'm1', rascunho: a },
        { origem: 'm2', rascunho: b },
      ],
      gap_id_do_representante: GAP,
    });

    expect(f.estado).toBe('consistent');
    expect(f.conflitos).toEqual([]);
    const nomes = f.rascunho!.inputs.map((c) => c.name).sort();
    // NENHUM campo sumiu: `cnpj` só existia em A e `municipio` só em B.
    expect(nomes).toEqual(['cnpj', 'competencia', 'municipio']);
    const competencia = f.rascunho!.inputs.find((c) => c.name === 'competencia')!;
    expect(competencia.observed_in).toBe(5);
    expect(competencia.required).toBe(true); // presente e obrigatório nos dois
    // Presente em UM só: não pode ser exigido do dev com base no outro pedido.
    expect(f.rascunho!.inputs.find((c) => c.name === 'cnpj')!.required).toBe(false);
    expect(f.rascunho!.inputs.find((c) => c.name === 'municipio')!.required).toBe(false);
  });

  it('o nome do representante nomeia, mas o do outro NÃO é apagado', () => {
    const f = dm().fundirRascunhos({
      membros: [
        { origem: 'm1', rascunho: rascunho({ nome: 'emitir_guia' }) },
        { origem: 'm2', rascunho: rascunho({ nome: 'gerar_guia_recolhimento' }) },
      ],
      gap_id_do_representante: GAP,
    });
    expect(f.rascunho!.proposed_tool_name).toBe('emitir_guia');
    expect(f.nomes_propostos).toEqual(['emitir_guia', 'gerar_guia_recolhimento']);
    expect(f.rascunho!.zod_source).toContain('gerar_guia_recolhimento');
  });

  it('o `zod_source` fundido continua marcado como rascunho, e diz que é união', () => {
    const f = dm().fundirRascunhos({
      membros: [
        { origem: 'm1', rascunho: rascunho({ nome: 'emitir_guia' }) },
        { origem: 'm2', rascunho: rascunho({ nome: 'emitir_guia' }) },
      ],
      gap_id_do_representante: GAP,
    });
    // A marcação de três camadas da fatia A não pode ser enfraquecida pela B.
    expect(f.rascunho!.zod_source.startsWith(MARCADOR_DE_RASCUNHO)).toBe(true);
    expect(f.rascunho!.zod_source).toContain('NENHUMA tool foi registrada');
    expect(f.rascunho!.zod_source).toContain('UNIÃO de 2 pedidos');
  });

  it('dois rascunhos `name_only` fundem sem inventar campo — e continuam `name_only`', () => {
    // É o caso DOMINANTE hoje (limitação herdada da fatia A). Se a fusão
    // inventasse campo aqui, o dev desenharia contra evidência que não existe.
    const f = dm().fundirRascunhos({
      membros: [
        { origem: 'm1', rascunho: rascunho({ nome: 'emitir_guia' }) },
        { origem: 'm2', rascunho: rascunho({ nome: 'emitir_guia' }) },
      ],
      gap_id_do_representante: GAP,
    });
    expect(f.estado).toBe('consistent');
    expect(f.rascunho!.completeness).toBe('name_only');
    expect(f.rascunho!.inputs).toEqual([]);
    expect(f.rascunho!.outputs).toEqual([]);
  });

  it('um `name_only` ao lado de um rico não apaga o rico nem inventa nada', () => {
    const f = dm().fundirRascunhos({
      membros: [
        { origem: 'm1', rascunho: rascunho({ nome: 'emitir_guia' }) },
        {
          origem: 'm2',
          rascunho: rascunho({
            nome: 'emitir_guia',
            inputs: [{ name: 'competencia', zod: 'z.string()' }],
          }),
        },
      ],
      gap_id_do_representante: GAP,
    });
    expect(f.estado).toBe('consistent');
    expect(f.rascunho!.inputs.map((c) => c.name)).toEqual(['competencia']);
    // Observado num pedido só: opcional, nunca obrigatório.
    expect(f.rascunho!.inputs[0]!.required).toBe(false);
  });
});

describe('#637 — rascunhos INCOMPATÍVEIS: divergente, e ninguém vence', () => {
  const A = rascunho({
    nome: 'emitir_guia',
    inputs: [{ name: 'competencia', zod: 'z.string()' }],
  });
  const B = rascunho({
    nome: 'emitir_guia',
    inputs: [{ name: 'competencia', zod: 'z.number().int()' }],
  });

  it('o mesmo campo com tipos diferentes NÃO produz contrato fundido', () => {
    const f = dm().fundirRascunhos({
      membros: [
        { origem: 'm1', rascunho: A },
        { origem: 'm2', rascunho: B },
      ],
      gap_id_do_representante: GAP,
    });
    expect(f.estado).toBe('divergent');
    // O ponto da issue: não existe spec que descreva os dois casos, então NÃO
    // se produz spec. Nem a do representante, nem um "melhor esforço".
    expect(f.rascunho).toBeNull();
  });

  it('o conflito é NOMEADO — campo, lado, as duas expressões e de quem vieram', () => {
    const f = dm().fundirRascunhos({
      membros: [
        { origem: 'm1', rascunho: A },
        { origem: 'm2', rascunho: B },
      ],
      gap_id_do_representante: GAP,
    });
    expect(f.conflitos).toEqual([
      {
        lado: 'input',
        campo: 'competencia',
        zods: ['z.number().int()', 'z.string()'],
        origens: [['m2'], ['m1']],
      },
    ]);
  });

  it('nem o representante nem o mais observado vence — a ordem não muda o veredito', () => {
    const direta = dm().fundirRascunhos({
      membros: [
        { origem: 'm1', rascunho: A },
        { origem: 'm2', rascunho: B },
      ],
      gap_id_do_representante: GAP,
    });
    const invertida = dm().fundirRascunhos({
      membros: [
        { origem: 'm2', rascunho: B },
        { origem: 'm1', rascunho: A },
      ],
      gap_id_do_representante: GAP,
    });
    expect(direta.estado).toBe('divergent');
    expect(invertida.estado).toBe('divergent');
    expect(direta.conflitos).toEqual(invertida.conflitos);
  });

  it('OS DOIS RASCUNHOS SOBREVIVEM como variantes — a fusão não apaga evidência', () => {
    const f = dm().fundirRascunhos({
      membros: [
        { origem: 'm1', rascunho: A },
        { origem: 'm2', rascunho: B },
      ],
      gap_id_do_representante: GAP,
    });
    expect(f.variantes.map((v) => v.origem)).toEqual(['m1', 'm2']);
    expect(f.variantes[0]!.rascunho).toBe(A);
    expect(f.variantes[1]!.rascunho).toBe(B);
  });

  it('conflito na SAÍDA também diverge — os dois lados do contrato valem igual', () => {
    const f = dm().fundirRascunhos({
      membros: [
        { origem: 'm1', rascunho: rascunho({ nome: 't', outputs: [{ name: 'url', zod: 'z.string()' }] }) },
        {
          origem: 'm2',
          rascunho: rascunho({ nome: 't', outputs: [{ name: 'url', zod: 'z.array(z.unknown())' }] }),
        },
      ],
      gap_id_do_representante: GAP,
    });
    expect(f.estado).toBe('divergent');
    expect(f.conflitos[0]!.lado).toBe('output');
  });

  it('UM conflito basta: o resto compatível não salva o contrato', () => {
    const f = dm().fundirRascunhos({
      membros: [
        {
          origem: 'm1',
          rascunho: rascunho({
            nome: 't',
            inputs: [
              { name: 'cnpj', zod: 'z.string()' },
              { name: 'valor', zod: 'z.number()' },
            ],
          }),
        },
        {
          origem: 'm2',
          rascunho: rascunho({
            nome: 't',
            inputs: [
              { name: 'cnpj', zod: 'z.string()' },
              { name: 'valor', zod: 'z.string()' },
            ],
          }),
        },
      ],
      gap_id_do_representante: GAP,
    });
    expect(f.estado).toBe('divergent');
    expect(f.rascunho).toBeNull();
    expect(f.conflitos.map((c) => c.campo)).toEqual(['valor']);
  });

  it('agregado sem membro nenhum não existe — e falhar alto é melhor que fingir', () => {
    expect(() =>
      dm().fundirRascunhos({ membros: [], gap_id_do_representante: GAP }),
    ).toThrow(/nenhum membro/);
  });
});
