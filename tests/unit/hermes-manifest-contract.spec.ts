/**
 * P05 (spec §4.2, §7.10; K-19) — o CONTRATO do manifest
 * `maia-hermes-runtime-manifest/v1`.
 *
 * O manifest é dado INTERNO compilado pelo backend: o modelo não o fornece e o
 * worker não o edita (§4.2). Ele é a lista fechada do que aquele run pode
 * chamar — e, por ser a única lista, um schema permissivo aqui é escalada de
 * privilégio com outro nome.
 *
 * O que este arquivo cobra, e que nenhum compilador cobra:
 *
 *  1. **Default é lista VAZIA.** Manifest sem `tools` expõe zero ferramentas —
 *     nunca "todas" (§4.2). Ausência é o conjunto vazio, não o universo;
 *  2. **`maia_*`, `mcp:*` e `all` são RECUSADOS** (K-19), de forma determinística
 *     e com erro TIPADO — não exceção genérica nem aviso em log;
 *  3. **O deny inicial do §7.10.3 é parte do contrato**: `terminal`,
 *     `execute_code`, `write_file`, `memory`, `browser` e os wrappers legados de
 *     aprendizado da Maia não entram na allowlist nem que alguém os digite;
 *  4. **O que autoriza não pode faltar nem ser inventado**: `effect_class` nulo,
 *     `audit_action` fora do vocabulário da casa ou `output_projection_id`
 *     ausente reprovam. §4.1: "null NUNCA autoriza handler";
 *  5. **Os booleans de negação não conseguem expressar permissão.** `denies.mcp`
 *     é o literal `true`; escrever `false` não afrouxa a V1, reprova o manifest;
 *  6. O módulo é PURO — respondível sem Postgres, sem Redis e sem boot.
 *
 * Puro: nenhum caso toca banco, fila ou rede.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { AUDIT_ACTIONS } from '@/governance/audit-actions.js';
import {
  RUNTIME_MANIFEST_SCHEMA,
  MANIFEST_REJECTION_CODES,
  INITIAL_TOOL_DENY,
  classifyReservedToolName,
  parseRuntimeManifest,
  computeManifestDigest,
  manifestToolNames,
} from '@/integrations/hermes/manifest.js';

const raiz = resolve(__dirname, '../..');
const fonte = readFileSync(resolve(raiz, 'src/integrations/hermes/manifest.ts'), 'utf8');

const RUN_ID = '3f7c1f4e-6a1b-4c6d-9f1a-2b3c4d5e6f70';
const HEX64 = 'a'.repeat(64);
const HEX40 = 'b'.repeat(40);

/** Uma ferramenta COMPLETA e legítima. Nome real da fase "live informativo" (§4.2). */
function tool(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'read_turn_context',
    maia_tool_name: 'read_turn_context',
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

function manifesto(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: RUNTIME_MANIFEST_SCHEMA,
    run_id: RUN_ID,
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
    tools: [tool()],
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
    ...over,
  };
}

/** Atalho: parseia e exige recusa, devolvendo o código para asserção exata. */
function recusa(input: unknown): string {
  const r = parseRuntimeManifest(input);
  if (r.kind !== 'rejected') {
    throw new Error(`esperava recusa, veio ${r.kind}`);
  }
  return r.code;
}

describe('P05 — o manifest default é VAZIO, nunca amplo', () => {
  it('1. manifest sem `tools` expõe zero ferramentas', () => {
    const semTools = manifesto();
    delete (semTools as { tools?: unknown }).tools;
    const r = parseRuntimeManifest(semTools);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(manifestToolNames(r.manifest)).toEqual([]);
  });

  it('2. um manifest válido expõe EXATAMENTE os nomes declarados', () => {
    const r = parseRuntimeManifest(manifesto());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(manifestToolNames(r.manifest)).toEqual(['read_turn_context']);
  });

  it('3. chave desconhecida no topo reprova o manifest (strict)', () => {
    // Um campo ignorado hoje é um campo lido amanhã (§5.3.3).
    expect(recusa(manifesto({ approved: true }))).toBe('schema');
  });

  it('4. schema com outra versão não é aceito', () => {
    expect(recusa(manifesto({ schema: 'maia-hermes-runtime-manifest/v2' }))).toBe('schema');
  });
});

describe('P05 — K-19: nomes reservados são recusados', () => {
  it('5. `maia_*` é recusado, com código próprio', () => {
    expect(recusa(manifesto({ tools: [tool({ name: 'maia_fixture_echo' })] }))).toBe(
      'reserved_tool_name',
    );
  });

  it('6. `mcp:*` é recusado — o prefixo REAL da casa, não um inventado', () => {
    expect(recusa(manifesto({ tools: [tool({ name: 'mcp:servidor:ferramenta' })] }))).toBe(
      'reserved_tool_name',
    );
  });

  it('7. `all` é recusado', () => {
    expect(recusa(manifesto({ tools: [tool({ name: 'all' })] }))).toBe('reserved_tool_name');
  });

  it('8. o curinga `*` também é recusado', () => {
    expect(recusa(manifesto({ tools: [tool({ name: '*' })] }))).toBe('reserved_tool_name');
  });

  it('9. a regra vale para `maia_tool_name`, não só para o nome exposto', () => {
    // O `maia_tool_name` é quem o dispatcher resolveria. Deixar `mcp:` passar ali
    // habilitaria o bridge MCP por dentro — §7.10.3: "Não inclui MCP no piloto" —
    // com um nome exposto de aparência inocente.
    expect(recusa(manifesto({ tools: [tool({ maia_tool_name: 'mcp:servidor:ferramenta' })] }))).toBe(
      'reserved_tool_name',
    );
  });

  it('10. a classificação é determinística e nomeia QUAL regra pegou', () => {
    expect(classifyReservedToolName('maia_x')).toBe('maia_prefix');
    expect(classifyReservedToolName('mcp:a:b')).toBe('mcp_prefix');
    expect(classifyReservedToolName('all')).toBe('wildcard_all');
    expect(classifyReservedToolName('*')).toBe('wildcard');
    expect(classifyReservedToolName('read_turn_context')).toBeNull();
  });

  it('11. nome legítimo com `maia` no MEIO não é recusado (par do caso 5)', () => {
    // A regra é PREFIXO. Sem este par, trocar `startsWith` por `includes`
    // continuaria verde e barraria ferramentas legítimas em produção.
    expect(classifyReservedToolName('consulta_maia_interna')).toBeNull();
  });
});

describe('P05 — o deny inicial do §7.10.3 é parte do contrato', () => {
  it('12. ferramentas nativas perigosas do Hermes não entram na allowlist', () => {
    for (const nome of ['terminal', 'execute_code', 'write_file', 'memory', 'browser']) {
      expect(INITIAL_TOOL_DENY.has(nome)).toBe(true);
      expect(recusa(manifesto({ tools: [tool({ name: nome, maia_tool_name: nome })] }))).toBe(
        'denied_tool_name',
      );
    }
  });

  it('13. os wrappers LEGADOS de aprendizado da Maia também não entram', () => {
    // §7.10.3: "save_fact, save_rule, propose_fact, propose_memory, propose_rule,
    // propose_hint, remember_safe_fact ANTIGOS não entram na allowlist Hermes".
    // `remember_safe_fact` é o caso que morde: ele está em `baseline.core`
    // (`grant-math.ts`), então o eixo de grant do agente o traria — e só o deny
    // o tira.
    for (const nome of ['save_fact', 'propose_rule', 'remember_safe_fact']) {
      expect(INITIAL_TOOL_DENY.has(nome)).toBe(true);
      expect(recusa(manifesto({ tools: [tool({ name: nome, maia_tool_name: nome })] }))).toBe(
        'denied_tool_name',
      );
    }
  });

  it('14. o deny vale pelo `maia_tool_name` (nome exposto não disfarça)', () => {
    expect(
      recusa(manifesto({ tools: [tool({ name: 'contexto_seguro', maia_tool_name: 'terminal' })] })),
    ).toBe('denied_tool_name');
  });

  it('15. nome duplicado reprova — a allowlist é um CONJUNTO', () => {
    expect(recusa(manifesto({ tools: [tool(), tool()] }))).toBe('duplicate_tool_name');
  });
});

describe('P05 — o que autoriza não pode faltar nem ser inventado', () => {
  it('16. `effect_class` nulo reprova (§4.1: null NUNCA autoriza handler)', () => {
    expect(recusa(manifesto({ tools: [tool({ effect_class: null })] }))).toBe('schema');
  });

  it('17. `effect_class` fora do vocabulário da casa reprova', () => {
    expect(recusa(manifesto({ tools: [tool({ effect_class: 'seguro' })] }))).toBe('schema');
  });

  it('18. `audit_action` inventada reprova — auditoria não se inventa', () => {
    expect(recusa(manifesto({ tools: [tool({ audit_action: 'hermes_fez_algo' })] }))).toBe('schema');
    // E o contrato é a lista REAL da casa, não uma cópia local que envelhece.
    expect(AUDIT_ACTIONS as readonly string[]).toContain('memory_recalled');
  });

  it('19. `required_actions` fora de `ACTION_KEYS` reprova', () => {
    expect(recusa(manifesto({ tools: [tool({ required_actions: ['fazer_tudo'] })] }))).toBe(
      'schema',
    );
  });

  it('20. `output_projection_id` ausente reprova (T31, metade de contrato)', () => {
    const t = tool();
    delete (t as { output_projection_id?: unknown }).output_projection_id;
    expect(recusa(manifesto({ tools: [t] }))).toBe('schema');
  });

  it('21. `authorization_target` fora do trio do §7.10.1 reprova', () => {
    expect(recusa(manifesto({ tools: [tool({ authorization_target: 'qualquer' })] }))).toBe(
      'schema',
    );
    const ok = parseRuntimeManifest(
      manifesto({ tools: [tool({ authorization_target: 'current_subject' })] }),
    );
    expect(ok.kind).toBe('ok');
  });

  it('22. orçamento monetário exige unidade EXPLÍCITA e inteiro decimal', () => {
    const limites = (over: Record<string, unknown>) => ({
      ...(manifesto().limits as Record<string, unknown>),
      budget: over,
    });
    expect(recusa(manifesto({ limits: limites({ amount_microusd: 0.25, unit: 'microusd' }) }))).toBe(
      'schema',
    );
    expect(recusa(manifesto({ limits: limites({ amount_microusd: '250000' }) }))).toBe('schema');
  });
});

describe('P05 — os booleans de negação não conseguem dizer "pode"', () => {
  it('23. `denies.mcp: false` reprova o manifest inteiro', () => {
    // A V1 não tem MCP (§7.10.3). Se o campo fosse `z.boolean()`, um manifest
    // gerado errado LIGARIA a capacidade; sendo literal `true`, a única coisa que
    // "desligar a negação" consegue produzir é um manifest inválido.
    const d = { ...(manifesto().denies as Record<string, unknown>), mcp: false };
    expect(recusa(manifesto({ denies: d }))).toBe('schema');
  });

  it('24. cada negação do §4.2 é obrigatória — omitir uma reprova', () => {
    for (const chave of [
      'native_memory',
      'generic_filesystem',
      'code_execution',
      'browsing',
      'mcp',
      'delegation',
      'background_review',
      'cron',
      'messaging',
      'discovery_expanding_tools',
    ]) {
      const d = { ...(manifesto().denies as Record<string, unknown>) };
      delete d[chave];
      expect(recusa(manifesto({ denies: d }))).toBe('schema');
    }
  });
});

describe('P05 — digest e vocabulário de recusa', () => {
  it('25. o digest é canônico: reordenar chaves não muda o valor', () => {
    const a = parseRuntimeManifest(manifesto());
    const invertido = Object.fromEntries(Object.entries(manifesto()).reverse());
    const b = parseRuntimeManifest(invertido);
    expect(a.kind).toBe('ok');
    expect(b.kind).toBe('ok');
    if (a.kind !== 'ok' || b.kind !== 'ok') return;
    expect(computeManifestDigest(a.manifest)).toBe(computeManifestDigest(b.manifest));
    expect(computeManifestDigest(a.manifest)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('26. mudar UM limite de ferramenta muda o digest (par do caso 25)', () => {
    const a = parseRuntimeManifest(manifesto());
    const b = parseRuntimeManifest(
      manifesto({
        tools: [tool({ limits: { max_calls: 5, result_limit_chars: 8_000, timeout_ms: 5_000 } })],
      }),
    );
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('fixtures inválidas');
    expect(computeManifestDigest(a.manifest)).not.toBe(computeManifestDigest(b.manifest));
  });

  it('26b. o digest cobre o manifest INTEIRO, não só as ferramentas', () => {
    // Achado ao MAPEAR as mutações, antes de rodá-las: um
    // `canonicalDigest(manifest.tools)` passaria nos casos 25 e 26 e faria dois
    // manifests com LIMITES diferentes terem a mesma identidade — o
    // `manifest_digest` do binding deixaria de detectar troca de orçamento ou
    // de prazo, que é metade do que o §4.2 põe no manifest.
    const a = parseRuntimeManifest(manifesto());
    const b = parseRuntimeManifest(
      manifesto({
        limits: { ...(manifesto().limits as Record<string, unknown>), max_tool_calls: 9 },
      }),
    );
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('fixtures inválidas');
    expect(computeManifestDigest(a.manifest)).not.toBe(computeManifestDigest(b.manifest));
  });

  it('27. todo código de recusa emitido pertence ao vocabulário fechado', () => {
    const entradas: unknown[] = [
      null,
      42,
      manifesto({ approved: true }),
      manifesto({ tools: [tool({ name: 'all' })] }),
      manifesto({ tools: [tool({ name: 'terminal', maia_tool_name: 'terminal' })] }),
      manifesto({ tools: [tool(), tool()] }),
    ];
    for (const e of entradas) {
      const r = parseRuntimeManifest(e);
      expect(r.kind).toBe('rejected');
      if (r.kind !== 'rejected') continue;
      expect(MANIFEST_REJECTION_CODES as readonly string[]).toContain(r.code);
    }
  });

  it('28. a recusa é DETERMINÍSTICA: mesma entrada, mesmo código', () => {
    const entrada = manifesto({ tools: [tool({ name: 'maia_x' })] });
    expect(recusa(entrada)).toBe(recusa(entrada));
  });
});

describe('P05 — o módulo é PURO', () => {
  it('29. não importa banco, ALS, env, métricas nem o registry/dispatcher', () => {
    // A varredura é dos ESPECIFICADORES DE IMPORT, não do texto do arquivo.
    //
    // A primeira versão varria o texto inteiro — como faz o contrato de
    // `recovery.ts` — e reprovou por causa da PROSA: o cabeçalho cita
    // `@/config/env.js` justamente para dizer que NÃO o importa. Varrer texto
    // não distingue acoplamento de citação, e a citação é load-bearing (é o que
    // leva o próximo leitor ao par). O teste foi corrigido para MAIS preciso, e
    // não para mais frouxo: um import real continua morrendo aqui.
    const imports = [...fonte.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
    // Sem esta linha, uma regex quebrada devolveria [] e o caso passaria a
    // aprovar qualquer coisa em silêncio.
    expect(imports.length).toBeGreaterThan(0);
    for (const p of [
      '@/db/',
      'db/client',
      'tenant-context',
      '@/config/env',
      '@/lib/metrics',
      'drizzle-orm',
      '_registry',
      '_dispatcher',
    ]) {
      expect(imports.filter((i) => i.includes(p)), `import proibido: ${p}`).toEqual([]);
    }
  });

  it('30. o arquivo cita as seções que originam cada regra', () => {
    expect(fonte).toContain('4.2');
    expect(fonte).toContain('7.10');
    expect(fonte).toContain('K-19');
  });
});
