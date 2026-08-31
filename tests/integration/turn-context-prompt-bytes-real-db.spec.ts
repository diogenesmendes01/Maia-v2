/**
 * Issue #525 — the prompt is BYTE-IDENTICAL, proved against a real Postgres.
 *
 * ## Why a golden file and not an assertion about the prompt's shape
 *
 * The ≤8 target of #525 cannot be reached by removing duplication any more:
 * every remaining read is a different table, so closing the gap means merging
 * statements that read DIFFERENT tables into one. A merge like that is only
 * legitimate if the rows that come back are the same rows, in the same order,
 * with the same JavaScript types — and "same type" is where a merged read
 * quietly breaks: `numeric` survives a plain `SELECT` as the string `'0.80'`
 * and comes back from a `jsonb` round-trip as the number `0.8`, which renders
 * `conf 0.8` where the prompt said `conf 0.80`. That is a behaviour change to
 * the model, dressed as a performance win.
 *
 * So the acceptance criterion is not "the prompt still looks right". It is
 * "these exact bytes". The three golden files under
 * `tests/fixtures/turn-context/` were captured from the implementation that
 * cost THIRTEEN statements, against this same fixture, before any merge
 * existed. Every later change has to reproduce them byte for byte.
 *
 * ## What makes the comparison meaningful
 *
 * The fixture is deliberately hostile to a lazy merge:
 *
 *   - `learned_rules.confianca` is `0.80` — a trailing zero that only survives
 *     if the column keeps its `numeric` type all the way to the renderer, and
 *     the value is RENDERED (`conf ${r.confianca}`), not just compared;
 *   - `agent_facts.valor` is `jsonb` with a nested object and a number that
 *     `JSON.stringify` would reformat if it were re-parsed differently;
 *   - `agent_capability_gaps.resolved_at` is a `timestamptz` the renderer calls
 *     `.getTime()` on — a string would throw, and a string that did not throw
 *     would sort differently;
 *   - `entity_states.saldo_consolidado` is `numeric` and rendered verbatim;
 *   - `permission_profiles.limite_default` is `numeric` and reaches the prompt
 *     through `Number(...)`, so a lost type shows up as a different limit;
 *   - facts, rules, memories, hints, skills and gaps all have MORE than one
 *     row, so a merge that reorders a branch shows up as a diff.
 *
 * ## Regenerating
 *
 * `UPDATE_PROMPT_GOLDEN=1 npm run test:integration -- <this file>` rewrites the
 * files. Doing that is a declaration that the prompt SHOULD change; the diff
 * belongs in the PR body.
 *
 * A golden que FALTA é falha, nunca regeneração automática: sem essa regra o
 * teste escreveria o próprio gabarito e passaria comparando-o consigo mesmo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { runWithTenantContext } from '@/db/tenant-context.js';
import { runWithQueryCounter } from '@/db/query-counter.js';
import { TURN_ROUND_TRIP_BUDGET } from '@/agent/turn-context/types.js';
import type { Conversa, Mensagem, Pessoa, Role } from '@/db/schema.js';

const SHOULD_RUN =
  !!process.env.TEST_DB_URL && process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const UPDATE = process.env.UPDATE_PROMPT_GOLDEN === '1';

const GOLDEN_DIR = new URL('../fixtures/turn-context/', import.meta.url);

/** Two scopes: one rich, one empty, one on the operational-profile-v2 path. */
const T = { tenant_id: 'i525-bytes-t', agent_id: 'i525-bytes-a' };

/**
 * Fixed ids everywhere. Three of them reach the prompt TEXT — the permission
 * profile id (`profile=…`), the learned-rule id (`[#12345678]`) and any entity
 * whose name is missing — so a generated uuid would make the golden file
 * unstable for reasons that have nothing to do with the read set.
 */
const ID = {
  pessoa: '00000000-0000-4000-8000-000000000001',
  conversa: '00000000-0000-4000-8000-000000000002',
  conversaVazia: '00000000-0000-4000-8000-000000000003',
  entA: '00000000-0000-4000-8000-000000000011',
  entB: '00000000-0000-4000-8000-000000000012',
  permA: '00000000-0000-4000-8000-000000000021',
  permB: '00000000-0000-4000-8000-000000000022',
  msgIn: '00000000-0000-4000-8000-000000000031',
  msgOut: '00000000-0000-4000-8000-000000000032',
  inbound: '00000000-0000-4000-8000-000000000033',
  rule1: '1a2b3c4d-0000-4000-8000-000000000041',
  rule2: '9f8e7d6c-0000-4000-8000-000000000042',
  procDef: '00000000-0000-4000-8000-000000000051',
  procExec: '00000000-0000-4000-8000-000000000052',
  role: '00000000-0000-4000-8000-000000000061',
  profA: 'i525-bytes-prof-a',
  profB: 'i525-bytes-prof-b',
};

let pool: pg.Pool;

async function seed(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(`INSERT INTO tenants(id, nome) VALUES ($1,$1) ON CONFLICT DO NOTHING`, [
      T.tenant_id,
    ]);
    await c.query(
      `INSERT INTO agents(id, tenant_id, nome) VALUES ($1,$2,$1) ON CONFLICT DO NOTHING`,
      [T.agent_id, T.tenant_id],
    );

    await c.query(
      `INSERT INTO pessoas(id, tenant_id, agent_id, nome, apelido, telefone_whatsapp, tipo, status, preferencias)
       VALUES ($1,$2,$3,'Ana Owner','Aninha','+5511900000001','dono','ativa','{"timezone":"America/Sao_Paulo"}'::jsonb)`,
      [ID.pessoa, T.tenant_id, T.agent_id],
    );

    for (const [id, pessoa] of [
      [ID.conversa, ID.pessoa],
      [ID.conversaVazia, ID.pessoa],
    ] as const) {
      await c.query(
        `INSERT INTO conversas(id, tenant_id, agent_id, pessoa_id, metadata)
         VALUES ($1,$2,$3,$4,'{}'::jsonb)`,
        [id, T.tenant_id, T.agent_id, pessoa],
      );
    }

    // Entities + states. `saldo_consolidado` is numeric and RENDERED verbatim.
    await c.query(
      `INSERT INTO entidades(id, tenant_id, agent_id, nome, tipo)
       VALUES ($1,$3,$4,'Padaria Central','pj'), ($2,$3,$4,'Ana PF','pf')`,
      [ID.entA, ID.entB, T.tenant_id, T.agent_id],
    );
    await c.query(
      `INSERT INTO entity_states(entidade_id, tenant_id, agent_id, saldo_consolidado, proximo_vencimento)
       VALUES ($1,$3,$4,'1234.50','2026-09-15'), ($2,$3,$4,'-80.00',NULL)`,
      [ID.entA, ID.entB, T.tenant_id, T.agent_id],
    );

    // Two DIFFERENT profiles, so the join in `resolveScope` has to carry the
    // right one to the right permission — a single-profile fixture would pass
    // even with the mapping wrong.
    await c.query(
      `INSERT INTO permission_profiles(id, tenant_id, agent_id, nome, acoes, limite_default)
       VALUES ($1,$3,$4,'Dono',ARRAY['*'],'2500.75'), ($2,$3,$4,'Consulta',ARRAY['consultar_saldo'],'0')`,
      [ID.profA, ID.profB, T.tenant_id, T.agent_id],
    );
    await c.query(
      `INSERT INTO permissoes(id, tenant_id, agent_id, pessoa_id, entidade_id, papel, profile_id, status, limites)
       VALUES ($1,$5,$6,$7,$3,'dono',$8,'ativa','{}'::jsonb),
              ($2,$5,$6,$7,$4,'leitor',$9,'ativa','{"valor_max":50}'::jsonb)`,
      [
        ID.permA,
        ID.permB,
        ID.entA,
        ID.entB,
        T.tenant_id,
        T.agent_id,
        ID.pessoa,
        ID.profA,
        ID.profB,
      ],
    );

    // History: one inbound, one outbound, plus the turn's own inbound row.
    await c.query(
      `INSERT INTO mensagens(id, tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, created_at)
       VALUES ($1,$4,$5,$6,'in','texto','qual o saldo da padaria?','2026-05-11T14:58:00Z'),
              ($2,$4,$5,$6,'out','texto','O saldo consolidado é R$ 1234.50.','2026-05-11T14:59:00Z'),
              ($3,$4,$5,$6,'in','texto','e o vencimento?','2026-05-11T15:00:00Z')`,
      [ID.msgIn, ID.msgOut, ID.inbound, T.tenant_id, T.agent_id, ID.conversa],
    );

    // Facts: nested jsonb + a number, on two different scopes.
    await c.query(
      `INSERT INTO agent_facts(tenant_id, agent_id, escopo, chave, valor, lifecycle_status)
       VALUES ($1,$2,'global','moeda','{"codigo":"BRL","casas":2}'::jsonb,'active'),
              ($1,$2,$3,'preferencia','{"contato":"whatsapp"}'::jsonb,'verified')`,
      [T.tenant_id, T.agent_id, `pessoa:${ID.pessoa}`],
    );

    // Rules: `confianca` is numeric and RENDERED. `0.80` is the trailing-zero
    // trap; `0.75` orders first so the ORDER BY is observable.
    await c.query(
      `INSERT INTO learned_rules(id, tenant_id, agent_id, tipo, contexto, acao, confianca, lifecycle_status, updated_at)
       VALUES ($1,$3,$4,'classificacao','pagamento de fornecedor','classificar como despesa','0.80','active','2026-05-01T00:00:00Z'),
              ($2,$3,$4,'classificacao','pix recebido','classificar como receita','0.95','verified','2026-05-02T00:00:00Z')`,
      [ID.rule1, ID.rule2, T.tenant_id, T.agent_id],
    );

    // Memories: one proactive + mentionable (renders), one not proactive whose
    // words appear in the inbound (renders), one not mentionable (must not).
    await c.query(
      `INSERT INTO memory_entry(tenant_id, agent_id, content, memory_type, scope_type, subject_id,
                                proactive_use, mention_allowed, needs_review, lifecycle_status, created_at)
       VALUES ($1,$2,'Prefere respostas curtas','preference','interlocutor',$3,true,true,false,'active','2026-05-01T00:00:00Z'),
              ($1,$2,'Costuma perguntar sobre vencimento no fim do mês','operational','agent',NULL,false,true,false,'active','2026-04-30T00:00:00Z'),
              ($1,$2,'Dado sensível que não pode ser citado','personal','agent',NULL,true,false,false,'active','2026-04-29T00:00:00Z')`,
      [T.tenant_id, T.agent_id, ID.pessoa],
    );

    await c.query(
      `INSERT INTO behavioral_hint(tenant_id, agent_id, scope_type, subject_id, hint_text,
                                   derived_sensitivity, lifecycle_status, created_at)
       VALUES ($1,$2,'agent',NULL,'Seja direto ao dar números','low','active','2026-04-01T00:00:00Z'),
              ($1,$2,'interlocutor',$3,'Chame pelo apelido','low','active','2026-04-02T00:00:00Z')`,
      [T.tenant_id, T.agent_id, ID.pessoa],
    );

    // Skills: confidences chosen to exercise both clauses (≥0.7 dominates,
    // <0.5 is learning) and the name tiebreak.
    await c.query(
      `INSERT INTO agent_capabilities_skill(tenant_id, agent_id, domain, skill_name, confidence)
       VALUES ($1,$2,'financeiro','conciliar_extrato','0.90'),
              ($1,$2,'financeiro','classificar_despesa','0.90'),
              ($1,$2,'financeiro','prever_fluxo','0.30')`,
      [T.tenant_id, T.agent_id],
    );

    // Gaps: two OPEN (one mentionable, one proposed) and one RECENTLY CLOSED,
    // which is the "## Capacidades novas" half of the same single read.
    await c.query(
      `INSERT INTO agent_capability_gaps(tenant_id, agent_id, capability_description, tipo,
                                         current_level, resolved_at, resolved_reason, resolved_tool_name)
       VALUES ($1,$2,'emitir nota fiscal','tool','mentionable',NULL,NULL,NULL),
              ($1,$2,'importar extrato do banco X','tool','proposed',NULL,NULL,NULL),
              ($1,$2,'consultar CNPJ na Receita','tool','proposed',now() - interval '2 days','ferramenta entregue','lookup_cnpj')`,
      [T.tenant_id, T.agent_id],
    );

    await c.query(
      `INSERT INTO self_state(tenant_id, agent_id, versao, system_prompt, resumo_aprendizados, ativa)
       VALUES ($1,$2,3,'Você é a Maia, assistente financeira.','Aprendeu a classificar pix.',true)`,
      [T.tenant_id, T.agent_id],
    );

    // Procedure (used only by the third case).
    await c.query(
      `INSERT INTO procedure_definitions(id, tenant_id, agent_id, scope, nome, version_number, status,
                                         intencao, steps, success_criteria, source)
       VALUES ($1,$2,$3,'agent','Fechamento mensal',2,'active','fechar o mês',
               '[{"id":"coletar","intencao":"coletar extratos","como":"pedir os arquivos","sucesso_criteria_ref":"c1","armadilhas":["extrato duplicado"]}]'::jsonb,
               '[{"id":"c1","type":"checklist"}]'::jsonb,'ensino')`,
      [ID.procDef, T.tenant_id, T.agent_id],
    );
  } finally {
    c.release();
  }
}

async function cleanup(): Promise<void> {
  const c = await pool.connect();
  try {
    for (const table of [
      'procedure_executions',
      'procedure_definitions',
      'agent_capability_gaps',
      'agent_capabilities_skill',
      'behavioral_hint',
      'memory_entry',
      'learned_rules',
      'agent_facts',
      'self_state',
      'agent_operational_profile_versions',
      'mensagens',
      'permissoes',
      'permission_profiles',
      'entity_states',
      'entidades',
      'conversas',
      'pessoas',
    ]) {
      await c.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND agent_id = $2`, [
        T.tenant_id,
        T.agent_id,
      ]);
    }
  } finally {
    c.release();
  }
}

function mkPessoa(): Pessoa {
  return {
    id: ID.pessoa,
    tenant_id: T.tenant_id,
    agent_id: T.agent_id,
    nome: 'Ana Owner',
    apelido: 'Aninha',
    telefone_whatsapp: '+5511900000001',
    tipo: 'dono',
    status: 'ativa',
    preferencias: { timezone: 'America/Sao_Paulo' },
    modelo_mental: {},
    created_at: new Date('2026-01-01T00:00:00Z'),
  } as unknown as Pessoa;
}

function mkConversa(id: string): Conversa {
  return { id, pessoa_id: ID.pessoa, metadata: {} } as Conversa;
}

function mkInbound(): Mensagem {
  return {
    id: ID.inbound,
    conversa_id: ID.conversa,
    direcao: 'in',
    tipo: 'texto',
    conteudo: 'e o vencimento?',
    ferramentas_chamadas: [],
    created_at: new Date('2026-05-11T15:00:00Z'),
  } as unknown as Mensagem;
}

const ROLE: Role = {
  id: ID.role,
  tenant_id: T.tenant_id,
  agent_id: T.agent_id,
  role_key: 'contabil',
  display_name: 'Contábil',
  description: 'Cuida do fechamento contábil.',
  prompt_addendum: 'Cite sempre a competência do mês.',
  active: true,
  is_default: false,
  metadata: {},
  granted_packs: [],
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
} as unknown as Role;

/**
 * The wall clock is the ONLY nondeterministic input to the renderer (the
 * "- Agora:" line in "## Estado atual"). Everything else is a function of the
 * fixture, which is what makes a golden file possible at all.
 */
function normalize(system: string): string {
  return system.replace(/^- Agora: .*$/m, '- Agora: <NOW>');
}

type Caso = {
  nome: string;
  conversa: string;
  role?: Role;
  perfilV2?: boolean;
  procedimentoAtivo?: boolean;
};

const CASOS: Caso[] = [
  // O turno TÍPICO da #525, e o que define o orçamento: identidade legada
  // `self_state`, uma entidade em escopo, toda seção opcional populada, nenhum
  // procedimento em execução, e o loader resolvendo o procedimento por conta
  // própria (o pior caso, já que `core.ts` normalmente o entrega pronto).
  { nome: 'rico-self-state', conversa: 'conversa' },
  // Everything the renderer can be handed as absent, in one prompt: no
  // history, no entity in scope, no procedure. The blocks that must still
  // appear ("(sem entidades acessíveis)", "(vazio)") are the ones a merge that
  // silently dropped a branch would erase.
  { nome: 'vazio', conversa: 'conversaVazia' },
  // The other identity branch, plus the two blocks the first case does not
  // reach: the role section and the running procedure.
  {
    nome: 'perfil-v2-com-procedimento',
    conversa: 'conversa',
    role: ROLE,
    perfilV2: true,
    procedimentoAtivo: true,
  },
];

/**
 * Quantos statements cada caso deve custar, contra o Postgres real — e por quê.
 *
 * `rico-self-state` é o turno que o orçamento descreve, e custa exatamente o
 * orçamento. Os outros dois divergem por razões declaradas, não por sorte:
 *
 *  - `vazio`: a pessoa não tem permissão nenhuma, o escopo resolve vazio, e
 *    `entidades ⋈ entity_states` não é lida (não há id para ler). 12 − 1 = 11.
 *  - `perfil-v2-com-procedimento`: o perfil v2 ATIVO dispensa a leitura do
 *    `self_state` (−1), e a execução ATIVA de procedimento faz o turno pagar
 *    também a DEFINIÇÃO dela (+1). Esse "+1" não é novo: o orçamento sempre
 *    descreveu o turno SEM procedimento em execução. 12 − 1 + 1 = 12.
 */
function esperadoDeStatements(caso: Caso): number {
  if (caso.nome === 'vazio') return TURN_ROUND_TRIP_BUDGET - 1;
  if (caso.procedimentoAtivo) return TURN_ROUND_TRIP_BUDGET - 1 + 1;
  return TURN_ROUND_TRIP_BUDGET;
}

d('#525 — o prompt do turno é byte-idêntico (Postgres real)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
    await cleanup();
    await seed();
    await mkdir(GOLDEN_DIR, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  for (const caso of CASOS) {
    it(`${caso.nome}: bytes idênticos ao golden`, async () => {
      const { resolveScope } = await import('@/governance/permissions.js');
      const { buildPrompt } = await import('@/agent/prompt-builder.js');

      const c = await pool.connect();
      try {
        // The v2 branch is created and dropped inside the case so the two
        // identity paths are both exercised against the same fixture.
        if (caso.procedimentoAtivo) {
          await c.query(
            `INSERT INTO procedure_executions(id, tenant_id, agent_id, conversa_id, definition_id,
                                              definition_version, status, current_step_id, execution_state)
             VALUES ($1,$2,$3,$4,$5,2,'in_progress','coletar','{"arquivos":1}'::jsonb)`,
            [ID.procExec, T.tenant_id, T.agent_id, ID.conversa, ID.procDef],
          );
        }
        if (caso.perfilV2) {
          await c.query(
            `INSERT INTO agent_operational_profile_versions
               (tenant_id, agent_id, version, status, proposed_by, profile_body)
             VALUES ($1,$2,9,'active','test',$3::jsonb)`,
            [
              T.tenant_id,
              T.agent_id,
              JSON.stringify({
                identity: { nome: 'Maia', missao: 'cuidar do financeiro' },
                voice: { tom: 'direto' },
              }),
            ],
          );
        }

        const pessoa =
          caso.conversa === 'conversaVazia'
            ? ({ ...mkPessoa(), id: '00000000-0000-4000-8000-0000000000ff' } as Pessoa)
            : mkPessoa();

        let statements = -1;
        const built = await runWithTenantContext(T, async () =>
          runWithQueryCounter(async (counter) => {
            const scope = await resolveScope(pessoa);
            const saida = await buildPrompt({
              pessoa,
              conversa: mkConversa(ID[caso.conversa as keyof typeof ID]),
              scope,
              inbound:
                caso.conversa === 'conversaVazia'
                  ? ({ ...mkInbound(), conversa_id: ID.conversaVazia } as Mensagem)
                  : mkInbound(),
              activeRole: caso.role,
              current_role_id: caso.role?.id,
            });
            statements = counter.count;
            return saida;
          }),
        );

        const actual =
          normalize(built.system) +
          '\n\n===== MESSAGES =====\n' +
          JSON.stringify(built.messages, null, 2) +
          '\n';

        const file = path.join(GOLDEN_DIR.pathname, `prompt-${caso.nome}.golden.txt`);
        // O `!existsSync(file)` que existia aqui, junto com o `UPDATE`, fazia o
        // teste ESCREVER a saída atual como golden e em seguida compará-la com
        // ela mesma — uma asserção que não pode falhar. Com os três arquivos
        // commitados isso não aparecia; some um deles (rebase malfeito, faxina
        // de fixture) e os três passariam a re-baselinar em silêncio,
        // exatamente na prova que esta PR usa para afirmar "byte-idêntico".
        //
        // Regenerar continua sendo possível, e continua sendo uma DECLARAÇÃO
        // explícita: `UPDATE_PROMPT_GOLDEN=1`. Golden ausente sem essa
        // declaração é falha, com a instrução no texto do erro.
        if (UPDATE) {
          await writeFile(file, actual, 'utf8');
        } else if (!existsSync(file)) {
          throw new Error(
            `golden ausente: ${path.basename(file)}. Um golden que se escreve sozinho não ` +
              `prova nada. Se o prompt MUDOU de propósito, regenere com ` +
              `UPDATE_PROMPT_GOLDEN=1 e ponha o diff no corpo da PR.`,
          );
        }
        const expected = await readFile(file, 'utf8');

        expect(actual).toBe(expected);
        // Bytes, not code points — the assertion the criterion is written in.
        expect(Buffer.byteLength(actual, 'utf8')).toBe(Buffer.byteLength(expected, 'utf8'));

        // …e os MESMOS bytes por NÃO MAIS que o orçamento de statements, contra
        // o Postgres de verdade. Os dois lados do critério da #525 medidos na
        // mesma execução: se alguém reintroduzir uma leitura para "consertar"
        // uma diferença de bytes, este número sobe e o caso fica vermelho aqui,
        // não só na lane unitária.
        expect(statements).toBe(esperadoDeStatements(caso));
        expect(statements).toBeLessThanOrEqual(TURN_ROUND_TRIP_BUDGET);
      } finally {
        if (caso.perfilV2) {
          await c.query(
            `DELETE FROM agent_operational_profile_versions WHERE tenant_id=$1 AND agent_id=$2`,
            [T.tenant_id, T.agent_id],
          );
        }
        if (caso.procedimentoAtivo) {
          await c.query(`DELETE FROM procedure_executions WHERE tenant_id=$1 AND agent_id=$2`, [
            T.tenant_id,
            T.agent_id,
          ]);
        }
        c.release();
      }
    });
  }
});
