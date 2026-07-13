# Multi-Agent Channel Routing — Design Spec

**Date:** 2026-07-09 (v2: 2026-07-13 · v3: 2026-07-13)
**Status:** Draft v3 — incorpora a 2ª rodada do review de design. Mudanças vs. v2: §1.6 fronteira única de saída + `channel_id` obrigatório em toda API de envio + backfill fail-closed (bloqueante), §2.5 sessão de pareamento dedicada (alta — circularidade), §1.4 staging com cifragem explícita AES-GCM + idempotência pré-resolução (2 altas), §1.5 auth dir por UUID do canal + validação E.164 (alta — path traversal).
**Scope:** Substituir o catch-all `primary/primary` do resolver de canal (issue #411) por resolução exata pela **linha do bot**, E habilitar operação real com múltiplas linhas (gerenciador multi-sessão, fronteira única de saída, outbound pela linha correta).

**Referências:**
- `src/gateway/channel-resolver.ts` — resolução atual e fixes #268/#411/#417.
- `src/gateway/baileys.ts` — socket único global, catch que descarta inbound não-resolvido (~494), dedup PÓS-resolução (~600).
- `src/agent/output-dispatch.ts` (~695) e `src/gateway/presence.ts` (~26) — **envios que NÃO passam pelo outbox hoje** (resposta principal, documentos, voz, polls, reactions, typing, read receipts). Base do bloqueante v3.
- `src/lib/redis.ts` — cliente abre `REDIS_URL` sem cifragem de payload (base da alta v3 sobre o staging).
- `src/admin-ui/trpc/routers/channelPolicies.ts` — `external_id` aceita string livre ≤200 chars (base da alta v3 de path traversal).
- `migrations/031_p6_channels.sql`; `docs/architecture/concerns/tenant-isolation.md`; PR #491.

**Architecture Locks tocados:** nenhum diretamente; entry point de tenant-resolution — `npm run test:leak` obrigatório em todo PR da série.

**Depends on:** #491 (mesclado). **Blocks:** operação multi-agente/multi-tenant real por WhatsApp.

---

## §0. Purpose

(V1→v2 recap.) O lookup usa a identidade errada (telefone do remetente em vez da linha do bot) e o runtime é mono-linha por construção. A v2 adicionou o gerenciador multi-sessão; a v3 fecha os furos operacionais apontados na 2ª rodada: **a saída não tem fronteira única hoje**, o pareamento era circular, o staging alegava cifragem inexistente e sem idempotência, e o auth dir por número permitia path traversal.

Não-objetivo (mantido): rotear múltiplos agentes numa MESMA linha (isso é role selection pós-triplete).

## §1. Design

### §1.1 Contrato do inbound

(Inalterado da v2.) `bot_line_external_id` (da SESSÃO que recebeu, normalizado via caminho do #489) para resolução; `sender_external_id` para identidade/pessoa.

### §1.2 Modos de resolução (tri-state)

(Inalterado da v2.) `MAIA_CHANNEL_ROUTING_MODE = 'shadow' | 'exact_first' | 'strict'` (default `shadow`); shadow computa exact em paralelo e só loga `shadow_divergence`.

### §1.3 Ambiguidade

(Inalterado da v2.) `throw` mantido como defesa; com a unicidade global (§2) vira estado impossível de criar.

### §1.4 Staging de inbound não-roteado (strict) — cifragem e idempotência (review v3, 2 altas)

Estado atual: resolução acontece antes de qualquer persistência; miss em strict perderia a mensagem; o dedup existente só roda DEPOIS do tenant resolvido (`baileys.ts` ~600), então retries do evento Baileys/worker duplicariam.

- **Armazenamento**: tabela Postgres `inbound_unrouted` (não payload no Redis): `id uuid`, `line_external_id`, `whatsapp_message_id`, `ciphertext BYTEA`, `enc_key_id`, `received_at`, `expires_at` (TTL 72h, sweeper). O job BullMQ carrega SÓ o id da row.
- **Cifragem EXPLÍCITA** (a v2 alegava "mesmo mecanismo do Redis", que não existe — `redis.ts` não cifra nada): envelope cifrado em aplicação com **AES-256-GCM**, chave em `MAIA_STAGING_ENC_KEY` (32 bytes, base64), `enc_key_id` gravado por registro; rotação = nova env + suporte de decrypt à chave anterior por 1 release. Sem a env configurada, strict recusa ligar (fail-closed).
- **Idempotência pré-resolução**:
  - UNIQUE `(line_external_id, whatsapp_message_id)` na tabela; insert `ON CONFLICT DO NOTHING` — retries do evento Baileys não duplicam o staging.
  - jobId BullMQ estável: `unrouted:<line>:<whatsapp_message_id>` — retries do enqueue não duplicam o job.
  - **Handoff idempotente**: quando a linha é registrada e o worker re-resolve, a entrega na pipeline normal usa a MESMA chave de dedup que o caminho vivo usa pós-resolução (contrato documentado no código do dedup atual) — se o caminho vivo e o replay correrem, um dos dois é descartado pelo dedup normal, nunca entrega dupla.
- Exceção consciente (payload fora de tenant resolvido) documentada em `governance-observability` com TTL + cifragem + acesso restrito ao worker.

### §1.5 Gerenciador multi-sessão (review v3: auth dir por UUID + E.164)

- **`LineSessionManager`**: mapa `channel_id → BaileysSession` (sessões de ROTEAMENTO sobem só para canais ativos+verificados; pareamento em §2.5). Recovery per-sessão; isolamento de falha; métricas por linha.
- **Auth dir por UUID do canal, nunca pelo número**: `BAILEYS_AUTH_DIR/lines/<channel_id-uuid>/`. A v2 propunha `<line_external_id>` no path — com `external_id` aceitando string livre (`channelPolicies.ts`), um valor como `../x` escaparia da raiz. UUID é gerado pelo DB (não-atacável); defesa em profundidade: o manager ainda valida `path.resolve` dentro da raiz.
- **Validação E.164 na borda e no repo**: para `channel_type='whatsapp'`, `external_id` DEVE ser E.164 normalizado (`^\+?[1-9][0-9]{6,14}$` + normalização canônica sem `+`), validado no Zod do tRPC E no `channelsRepo.create*` (defesa dupla — a UI não é trust boundary). Migração de dados: rows whatsapp existentes fora do formato são reportadas por query de auditoria (runbook decide corrigir/desativar).
- **Topologia**: in-process v1; corte limpo para processo-por-linha (inalterado da v2).

### §1.6 Fronteira ÚNICA de saída + `channel_id` obrigatório (review v3, bloqueante)

A v2 assumia "o outbox já é a fronteira transacional de saída" — **falso hoje**: a resposta principal chama Baileys direto (`output-dispatch.ts` ~695) e documentos/voz/polls/reactions/typing/read-receipts também escapam (`presence.ts` ~26). Adicionar `channel_id` só no outbox permitiria resposta pela sessão errada por qualquer um desses caminhos. Design v3:

- **API única de envio**: `LineSessionManager.forChannel(channel_id): LineOutput` é o ÚNICO objeto com métodos de envio (`sendText`, `sendMedia`, `sendPoll`, `sendReaction`, `setPresence`, `sendReadReceipt`, …). `channel_id` é obrigatório **na assinatura** — não existe método de envio sem canal (imposição em compile-time). O socket Baileys deixa de ser exportado; acesso direto a `sock.*` fora do manager vira erro de lint (regra `no-restricted-imports`/`no-restricted-properties` no CI) — o grep de migração enumera e converte TODOS os call sites atuais (output-dispatch, presence, mídia, voz, polls, reactions, receipts, setup/pairing).
- **Durável vs. efêmero**: envios de CONTEÚDO (texto, mídia, voz, docs, polls) continuam passando pelo outbox (transacional, retry) — o registro de outbox ganha `channel_id NOT NULL` para rows novas e o drain resolve `channel_id → sessão` via manager. Sinais EFÊMEROS (typing, read receipt, reaction?) não precisam de durabilidade e vão direto pela `LineOutput` da sessão do canal — reactions são promovidas a durável se a auditoria exigir (decisão na implementação, default: efêmero).
- **`conversas.channel_id`**: migração append-only adiciona `channel_id` a `conversas` (NULL para legado), preenchido na resolução do inbound. Toda resposta a uma conversa deriva o canal DELA; mensagens proativas (sem conversa) exigem `channel_id` explícito do chamador (scheduling/objectives passam a carregar o canal).
- **Backfill fail-closed** (a v2 dizia "backfill = canal primário" — inseguro para proativas/sem conversa): a migração deriva `channel_id` apenas quando é UNÍVOCO (o agente tem exatamente 1 canal ativo do tipo). Caso contrário a row fica `channel_id NULL` + `status='blocked_channel_unresolved'`, listada em runbook/admin para resolução manual. **Nunca escolher silenciosamente.** O drain não envia row bloqueada.

## §2. Ownership da linha: declarado vs. verificado

### §2.1–2.4 (inalterados da v2)

Canal da UI nasce `active=false` (`verification='declared'`); pareamento compara `sock.user.id` com o declarado e ativa (`verification='paired'`, auditado); índice único parcial GLOBAL `channels_active_line_uq ON channels(channel_type, external_id) WHERE active` (migração falha se houver duplicata ativa — runbook antes); defesa de ambiguidade em runtime mantida.

### §2.5 Sessão de pareamento dedicada (review v3, alta — quebra a circularidade)

A v2 era circular: o manager só sobe sessão para canal ativo+verificado, mas o canal só ativa depois de pareado — e parear exige sessão. Design:

- **`PairingSession(channel_id)`**: tipo de sessão distinto, iniciado SOB DEMANDA pela superfície `/setup` para um canal **declarado** (inativo). Auth dir isolado `BAILEYS_AUTH_DIR/pairing/<channel_id-uuid>/`, TTL curto (15 min sem conclusão ⇒ encerra e limpa).
- Ao conectar: compara o número real com o declarado — casou ⇒ ativa o canal (23505 do índice global ⇒ erro "linha pertence a outro workspace"), **promove o auth state** para `lines/<channel_id>/` (rename atômico) e o manager sobe a sessão de ROTEAMENTO; não casou ⇒ recusa com o número real na mensagem, auth de pairing descartado.
- Sessões de pareamento **nunca roteiam**: inbound recebido durante o pareamento é ignorado com audit (`pairing_session_inbound_dropped`).

## §3. Invariantes (stop conditions)

1. Zero regressão #268/#417; `test:leak` obrigatório.
2. Fail-closed: miss em strict ⇒ staging + falha tipada; **nenhum envio sem `channel_id`** (compile-time + lint); outbound nunca sai por linha diferente da do canal; backfill nunca escolhe canal sozinho.
3. Ownership verificado por pareamento; unicidade global no DB.
4. Auditoria: divergências de shadow, catch-all em exact_first, pareamento (sucesso/recusa/drop de inbound), transições de sessão, rows bloqueadas de backfill.

## §4. Rollout

0. **Fronteira de saída** (pré-requisito novo, antes de qualquer multi-linha): `LineOutput` + migração de TODOS os call sites + lint gate + `conversas.channel_id` + `outbox.channel_id` com backfill fail-closed. Comportamento idêntico (uma linha só).
1. **Multi-sessão atrás de flag** (`MAIA_MULTI_LINE=false`): manager com a linha primária; migrações de índice global (runbook de duplicatas antes) + E.164.
2. **`shadow`** (default): ≥1 semana de `shadow_divergence`.
3. **`exact_first`** + `MAIA_MULTI_LINE=true`: pareamento de linhas novas via PairingSession.
4. **`strict`**: pré-condições: staging `inbound_unrouted` operante (com `MAIA_STAGING_ENC_KEY` configurada) + 7 dias sem `legacy_catch_all`.

## §5. Testes

- Unit: resolver nos 3 modos; normalização/validação E.164 (incluindo tentativas de traversal rejeitadas na borda E no repo); `LineOutput` recusa uso sem canal (tipo); classificação durável/efêmero.
- Integração: pareamento (match/mismatch/duplicata global/TTL/drop de inbound com audit); promoção de auth state; outbox drena pela sessão do canal e BLOQUEIA row sem canal; staging (dedup por UNIQUE, jobId estável, handoff idempotente contra corrida com o caminho vivo, decrypt com rotação de chave); leak suite.
- E2E gateway: duas linhas → dois agentes, respostas e presence pela linha de origem.

## §6. Riscos e alternativas descartadas

- **Risco:** migração de call sites de envio é ampla (dispatch, presence, mídia, voz, polls, reactions, receipts) — mitigada por ser mecânica, com lint gate impedindo regressão e fase 0 dedicada sem mudança de comportamento.
- **Risco:** N sockets in-process — corte limpo para processo-por-linha (inalterado).
- **Descartados (mantidos):** rotear pelo remetente; agent-selector no inbound; upsert automático de canal no pareamento sem declaração prévia.
- **Descartado (v3) — payload do staging no Redis:** sem cifragem nativa e com TTL/observabilidade piores que uma tabela dedicada; Redis guarda só o job, Postgres guarda o envelope cifrado.
