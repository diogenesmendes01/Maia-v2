/**
 * P05 (spec §6.9.1, §7.10.1; INV-03, INV-10) — a POLÍTICA PURA do broker: a
 * superfície EFETIVA de ferramentas e a decisão de admissão por chamada.
 *
 * O §7.10.1 escreve a superfície como uma interseção:
 *
 *   nomes permitidos = allowlist do deployment ∩ manifest do run ∩ grant vigente
 *                      do agente ∩ escopo efetivo da role ∩ tools da skill
 *                      ∩ capacidades autorizadas à pessoa/recurso − todos os denies
 *
 * E acrescenta a regra que INVERTE o comportamento do `runtime-filter.ts` atual:
 * "falha de lookup de uma role/skill requerida **não** volta para baseline mais
 * amplo. O runtime-filter atual permite ausência de role narrowing […]; a nova
 * bridge não pode tratar isso como autorização para expandir tools."
 *
 * O que este arquivo cobra:
 *
 *  1. Interseção de verdade: sobreviver a UM eixo não basta (T21, T22);
 *  2. Falha de lookup FECHA a superfície — nunca cai para baseline/owner (T23);
 *  3. Campos de autoridade nos args são recusados em qualquer profundidade (T20);
 *  4. A ordem de checagem do §6.9.1 é a ordem REAL: identidade antes de catálogo
 *     (T19 antes de T21), catálogo antes de argumento;
 *  5. Nenhum código de recusa inventado: todo recusa mapeia num código que o
 *     schema REAL de `EngineToolReplyV1` aceita;
 *  6. Evidência de execução é o journal, não o que o motor afirma (T29).
 *
 * Puro: nenhum caso toca banco, fila ou rede.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { engineToolReplyV1Schema } from '@/runtime/engines/schemas.js';
import { parseRuntimeManifest, computeManifestDigest } from '@/integrations/hermes/manifest.js';
import { parseRunBinding, type RunBindingV1 } from '@/integrations/hermes/run-binding.js';
import {
  SURFACE_AXES,
  BROKER_REFUSAL_REASONS,
  RESERVED_ARGUMENT_KEYS,
  MAX_ARG_DEPTH,
  computeEffectiveToolSurface,
  refusalWireCode,
  screenToolArgs,
  decideToolCall,
  reconcileObservedToolCalls,
  type ToolAxisV1,
  type ToolSurfaceInputV1,
} from '@/integrations/hermes/tool-broker.js';

const raiz = resolve(__dirname, '../..');
const fonte = readFileSync(resolve(raiz, 'src/integrations/hermes/tool-broker.ts'), 'utf8');

const RUN_A = '3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70';
const RUN_B = '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PESSOA_A = '11111111-1111-4111-8111-111111111111';
const CONVERSA_A = '33333333-3333-4333-8333-333333333333';
const ENTIDADE_A = '44444444-4444-4444-8444-444444444444';
const ENTIDADE_B = '55555555-5555-4555-8555-555555555555';
const HEX64 = 'a'.repeat(64);
const HEX40 = 'b'.repeat(40);

const NOME = 'read_turn_context';

/**
 * Embrulha a folha em `niveis` objetos, sempre pela MESMA chave — e a chave é
 * `dados`, DECLARADA no schema da ferramenta, porque é essa a forma que atravessa
 * as duas peneiras: a de campo desconhecido só olha o topo, e no topo está um
 * campo legítimo.
 */
function aninhar(folha: Record<string, unknown>, niveis: number): Record<string, unknown> {
  let atual: Record<string, unknown> = folha;
  for (let i = 0; i < niveis; i++) atual = { dados: atual };
  return atual;
}

// ─── fixtures ───────────────────────────────────────────────────────────────

function tool(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: NOME,
    maia_tool_name: NOME,
    input_schema: { type: 'object', additionalProperties: false, properties: {} },
    output_schema: { type: 'object', additionalProperties: false, properties: {} },
    input_schema_hash: HEX64,
    output_schema_hash: HEX64,
    implementation_version: '1.0.0',
    side_effect: 'read',
    effect_class: 'abort_safe',
    required_actions: [],
    authorization_target: 'current_turn',
    output_projection_id: 'turn_context_v1',
    audit_action: 'memory_recalled',
    limits: { max_calls: 4, result_limit_chars: 8_000, timeout_ms: 5_000 },
    approval_mode: 'none',
    ...over,
  };
}

function manifesto(tools: Array<Record<string, unknown>> = [tool()]) {
  const r = parseRuntimeManifest({
    schema: 'maia-hermes-runtime-manifest/v1',
    run_id: RUN_A,
    policy_revision: 'rev-7',
    mode: 'live',
    bundle_digest: HEX64,
    context_digest: HEX64,
    control_epoch: '12',
    exposure_epoch: '3',
    runtime_pin: {
      hermes_sha: HEX40,
      adapter_revision: 'hermes-adapter-0.1.0',
      image_digest: HEX64,
      dependency_lock_digest: HEX64,
    },
    tools,
    limits: {
      deadline_at: '2026-09-16T12:00:00.000Z',
      max_tool_calls: 8,
      max_inference_calls: 12,
      max_context_tokens: 100_000,
      max_output_tokens: 1_024,
      max_payload_bytes: 262_144,
      max_json_depth: 32,
      budget: { amount_microusd: '250000', unit: 'microusd' },
    },
    data_policy: { ref: 'dp-piloto', version: '2' },
    publication_refs: [],
    retention_policy_ref: 'ret-piloto-30d',
    denies: {
      native_memory: true,
      generic_filesystem: true,
      code_execution: true,
      browsing: true,
      mcp: true,
      delegation: true,
      background_review: true,
      cron: true,
      messaging: true,
      discovery_expanding_tools: true,
    },
  });
  if (r.kind !== 'ok') throw new Error(`fixture de manifest inválida: ${r.code} ${r.detail}`);
  return r.manifest;
}

function binding(over: Record<string, unknown> = {}): RunBindingV1 {
  const r = parseRunBinding({
    version: 1,
    run_id: RUN_A,
    execution_id: RUN_A,
    task_id: 'task-1',
    initial_session_id: 'sess-1',
    tenant_id: 'tenant-alfa',
    agent_id: 'agente-1',
    pessoa_id: PESSOA_A,
    conversa_id: CONVERSA_A,
    mensagem_id: '66666666-6666-4666-8666-666666666666',
    turn_id: '77777777-7777-4777-8777-777777777777',
    turn_attempt: 1,
    origin_claim_token: '88888888-8888-4888-8888-888888888888',
    control_id: '99999999-9999-4999-8999-999999999999',
    control_epoch: '12',
    mode: 'live',
    manifest_digest: computeManifestDigest(manifesto()),
    context_digest: HEX64,
    bundle_digest: HEX64,
    deadline_at: '2026-09-16T12:00:00.000Z',
    acl: { pessoa_ids: [PESSOA_A], conversa_ids: [CONVERSA_A], entidade_ids: [ENTIDADE_A] },
    ...over,
  });
  if (r.kind !== 'ok') throw new Error(`fixture de binding inválida: ${r.code} ${r.detail}`);
  return r.binding;
}

const permite = (...names: string[]): ToolAxisV1 => ({ kind: 'allow', names });

function superficie(over: Partial<ToolSurfaceInputV1> = {}): ToolSurfaceInputV1 {
  return {
    run_kind: 'scoped',
    axes: {
      deployment: permite(NOME, 'published_skill_read'),
      manifest: permite(NOME),
      agent_grant: permite(NOME, 'published_skill_read'),
      role: permite(NOME, 'published_skill_read'),
      skill: permite(NOME),
      subject: permite(NOME),
      policy: permite(NOME, 'published_skill_read'),
    },
    denies: [],
    ...over,
  };
}

function comEixo(axis: keyof ToolSurfaceInputV1['axes'], valor: ToolAxisV1): ToolSurfaceInputV1 {
  const base = superficie();
  return { ...base, axes: { ...base.axes, [axis]: valor } };
}

// ─── INV-03: a interseção ───────────────────────────────────────────────────

describe('P05 — INV-03: a superfície é a INTERSEÇÃO dos sete eixos', () => {
  it('1. o que está em todos os eixos sobrevive', () => {
    expect(computeEffectiveToolSurface(superficie()).names).toEqual([NOME]);
  });

  it('2. cada eixo sozinho é capaz de REMOVER a ferramenta', () => {
    // Um caso por eixo. Sem isto, apagar um termo da interseção continuaria
    // verde — que foi exatamente o defeito que a varredura de mutação procura.
    for (const eixo of SURFACE_AXES) {
      const s = computeEffectiveToolSurface(comEixo(eixo, permite('outra_coisa')));
      expect(s.names, `eixo ${eixo} não está sendo aplicado`).toEqual([]);
    }
  });

  it('3. T21: tool fora do MANIFEST some, mesmo existindo em todo o resto', () => {
    const s = computeEffectiveToolSurface(comEixo('manifest', permite('published_skill_read')));
    expect(s.names).not.toContain(NOME);
  });

  it('4. T22: grant revogado depois da admissão tira a ferramenta', () => {
    // A superfície é recomputada A CADA chamada a partir dos eixos recebidos —
    // INV-04: "grants/epoch atuais prevalecem sobre snapshot".
    const antes = computeEffectiveToolSurface(superficie());
    const depois = computeEffectiveToolSurface(comEixo('agent_grant', permite()));
    expect(antes.names).toEqual([NOME]);
    expect(depois.names).toEqual([]);
  });

  it('5. o deny remove mesmo o que passou em TODOS os eixos', () => {
    const s = computeEffectiveToolSurface({ ...superficie(), denies: [NOME] });
    expect(s.names).toEqual([]);
  });

  it('6. nome reservado não sobrevive nem se todo eixo o listar (K-19)', () => {
    const todos = Object.fromEntries(
      SURFACE_AXES.map((a) => [a, permite('maia_fixture_echo')]),
    ) as ToolSurfaceInputV1['axes'];
    const s = computeEffectiveToolSurface({ run_kind: 'scoped', axes: todos, denies: [] });
    expect(s.names).toEqual([]);
  });

  it('6b. o deny inicial do §7.10.3 vale na SUPERFÍCIE, não só no manifest', () => {
    // Achado ao mapear as mutações, antes de rodá-las: sem este caso, apagar o
    // filtro de `INITIAL_TOOL_DENY` de dentro da interseção não quebrava nada —
    // o deny só estava provado na porta do manifest, e a superfície é
    // alimentada por SEIS outros eixos, qualquer um capaz de trazer o nome de
    // volta. `remember_safe_fact` é o caso real: ele vem do `baseline.core`.
    const todos = Object.fromEntries(
      SURFACE_AXES.map((a) => [a, permite('remember_safe_fact')]),
    ) as ToolSurfaceInputV1['axes'];
    const s = computeEffectiveToolSurface({ run_kind: 'scoped', axes: todos, denies: [] });
    expect(s.names).toEqual([]);
  });

  it('7. a saída é ordenada e sem repetição — é um CONJUNTO', () => {
    const axes = Object.fromEntries(
      SURFACE_AXES.map((a) => [a, permite('b_tool', 'a_tool', 'b_tool')]),
    ) as ToolSurfaceInputV1['axes'];
    const s = computeEffectiveToolSurface({ run_kind: 'scoped', axes, denies: [] });
    expect(s.names).toEqual(['a_tool', 'b_tool']);
  });
});

describe('P05 — T23: falha de lookup FECHA, não abre', () => {
  it('8. qualquer eixo com lookup falho zera a superfície', () => {
    for (const eixo of SURFACE_AXES) {
      const s = computeEffectiveToolSurface(comEixo(eixo, { kind: 'lookup_failed' }));
      expect(s.names, `eixo ${eixo}`).toEqual([]);
      expect(s.closed_reason?.kind).toBe('lookup_failed');
      expect(s.closed_reason?.axis).toBe(eixo);
    }
  });

  it('9. role/skill AUSENTE num run scoped fecha — não vira "sem narrowing"', () => {
    // A inversão explícita do §7.10.1 em relação a `runtime-filter.ts:132-185`.
    for (const eixo of ['role', 'skill'] as const) {
      const s = computeEffectiveToolSurface(comEixo(eixo, { kind: 'not_applicable' }));
      expect(s.names, `eixo ${eixo}`).toEqual([]);
      expect(s.closed_reason?.kind).toBe('axis_required');
    }
  });

  it('10. em `baseline_only`, role/skill ausentes são legítimos (par do caso 9)', () => {
    const base = superficie({ run_kind: 'baseline_only' });
    const s = computeEffectiveToolSurface({
      ...base,
      axes: {
        ...base.axes,
        role: { kind: 'not_applicable' },
        skill: { kind: 'not_applicable' },
      },
    });
    expect(s.names).toEqual([NOME]);
    expect(s.closed_reason).toBeNull();
  });

  it('11. `baseline_only` NÃO amplia: os outros eixos continuam valendo', () => {
    const base = superficie({ run_kind: 'baseline_only' });
    const s = computeEffectiveToolSurface({
      ...base,
      axes: {
        ...base.axes,
        role: { kind: 'not_applicable' },
        skill: { kind: 'not_applicable' },
        agent_grant: permite(),
      },
    });
    expect(s.names).toEqual([]);
  });

  it('12. eixo que NÃO é role/skill não pode ser `not_applicable` nem em baseline', () => {
    const base = superficie({ run_kind: 'baseline_only' });
    const s = computeEffectiveToolSurface({
      ...base,
      axes: { ...base.axes, manifest: { kind: 'not_applicable' } },
    });
    expect(s.names).toEqual([]);
    expect(s.closed_reason?.kind).toBe('axis_required');
  });
});

// ─── T20: argumentos ────────────────────────────────────────────────────────

describe('P05 — T20: campos de autoridade nos args são recusados', () => {
  it('13. `tenant_id` e `approved` são reservados em QUALQUER profundidade', () => {
    for (const chave of ['tenant_id', 'approved', 'claim_token']) {
      expect(RESERVED_ARGUMENT_KEYS.has(chave)).toBe(true);
      const raso = screenToolArgs([chave], { [chave]: 'x' });
      expect(raso.kind, `${chave} raso`).toBe('reject');
      const fundo = screenToolArgs(['filtro'], { filtro: { nivel: [{ [chave]: 'x' }] } });
      expect(fundo.kind, `${chave} aninhado`).toBe('reject');
      if (fundo.kind !== 'reject') continue;
      expect(fundo.reason).toBe('reserved_argument');
    }
  });

  it('13b. reservado no LIMITE de profundidade ainda é ACHADO', () => {
    // O par do 13c, e o que prende o teto pelos dois lados: sem este caso,
    // endurecer o limite (`>` virando `>=`) faria a triagem recusar cedo demais
    // e nenhum teste notaria.
    const r = screenToolArgs(['dados'], aninhar({ tenant_id: 'x' }, MAX_ARG_DEPTH));
    expect(r.kind).toBe('reject');
    if (r.kind !== 'reject') return;
    expect(r.reason).toBe('reserved_argument');
  });

  it('13c. ACIMA do teto a triagem RECUSA — estourar não pode ser silêncio', () => {
    // O defeito que a varredura por OPERADOR expôs (achado do coordenador): o
    // termo de profundidade fazia o varredor DESISTIR e devolver "nada
    // encontrado", que é fail-OPEN. Acima do teto o `tenant_id` atravessava as
    // DUAS peneiras — a de reservado (que desistia) e a de desconhecido (que só
    // olha o TOPO, e no topo estava a chave declarada `dados`).
    for (const niveis of [MAX_ARG_DEPTH + 1, MAX_ARG_DEPTH + 2, 40]) {
      const r = screenToolArgs(['dados'], aninhar({ tenant_id: 'x' }, niveis));
      expect(r.kind, `niveis=${niveis}`).toBe('reject');
      if (r.kind !== 'reject') continue;
      expect(r.reason, `niveis=${niveis}`).toBe('too_deep');
    }
  });

  it('13d. o teto recusa mesmo SEM nada reservado embaixo', () => {
    // Fail-closed de verdade: a recusa não é "achei algo ruim", é "não consigo
    // certificar este payload". Um payload fundo demais e inocente também morre,
    // e isso é deliberado — o contrário seria afirmar uma garantia que a
    // varredura não deu.
    const r = screenToolArgs(['dados'], aninhar({ texto: 'inocente' }, 40));
    expect(r.kind).toBe('reject');
    if (r.kind !== 'reject') return;
    expect(r.reason).toBe('too_deep');
  });

  it('14. declarar o campo reservado no schema NÃO o legaliza (par do 13)', () => {
    // "Rejeitar campos de identidade/proveniência/aprovação" é absoluto: um
    // schema de tool que declarasse `approved` seria o próprio bug.
    expect(screenToolArgs(['approved'], { approved: true }).kind).toBe('reject');
  });

  it('15. campo não declarado no schema é recusado como desconhecido', () => {
    const r = screenToolArgs(['texto'], { texto: 'oi', extra: 1 });
    expect(r.kind).toBe('reject');
    if (r.kind !== 'reject') return;
    expect(r.reason).toBe('unknown_argument');
  });

  it('16. `pessoa_id` DECLARADO passa a triagem — ele seleciona, não autoriza', () => {
    // §6.9.1 item 3: "pessoa_id ou recursos legítimos em domínio só selecionam
    // objetos DENTRO da ACL, nunca autoridade". Quem decide é a ACL, adiante.
    expect(screenToolArgs(['pessoa_id'], { pessoa_id: PESSOA_A }).kind).toBe('ok');
  });

  it('17. args legítimos passam', () => {
    expect(screenToolArgs(['texto'], { texto: 'oi' }).kind).toBe('ok');
  });
});

// ─── decisão por chamada ────────────────────────────────────────────────────

function decisao(over: Record<string, unknown> = {}) {
  return decideToolCall({
    binding: binding(),
    manifest: manifesto(),
    frame: { run_id: RUN_A, name: NOME, args: {}, call_seq: 0 },
    surface: superficie(),
    selectors: { pessoa_id: 'pessoa', entidade_id: 'entidade' },
    ...over,
  });
}

describe('P05 — a decisão por chamada segue a ordem do §6.9.1', () => {
  it('18. chamada legítima é admitida', () => {
    const d = decisao();
    expect(d.kind).toBe('admit');
    if (d.kind !== 'admit') return;
    expect(d.tool.maia_tool_name).toBe(NOME);
  });

  it('19. T19: frame de outro run é recusado ANTES de olhar o catálogo', () => {
    // Duas coisas erradas ao mesmo tempo: correlação divergente E nome fora da
    // superfície. Vence a identidade — item 1 do §6.9.1 vem antes do item 3.
    const d = decideToolCall({
      binding: binding(),
      manifest: manifesto(),
      frame: { run_id: RUN_B, name: 'inexistente', args: {}, call_seq: 0 },
      surface: superficie(),
      selectors: {},
    });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d.reason).toBe('binding_mismatch');
    expect(JSON.stringify(d)).not.toContain(RUN_B);
  });

  it('20. digest de manifest divergente é recusado (§6.9.1 item 3)', () => {
    const d = decisao({ binding: binding({ manifest_digest: 'c'.repeat(64) }) });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d.reason).toBe('manifest_digest_mismatch');
  });

  it('21. T21: nome fora do manifest é recusado mesmo existindo no registry Maia', () => {
    // `remember_safe_fact` existe no `baseline.core` da casa — e não está aqui.
    const d = decisao({
      frame: { run_id: RUN_A, name: 'remember_safe_fact', args: {}, call_seq: 0 },
    });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d.reason).toBe('tool_not_in_surface');
  });

  it('22. T28: nome perigoso injetado por texto é recusado no dispatch', () => {
    const d = decisao({ frame: { run_id: RUN_A, name: 'terminal', args: {}, call_seq: 0 } });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(['tool_not_in_surface', 'tool_denied']).toContain(d.reason);
  });

  it('23. T23: lookup falho recusa sem cair para baseline', () => {
    const d = decisao({ surface: comEixo('agent_grant', { kind: 'lookup_failed' }) });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d.reason).toBe('context_lookup_failed');
  });

  it('24. catálogo vem antes de argumento: tool desconhecida com args sujos', () => {
    const d = decisao({
      frame: { run_id: RUN_A, name: 'inexistente', args: { approved: true }, call_seq: 0 },
    });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d.reason).toBe('tool_not_in_surface');
  });

  it('25. T20 ponta a ponta: `approved` no frame recusa a chamada', () => {
    const d = decisao({ frame: { run_id: RUN_A, name: NOME, args: { approved: true }, call_seq: 0 } });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d.reason).toBe('reserved_argument');
  });

  it('25b. T20 ponta a ponta: payload fundo demais RECUSA a chamada', () => {
    // O defeito não pode morrer só na função interna: a porta que o gateway vai
    // chamar é esta, e era por ela que o `tenant_id` a 17+ níveis entrava.
    const d = decisao({
      frame: { run_id: RUN_A, name: NOME, args: aninhar({ tenant_id: 'x' }, 40), call_seq: 0 },
    });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d.reason).toBe('too_deep');
  });

  it('26. T24 ponta a ponta: recurso de outro cliente recusa a chamada', () => {
    const comSeletor = manifesto([
      tool({
        input_schema: {
          type: 'object',
          additionalProperties: false,
          properties: { entidade_id: { type: 'string' } },
        },
      }),
    ]);
    const d = decideToolCall({
      binding: binding({ manifest_digest: computeManifestDigest(comSeletor) }),
      manifest: comSeletor,
      frame: { run_id: RUN_A, name: NOME, args: { entidade_id: ENTIDADE_B }, call_seq: 0 },
      surface: superficie(),
      selectors: { entidade_id: 'entidade' },
    });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d.reason).toBe('resource_out_of_acl');
    expect(JSON.stringify(d)).not.toContain(ENTIDADE_B);
  });

  it('27. INV-10: em shadow, ferramenta com efeito é bloqueada', () => {
    const escrita = manifesto([
      tool({ side_effect: 'write', effect_class: 'idempotent', audit_action: 'fact_saved' }),
    ]);
    const d = decideToolCall({
      binding: binding({ mode: 'shadow', manifest_digest: computeManifestDigest(escrita) }),
      manifest: escrita,
      frame: { run_id: RUN_A, name: NOME, args: {}, call_seq: 0 },
      surface: superficie(),
      selectors: {},
    });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d.reason).toBe('shadow_write_blocked');
  });

  it('28. T30: tool com aprovação exigida NÃO é admitida pelo modelo', () => {
    const comAprovacao = manifesto([
      tool({ approval_mode: 'dual', side_effect: 'write', effect_class: 'idempotent' }),
    ]);
    const d = decideToolCall({
      binding: binding({ manifest_digest: computeManifestDigest(comAprovacao) }),
      manifest: comAprovacao,
      frame: { run_id: RUN_A, name: NOME, args: {}, call_seq: 0 },
      surface: superficie(),
      selectors: {},
    });
    // Nem `admit` (executaria) nem `refuse` (diria que não pode): a espera tem
    // nome próprio, e o modelo não consegue transformá-la em autorização.
    expect(d.kind).toBe('defer');
    if (d.kind !== 'defer') return;
    expect(d.reason).toBe('approval_required');
  });

  it('29. T30, o par: `approved:true` no frame não converte o defer em admit', () => {
    const comAprovacao = manifesto([
      tool({ approval_mode: 'dual', side_effect: 'write', effect_class: 'idempotent' }),
    ]);
    const d = decideToolCall({
      binding: binding({ manifest_digest: computeManifestDigest(comAprovacao) }),
      manifest: comAprovacao,
      frame: { run_id: RUN_A, name: NOME, args: { approved: true }, call_seq: 0 },
      surface: superficie(),
      selectors: {},
    });
    expect(d.kind).toBe('refuse');
    if (d.kind !== 'refuse') return;
    expect(d.reason).toBe('reserved_argument');
  });
});

describe('P05 — nenhum código de recusa é inventado', () => {
  it('30. toda recusa mapeia num código que o schema REAL do wire aceita', () => {
    for (const reason of BROKER_REFUSAL_REASONS) {
      const reply = {
        kind: 'refused' as const,
        call_id: `${RUN_A}:0`,
        code: refusalWireCode(reason),
      };
      const r = engineToolReplyV1Schema.safeParse(reply);
      expect(r.success, `razão ${reason} produziu código fora do wire`).toBe(true);
    }
  });

  it('31. `approval_required` NÃO é uma recusa — o wire não tem esse código', () => {
    // Contradição REGISTRADA, não contornada: o §6.9.2 fala em "retorno da tool
    // `approval_required`", mas o vocabulário fechado de `tool.result` do P00 não
    // tem esse código, e `EngineToolCallStateV1` tem o estado. Inventar um código
    // no wire quebraria o espelho Python. Por isso a espera é `defer`.
    expect(BROKER_REFUSAL_REASONS as readonly string[]).not.toContain('approval_required');
  });
});

describe('P05 — T29: evidência de execução é o journal, não a afirmação do motor', () => {
  it('32. ref afirmada que não está no journal não vira evidência', () => {
    const r = reconcileObservedToolCalls([`${RUN_A}:0`], [`${RUN_A}:0`, `${RUN_A}:99`]);
    expect(r.refs).toEqual([`${RUN_A}:0`]);
    expect(r.fabricated).toEqual([`${RUN_A}:99`]);
  });

  it('33. as refs devolvidas são SEMPRE as do journal (par do caso 32)', () => {
    // Mesmo quando o motor não afirma nada, quem conta é o ledger (§6.8).
    const r = reconcileObservedToolCalls([`${RUN_A}:0`], []);
    expect(r.refs).toEqual([`${RUN_A}:0`]);
    expect(r.fabricated).toEqual([]);
  });
});

describe('P05 — o módulo é PURO', () => {
  it('34. não importa banco, ALS, env, métricas nem o dispatcher', () => {
    // Especificadores de import, não texto do arquivo — ver a nota no caso 29 de
    // `hermes-manifest-contract.spec.ts`. Aqui a diferença é gritante: este
    // módulo CITA `_dispatcher.ts:300-324` porque a lacuna de narrowing daquele
    // arquivo é a razão de este existir. A citação precisa sobreviver; o import,
    // não.
    const imports = [...fonte.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
    expect(imports.length).toBeGreaterThan(0);
    for (const p of [
      '@/db/',
      'db/client',
      'tenant-context',
      '@/config/env',
      '@/lib/metrics',
      'drizzle-orm',
      '_dispatcher',
    ]) {
      expect(imports.filter((i) => i.includes(p)), `import proibido: ${p}`).toEqual([]);
    }
  });

  it('35. o arquivo cita as seções e o invariante que o originam', () => {
    expect(fonte).toContain('6.9.1');
    expect(fonte).toContain('7.10.1');
    expect(fonte).toContain('INV-03');
  });
});
