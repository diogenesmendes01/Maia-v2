/**
 * #636 (fatia A da épica #471) — O GUARDRAIL, que é o coração da issue.
 *
 *   **O agente especifica; humano implementa e instala.**
 *
 * Nada nesta fatia pode registrar tool, executar código proposto ou criar
 * capability — nem ao GERAR a proposta, nem ao APROVÁ-LA.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE ESTE ARQUIVO NÃO USA MAIS "ANTES × DEPOIS"
 * ─────────────────────────────────────────────────────────────────────────────
 * A primeira versão fotografava `Object.keys(REGISTRY)` antes e depois de rodar
 * o caminho de produção e comparava as duas fotos. Um delta sobre estado
 * GLOBAL E MUTÁVEL não é seguro sob `retry: 1` (`vitest.config.ts:130`), e o
 * furo é exatamente este:
 *
 *   tentativa 1 · antes=64, produção instala, depois=65 → VERMELHO
 *   tentativa 2 · o objeto de módulo ainda tem 65 (a mutação sobreviveu),
 *                 então antes=65, depois=65 → delta zero → VERDE
 *
 * O `retry` transformava o vermelho em verde, e o processo saía com
 * `falharam=0`. (O reporter denunciava em `RECUPERADOS PELA SEGUNDA TENTATIVA`,
 * mas quem lê os números do resumo não vê.) Um teste cuja segunda tentativa
 * herda o estrago como linha de base não testa nada.
 *
 * A correção é trocar DELTA por INVARIANTE ABSOLUTA. As três afirmações abaixo
 * são verdadeiras ou falsas por si só, em qualquer tentativa, sem depender de
 * uma foto anterior:
 *
 *   1. nenhuma tool viva fora do catálogo COMMITADO (`TOOL_CATALOG`);
 *   2. o grant do agente é EXATAMENTE o semeado (`baseline.core`, nada mais);
 *   3. o agente não tem NENHUMA capability de domínio ou skill.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FRONTEIRA DE COMPORTAMENTO, NÃO DE DIRETÓRIO
 * ─────────────────────────────────────────────────────────────────────────────
 * A invariante (1) usa `src/admin-ui/generated/tool-catalog.ts` — artefato
 * COMMITADO, mantido em dia por um teste bloqueante
 * (`tests/unit/tool-catalog-drift.spec.ts`). Isso é o que dá a fronteira certa:
 *
 *   · é ABSOLUTA, então sobrevive ao `retry`;
 *   · não depende de identidade de módulo — ela afirma sobre o registro VIVO,
 *     seja qual for a instância que o mutou;
 *   · **não tem fronteira de arquivo**: uma tool instalada em runtime a partir
 *     de QUALQUER arquivo, por qualquer mecanismo, não está no arquivo
 *     committado e por isso aparece.
 *
 * A varredura estática do fim do arquivo é a defesa SECUNDÁRIA, e agora é
 * derivada do GRAFO DE IMPORTS dos call sites reais (geração E aprovação), não
 * de um `readdirSync` de uma pasta. Ela tem uma fronteira declarada (módulos de
 * infraestrutura compartilhada) — ver `tests/helpers/grafo-de-imports.ts`.
 *
 * POR QUE ISSO NÃO É UM ESPELHO. O teste importa `proposeToolRequestForGap` e
 * `dispatchApproval` de produção e chama as duas. Apagar qualquer um derruba o
 * arquivo no `beforeAll`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { TOOL_CATALOG } from '@/admin-ui/generated/tool-catalog.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';
import { arquivosAlcancados } from '../helpers/grafo-de-imports.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'wt636_guard_tenant';
const AG = 'wt636_guard_agent';

/** O grant SEMEADO neste escopo. A invariante compara com ISTO, não com uma foto. */
const GRANT_SEMEADO = {
  granted_packs: ['baseline.core'],
  granted_tools: [] as string[],
  denied_tools: [] as string[],
};

let pool: pg.Pool;

const proposer = moduloDeProducao(() => import('@/cognition/tool-request/proposer.js'));
const registro = moduloDeProducao(() => import('@/tools/_registry.js'));
const aprovacao = moduloDeProducao(() => import('@/cognition/proposal-approval-handler.js'));

/**
 * As tools VIVAS que o catálogo committado não declara.
 *
 * Este é o detector do guardrail. `TOOL_CATALOG` é gerado por
 * `npm run gen:tool-catalog` a partir do registro e vive em disco sob revisão;
 * o registro vivo só pode ser um SUBCONJUNTO dele (o catálogo ainda lista as
 * tools desligadas por flag de config, que somem do `REGISTRY`). Qualquer nome
 * a mais em runtime é, por definição, tool que nasceu sem código revisado.
 */
function toolsNaoDeclaradas(REGISTRY: Record<string, unknown>): string[] {
  const declaradas = new Set(TOOL_CATALOG.map((t) => t.name));
  return Object.keys(REGISTRY)
    .filter((nome) => !declaradas.has(nome))
    .sort();
}

/** As três invariantes absolutas, afirmadas de uma vez. */
async function exigirNadaInstalado(c: pg.PoolClient, quando: string): Promise<void> {
  const { REGISTRY } = registro();

  expect(
    toolsNaoDeclaradas(REGISTRY as unknown as Record<string, unknown>),
    `${quando}: tool viva fora do catálogo committado`,
  ).toEqual([]);

  const grants = await c.query(
    `SELECT granted_packs, granted_tools, denied_tools FROM agent_tool_grants
      WHERE tenant_id = $1 AND agent_id = $2`,
    [T, AG],
  );
  expect(grants.rows, `${quando}: o grant do agente mudou`).toEqual([GRANT_SEMEADO]);

  const caps = await c.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM agent_capabilities_domain
              WHERE tenant_id = $1 AND agent_id = $2)
           + (SELECT count(*) FROM agent_capabilities_skill
              WHERE tenant_id = $1 AND agent_id = $2) AS n`,
    [T, AG],
  );
  expect(Number(caps.rows[0]!.n), `${quando}: capability criada para o agente`).toBe(0);
}

async function prepararCenario(c: pg.PoolClient): Promise<{ gapId: string }> {
  const g = await c.query<{ id: string }>(
    `INSERT INTO agent_capability_gaps
       (tenant_id, agent_id, capability_description, tipo, contexto,
        frequency_score, severity_score, current_level)
     VALUES ($1, $2, 'emitir guia de recolhimento no portal municipal', 'tool',
             'cobranca', 7, 6, 'proposed') RETURNING id`,
    [T, AG],
  );
  const gapId = g.rows[0]!.id;
  await c.query(
    `INSERT INTO agent_capability_gap_observations
       (tenant_id, agent_id, gap_id, intent, attempted_args)
     VALUES ($1, $2, $3, 'emitir guia de recolhimento', '{"competencia":"2026-08"}'::jsonb)`,
    [T, AG, gapId],
  );
  return { gapId };
}

async function faxina(c: pg.PoolClient, gapId: string) {
  if (!gapId) return;
  await c
    .query('DELETE FROM capability_proposals WHERE gap_id = $1', [gapId])
    .catch(() => undefined);
  await c
    .query('DELETE FROM agent_capability_gap_observations WHERE gap_id = $1', [gapId])
    .catch(() => undefined);
  await c.query('DELETE FROM agent_capability_gaps WHERE id = $1', [gapId]).catch(() => undefined);
}

d('#636 — guardrail: nenhum caminho registra tool automaticamente', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    const c = await pool.connect();
    try {
      await c.query('INSERT INTO tenants(id, nome) VALUES ($1, $1) ON CONFLICT DO NOTHING', [T]);
      await c.query(
        'INSERT INTO agents(id, tenant_id, nome) VALUES ($1, $2, $1) ON CONFLICT DO NOTHING',
        [AG, T],
      );
      // Semeia o grant no valor EXATO com que a invariante o compara, e o
      // reafirma em cada rodada (DO UPDATE) para que uma rodada anterior que
      // tenha sujado o escopo não vire linha de base desta.
      await c.query(
        `INSERT INTO agent_tool_grants (tenant_id, agent_id, granted_packs, granted_tools, denied_tools)
         VALUES ($1, $2, ARRAY['baseline.core'], ARRAY[]::text[], ARRAY[]::text[])
         ON CONFLICT (tenant_id, agent_id) DO UPDATE
           SET granted_packs = ARRAY['baseline.core'],
               granted_tools = ARRAY[]::text[],
               denied_tools  = ARRAY[]::text[]`,
        [T, AG],
      );
      await c.query(
        'DELETE FROM agent_capabilities_domain WHERE tenant_id = $1 AND agent_id = $2',
        [T, AG],
      );
      await c.query(
        'DELETE FROM agent_capabilities_skill WHERE tenant_id = $1 AND agent_id = $2',
        [T, AG],
      );
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  it('o detector enxerga instalação vinda de QUALQUER lugar (autoteste)', () => {
    // Sem este caso, `toEqual([])` poderia estar passando por o detector ser
    // cego, e não por nada estar instalado. Aqui a "instalação" vem de um
    // arquivo que não é nenhum dos do caminho — que é justamente o ponto: a
    // invariante não tem fronteira de arquivo.
    const REGISTRY = registro().REGISTRY as unknown as Record<string, unknown>;
    expect(toolsNaoDeclaradas(REGISTRY)).toEqual([]);
    REGISTRY['tool_instalada_por_qualquer_arquivo'] = REGISTRY.explain_limitation;
    try {
      expect(toolsNaoDeclaradas(REGISTRY)).toEqual(['tool_instalada_por_qualquer_arquivo']);
    } finally {
      delete REGISTRY['tool_instalada_por_qualquer_arquivo'];
    }
    expect(toolsNaoDeclaradas(REGISTRY)).toEqual([]);
  });

  it('gerar a proposta NÃO registra tool nem concede capability', async () => {
    const c = await pool.connect();
    let gapId = '';
    try {
      await exigirNadaInstalado(c, 'antes de gerar');
      ({ gapId } = await prepararCenario(c));

      const gap = (await c.query('SELECT * FROM agent_capability_gaps WHERE id = $1', [gapId]))
        .rows[0];
      const r = await runWithTenantContext({ tenant_id: T, agent_id: AG }, () =>
        proposer().proposeToolRequestForGap({ gap: gap as never }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      await exigirNadaInstalado(c, 'depois de gerar');

      // A tool PROPOSTA não existe — a proposta é sobre o que falta.
      const nome = r.spec.contract_draft.proposed_tool_name;
      expect(nome.length).toBeGreaterThan(0);
      expect(Object.keys(registro().REGISTRY)).not.toContain(nome);

      // O que foi produzido é UMA linha de proposta, e só.
      const n = await c.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM capability_proposals WHERE gap_id = $1',
        [gapId],
      );
      expect(n.rows[0]!.n).toBe(1);
    } finally {
      await faxina(c, gapId);
      c.release();
    }
  });

  it('APROVAR a proposta também não registra tool — a aprovação é um aceno a humanos', async () => {
    const c = await pool.connect();
    let gapId = '';
    try {
      await exigirNadaInstalado(c, 'antes de aprovar');
      ({ gapId } = await prepararCenario(c));

      const gap = (await c.query('SELECT * FROM agent_capability_gaps WHERE id = $1', [gapId]))
        .rows[0];
      const r = await runWithTenantContext({ tenant_id: T, agent_id: AG }, () =>
        proposer().proposeToolRequestForGap({ gap: gap as never }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const proposta = (
        await c.query('SELECT * FROM capability_proposals WHERE id = $1', [r.proposal_id])
      ).rows[0];

      const resultado = await runWithTenantContext({ tenant_id: T, agent_id: AG }, () =>
        aprovacao().dispatchApproval(proposta as never, { approverId: 'dono' }),
      );

      // Aprovar é onde alguém escreveria "aprovou, então instala". As três
      // invariantes são afirmadas DEPOIS da aprovação, e são absolutas: uma
      // segunda tentativa não herda o estrago como linha de base.
      await exigirNadaInstalado(c, 'depois de aprovar');

      // O dispatcher trata `tool_request` num `case` EXPLÍCITO e terminal —
      // não é o `default` (que lançaria) nem o stub `approved_no_op` (que quer
      // dizer "handler ainda não existe"). Ver o cabeçalho de
      // `src/cognition/proposal-approval-handler.ts`.
      expect(resultado).toEqual({
        status: 'acknowledged_for_humans',
        capability_type: 'tool_request',
      });
    } finally {
      await faxina(c, gapId);
      c.release();
    }
  });

  it('o rascunho de contrato NUNCA é avaliado: é texto, e nada o executa', async () => {
    const c = await pool.connect();
    let gapId = '';
    try {
      ({ gapId } = await prepararCenario(c));
      const gap = (await c.query('SELECT * FROM agent_capability_gaps WHERE id = $1', [gapId]))
        .rows[0];
      const r = await runWithTenantContext({ tenant_id: T, agent_id: AG }, () =>
        proposer().proposeToolRequestForGap({ gap: gap as never }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.spec.contract_draft.zod_source).toContain('PROPOSTA — NÃO É CONTRATO VIGENTE');
      expect(r.spec.contract_draft.zod_source).toContain('NENHUMA tool foi registrada');
      expect(r.spec.guardrail).toBe('o agente especifica; humano implementa e instala');
      await exigirNadaInstalado(c, 'depois de renderizar o rascunho');
    } finally {
      await faxina(c, gapId);
      c.release();
    }
  });
});

/**
 * Varredura de FONTE — defesa secundária.
 *
 * A invariante de runtime acima é absoluta e não tem fronteira de arquivo. Esta
 * varredura existe para o flanco que ela não cobre: um caminho de escrita que
 * só dispare sob outra condição (uma flag, um `capability_type` diferente, um
 * horário) e portanto nunca rode na rodada. Ela lê a FONTE dos arquivos que o
 * caminho realmente alcança e recusa a presença dos verbos de instalação.
 *
 * O conjunto varrido vem do GRAFO DE IMPORTS a partir dos call sites reais —
 * geração, disparo e aprovação — e não de um `readdirSync` de uma pasta. Foi o
 * `readdirSync` que deixou `proposal-approval-handler.ts` de fora, que é
 * exatamente o arquivo onde alguém escreveria "aprovou, então instala".
 */
describe('#636 — nenhum arquivo do CAMINHO contém verbo de instalação', () => {
  const raizDoSrc = fileURLToPath(new URL('../../src/', import.meta.url));
  const doSrc = (rel: string) => fileURLToPath(new URL(`../../src/${rel}`, import.meta.url));

  /** Os call sites reais do pedido de ferramenta: gerar, disparar, aprovar. */
  const ENTRADAS = [
    'cognition/tool-request/proposer.ts',
    'cognition/tool-request/types.ts',
    'cognition/tool-request/contract-draft.ts',
    'cognition/tool-request/existing-tool.ts',
    'workers/gap-escalation-monitor.ts',
    'cognition/proposal-approval-handler.ts',
    'tools/approve-capability-proposal.ts',
  ].map(doSrc);

  /**
   * Onde a travessia para. Cada linha é uma cegueira ASSUMIDA, e o motivo é
   * sempre o mesmo: estes módulos DEFINEM os verbos proibidos (ou puxam metade
   * da plataforma), então varrê-los acusaria a definição como se fosse uso.
   * Ver `tests/helpers/grafo-de-imports.ts`.
   */
  const BARREIRAS = [
    'db/', // define agentToolGrantsRepo, capabilitiesSkillRepo, capabilitiesDomainRepo
    'tools/_registry.ts', // define o próprio REGISTRY
    'tools/packs.ts',
    'tools/grant-math.ts',
    'tools/runtime-filter.ts',
    'lib/',
    'config/',
    'governance/',
    'observability/',
    'shared/',
    'types/',
    'admin-ui/',
    'control-plane/',
    'runtime/',
    'identity/',
  ];

  const PROIBIDOS: Array<{ padrao: RegExp; porque: string }> = [
    // `[^\n;]*` entre o nome e o `[` é o que faz o padrão sobreviver a um
    // CAST — `(REGISTRY as Record<string, unknown>)['x'] = y` foi exatamente a
    // forma que a sonda do revisor usou, e um padrão ancorado em
    // `REGISTRY\s*\[` não a vê. O `;` fecha o alcance no fim do statement.
    { padrao: /\bREGISTRY\b[^\n;]*\[[^\]\n]*\]\s*=[^=]/, porque: 'escrita no registro de tools' },
    { padrao: /\bREGISTRY\b[^\n;]*\.[A-Za-z_$][\w$]*\s*=[^=]/, porque: 'escrita no registro de tools' },
    { padrao: /\bObject\.(assign|defineProperty)\s*\(\s*\(?\s*REGISTRY\b/, porque: 'escrita no registro de tools' },
    { padrao: /agentToolGrantsRepo/, porque: 'concessão de tool ao agente' },
    { padrao: /capabilitiesSkillRepo|capabilitiesDomainRepo/, porque: 'criação de capability' },
    { padrao: /\beval\s*\(/, porque: 'execução de código proposto' },
    { padrao: /new\s+Function\s*\(/, porque: 'execução de código proposto' },
  ];

  /**
   * Tira comentários antes de casar. Os cabeçalhos desta fatia FALAM dos verbos
   * proibidos — é justamente onde está escrito por que eles não aparecem — e
   * casar contra prosa transformaria a documentação do guardrail em violação
   * do guardrail. O que interessa é o CÓDIGO.
   */
  function semComentarios(fonte: string): string {
    return fonte.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  const alcancados = (): string[] =>
    arquivosAlcancados({ entradas: ENTRADAS, raizDoSrc, barreiras: BARREIRAS });

  it('o conjunto varrido é derivado do grafo e CONTÉM o caminho de aprovação', () => {
    const rel = alcancados().map((f) => f.slice(raizDoSrc.length));
    // Se a travessia quebrar e devolver pouco, a varredura passaria por
    // vacuidade. Estes são os arquivos que o guardrail existe para vigiar —
    // e `proposal-approval-handler.ts` é o que a versão anterior perdia.
    for (const obrigatorio of [
      'cognition/tool-request/proposer.ts',
      'cognition/tool-request/contract-draft.ts',
      'cognition/tool-request/existing-tool.ts',
      'cognition/tool-request/types.ts',
      'cognition/proposal-approval-handler.ts',
      'cognition/proposal-approval-handlers/holiday.ts',
      'cognition/capability-proposer.ts',
      'workers/gap-escalation-monitor.ts',
      'tools/approve-capability-proposal.ts',
    ]) {
      expect(rel, `o grafo perdeu ${obrigatorio}`).toContain(obrigatorio);
    }
    // E o grafo tem de ir ALÉM das entradas declaradas — senão ele é a lista
    // fixa que ele veio substituir.
    expect(rel.length).toBeGreaterThan(ENTRADAS.length);
  });

  it('a varredura enxerga um verbo plantado em qualquer arquivo alcançado', () => {
    // Autoteste do detector: sem ele, `toEqual([])` poderia estar passando por
    // os padrões estarem quebrados.
    const formas = [
      "REGISTRY['x'] = y;",
      // A forma com CAST — a que a revisão usou para furar a versão anterior.
      "(REGISTRY as Record<string, unknown>)['x'] = REGISTRY.explain_limitation;",
      'REGISTRY.x = y;',
      'Object.assign(REGISTRY, { x: y });',
    ];
    for (const forma of formas) {
      const achados = PROIBIDOS.filter((p) => p.padrao.test(semComentarios(forma)));
      expect(achados.map((a) => a.porque), `nao pegou: ${forma}`).toContain(
        'escrita no registro de tools',
      );
    }
    // E não pode acusar LEITURA: `proposer.ts` lê o registro de propósito.
    for (const leitura of ['return Object.keys(REGISTRY);', 'const t = REGISTRY[nome];']) {
      expect(
        PROIBIDOS.some((p) => p.padrao.test(semComentarios(leitura))),
        `falso positivo em: ${leitura}`,
      ).toBe(false);
    }
    expect(PROIBIDOS.some((p) => p.padrao.test(semComentarios('await agentToolGrantsRepo.x()')))).toBe(
      true,
    );
  });

  it('o removedor de comentários não engole código (senão a varredura seria cega)', () => {
    expect(semComentarios('const a = 1; // agentToolGrantsRepo')).toContain('const a = 1;');
    expect(semComentarios('const a = 1; // agentToolGrantsRepo')).not.toContain(
      'agentToolGrantsRepo',
    );
    expect(semComentarios('/* eval( */ eval(x)')).toContain('eval(x)');
    expect(semComentarios("const u = 'https://x/y';")).toContain('https://x/y');
  });

  it('nenhum arquivo do caminho registra, concede ou executa', () => {
    const achados: string[] = [];
    for (const arquivo of alcancados()) {
      const codigo = semComentarios(readFileSync(arquivo, 'utf8'));
      for (const { padrao, porque } of PROIBIDOS) {
        if (padrao.test(codigo)) {
          achados.push(`${arquivo.slice(raizDoSrc.length)}: ${porque} (${padrao})`);
        }
      }
    }
    expect(achados).toEqual([]);
  });
});
