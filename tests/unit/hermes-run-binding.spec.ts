/**
 * P05 (spec §6.3, §6.4.1, §6.9.1; INV-01, INV-02) — o CONTRATO do `RunBinding`
 * e da ACL de recurso/cliente.
 *
 * O §6.3 é categórico sobre de onde vem a autoridade: "o broker nunca usa IDs de
 * tenant/cliente/execução vindos do frame. Resolve contexto pelo objeto de
 * conexão já vinculado. Campos de correlação repetidos no frame, se presentes,
 * só são COMPARADOS e recusados em divergência."
 *
 * O que este arquivo cobra:
 *
 *  1. O binding é CONGELADO recursivamente (§6.4.1) — nem um consumidor
 *     distraído consegue reescrever o tenant no meio de um run;
 *  2. Correlação divergente RECUSA (T19) e a recusa **não revela** nada sobre o
 *     outro run: nem o id que veio no frame, nem se ele existe;
 *  3. A ACL de recurso decide por PERTENCIMENTO ao binding, nunca pela forma do
 *     id (T24, INV-01: "IDs não conferem autorização"), e enxerga ids
 *     ANINHADOS (§6.9.1 item 5: "inclusive nested IDs");
 *  4. ACL vazia RECUSA — G-AUTH: "contexto vazio recusa acesso";
 *  5. A projeção que desce ao worker NÃO carrega tenant, pessoa nem token
 *     (§6.3: "credenciais ficam fora do worker"; T67).
 *
 * Puro: nenhum caso toca banco, fila ou rede.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  BINDING_REJECTION_CODES,
  parseRunBinding,
  freezeRunBinding,
  checkFrameCorrelation,
  collectResourceRefs,
  authorizeResourceRefs,
  workerBindingProjection,
  type RunBindingV1,
} from '@/integrations/hermes/run-binding.js';

const raiz = resolve(__dirname, '../..');
const fonte = readFileSync(resolve(raiz, 'src/integrations/hermes/run-binding.ts'), 'utf8');

const RUN_A = '3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70';
const RUN_B = '9d8c7b6a-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PESSOA_A = '11111111-1111-4111-8111-111111111111';
const PESSOA_B = '22222222-2222-4222-8222-222222222222';
const CONVERSA_A = '33333333-3333-4333-8333-333333333333';
const ENTIDADE_A = '44444444-4444-4444-8444-444444444444';
const ENTIDADE_B = '55555555-5555-4555-8555-555555555555';
const HEX64 = 'a'.repeat(64);

function bruto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    manifest_digest: HEX64,
    context_digest: HEX64,
    bundle_digest: HEX64,
    deadline_at: '2026-09-16T12:00:00.000Z',
    acl: {
      pessoa_ids: [PESSOA_A],
      conversa_ids: [CONVERSA_A],
      entidade_ids: [ENTIDADE_A],
    },
    ...over,
  };
}

function binding(over: Record<string, unknown> = {}): RunBindingV1 {
  const r = parseRunBinding(bruto(over));
  if (r.kind !== 'ok') throw new Error(`fixture inválida: ${r.code} ${r.detail}`);
  return r.binding;
}

describe('P05 — o binding é validado e CONGELADO', () => {
  it('1. um binding completo parseia', () => {
    const r = parseRunBinding(bruto());
    expect(r.kind).toBe('ok');
  });

  it('2. chave desconhecida reprova (strict) — nada entra de carona', () => {
    const r = parseRunBinding(bruto({ approved: true }));
    expect(r.kind).toBe('rejected');
    if (r.kind !== 'rejected') return;
    expect(BINDING_REJECTION_CODES as readonly string[]).toContain(r.code);
  });

  it('3. `execution_id` diferente de `run_id` reprova (§4.1 linha 272)', () => {
    // "EngineRequestV1.run_id = RunBinding.execution_id; um mesmo UUID, não dois
    // registros de autoridade."
    const r = parseRunBinding(bruto({ execution_id: RUN_B }));
    expect(r.kind).toBe('rejected');
    if (r.kind !== 'rejected') return;
    expect(r.code).toBe('identity_mismatch');
  });

  it('4. congelar é RECURSIVO: a ACL aninhada não é mutável (§6.4.1)', () => {
    const b = freezeRunBinding(binding());
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(b.acl)).toBe(true);
    expect(Object.isFrozen(b.acl.pessoa_ids)).toBe(true);
    expect(() => {
      (b.acl.pessoa_ids as string[]).push(PESSOA_B);
    }).toThrow();
  });
});

describe('P05 — T19: correlação de frame compara, nunca escolhe contexto', () => {
  it('5. frame com o `run_id` do próprio binding casa', () => {
    expect(checkFrameCorrelation(binding(), { run_id: RUN_A })).toEqual({ kind: 'match' });
  });

  it('6. frame com o `run_id` de OUTRO run é recusado', () => {
    const r = checkFrameCorrelation(binding(), { run_id: RUN_B });
    expect(r.kind).toBe('mismatch');
  });

  it('7. a recusa não revela o id do outro run nem se ele existe (T19)', () => {
    const r = checkFrameCorrelation(binding(), { run_id: RUN_B });
    if (r.kind !== 'mismatch') throw new Error('esperava mismatch');
    const texto = JSON.stringify(r);
    expect(texto).not.toContain(RUN_B);
    expect(texto).not.toContain('exist');
    // O que ELE diz é só qual CAMPO divergiu — o suficiente para auditar.
    expect(r.field).toBe('run_id');
  });

  it('8. frame SEM campo de correlação casa — correlação é opcional (§6.3)', () => {
    // O frame não é a fonte da autoridade; ausência não é divergência.
    expect(checkFrameCorrelation(binding(), {}).kind).toBe('match');
  });

  it('9. `execution_id` divergente também é recusado (par do caso 6)', () => {
    const r = checkFrameCorrelation(binding(), { run_id: RUN_A, execution_id: RUN_B });
    expect(r.kind).toBe('mismatch');
    if (r.kind !== 'mismatch') return;
    expect(r.field).toBe('execution_id');
  });
});

describe('P05 — T24: ACL de recurso decide por PERTENCIMENTO', () => {
  const seletores = {
    pessoa_id: 'pessoa',
    conversa_id: 'conversa',
    entidade_id: 'entidade',
  } as const;

  it('10. recurso DENTRO da ACL é permitido', () => {
    const refs = collectResourceRefs({ entidade_id: ENTIDADE_A }, seletores);
    expect(authorizeResourceRefs(binding(), refs)).toEqual({ kind: 'allow' });
  });

  it('11. id REAL de outro cliente do mesmo agente é RECUSADO (T24)', () => {
    // O id existe e é bem formado. É exatamente o caso do T24: "Cliente A
    // fornece ID real de recurso de B no mesmo agente".
    const refs = collectResourceRefs({ entidade_id: ENTIDADE_B }, seletores);
    const d = authorizeResourceRefs(binding(), refs);
    expect(d.kind).toBe('deny');
    if (d.kind !== 'deny') return;
    expect(d.reason).toBe('out_of_acl');
  });

  it('12. a recusa nomeia o CAMPO, não o id recusado (INV-12)', () => {
    const refs = collectResourceRefs({ entidade_id: ENTIDADE_B }, seletores);
    const d = authorizeResourceRefs(binding(), refs);
    if (d.kind !== 'deny') throw new Error('esperava deny');
    expect(JSON.stringify(d)).not.toContain(ENTIDADE_B);
    expect(d.field).toContain('entidade_id');
  });

  it('13. id ANINHADO fora da ACL é visto e recusado (§6.9.1 item 5)', () => {
    const refs = collectResourceRefs(
      { filtro: { alvos: [{ entidade_id: ENTIDADE_A }, { entidade_id: ENTIDADE_B }] } },
      seletores,
    );
    expect(refs.length).toBe(2);
    expect(authorizeResourceRefs(binding(), refs).kind).toBe('deny');
  });

  it('14. `pessoa_id` legítimo só SELECIONA dentro da ACL (§6.9.1 item 3)', () => {
    const dentro = collectResourceRefs({ pessoa_id: PESSOA_A }, seletores);
    expect(authorizeResourceRefs(binding(), dentro).kind).toBe('allow');
    const fora = collectResourceRefs({ pessoa_id: PESSOA_B }, seletores);
    expect(authorizeResourceRefs(binding(), fora).kind).toBe('deny');
  });

  it('15. ACL VAZIA recusa — contexto vazio nega acesso (G-AUTH)', () => {
    const b = binding({ acl: { pessoa_ids: [], conversa_ids: [], entidade_ids: [] } });
    const refs = collectResourceRefs({ entidade_id: ENTIDADE_A }, seletores);
    const d = authorizeResourceRefs(b, refs);
    expect(d.kind).toBe('deny');
    if (d.kind !== 'deny') return;
    expect(d.reason).toBe('empty_acl');
  });

  it('16. nenhum recurso pedido é permitido — não há o que autorizar', () => {
    expect(authorizeResourceRefs(binding(), []).kind).toBe('allow');
  });

  it('17. campo que NÃO é seletor declarado não vira recurso', () => {
    // O contrário faria qualquer string com cara de uuid virar pedido de ACL, e a
    // ACL passaria a depender de heurística de nome de campo.
    const refs = collectResourceRefs({ observacao: ENTIDADE_B }, seletores);
    expect(refs).toEqual([]);
  });
});

describe('P05 — a projeção que desce ao worker não carrega autoridade', () => {
  it('18. a projeção tem EXATAMENTE os campos do `binding` do wire (§6.4.1)', () => {
    const p = workerBindingProjection(binding());
    expect(Object.keys(p).sort()).toEqual(
      ['execution_id', 'initial_session_id', 'manifest_digest', 'mode', 'task_id'].sort(),
    );
  });

  it('19. a projeção não contém tenant, pessoa, claim token nem ACL (T67)', () => {
    const texto = JSON.stringify(workerBindingProjection(binding()));
    for (const segredo of [
      'tenant-alfa',
      PESSOA_A,
      '88888888-8888-4888-8888-888888888888',
      ENTIDADE_A,
    ]) {
      expect(texto).not.toContain(segredo);
    }
  });
});

describe('P05 — o módulo é PURO', () => {
  it('20. não importa banco, ALS, env nem métricas', () => {
    // Especificadores de import, não texto do arquivo — ver a nota no caso 29 de
    // `hermes-manifest-contract.spec.ts`: prosa que CITA um caminho para dizer
    // que não o usa não é acoplamento, e reprovar por ela mede a documentação.
    const imports = [...fonte.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
    expect(imports.length).toBeGreaterThan(0);
    for (const p of [
      '@/db/',
      'db/client',
      'tenant-context',
      '@/config/env',
      '@/lib/metrics',
      'drizzle-orm',
    ]) {
      expect(imports.filter((i) => i.includes(p)), `import proibido: ${p}`).toEqual([]);
    }
  });

  it('21. o arquivo cita as seções que originam cada regra', () => {
    expect(fonte).toContain('6.4.1');
    expect(fonte).toContain('6.9.1');
    expect(fonte).toContain('INV-01');
  });
});
