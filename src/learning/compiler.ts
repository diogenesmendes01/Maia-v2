/**
 * P09 (spec §7.7) — COMPILADOR do bundle publicado.
 *
 * ─── O que ele produz, e o que ele não é ────────────────────────────────────
 *
 * Uma PROJEÇÃO IMUTÁVEL de uma skill aprovada da Maia. A primeira linha do
 * §7.7.1 é o contrato inteiro: "NOVO compilador/publicador produz projeção
 * imutável, **não replica autoridade**".
 *
 * A distinção não é retórica. O bundle carrega `allowed_tools`, `usage_policy`
 * e `constraints`, e nenhum deles autoriza nada: quem intersecta ferramentas
 * por turno é o dispatcher, quem avalia política é o backend, e o texto do
 * `SKILL.md` não implementa hard limit. O bundle DESCREVE o que a Maia decidiu;
 * ele não decide.
 *
 * ─── Determinismo é o requisito, não uma qualidade ──────────────────────────
 *
 * O digest do bundle é o que o wrapper confere antes de executar. Se a mesma
 * skill compilasse para digests diferentes em duas execuções, a conferência
 * passaria a reprovar publicações legítimas — e, pior, a única forma de fazê-la
 * parar de reprovar seria afrouxá-la.
 *
 * Por isso: chaves ordenadas, sem timestamp no material, sem id gerado na hora.
 * O digest é função do CONTEÚDO.
 *
 * ─── Onde ele recusa ────────────────────────────────────────────────────────
 *
 * Política malformada BLOQUEIA (§7.7.1). Ausente ou `{}` cai no default
 * conservador interno — e o §7.7.1 é explícito em que isso NÃO é `public_safe`.
 * Um wildcard em `allowed_tools` bloqueia: "nomes exatos no manifest; nenhum
 * wildcard".
 */
import { createHash } from 'node:crypto';
import {
  CONSERVATIVE_DEFAULT_USAGE_POLICY,
  SkillUsagePolicySchema,
  type SkillUsagePolicy,
} from '@/skills/usage-policy.js';

/** O que a Maia tem, do lado canônico. */
export type SkillSourceV1 = {
  skill_id: string;
  version: number;
  tenant_id: string;
  /** `null` significa tenant-wide — NÃO global (§7.7.1). */
  agent_id: string | null;
  goal: string;
  when_to_use: string;
  category: string;
  procedure: string;
  constraints: readonly string[];
  allowed_tools: readonly string[];
  applicable_to_role: readonly string[];
  /** JSON cru da coluna; pode ser `null`, `{}` ou malformado. */
  usage_policy: unknown;
  input_schema: unknown;
  output_schema: unknown;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
};

export type CompiledBundleV1 = {
  /** Digest do conteúdo. É o que o wrapper confere. */
  bundle_digest: string;
  manifest: Record<string, unknown>;
  files: {
    'manifest.json': string;
    'SKILL.md': string;
    'references/input.schema.json': string;
    'references/output.schema.json': string;
    'references/usage-policy.json': string;
  };
};

export type CompileResultV1 =
  | { kind: 'compiled'; bundle: CompiledBundleV1 }
  | {
      kind: 'blocked';
      reason:
        | 'usage_policy_malformed'
        | 'wildcard_tool'
        | 'not_approved'
        | 'confirmation_not_wired'
        | 'exposure_requires_approval';
      detail: string;
    };

/** JSON canônico: chaves ordenadas em toda profundidade. */
function canonical(value: unknown): string {
  const ordenar = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(ordenar);
    const entradas = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entradas.map(([k, val]) => [k, ordenar(val)]));
  };
  return JSON.stringify(ordenar(value));
}

function sha256(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

/**
 * Nome técnico do bundle.
 *
 * Derivado de UUID e versão, NUNCA do texto que a skill declara sobre si —
 * §7.7.1: "nome técnico seguro baseado no UUID/versão, descriptor preservado
 * como dado". Um nome vindo do descriptor seria conteúdo escolhido do outro
 * lado virando caminho de diretório.
 */
export function bundleTechnicalName(skill_id: string, version: number): string {
  return `s_${skill_id.replace(/-/g, '')}_v${version}`;
}

/**
 * A política EFETIVA e seu hash.
 *
 * Três casos, e o do meio é o que a spec chama nominalmente:
 *  - ausente ou `{}` → default conservador INTERNO. Não é `public_safe`;
 *  - válida → ela mesma;
 *  - malformada → bloqueia. Uma política que não parseia é uma política que
 *    ninguém consegue avaliar, e publicar assim entregaria a skill sem regra.
 */
function resolverPolitica(
  raw: unknown,
): { kind: 'ok'; policy: SkillUsagePolicy } | { kind: 'malformed'; detail: string } {
  const vazio =
    raw === null ||
    raw === undefined ||
    (typeof raw === 'object' &&
      !Array.isArray(raw) &&
      Object.keys(raw as Record<string, unknown>).length === 0);
  if (vazio) return { kind: 'ok', policy: CONSERVATIVE_DEFAULT_USAGE_POLICY };

  const parsed = SkillUsagePolicySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: 'malformed',
      detail: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}:${i.code}`)
        .join(','),
    };
  }
  return { kind: 'ok', policy: parsed.data };
}

/**
 * Compila a skill aprovada num bundle publicável.
 *
 * `allowCanaryGated` existe para o dia em que a ligação de confirmação e
 * destinatário estiver comprovada. Enquanto não estiver, o default do canário
 * do §7.7.1 vale: skill com `requires_confirmation=true` ou
 * `exposure_policy=approval_required` fica FORA, porque
 * `evaluateUsagePolicy` declara esses campos e **não os executa como gates**.
 * Publicar assim alegaria uma garantia que o avaliador não dá.
 */
export function compileSkillBundle(
  source: SkillSourceV1,
  opts: { allowCanaryGated?: boolean } = {},
): CompileResultV1 {
  if (source.status !== 'active') {
    return {
      kind: 'blocked',
      reason: 'not_approved',
      detail: `status=${source.status}: só skill ativa é publicável`,
    };
  }

  const curinga = source.allowed_tools.find((t) => t.includes('*') || t.trim() === '');
  if (curinga !== undefined) {
    // "nomes exatos no manifest; nenhum wildcard". Um curinga transformaria o
    // manifest numa promessa aberta, e a interseção por turno passaria a ser a
    // única coisa entre a skill e o registry inteiro.
    return { kind: 'blocked', reason: 'wildcard_tool', detail: `allowed_tools: ${curinga}` };
  }

  const politica = resolverPolitica(source.usage_policy);
  if (politica.kind === 'malformed') {
    return { kind: 'blocked', reason: 'usage_policy_malformed', detail: politica.detail };
  }

  if (opts.allowCanaryGated !== true) {
    if (politica.policy.requires_confirmation) {
      return {
        kind: 'blocked',
        reason: 'confirmation_not_wired',
        detail: 'requires_confirmation=true e a ligação de confirmação não está comprovada',
      };
    }
    if (politica.policy.exposure_policy === 'approval_required') {
      return {
        kind: 'blocked',
        reason: 'exposure_requires_approval',
        detail: 'exposure_policy=approval_required sem gate de destinatário comprovado',
      };
    }
  }

  const usagePolicyJson = canonical(politica.policy);
  const inputSchemaJson = canonical(source.input_schema ?? {});
  const outputSchemaJson = canonical(source.output_schema ?? {});

  const skillMd = renderSkillMd(source, politica.policy);

  /**
   * O manifest NÃO carrega `approved_by`.
   *
   * §7.7.1 diz que aprovação é "metadados privados de governança" e que "não é
   * necessário expor nome de aprovador ao cliente". O bundle atravessa para o
   * outro lado; o nome de quem assinou fica do lado de cá, no registry.
   */
  const manifest: Record<string, unknown> = {
    bundle_format: 1,
    technical_name: bundleTechnicalName(source.skill_id, source.version),
    skill_id: source.skill_id,
    version: source.version,
    scope: { tenant_id: source.tenant_id, agent_id: source.agent_id },
    category: source.category,
    descriptor: { goal: source.goal, when_to_use: source.when_to_use },
    allowed_tools: [...source.allowed_tools].sort(),
    applicable_to_role: [...source.applicable_to_role].sort(),
    // Constraints entram como REFERÊNCIA e hash: o texto explica, os
    // avaliadores do backend é que aplicam (§7.7.1).
    constraints_digest: sha256(canonical([...source.constraints].sort())),
    digests: {
      skill_md: sha256(skillMd),
      input_schema: sha256(inputSchemaJson),
      output_schema: sha256(outputSchemaJson),
      usage_policy: sha256(usagePolicyJson),
    },
  };

  const manifestJson = canonical(manifest);

  /**
   * O digest do BUNDLE cobre o manifest e todos os arquivos.
   *
   * Cobrir só o manifest deixaria o conteúdo de `SKILL.md` fora da
   * conferência — e é `SKILL.md` que o modelo lê.
   */
  const bundle_digest = sha256(
    canonical({
      manifest: manifestJson,
      skill_md: skillMd,
      input_schema: inputSchemaJson,
      output_schema: outputSchemaJson,
      usage_policy: usagePolicyJson,
    }),
  );

  return {
    kind: 'compiled',
    bundle: {
      bundle_digest,
      manifest,
      files: {
        'manifest.json': manifestJson,
        'SKILL.md': skillMd,
        'references/input.schema.json': inputSchemaJson,
        'references/output.schema.json': outputSchemaJson,
        'references/usage-policy.json': usagePolicyJson,
      },
    },
  };
}

/**
 * O corpo instrucional.
 *
 * Determinístico e sem nada que mude entre execuções. A proveniência vem do id
 * e da versão — não de data de geração, que faria o digest variar sozinho.
 */
function renderSkillMd(source: SkillSourceV1, policy: SkillUsagePolicy): string {
  const linhas: string[] = [
    '---',
    `skill_id: ${source.skill_id}`,
    `version: ${source.version}`,
    `technical_name: ${bundleTechnicalName(source.skill_id, source.version)}`,
    '---',
    '',
    `# ${source.category}`,
    '',
    '## Objetivo',
    '',
    source.goal,
    '',
    '## Quando usar',
    '',
    source.when_to_use,
    '',
    '## Procedimento',
    '',
    source.procedure,
    '',
    '## Restrições',
    '',
    // As restrições aparecem como TEXTO explicativo. A linha seguinte não é
    // decorativa: sem ela, alguém lê a lista e conclui que o bundle as aplica.
    '> Estas restrições são descritivas. Quem as aplica é o backend da Maia;',
    '> o texto abaixo não implementa limite nenhum por si.',
    '',
    ...[...source.constraints].sort().map((c) => `- ${c}`),
    '',
    '## Ferramentas permitidas',
    '',
    ...[...source.allowed_tools].sort().map((t) => `- ${t}`),
    '',
    '## Política de uso (resumo)',
    '',
    `- audiência: ${[...policy.allowed_audience].sort().join(', ')}`,
    `- classe de dado: ${[...policy.data_scope].sort().join(', ')}`,
    `- exposição: ${policy.exposure_policy}`,
    `- autenticação mínima: ${policy.requires_auth_level}`,
    '',
  ];
  return linhas.join('\n');
}
