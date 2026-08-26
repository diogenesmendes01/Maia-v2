/**
 * Issue #634 (fatia E da épica #506) — a MÍDIA DE SAÍDA passa a ser durável, e
 * três dívidas nomeadas por fatias anteriores fecham aqui.
 *
 * ## O que este arquivo prova, e o que ele DELIBERADAMENTE não prova
 *
 * Ele entra por `dispatchOutput` — o call site de produção — contra Postgres
 * REAL e contra um `MEDIA_ROOT` REAL num diretório temporário. O único double é
 * a saída física do canal (`@/gateway/line-output.js`) e a síntese de voz
 * (`@/lib/tts.js`), que são as duas fronteiras externas: uma chamada de rede à
 * OpenAI e o socket do WhatsApp.
 *
 * Ele NÃO reimplementa o layout do store nem o `WHERE` de nenhuma consulta. As
 * asserções olham o disco e o banco pelas MESMAS funções que produção usa —
 * `resolveOutboundMediaPath`, `outboundMediaSubjectDir` — porque uma cópia do
 * layout no teste provaria a cópia, não a produção.
 *
 * ## As dívidas, e a sonda que prova cada uma
 *
 *  1. **#631, ramo de VOZ não commitava.** Sonda 1: o ramo de voz produz UMA
 *     linha em `outbound_messages` com `payload_type='audio'` e
 *     `payload_json.media.kind='storage_object'`.
 *  2. **#631, DOCUMENTO commitava `local_path` que morria no `finally`.**
 *     Sonda 3: depois de um envio que terminou INCERTO (o transporte lançou), o
 *     PDF temporário SUMIU e a referência commitada CONTINUA resolvendo para
 *     bytes idênticos. Com `local_path` este caso é impossível de passar.
 *  3. **#632, `storage_object` não era resolvível.** Sonda 2/3: a resolução
 *     acontece pela função que o `provider-adapter` chama.
 *
 * ## Isolamento (armadilha conhecida: "escopo por tenant passa verde sem estar
 * testado")
 *
 * Sonda 4 FORÇA a colisão: o MESMO `object_key`, o MESMO arquivo no disco, e
 * duas leituras — uma sob o escopo dono, outra sob outro tenant. A contenção de
 * `media-guard` aprova as DUAS (os objetos moram sob a mesma raiz), então quem
 * carrega o isolamento é, comprovadamente, a comparação de escopo em
 * `resolveOutboundMediaPath`. A sonda também verifica o caso POSITIVO, senão um
 * resolvedor que recusasse tudo passaria.
 *
 * ## LGPD
 *
 * Sonda 5 chama o adapter REAL de privacidade (`createPrivacyPorts().purge`)
 * para a classe `media.outbound_artifacts` e verifica as duas metades: o objeto
 * do titular some, e o objeto de OUTRO titular do mesmo escopo sobrevive.
 *
 * Pulado sem `TEST_DB_URL` — e `pulado` NÃO é `passou`.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdtempSync, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHOULD_RUN =
  !!process.env.TEST_DB_URL &&
  process.env.DATABASE_URL === process.env.TEST_DB_URL;
const d = SHOULD_RUN ? describe : describe.skip;

const TENANT = "primary";
const AGENT = "primary";
/** Escopo VIZINHO, usado só para forçar a colisão da sonda de isolamento. */
const TENANT_VIZINHO = "vizinho-634";

const { estado, canal, tts } = vi.hoisted(() => {
  // `config` é lido no import do módulo, então o segredo tem de estar no
  // ambiente ANTES dele — e `vi.hoisted` é o único ponto que roda antes de
  // qualquer import ESM deste arquivo. Fixture, não credencial: o valor só
  // precisa ser estável dentro do arquivo, para que a derivação do teste e a do
  // adapter de privacidade coincidam.
  process.env.RUNTIME_TRACE_HMAC_MASTER_SECRET ??=
    "fixture-sonda-634-sem-valor-real";
  return {
    // A raiz é preenchida no `beforeAll`: `vi.hoisted` roda antes de qualquer
    // import, e criar o diretório aqui exigiria `require`, que o lint proíbe. O
    // mock abaixo expõe `MEDIA_ROOT` como GETTER, então ele é lido no momento do
    // `await import('@/gateway/baileys.js')` do store — já com a raiz criada.
    estado: { raiz: "" },
    // Os dubles nascem AQUI dentro, e nao numa atribuicao de topo de arquivo:
    // as factories de `vi.mock` rodam no primeiro import do modulo mockado, que
    // o hoisting do ESM coloca ANTES de qualquer statement deste arquivo. Um
    // `tts.synthesize = vi.fn()` la embaixo chegaria tarde, e o mock exportaria
    // `null` — que foi exatamente o vermelho `synthesizeSpeech is not a
    // function` que esta sonda deu antes da correcao.
    canal: {
      sendText: vi.fn(),
      sendVoice: vi.fn(),
      sendDocument: vi.fn(),
      conectado: true,
    },
    tts: { synthesize: vi.fn() },
  };
});

/**
 * `MEDIA_ROOT` vem de `join(config.BAILEYS_AUTH_DIR, '..', 'media')`, e
 * `@/gateway/baileys.js` tem efeito de import pesado (é o módulo que
 * `tests/unit/baileys-no-import-side-effects.spec.ts` vigia). O store o carrega
 * por import DINÂMICO exatamente para poder ser trocado aqui: o double devolve
 * um diretório temporário, e tudo abaixo dele — escrita, rename, contenção,
 * resolução, purga — é código de produção contra um filesystem de verdade.
 */
vi.mock("@/gateway/baileys.js", () => ({
  get MEDIA_ROOT() {
    return estado.raiz;
  },
  ensureMediaDirs: () => undefined,
  isBaileysConnected: () => canal.conectado,
}));

vi.mock("@/gateway/line-output.js", () => ({
  forCurrentAgentChannel: vi.fn(async () => ({
    scope: { tenant_id: TENANT, agent_id: AGENT, channel_id: null },
    sendText: canal.sendText,
    sendDocument: canal.sendDocument,
    sendVoice: canal.sendVoice,
    sendPoll: vi.fn(),
    sendReaction: vi.fn(),
    startTyping: vi.fn(() => ({ stop: vi.fn() })),
    markRead: vi.fn(),
    isConnected: () => canal.conectado,
  })),
}));

vi.mock("@/lib/tts.js", async (original) => {
  const actual = await original<typeof import("@/lib/tts.js")>();
  return { ...actual, synthesizeSpeech: tts.synthesize };
});

import {
  dispatchOutput,
  OutboundDeliveryError,
} from "@/agent/output-dispatch.js";
import { runWithTenantContext } from "@/db/tenant-context.js";
import { runWithOutboundTurnScope } from "@/runtime/outbound/turn-scope.js";
import {
  OUTBOUND_MEDIA_BUCKET,
  outboundMediaSubjectDir,
  putOutboundMedia,
  resolveOutboundMediaPath,
  OutboundMediaError,
} from "@/runtime/outbound/media-store.js";
import type { MediaRef } from "@/runtime/outbound/contract.js";
import { createPrivacyPorts } from "@/ops/privacy/adapters.js";
import { resolveSubjectRef } from "@/ops/privacy/workflow.js";
import { deriveTombstoneSecret } from "@/ops/retention/tombstones.js";
import { config } from "@/config/env.js";
import type { TurnHandle } from "@/runtime/turns/lifecycle.js";
import type { TurnLease } from "@/runtime/turns/lease.js";
import type { Pessoa, Conversa, Mensagem } from "@/db/schema.js";

let pool: pg.Pool;
let pessoaId: string;
let conversaId: string;
let inboundId: string;
let turnId: string;
let claimToken: string;

const VOZ = Buffer.from("OggS-conteudo-de-voz-sintetizada-634");

function handleComPosse(): TurnHandle {
  return {
    turn_id: turnId,
    status: "running",
    state_version: 3,
    attempt_count: 1,
    conversa_id: conversaId,
    lease: { token: claimToken } as unknown as TurnLease,
  };
}

function ctxDeVoz(text: string): Parameters<typeof dispatchOutput>[0] {
  return {
    pessoa: {
      id: pessoaId,
      telefone_whatsapp: "+5511900000634",
      preferencias: null,
    } as Pessoa,
    conversa: { id: conversaId, channel_id: null } as unknown as Conversa,
    inbound: {
      id: inboundId,
      conteudo: "quanto eu gastei?",
      metadata: {},
      // O ramo de voz exige entrada de ÁUDIO — simetria voz-in/voz-out.
      tipo: "audio",
    } as unknown as Mensagem,
    jid: "5511900000634@s.whatsapp.net",
    text,
    latestPending: null,
    latestReportPdf: null,
    turnHasSensitive: false,
    sensitiveTools: [],
  };
}

async function ctxDeDocumento(text: string): Promise<{
  ctx: Parameters<typeof dispatchOutput>[0];
  tmpPdf: string;
  bytes: Buffer;
}> {
  const dir = join(estado.raiz, "tmp");
  await mkdir(dir, { recursive: true });
  const tmpPdf = join(dir, `${randomUUID()}.pdf`);
  const bytes = Buffer.from("%PDF-1.4 relatorio da sonda 634");
  await writeFile(tmpPdf, bytes);
  return {
    tmpPdf,
    bytes,
    ctx: {
      ...ctxDeVoz(text),
      inbound: {
        id: inboundId,
        conteudo: "me manda o extrato",
        metadata: {},
        tipo: "texto",
      } as unknown as Mensagem,
      latestReportPdf: {
        path: tmpPdf,
        fileName: "extrato.pdf",
        mimetype: "application/pdf",
        tipo: "extrato",
      } as Parameters<typeof dispatchOutput>[0]["latestReportPdf"],
    },
  };
}

function comoOWorkerDono<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, () =>
    runWithOutboundTurnScope(handleComPosse(), fn),
  );
}

async function linhaOutbound(): Promise<{
  id: string;
  status: string;
  payload_type: string;
  payload_json: { media?: MediaRef; mimetype?: string; source_text?: string };
} | null> {
  const { rows } = await pool.query(
    `SELECT id, status, payload_type, payload_json FROM outbound_messages WHERE turn_id = $1`,
    [turnId],
  );
  return rows[0] ?? null;
}

d("#634 — mídia de saída durável (Postgres + filesystem reais)", () => {
  beforeAll(async () => {
    estado.raiz = mkdtempSync(join(tmpdir(), "maia-634-media-"));
    // O ledger de tombstones de #536 e o `subject_ref` derivam deste segredo, e
    // `config` é congelado no import. Fixture, não credencial: o valor só
    // precisa ser estável dentro do arquivo, para que a derivação do teste e a
    // do adapter coincidam.
    pool = new pg.Pool({ connectionString: process.env.TEST_DB_URL, max: 4 });
  });

  afterAll(async () => {
    await pool.end();
    await rm(estado.raiz, { recursive: true, force: true });
  });

  beforeEach(async () => {
    canal.conectado = true;
    canal.sendText.mockReset();
    canal.sendVoice.mockReset();
    canal.sendDocument.mockReset();
    tts.synthesize.mockReset();
    tts.synthesize.mockResolvedValue(VOZ);
    vi.spyOn(config, "FEATURE_OUTBOUND_VOICE", "get").mockReturnValue(true);

    const c = await pool.connect();
    try {
      const p = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1, $2, 'Sonda 634', $3, 'dono', 'ativa') RETURNING id`,
        [TENANT, AGENT, `+55119${Date.now().toString().slice(-8)}`],
      );
      pessoaId = p.rows[0]!.id;
      const conv = await c.query<{ id: string }>(
        `INSERT INTO conversas(tenant_id, agent_id, pessoa_id, status)
         VALUES ($1, $2, $3, 'ativa') RETURNING id`,
        [TENANT, AGENT, pessoaId],
      );
      conversaId = conv.rows[0]!.id;
      const m = await c.query<{ id: string }>(
        `INSERT INTO mensagens(tenant_id, agent_id, conversa_id, direcao, tipo, conteudo, metadata)
         VALUES ($1, $2, $3, 'in', 'audio', 'quanto eu gastei?', '{}'::jsonb) RETURNING id`,
        [TENANT, AGENT, conversaId],
      );
      inboundId = m.rows[0]!.id;
      claimToken = randomUUID();
      const t = await c.query<{ id: string }>(
        `INSERT INTO agent_turns
           (tenant_id, agent_id, representative_message_id, conversa_id, status,
            attempt_count, claim_token, claimed_by, claimed_at, lease_expires_at, state_version)
         VALUES ($1, $2, $3, $4, 'running', 1, $5, 'sonda-634', now(), now() + interval '5 minutes', 3)
         RETURNING id`,
        [TENANT, AGENT, inboundId, conversaId, claimToken],
      );
      turnId = t.rows[0]!.id;
    } finally {
      c.release();
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const c = await pool.connect();
    try {
      await c.query(`DELETE FROM audit_log WHERE conversa_id = $1`, [
        conversaId,
      ]);
      await c.query(`DELETE FROM outbound_messages WHERE conversa_id = $1`, [
        conversaId,
      ]);
      await c.query(
        `UPDATE agent_turns SET outbound_message_id = NULL WHERE id = $1`,
        [turnId],
      );
      await c.query(`DELETE FROM agent_turn_inputs WHERE turn_id = $1`, [
        turnId,
      ]);
      await c.query(`DELETE FROM agent_turns WHERE id = $1`, [turnId]);
      await c.query(`DELETE FROM mensagens WHERE conversa_id = $1`, [
        conversaId,
      ]);
      await c.query(`DELETE FROM conversas WHERE id = $1`, [conversaId]);
      await c.query(`DELETE FROM pessoas WHERE id = $1`, [pessoaId]);
      await rm(join(estado.raiz, "outbound"), { recursive: true, force: true });
    } finally {
      c.release();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 1 — a exceção declarada de #631 (voz não commita) está FECHADA.
  // ═══════════════════════════════════════════════════════════════════════

  it("o ramo de VOZ commita um artefato durável com storage_object", async () => {
    canal.sendVoice.mockResolvedValue("3EB0VOZ634");
    await comoOWorkerDono(() =>
      dispatchOutput(ctxDeVoz("trezentos reais este mês")),
    );

    expect(canal.sendVoice).toHaveBeenCalledTimes(1);
    const linha = await linhaOutbound();
    // Invariante ABSOLUTA: existe UMA linha, e ela é de áudio. Reverter o ramo
    // de voz para o de #631 (sem commit) faz `linha` virar `null`.
    expect(linha).not.toBeNull();
    expect(linha!.payload_type).toBe("audio");
    expect(linha!.payload_json.media).toEqual({
      kind: "storage_object",
      bucket: OUTBOUND_MEDIA_BUCKET,
      object_key: expect.stringMatching(
        new RegExp(`^${TENANT}/${AGENT}/[0-9a-f-]{36}/[0-9a-f]{64}\\.ogg$`),
      ),
    });
    // `source_text` é o material do retry e do fallback — #630 o exige.
    expect(linha!.payload_json.source_text).toBe("trezentos reais este mês");
    // E o payload NÃO carrega bytes nem caminho: se carregasse, o `.strict()`
    // do contrato teria recusado, mas a asserção fica explícita.
    expect(JSON.stringify(linha!.payload_json)).not.toContain(estado.raiz);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 2 — os bytes que o canal recebeu são os bytes do objeto.
  // ═══════════════════════════════════════════════════════════════════════

  it("o objeto referenciado contém exatamente o áudio que foi sintetizado", async () => {
    canal.sendVoice.mockResolvedValue("3EB0VOZ634B");
    await comoOWorkerDono(() => dispatchOutput(ctxDeVoz("resposta em voz")));
    // Entrega CONFIRMADA ⇒ o objeto é descartado (GC do buffer de entrega). A
    // prova de que ele EXISTIU e tinha os bytes certos é o que o canal recebeu.
    expect(canal.sendVoice.mock.calls[0]![1]).toEqual(VOZ);
    const linha = await linhaOutbound();
    expect(linha!.status).toBe("delivered");
    // E o GC de fato aconteceu: o objeto de uma entrega confirmada não fica.
    await expect(
      comoOWorkerDono(() =>
        resolveOutboundMediaPath(linha!.payload_json.media as MediaRef),
      ),
    ).rejects.toBeInstanceOf(OutboundMediaError);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 3 — a dívida do `local_path` do DOCUMENTO.
  //
  // Este é o caso que #631 declarou impossível: o PDF temporário some no
  // `finally`, então uma segunda tentativa encontrava ENOENT com CERTEZA.
  // ═══════════════════════════════════════════════════════════════════════

  it("depois de um envio INCERTO o PDF temporário sumiu e a referência commitada ainda resolve", async () => {
    const { ctx, tmpPdf, bytes } = await ctxDeDocumento("segue o extrato");
    // O transporte lança: desfecho AMBÍGUO, a linha NÃO é confirmada e o
    // objeto durável não é coletado — é dele que a reconciliação de #633 e o
    // rearmamento manual precisam.
    canal.sendDocument.mockRejectedValue(new Error("socket hangup"));

    await expect(
      comoOWorkerDono(() => dispatchOutput(ctx)),
    ).rejects.toBeInstanceOf(OutboundDeliveryError);

    // O temporário desta tentativa foi removido pelo `finally`, como sempre.
    expect(existsSync(tmpPdf)).toBe(false);

    const linha = await linhaOutbound();
    expect(linha!.payload_type).toBe("document");
    expect((linha!.payload_json.media as MediaRef).kind).toBe("storage_object");
    // A afirmação inteira da fatia: a referência COMMITADA continua resolvendo,
    // e para os MESMOS bytes. Com `{kind:'local_path', path: tmpPdf}` — o que
    // #631 persistia — esta resolução seria ENOENT.
    const caminho = await comoOWorkerDono(() =>
      resolveOutboundMediaPath(linha!.payload_json.media as MediaRef),
    );
    expect(await readFile(caminho)).toEqual(bytes);
    // E o que foi ao canal veio do OBJETO, não do temporário.
    expect(canal.sendDocument.mock.calls[0]![1]).toBe(caminho);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 4 — isolamento entre escopos, com a colisão FORÇADA.
  // ═══════════════════════════════════════════════════════════════════════

  it("a MESMA chave de objeto não resolve sob outro tenant, e resolve sob o dono", async () => {
    const ref = await runWithTenantContext(
      { tenant_id: TENANT, agent_id: AGENT },
      () =>
        putOutboundMedia({
          bytes: Buffer.from("segredo do tenant dono"),
          ext: "ogg",
          pessoa_id: pessoaId,
        }),
    );

    // CASO POSITIVO primeiro: sem ele, um resolvedor que recusasse tudo
    // passaria na metade negativa e a sonda não provaria nada.
    const doDono = await runWithTenantContext(
      { tenant_id: TENANT, agent_id: AGENT },
      () => resolveOutboundMediaPath(ref.ref),
    );
    expect(existsSync(doDono)).toBe(true);

    // CASO NEGATIVO: a MESMA chave, o MESMO arquivo no disco, outro escopo. A
    // contenção de `media-guard` aprovaria (a raiz é a mesma); quem recusa é a
    // comparação de escopo, e o `reason` diz qual checagem carregou o peso.
    await expect(
      runWithTenantContext({ tenant_id: TENANT_VIZINHO, agent_id: AGENT }, () =>
        resolveOutboundMediaPath(ref.ref),
      ),
    ).rejects.toMatchObject({ reason: "scope_mismatch" });

    // E um bucket estrangeiro também não entra — o `storage_object` de outro
    // store não vira leitura neste volume.
    await expect(
      runWithTenantContext({ tenant_id: TENANT, agent_id: AGENT }, () =>
        resolveOutboundMediaPath({
          kind: "storage_object",
          bucket: "outro-store",
          object_key:
            ref.ref.kind === "storage_object" ? ref.ref.object_key : "",
        }),
      ),
    ).rejects.toMatchObject({ reason: "foreign_bucket" });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SONDA 5 — LGPD: a purga por titular ALCANÇA o store, e só o titular.
  // ═══════════════════════════════════════════════════════════════════════

  it("o apagamento por titular remove os objetos DELE e preserva os de outro titular", async () => {
    const c = await pool.connect();
    let outroId: string;
    try {
      const o = await c.query<{ id: string }>(
        `INSERT INTO pessoas(tenant_id, agent_id, nome, telefone_whatsapp, tipo, status)
         VALUES ($1, $2, 'Outro 634', $3, 'cliente', 'ativa') RETURNING id`,
        [TENANT, AGENT, `+55118${Date.now().toString().slice(-8)}`],
      );
      outroId = o.rows[0]!.id;
    } finally {
      c.release();
    }
    try {
      const doTitular = await runWithTenantContext(
        { tenant_id: TENANT, agent_id: AGENT },
        () =>
          putOutboundMedia({
            bytes: Buffer.from("voz do titular"),
            ext: "ogg",
            pessoa_id: pessoaId,
          }),
      );
      const doOutro = await runWithTenantContext(
        { tenant_id: TENANT, agent_id: AGENT },
        () =>
          putOutboundMedia({
            bytes: Buffer.from("voz do outro"),
            ext: "ogg",
            pessoa_id: outroId,
          }),
      );
      expect(existsSync(doTitular.path)).toBe(true);
      expect(existsSync(doOutro.path)).toBe(true);

      const scope = { tenant_id: TENANT, agent_id: AGENT };
      const identifier = { kind: "person_id" as const, value: pessoaId };
      const { subject_ref } = resolveSubjectRef(
        scope,
        identifier,
        deriveTombstoneSecret(config.RUNTIME_TRACE_HMAC_MASTER_SECRET),
      );
      // O adapter REAL de #536, com a classe nova. Se `media.outbound_artifacts`
      // estivesse em `UNSUPPORTED_CLASSES`, ou se o `switch` de `purgeClass` não
      // tivesse o ramo, isto LANÇA `purge_mechanism_not_implemented` — que é
      // exatamente o estado em que `media.blobs` continua.
      const removidos = await runWithTenantContext(scope, () =>
        createPrivacyPorts().purge({
          scope,
          data_class: "media.outbound_artifacts",
          mechanism: "delete",
          subject: { subject_ref, identifier },
        }),
      );

      expect(removidos).toBe(1);
      expect(existsSync(doTitular.path)).toBe(false);
      // A outra metade, e é ela que prova que a purga é POR TITULAR e não uma
      // limpeza do escopo inteiro.
      expect(existsSync(doOutro.path)).toBe(true);
      // O diretório do titular também some — não fica casca vazia.
      const dir = await outboundMediaSubjectDir({
        ...scope,
        pessoa_id: pessoaId,
      });
      expect(existsSync(dir)).toBe(false);
    } finally {
      const c2 = await pool.connect();
      try {
        await c2.query(`DELETE FROM pessoas WHERE id = $1`, [outroId!]);
      } finally {
        c2.release();
      }
    }
  });
});
