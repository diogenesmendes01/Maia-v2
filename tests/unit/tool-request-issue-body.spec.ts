/**
 * #638 (fatia C da épica #471) — o que vai (e o que NÃO vai) para o corpo da
 * issue, e a chave que torna o aceite idempotente.
 *
 * Este arquivo importa `@/cognition/tool-request/issue-body.js` de produção e
 * chama as funções reais. Não há espelho: apagar `corpoDaIssue` derruba o
 * `beforeAll` do helper e reprova tudo aqui sem executar caso nenhum.
 */
import { describe, it, expect } from 'vitest';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const corpo = moduloDeProducao(() => import('@/cognition/tool-request/issue-body.js'));
const tipos = moduloDeProducao(() => import('@/cognition/tool-request/types.js'));

const T = 'wt638_body_tenant';
const AG = 'wt638_body_agent';
const AGG = '11111111-2222-3333-4444-555555555555';

function agregado(over: Record<string, unknown> = {}) {
  return {
    proposed_tool_name: 'emitir_guia_municipal',
    nomes_propostos: ['emitir_guia_municipal', 'gerar_guia_municipal'],
    member_count: 3,
    total_occurrences: 11,
    contract_state: 'consistent',
    merged_contract_draft: {
      completeness: 'partially_observed',
      inputs: [{ name: 'competencia', zod: 'z.string()', required: true, observed_in: 3 }],
      outputs: [],
      zod_source: '// PROPOSTA — NÃO É CONTRATO VIGENTE.\nexport const x = z.object({});',
    },
    contract_conflicts: [],
    first_member_at: new Date('2026-08-01T00:00:00Z'),
    last_member_at: new Date('2026-08-20T00:00:00Z'),
    metrica: 'dice_token_v1',
    limiar: '0.8500',
    assinatura_version: 1,
    ...over,
  };
}

const pedido = {
  capability_description: 'emitir guia de recolhimento no portal municipal',
  intent: 'emitir guia de recolhimento',
  situacoes_totais: 4,
  situacoes_com_trace: 2,
  root_trace_ids: ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'],
};

describe('#638 — chave de idempotência do aceite', () => {
  it('é determinística: mesmo escopo + mesmo agregado ⇒ mesma chave', () => {
    const { chaveDeIdempotencia } = corpo();
    const a = chaveDeIdempotencia({ tenant_id: T, agent_id: AG, aggregate_id: AGG });
    const b = chaveDeIdempotencia({ tenant_id: T, agent_id: AG, aggregate_id: AGG });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('separa escopos: trocar tenant, agent OU agregado muda a chave', () => {
    const { chaveDeIdempotencia } = corpo();
    const base = chaveDeIdempotencia({ tenant_id: T, agent_id: AG, aggregate_id: AGG });
    const outroTenant = chaveDeIdempotencia({
      tenant_id: 'outro_tenant',
      agent_id: AG,
      aggregate_id: AGG,
    });
    const outroAgente = chaveDeIdempotencia({
      tenant_id: T,
      agent_id: 'outro_agente',
      aggregate_id: AGG,
    });
    const outroAgregado = chaveDeIdempotencia({
      tenant_id: T,
      agent_id: AG,
      aggregate_id: '99999999-8888-7777-6666-555555555555',
    });
    expect(new Set([base, outroTenant, outroAgente, outroAgregado]).size).toBe(4);
  });

  it('NÃO contém o escopo em texto claro — a issue pode ser pública', () => {
    const { chaveDeIdempotencia } = corpo();
    const chave = chaveDeIdempotencia({ tenant_id: T, agent_id: AG, aggregate_id: AGG });
    expect(chave).not.toContain(T);
    expect(chave).not.toContain(AG);
    expect(chave).not.toContain(AGG);
  });
});

describe('#638 — o corpo da issue', () => {
  it('carrega o guardrail e a marcação de rascunho', () => {
    const { corpoDaIssue } = corpo();
    const { MARCADOR_DE_RASCUNHO, TOOL_REQUEST_GUARDRAIL } = tipos();
    const texto = corpoDaIssue({ idempotency_key: 'k'.repeat(32), agregado: agregado(), pedido });
    expect(texto).toContain(TOOL_REQUEST_GUARDRAIL);
    expect(texto).toContain(MARCADOR_DE_RASCUNHO);
    expect(texto).toContain('nenhuma tool foi\n > registrada'.replace('\n > ', ' '));
  });

  it('carrega o marcador de idempotência, e `corpoTemMarcador` o reconhece', () => {
    const { corpoDaIssue, corpoTemMarcador, MARCADOR_DE_PEDIDO } = corpo();
    const chave = 'abc123'.padEnd(32, '0');
    const texto = corpoDaIssue({ idempotency_key: chave, agregado: agregado(), pedido });
    expect(texto).toContain(`${MARCADOR_DE_PEDIDO}${chave}`);
    expect(corpoTemMarcador(texto, chave)).toBe(true);
    expect(corpoTemMarcador(texto, 'x'.repeat(32))).toBe(false);
    expect(corpoTemMarcador(null, chave)).toBe(false);
    // Chave vazia nunca casa — senão qualquer corpo seria "a issue deste pedido".
    expect(corpoTemMarcador(texto, '')).toBe(false);
  });

  it('mostra o contador e a janela que o BACKEND calculou', () => {
    const { corpoDaIssue } = corpo();
    const texto = corpoDaIssue({ idempotency_key: 'k'.repeat(32), agregado: agregado(), pedido });
    expect(texto).toContain('**Pedidos agrupados:** 3');
    expect(texto).toContain('**Ocorrências somadas:** 11');
    expect(texto).toContain('dice_token_v1');
  });

  it('quando a fusão é `divergent`, NÃO emite bloco de contrato — emite os conflitos', () => {
    const { corpoDaIssue } = corpo();
    const { MARCADOR_DE_RASCUNHO } = tipos();
    const texto = corpoDaIssue({
      idempotency_key: 'k'.repeat(32),
      agregado: agregado({
        contract_state: 'divergent',
        merged_contract_draft: null,
        contract_conflicts: [{ lado: 'input', campo: 'competencia', zods: ['z.string()', 'z.number()'] }],
      }),
      pedido,
    });
    expect(texto).toContain('discordam sobre o contrato');
    expect(texto).toContain('competencia');
    // Nenhum contrato fundido apresentado como se fosse consenso.
    expect(texto).not.toContain('**Entradas observadas**');
    expect(texto).not.toContain(MARCADOR_DE_RASCUNHO);
  });

  it('NÃO vaza tenant, agent nem o texto livre das situações', () => {
    const { corpoDaIssue } = corpo();
    const texto = corpoDaIssue({
      idempotency_key: 'k'.repeat(32),
      agregado: agregado(),
      pedido: {
        ...pedido,
        // Texto de turno real — nome e valor do interlocutor. NÃO é passado
        // para o corpo por construção: `PedidoParaIssue` não tem campo para
        // ele, e este caso trava essa ausência.
        intent: 'emitir guia para Fulano de Tal, R$ 1.234,56',
      },
    });
    expect(texto).not.toContain(T);
    expect(texto).not.toContain(AG);
    expect(texto).not.toContain('Fulano de Tal');
    expect(texto).not.toContain('1.234,56');
    // E diz onde as situações estão, em vez de simplesmente omiti-las.
    expect(texto).toContain('/capabilities');
  });

  it('o corpo não tem NADA que pareça credencial — o módulo não conhece nenhuma', async () => {
    const { corpoDaIssue } = corpo();
    const texto = corpoDaIssue({ idempotency_key: 'k'.repeat(32), agregado: agregado(), pedido });
    // `token` solto NÃO entra nesta lista: o nome da métrica de similaridade é
    // `dice_token_v1`, e a primeira versão deste caso ficou vermelha por causa
    // dele. Um padrão que acusa a métrica não prova nada sobre credencial — os
    // padrões abaixo são os que só apareceriam com uma de verdade.
    for (const proibido of ['authorization', 'bearer ', 'ghp_', 'github_pat_', 'x-github']) {
      expect(texto.toLowerCase()).not.toContain(proibido);
    }
    // A garantia estrutural: a FONTE do módulo não importa configuração nenhuma.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const fonte = readFileSync(
      fileURLToPath(new URL('../../src/cognition/tool-request/issue-body.ts', import.meta.url)),
      'utf8',
    );
    expect(fonte).not.toContain("from '@/config/");
    expect(fonte).not.toContain('process.env');
  });

  it('o título é estável para o mesmo agregado', () => {
    const { tituloDaIssue } = corpo();
    expect(tituloDaIssue(agregado())).toBe(tituloDaIssue(agregado()));
    expect(tituloDaIssue(agregado())).toContain('emitir_guia_municipal');
  });
});
