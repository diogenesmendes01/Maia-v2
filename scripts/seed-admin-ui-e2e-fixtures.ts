#!/usr/bin/env tsx
/**
 * Fixtures das JORNADAS do console (issue #623).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Por que não estender `scripts/seed-proposals-fixtures.ts`
 * ─────────────────────────────────────────────────────────────────────────
 * Aquele script é do P8.5 e semeia o tenant `test-tenant` com ids fixos de
 * usuários e três propostas genéricas. As jornadas precisam de outra coisa, e
 * a diferença é de contrato, não de gosto:
 *
 *   - o tenant tem de ser `primary` — é o que `OIDC_TENANT_SLUGS` declara no
 *     job e o que a sessão carrega; uma proposta em `test-tenant` seria
 *     invisível para o console (e é isso que `assertTenant` garante);
 *   - os ids têm de ser UUID: `proposals.getProposal` e `traces.getTrace`
 *     validam `z.string().uuid()`, então `test-id`/`locked-test`/
 *     `test-trace-id` reprovam ANTES de qualquer consulta;
 *   - o RISCO e as TRAVAS de uma proposta de capacidade são DERIVADOS de
 *     `capability_type` + `proposed_spec` (`src/db/capability-risk.ts`),
 *     nunca escritos à mão. Cada fixture abaixo escolhe os marcadores que
 *     produzem a classe de aprovação que a jornada exercita — e é por isso
 *     que os comentários citam o marcador, não o resultado.
 *
 * Idempotente e DESTRUTIVO só sobre as próprias linhas: apaga o que semeou
 * (por id) e regrava. O estado inicial de cada execução é o mesmo.
 *
 * Uso: `npx tsx scripts/seed-admin-ui-e2e-fixtures.ts`
 * (o `scripts/admin-ui-e2e.sh` o chama antes de subir a suíte).
 */
// Boot fail-closed do subset `runtime`, EXPLÍCITO (issue #596) — mesmo motivo
// de `scripts/seed-proposals-fixtures.ts`: este processo escreve no banco que
// `DATABASE_URL` aponta e assina traces com
// `RUNTIME_TRACE_HMAC_MASTER_SECRET`. Configuração torta tem de reprovar aqui,
// não uma variável por vez lá na frente.
import '@/config/env.js';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import {
  admin_audit_log,
  agent_operational_profile_versions,
  capability_proposals,
  channel_line_state,
  channels,
  proposal_approvals,
} from '@/db/schema.js';
import { writeEnvelope } from '@/control-plane/runtime-trace/envelope-writer.js';
import { writeBody } from '@/control-plane/runtime-trace/body-writer.js';

/** Tenant/agente reservados do runtime single-tenant. NUNCA o literal `default`. */
const TENANT = 'primary';
const AGENTE = 'primary';

/** Espelha `tests/admin-ui/e2e/_apoio/sessao.ts` — um par por papel. */
const USUARIOS = [
  { id: 'e2e-user-founder', role: 'founder', email: 'founder.e2e@maia.test', name: 'E2E Founder' },
  { id: 'e2e-user-owner', role: 'owner', email: 'owner.e2e@maia.test', name: 'E2E Owner' },
  {
    id: 'e2e-user-compliance',
    role: 'compliance_officer',
    email: 'compliance.e2e@maia.test',
    name: 'E2E Compliance',
  },
  { id: 'e2e-user-analyst', role: 'analyst', email: 'analyst.e2e@maia.test', name: 'E2E Analyst' },
  { id: 'e2e-user-viewer', role: 'viewer', email: 'viewer.e2e@maia.test', name: 'E2E Viewer' },
] as const;

/** Espelha `tests/admin-ui/e2e/_apoio/fixtures.ts`. */
const P = {
  simples: 'e2e10000-0000-4000-8000-000000000001',
  travada: 'e2e10000-0000-4000-8000-000000000002',
  dupla: 'e2e10000-0000-4000-8000-000000000003',
  auditoria: 'e2e10000-0000-4000-8000-000000000004',
  rejeicao: 'e2e10000-0000-4000-8000-000000000005',
  lote1: 'e2e10000-0000-4000-8000-000000000006',
  lote2: 'e2e10000-0000-4000-8000-000000000007',
  lote3: 'e2e10000-0000-4000-8000-000000000008',
  perigosa: 'e2e10000-0000-4000-8000-000000000009',
} as const;

const TRACE = 'e2e20000-0000-4000-8000-000000000001';

/**
 * Versões do perfil operacional da Tela 3. Duas linhas, e as duas precisam
 * existir para a jornada dizer alguma coisa: `Reverter` só é oferecido quando
 * há uma ATIVA (a origem) e o alvo é ANTERIOR a ela
 * (`validateRollbackTarget`, em `src/admin-ui/lib/rollback-targets.ts`).
 * Uma tabela com uma versão só não distingue "a regra está valendo" de "a
 * coluna de ações não renderizou".
 */
const VERSOES_PERFIL = [
  { id: 'e2e30000-0000-4000-8000-000000000001', version: 1, status: 'frozen' },
  { id: 'e2e30000-0000-4000-8000-000000000002', version: 2, status: 'active' },
] as const;

/**
 * Linha WhatsApp DECLARADA — jornada `channel-lines.spec.ts`.
 *
 * `channels.active = false` + `channel_line_state.state = 'declared'` é o
 * estado em que uma linha NASCE (#518): número registrado, posse não provada,
 * não roteia. Era exatamente esse par que sumia da tela antes da #518, e é o
 * único estado que a listagem consegue exibir sem runtime — QR, código e a
 * transição para `pareando` vêm do worker `channel_pairing`, que este job não
 * sobe (ver o cabeçalho de `channel-lines-pairing.spec.ts`).
 *
 * `external_id` PRÓPRIO e não o `default-channel` das migrations: aquele nasce
 * `active = true` / `verified_offline`, ou seja, descreve o estado OPOSTO — e
 * a jornada mediria a linha errada. O número é fictício (faixa +5511 9900000xx)
 * e o índice único é `(tenant_id, channel_type, external_id)`, então ele não
 * colide com o canal semeado pela migration.
 */
const LINHA_DECLARADA = {
  channel_id: 'e2e40000-0000-4000-8000-000000000001',
  external_id: '+5511990000001',
  display_name: 'Linha comercial E2E',
} as const;

interface Fixture {
  id: string;
  capability_type: string;
  title: string;
  description: string;
  motivation: string;
  proposed_spec: Record<string, unknown>;
}

/**
 * `capability_type: 'knowledge'` tem piso de risco `low`
 * (TYPE_RISK_FLOOR em src/db/capability-risk.ts) e `read_only` mantém o
 * marcador em `low` -> classe `capability_safe_tool` -> aprovador `owner`,
 * sem trava. É o único arranjo que produz uma proposta ELEGÍVEL à rejeição em
 * massa (`bulkReject` exige risco `low` e zero travas).
 */
function baixoRisco(id: string, titulo: string, extra: Record<string, unknown> = {}): Fixture {
  return {
    id,
    capability_type: 'knowledge',
    title: titulo,
    description: 'Fixture determinística das jornadas E2E do console (#623).',
    motivation: 'Exercitar a jornada do operador ponta a ponta no CI.',
    proposed_spec: { read_only: true, ...extra },
  };
}

const FIXTURES: Fixture[] = [
  baixoRisco(P.simples, 'Jornada E2E — proposta simples'),
  // `architecture_locks` no spec é lido literalmente por
  // `deriveCapabilityLocks`: a trava aparece no detalhe e desabilita os botões
  // para quem não é founder.
  baixoRisco(P.travada, 'Jornada E2E — proposta travada', {
    architecture_locks: ['soul_immutable_core'],
  }),
  baixoRisco(P.auditoria, 'Jornada E2E — trilha de auditoria'),
  baixoRisco(P.rejeicao, 'Jornada E2E — rejeição'),
  baixoRisco(P.lote1, 'Jornada E2E — lote 1'),
  baixoRisco(P.lote2, 'Jornada E2E — lote 2'),
  baixoRisco(P.lote3, 'Jornada E2E — lote 3'),
  // Aprovação DUPLA sem trava nenhuma. `procedure` tem piso `medium` e
  // `has_side_effects` leva o marcador a `high`: classe
  // `capability_side_effect` -> papéis `owner` + `compliance_officer`
  // distintos, `architectureLocks: []` na matriz E nenhuma trava derivada do
  // spec. É o único arranjo em que um owner consegue assinar a PRIMEIRA de
  // duas — com `tool` (piso `critical`) a classe seria
  // `capability_dangerous_tool`, cuja trava de matriz exige founder.
  {
    id: P.dupla,
    capability_type: 'procedure',
    title: 'Jornada E2E — aprovação dupla',
    description: 'Fixture determinística das jornadas E2E do console (#623).',
    motivation: 'Exercitar a jornada de aprovação dupla no CI.',
    proposed_spec: { has_side_effects: true },
  },
  // Trava vinda da CLASSE, não do spec: `tool` (piso `critical`) +
  // `has_side_effects` -> `capability_dangerous_tool`, cuja matriz declara
  // `architectureLocks: ['tool_blast_radius']`. `deriveCapabilityLocks` NÃO
  // devolve nada aqui (o marcador não é destrutivo) — é justamente o caso em
  // que a tela lia `locks` e o servidor aplicava a união, e habilitava um
  // botão que o backend recusava (corrigido em
  // `src/admin-ui/app/proposals/[id]/page.tsx`, #623).
  {
    id: P.perigosa,
    capability_type: 'tool',
    title: 'Jornada E2E — ferramenta perigosa',
    description: 'Fixture determinística das jornadas E2E do console (#623).',
    motivation: 'Exercitar a trava vinda da classe de aprovação no CI.',
    proposed_spec: { has_side_effects: true },
  },
];

async function limpar(): Promise<void> {
  const ids = FIXTURES.map((f) => f.id);
  await db.delete(agent_operational_profile_versions).where(
    inArray(
      agent_operational_profile_versions.id,
      VERSOES_PERFIL.map((v) => v.id),
    ),
  );
  await db.delete(proposal_approvals).where(inArray(proposal_approvals.proposal_id, ids));
  await db
    .delete(admin_audit_log)
    .where(and(eq(admin_audit_log.tenant_id, TENANT), inArray(admin_audit_log.resource_id, ids)));
  await db.delete(capability_proposals).where(inArray(capability_proposals.id, ids));
  // A linha primeiro, o canal depois: `channel_line_state.channel_id` referencia
  // `channels.id`.
  await db
    .delete(channel_line_state)
    .where(eq(channel_line_state.channel_id, LINHA_DECLARADA.channel_id));
  await db.delete(channels).where(eq(channels.id, LINHA_DECLARADA.channel_id));
}

async function semearUsuarios(): Promise<void> {
  for (const u of USUARIOS) {
    // `email_verified` NÃO é decoração: `resolveOidcAppUser` recusa usuário
    // sem verificação, e é por ele que um sign-in OIDC real passaria.
    await db.execute(sql`
      INSERT INTO app_users (id, tenant_id, email, name, role, email_verified)
      VALUES (${u.id}, ${TENANT}, ${u.email}, ${u.name}, ${u.role}, now())
      ON CONFLICT (id) DO UPDATE
        SET tenant_id = EXCLUDED.tenant_id,
            email = EXCLUDED.email,
            name = EXCLUDED.name,
            role = EXCLUDED.role,
            email_verified = EXCLUDED.email_verified
    `);
  }
}

async function semearPropostas(): Promise<void> {
  // `created_at` explícito e ESPAÇADO: a fila unificada ordena por
  // (created_at DESC, id DESC) e a jornada de inbox clica na PRIMEIRA linha.
  // Sem ordem estável, "a primeira linha" seria uma corrida.
  let offset = FIXTURES.length;
  for (const f of FIXTURES) {
    await db.execute(sql`
      INSERT INTO capability_proposals (
        id, tenant_id, agent_id, capability_type, title, description,
        motivation, proposed_spec, status, submitted_at, created_at, updated_at
      ) VALUES (
        ${f.id}, ${TENANT}, ${AGENTE}, ${f.capability_type}, ${f.title}, ${f.description},
        ${f.motivation}, ${JSON.stringify(f.proposed_spec)}::jsonb, 'submitted',
        now(), now() - make_interval(mins => ${offset}), now()
      )
    `);
    offset -= 1;
  }
}

/**
 * Trace semeado pelo ESCRITOR DE PRODUÇÃO. A alternativa — INSERT direto —
 * exigiria forjar `envelope_hmac`/`packet_hmac`, e a tela de detalhe RECOMPUTA
 * as duas assinaturas (`runtimeTraceRepo.get`): uma fixture assinada à mão
 * apareceria como `invalid` e a jornada mediria o aviso de adulteração em vez
 * do trace.
 */
async function semearTrace(): Promise<void> {
  await db.execute(sql`DELETE FROM runtime_trace_bodies WHERE trace_id = ${TRACE}::uuid`);
  await db.execute(sql`DELETE FROM runtime_trace_body_outbox WHERE trace_id = ${TRACE}::uuid`);
  await db.execute(sql`DELETE FROM runtime_trace_envelopes WHERE trace_id = ${TRACE}::uuid`);

  const decision = {
    decision: 'allow' as const,
    side_effect_level: 'medium' as const,
    reason: 'Fixture determinística das jornadas E2E do console (#623).',
  };
  const packet = {
    trace_id: TRACE,
    tenant_id: TENANT,
    agent_id: AGENTE,
    request: { direction: 'inbound' as const, text: 'jornada e2e do console' },
  };

  await writeEnvelope({
    trace_id: TRACE,
    tenant_id: TENANT,
    agent_id: AGENTE,
    decision,
    redaction_class: 'standard',
  });
  await writeBody({
    trace_id: TRACE,
    tenant_id: TENANT,
    agent_id: AGENTE,
    packet,
    decision,
    redaction_class: 'standard',
  });
}

/**
 * As versões entram por SQL direto — o caminho de produção para criar uma
 * versão ATIVA é aprovar uma proposta de perfil, e passar por ele aqui
 * misturaria a jornada da Tela 3 com a da Tela 2 (e deixaria trilha de
 * auditoria que a jornada de auditoria conta).
 */
async function semearVersoesDePerfil(): Promise<void> {
  for (const v of VERSOES_PERFIL) {
    await db.execute(sql`
      INSERT INTO agent_operational_profile_versions (
        id, tenant_id, agent_id, version, status, proposed_by, proposed_reason,
        profile_body, created_at,
        activated_at, frozen_at
      ) VALUES (
        ${v.id}, ${TENANT}, ${AGENTE}, ${v.version}, ${v.status}, 'e2e-seed',
        'Fixture determinística das jornadas E2E do console (#623).',
        ${JSON.stringify({ tom: `jornada-e2e-v${v.version}` })}::jsonb,
        now() - make_interval(mins => ${10 - v.version}),
        CASE WHEN ${v.status} = 'active' THEN now() ELSE NULL END,
        CASE WHEN ${v.status} = 'frozen' THEN now() ELSE NULL END
      )
    `);
  }
}

/**
 * A linha entra por SQL direto porque o caminho de produção para CRIAR um
 * canal é a própria tela (`channelLines`/`channelPolicies`), e passar por ele
 * aqui faria a jornada de listagem depender da jornada de criação — além de
 * deixar trilha em `admin_audit_log`, que a jornada de auditoria conta.
 */
async function semearLinhaDeclarada(): Promise<void> {
  await db.execute(sql`
    INSERT INTO channels (id, tenant_id, agent_id, external_id, channel_type, display_name, active)
    VALUES (
      ${LINHA_DECLARADA.channel_id}::uuid, ${TENANT}, ${AGENTE},
      ${LINHA_DECLARADA.external_id}, 'whatsapp', ${LINHA_DECLARADA.display_name}, false
    )
  `);
  await db.execute(sql`
    INSERT INTO channel_line_state (channel_id, tenant_id, agent_id, state)
    VALUES (${LINHA_DECLARADA.channel_id}::uuid, ${TENANT}, ${AGENTE}, 'declared')
  `);
}

async function main(): Promise<void> {
  await limpar();
  await semearUsuarios();
  await semearPropostas();
  await semearVersoesDePerfil();
  await semearTrace();
  await semearLinhaDeclarada();
  // eslint-disable-next-line no-console
  console.log(
    `fixtures e2e do console: ${USUARIOS.length} usuários, ${FIXTURES.length} propostas, ` +
      `${VERSOES_PERFIL.length} versões de perfil, 1 trace e 1 linha whatsapp ` +
      `declarada (${LINHA_DECLARADA.external_id}) no tenant ${TENANT}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
