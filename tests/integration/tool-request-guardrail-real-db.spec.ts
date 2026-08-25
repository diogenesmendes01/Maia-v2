/**
 * #636 (fatia A da épica #471) — O GUARDRAIL, que é o coração da issue.
 *
 *   **O agente especifica; humano implementa e instala.**
 *
 * Nada nesta fatia pode registrar tool, executar código proposto ou criar
 * capability. Estes casos provam isso ANCORADOS NO CALL SITE REAL:
 *
 *  · o registro de tools é o objeto `REGISTRY` de `src/tools/_registry.ts`
 *    — o MESMO módulo que `proposer.ts` importa e que o dispatcher usa. O caso
 *    fotografa `Object.keys(REGISTRY)` antes e depois de rodar o caminho de
 *    produção e exige que as fotos sejam iguais;
 *  · a instalação por agente é a tabela `agent_tool_grants` (#408) e as
 *    `agent_capabilities_*` — as fotos são as LINHAS dessas tabelas no escopo,
 *    lidas por SQL cru.
 *
 * POR QUE ISSO NÃO É UM ESPELHO. O teste não reconstrói o caminho: ele importa
 * `proposeToolRequestForGap` e `dispatchApproval` de produção e chama as duas.
 * Apagar qualquer um dos dois derruba o arquivo no `beforeAll` (o import falha),
 * e plugar um registro automático em qualquer ponto do caminho muda uma das
 * fotos. Não existe versão deste arquivo que fique verde com o código de
 * produção ausente.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { moduloDeProducao } from '../helpers/modulo-de-producao.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const T = 'wt636_guard_tenant';
const AG = 'wt636_guard_agent';

let pool: pg.Pool;

const proposer = moduloDeProducao(() => import('@/cognition/tool-request/proposer.js'));
const registro = moduloDeProducao(() => import('@/tools/_registry.js'));
const aprovacao = moduloDeProducao(() => import('@/cognition/proposal-approval-handler.js'));

/** A foto do estado que "instalar uma tool" mudaria. */
type Foto = {
  registry: string[];
  grants: string;
  capsDominio: string;
  capsSkill: string;
};

async function fotografar(c: pg.PoolClient, REGISTRY: Record<string, unknown>): Promise<Foto> {
  const q = async (sql: string) => JSON.stringify((await c.query(sql, [T, AG])).rows);
  return {
    registry: Object.keys(REGISTRY).sort(),
    grants: await q(
      `SELECT granted_packs, granted_tools, denied_tools FROM agent_tool_grants
        WHERE tenant_id = $1 AND agent_id = $2 ORDER BY id`,
    ),
    capsDominio: await q(
      `SELECT domain FROM agent_capabilities_domain
        WHERE tenant_id = $1 AND agent_id = $2 ORDER BY domain`,
    ),
    capsSkill: await q(
      `SELECT domain, skill_name FROM agent_capabilities_skill
        WHERE tenant_id = $1 AND agent_id = $2 ORDER BY domain, skill_name`,
    ),
  };
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
      await c.query(
        `INSERT INTO agent_tool_grants (tenant_id, agent_id, granted_packs, granted_tools, denied_tools)
         VALUES ($1, $2, ARRAY['baseline.core'], ARRAY[]::text[], ARRAY[]::text[])
         ON CONFLICT (tenant_id, agent_id) DO NOTHING`,
        [T, AG],
      );
    } finally {
      c.release();
    }
  });
  afterAll(async () => {
    await pool.end();
  });

  it('gerar a proposta NÃO registra tool nem concede capability', async () => {
    const c = await pool.connect();
    let gapId = '';
    try {
      const { REGISTRY } = registro();
      ({ gapId } = await prepararCenario(c));
      const antes = await fotografar(c, REGISTRY);

      const gap = (await c.query('SELECT * FROM agent_capability_gaps WHERE id = $1', [gapId]))
        .rows[0];
      const r = await runWithTenantContext({ tenant_id: T, agent_id: AG }, () =>
        proposer().proposeToolRequestForGap({ gap: gap as never }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const depois = await fotografar(c, REGISTRY);

      // 1 · o registro de tools de produção é BIT A BIT o mesmo.
      expect(depois.registry).toEqual(antes.registry);
      // 2 · nada foi instalado no agente.
      expect(depois.grants).toBe(antes.grants);
      expect(depois.capsDominio).toBe(antes.capsDominio);
      expect(depois.capsSkill).toBe(antes.capsSkill);

      // 3 · a tool PROPOSTA não existe — a proposta é sobre o que falta.
      const nome = r.spec.contract_draft.proposed_tool_name;
      expect(nome.length).toBeGreaterThan(0);
      expect(depois.registry).not.toContain(nome);

      // 4 · o que foi produzido é UMA linha de proposta, e só.
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
      const { REGISTRY } = registro();
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

      const antes = await fotografar(c, REGISTRY);
      const resultado = await runWithTenantContext({ tenant_id: T, agent_id: AG }, () =>
        aprovacao().dispatchApproval(proposta as never, { approverId: 'dono' }),
      );
      const depois = await fotografar(c, REGISTRY);

      // O dispatcher trata `tool_request` num `case` EXPLÍCITO e terminal —
      // não é o `default` (que lançaria) nem o stub `approved_no_op` (que quer
      // dizer "handler ainda não existe"). Ver o cabeçalho de
      // `src/cognition/proposal-approval-handler.ts`.
      expect(resultado).toEqual({
        status: 'acknowledged_for_humans',
        capability_type: 'tool_request',
      });
      expect(depois.registry).toEqual(antes.registry);
      expect(depois.grants).toBe(antes.grants);
      expect(depois.capsDominio).toBe(antes.capsDominio);
      expect(depois.capsSkill).toBe(antes.capsSkill);
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

      // O texto está lá, marcado, e permanece texto: nenhum símbolo com esse
      // nome passou a existir no registro (verificado no caso acima) e nenhum
      // caminho desta fatia chama eval/Function/import — verificado abaixo.
      expect(r.spec.contract_draft.zod_source).toContain('PROPOSTA — NÃO É CONTRATO VIGENTE');
      expect(r.spec.contract_draft.zod_source).toContain('NENHUMA tool foi registrada');
      expect(r.spec.guardrail).toBe('o agente especifica; humano implementa e instala');
    } finally {
      await faxina(c, gapId);
      c.release();
    }
  });
});

/**
 * Varredura de FONTE, complementar às fotos acima.
 *
 * As fotos provam que ESTA execução não registrou nada. Esta varredura fecha o
 * flanco de um caminho de escrita que só disparasse em outra condição: ela lê
 * os arquivos REAIS da fatia e recusa a presença dos verbos de instalação.
 *
 * Não passa vacuamente: o caso exige que a pasta tenha os arquivos esperados,
 * então apagá-la reprova em vez de "não encontrar nada de errado".
 */
describe('#636 — a fatia não contém verbo de instalação', () => {
  const raizDaFatia = fileURLToPath(new URL('../../src/cognition/tool-request/', import.meta.url));

  const PROIBIDOS: Array<{ padrao: RegExp; porque: string }> = [
    { padrao: /\bREGISTRY\s*\[[^\]]*\]\s*=/, porque: 'escrita no registro de tools' },
    { padrao: /agentToolGrantsRepo/, porque: 'concessão de tool ao agente' },
    { padrao: /capabilitiesSkillRepo|capabilitiesDomainRepo/, porque: 'criação de capability' },
    { padrao: /\beval\s*\(/, porque: 'execução de código proposto' },
    { padrao: /new\s+Function\s*\(/, porque: 'execução de código proposto' },
    { padrao: /\bimport\s*\(/, porque: 'import dinâmico de código proposto' },
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

  it('os arquivos da fatia existem (a varredura não pode passar por vacuidade)', () => {
    const arquivos = readdirSync(raizDaFatia).filter((f) => f.endsWith('.ts'));
    expect(arquivos.sort()).toEqual(
      ['contract-draft.ts', 'existing-tool.ts', 'proposer.ts', 'types.ts'].sort(),
    );
  });

  it('o removedor de comentários não engole código (senão a varredura seria cega)', () => {
    expect(semComentarios('const a = 1; // agentToolGrantsRepo')).toContain('const a = 1;');
    expect(semComentarios('const a = 1; // agentToolGrantsRepo')).not.toContain(
      'agentToolGrantsRepo',
    );
    expect(semComentarios('/* eval( */ eval(x)')).toContain('eval(x)');
    // Uma URL não é comentário de linha.
    expect(semComentarios("const u = 'https://x/y';")).toContain('https://x/y');
  });

  it('nenhum arquivo da fatia registra, concede ou executa', () => {
    const arquivos = readdirSync(raizDaFatia).filter((f) => f.endsWith('.ts'));
    const achados: string[] = [];
    for (const arquivo of arquivos) {
      const codigo = semComentarios(readFileSync(join(raizDaFatia, arquivo), 'utf8'));
      for (const { padrao, porque } of PROIBIDOS) {
        if (padrao.test(codigo)) achados.push(`${arquivo}: ${porque} (${padrao})`);
      }
    }
    expect(achados).toEqual([]);
  });
});
