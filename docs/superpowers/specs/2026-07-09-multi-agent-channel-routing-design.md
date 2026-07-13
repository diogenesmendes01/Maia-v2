# Multi-Agent Channel Routing — Design Spec

**Date:** 2026-07-09 (v2/v3: 2026-07-13 · v4: 2026-07-13)
**Status:** Draft v4 — incorpora a 3ª rodada do review de design. Mudanças vs. v3: §1.7 dedup de `mensagens` escopado por canal + `findByWhatsappIdCrossTenant` com linha (bloqueante 1), §1.6 contrato `forChannel({tenant_id, agent_id, channel_id})` + FKs compostas + identidade de conversa por canal + CHECK de bloqueio expressável (bloqueante 2), §1.4 recovery sweep Postgres→BullMQ + re-arm no conflito + envelope AES-GCM versionado com keyring (bloqueante 3 + alta), §1.6 fase 0 preserva o modelo de durabilidade atual — envio síncrono continua direto, mas obrigatoriamente via `LineOutput` (alta), §1.5/§2 E.164 canônico COM `+` e índice global restrito a whatsapp (alta).
**Scope:** Substituir o catch-all `primary/primary` (issue #411) por resolução exata pela **linha do bot**, com operação real multi-linha: gerenciador multi-sessão, fronteira única de saída escopada por tenant+agent+canal, dedup por canal e staging durável.

**Referências (adições v4):**
- `migrations/003_review_fixes.sql` (~10) — UNIQUE **global** `(metadata->>'whatsapp_id')` em `mensagens`; o próprio dedup documenta que IDs podem colidir entre sessões.
- `src/db/repositories/conversation-repos.ts` (~20) — `findActive` busca por pessoa+tenant+agente (sem canal); `findByWhatsappIdCrossTenant` para edits/revokes.
- `src/agent/output-dispatch.ts` (~266) — PDFs temporários apagados no `finally`; respostas síncronas usam ledger próprio (`outbound_messages`), não o outbox.
- `src/gateway/jid-tenant-resolver.ts` (~97) — E.164 canônico **com** `+`.
- (v1–v3): `channel-resolver.ts`, `baileys.ts`, `presence.ts`, `redis.ts`, `channelPolicies.ts`, `031_p6_channels.sql`, tenant-isolation, PR #491.

**Architecture Locks tocados:** nenhum diretamente; entry point de tenant-resolution — `npm run test:leak` obrigatório em todo PR da série.

**Depends on:** #491 (mesclado). **Blocks:** operação multi-agente/multi-tenant real por WhatsApp.

---

## §0. Purpose

(Recap v1→v3.) Lookup pela identidade errada + runtime mono-linha; v2 adicionou multi-sessão e ownership; v3 adicionou fronteira de saída, pareamento dedicado, staging cifrado e E.164. A v4 fecha a 3ª rodada: **o dedup de entrada é global e colidiria entre linhas**, **`channel_id` sozinho não prova tenant+agent**, **havia janela de perda entre Postgres e BullMQ**, e a fase 0 prometia "comportamento idêntico" enquanto movia envio síncrono para um worker que não teria mais o artefato temporário.

Não-objetivo (mantido): múltiplos agentes numa MESMA linha.

## §1. Design

### §1.1 Contrato do inbound

(Inalterado.) `bot_line_external_id` da SESSÃO que recebeu (normalizado) para resolução; `sender_external_id` para identidade/pessoa.

### §1.2 Modos de resolução (tri-state)

(Inalterado.) `MAIA_CHANNEL_ROUTING_MODE = shadow | exact_first | strict` (default `shadow`).

### §1.3 Ambiguidade

(Inalterado.) `throw` mantido como defesa; unicidade global (§2) torna o estado incriável.

### §1.4 Staging de inbound não-roteado (strict) — atômico de ponta a ponta (review v4, bloqueante 3 + alta cripto)

- **Armazenamento**: tabela `inbound_unrouted` (Postgres): `id uuid`, `line_external_id`, `whatsapp_message_id`, `envelope BYTEA`, `status ('pending'|'handed_off'|'expired')`, `received_at`, `expires_at` (TTL 72h). Job BullMQ carrega só o id. UNIQUE `(line_external_id, whatsapp_message_id)`.
- **Envelope AES-256-GCM versionado** (a v3 listava só ciphertext+key_id — não implementável: GCM exige nonce único e tag): `{ v: 1, key_id, nonce (12B aleatórios por registro), tag (16B), ciphertext }`, serializado no BYTEA. **Keyring**: `MAIA_STAGING_KEYRING` (JSON `key_id → chave base64 32B`) + `MAIA_STAGING_ACTIVE_KEY_ID`; cifra sempre com a ativa; decifra por `key_id` do envelope. Regra operacional: uma chave só sai do keyring quando nenhuma row `pending` a referencia — na prática, permanece por ≥ TTL máximo (72h) após a rotação, verificado pelo sweeper (recusa expirar chave referenciada). Strict recusa ligar sem keyring válido.
- **Sem janela de perda Postgres→BullMQ** (a v3 gravava a row e depois `queue.add()` — crash no meio deixaria mensagem cifrada sem job):
  - `queue.add` com jobId estável `unrouted:<line>:<whatsapp_id>` logo após o commit (caminho feliz);
  - **recovery sweep** `unrouted-job-recovery` (mesmo padrão do `runMessageRecovery` existente): periodicamente varre rows `pending` com `received_at` além de um limiar e re-arma o job — o jobId estável torna o re-add idempotente;
  - **conflito no insert** (retry do evento Baileys): `ON CONFLICT ... DO UPDATE SET id=EXCLUDED.id RETURNING id` (ou select da row existente) e **re-arma o job** com o mesmo jobId — o retry nunca conclui sem garantir job vivo.
- **Handoff idempotente**: ver §1.7 — a entrega na pipeline normal usa o dedup POR CANAL novo; corrida entre replay e caminho vivo resolve no UNIQUE, nunca entrega dupla. Row entregue ⇒ `status='handed_off'`.
- Exceção consciente (payload fora de tenant) documentada em `governance-observability` (TTL + cifragem + acesso restrito).

### §1.5 Gerenciador multi-sessão

- (Inalterado da v3): sessões de roteamento por canal ativo+verificado; auth dir por **UUID do canal** (`lines/<channel_id>/`) com validação `path.resolve`; recovery per-sessão; corte para processo-por-linha.
- **E.164 canônico COM `+`** (review v4 — a v3 normalizava "sem `+`", INVERTIDO em relação ao resolver real, `jid-tenant-resolver.ts` ~97, o que quebraria o exact lookup): representação canônica `+<dígitos>` em canais, lookups e no `bot_line_external_id`; validação Zod + repo (`^\+[1-9][0-9]{6,14}$` para `channel_type='whatsapp'`). Migração de dados normaliza variantes existentes ANTES do índice global (runbook para não-normalizáveis).

### §1.6 Fronteira única de saída escopada pelo triplete (review v4, bloqueante 2 + alta durabilidade)

- **Contrato com triplete completo**: `LineSessionManager.forChannel({ tenant_id, agent_id, channel_id }): LineOutput` — o manager valida que o canal pertence ao (tenant, agent) informado (fail-closed: mismatch ⇒ erro tipado + audit). `channel_id` sozinho não prova escopo (invariante #1): um UUID estrangeiro plantado por bug devolveria a sessão de outro tenant.
- **Constraints que provam o vínculo no DB**: índice único de suporte `channels(tenant_id, agent_id, id)`; `conversas.channel_id` e `outbox.channel_id` ganham **FK composta** `(tenant_id, agent_id, channel_id) REFERENCES channels(tenant_id, agent_id, id)` — uma row nunca aponta para canal de outro tenant/agente, por construção.
- **Regra de bloqueio expressável** (a v3 dizia "NOT NULL para rows novas", não-expressável): `CHECK (channel_id IS NOT NULL OR status = 'blocked_channel_unresolved')` no outbox; o drain ignora rows bloqueadas; runbook/admin listam para resolução manual. Backfill fail-closed inalterado (canal só quando unívoco; NUNCA escolher primário).
- **Identidade da conversa inclui o canal** (review v4): `conversasRepo.findActive` passa a receber `channel_id` — com um agente em N linhas, a MESMA pessoa em duas linhas são DUAS conversas; sem isso a resposta sairia pela linha da conversa anterior. Rows legadas (`channel_id NULL`) casam qualquer canal do agente até serem naturalmente encerradas (janela de transição documentada; conversas novas sempre nascem com canal).
- **Durabilidade: fase 0 preserva o modelo atual** (review v4 — mover envio síncrono para o outbox NÃO é mecânico: o worker assíncrono não teria o PDF temporário apagado no `finally` do dispatch, nem o ledger `outbound_messages` reconciliado): a fronteira única da fase 0 é a **API** (`LineOutput` obrigatório, socket não-exportado, lint gate), não o modelo de durabilidade. Envio síncrono (resposta principal, mídia/voz/docs/polls do turno) continua direto → `LineOutput.send*`, com o ledger atual intacto; o outbox continua servindo exatamente quem já serve (proativo/agendado), agora com `channel_id`. **Promover envio síncrono ao outbox é decisão futura separada**, exigindo armazenamento durável do artefato + ownership do cleanup + reconciliação de ledgers — fora do escopo desta spec.
- Efêmeros (typing, read receipts, reactions) via `LineOutput` da sessão do canal (inalterado).

### §1.7 Dedup de entrada por canal (review v4, bloqueante 1)

`mensagens` tem hoje UNIQUE **global** `(metadata->>'whatsapp_id')` (`003_review_fixes.sql`), e o próprio dedup documenta colisão possível de IDs entre sessões — com N linhas, a mensagem do tenant B colidiria com a do tenant A e seria descartada silenciosamente. Migração `NNN_mensagens_dedup_scope`:

- DROP da unique global; novas partial uniques:
  - `(channel_id, (metadata->>'whatsapp_id')) WHERE channel_id IS NOT NULL` — rows novas (canal sempre conhecido pós-resolução);
  - `(tenant_id, agent_id, (metadata->>'whatsapp_id')) WHERE channel_id IS NULL` — preserva a proteção para rows legadas sem estreitar além do necessário.
- `mensagens.channel_id` (nova coluna, FK composta como em §1.6) preenchido na persistência do inbound.
- **`findByWhatsappIdCrossTenant`** (edits/revokes) passa a receber a linha/canal da sessão que entregou o evento e resolve DENTRO desse escopo — sem varredura global por um ID que pode colidir.
- O handoff do staging (§1.4) entrega usando este dedup por canal — chave idêntica à do caminho vivo.

## §2. Ownership da linha: declarado vs. verificado

- §2.1–2.4 (inalterados da v2/v3): declarado→verificado; pareamento compara número real e ativa; defesa de ambiguidade mantida.
- **Índice global restrito a WhatsApp** (review v4 — `web/api/other` podem legitimamente repetir IDs entre tenants): `CREATE UNIQUE INDEX channels_active_line_uq ON channels(channel_type, external_id) WHERE active AND channel_type = 'whatsapp';` — runbook de duplicatas ativas antes; a migração falha se houver duplicata whatsapp (fail-closed).
- §2.5 `PairingSession` (inalterado da v3): sob demanda, auth dir `pairing/<channel_id>/`, TTL 15min, nunca roteia, promoção atômica do auth state.

## §3. Invariantes (stop conditions)

1. Zero regressão #268/#417; `test:leak` obrigatório.
2. Fail-closed: nenhum envio sem triplete validado (`forChannel` + FKs compostas); miss em strict ⇒ staging; backfill nunca escolhe canal; mismatch de triplete ⇒ erro + audit.
3. **Nenhuma mensagem descartada por colisão cross-tenant/cross-linha de `whatsapp_id`** (dedup por canal).
4. Ownership verificado; unicidade global (whatsapp) no DB; E.164 canônico com `+` idêntico ao resolver.
5. **Sem janela de perda no staging**: job garantido por commit+re-arm+recovery sweep; chave de cifra nunca expira com rows pendentes.
6. Auditoria: divergências de shadow, catch-all, pareamento, transições de sessão, rows bloqueadas, mismatches de triplete.

## §4. Rollout

0. **Fronteira de saída** (pré-requisito): `LineOutput` com triplete + migração de TODOS os call sites (comportamento e durabilidade IDÊNTICOS — envio síncrono continua direto) + lint gate + `conversas/outbox/mensagens.channel_id` + FKs compostas + CHECK de bloqueio + dedup por canal + backfill fail-closed.
1. **Multi-sessão atrás de flag** (`MAIA_MULTI_LINE=false`): manager com a linha primária; índice global whatsapp-only (runbook antes) + normalização E.164 com `+`.
2. **`shadow`** (default): ≥1 semana de `shadow_divergence`.
3. **`exact_first`** + `MAIA_MULTI_LINE=true`: pareamento de linhas novas.
4. **`strict`**: staging operante (keyring válido + recovery sweep rodando) + 7 dias sem `legacy_catch_all`.

## §5. Testes

- Unit: resolver nos 3 modos; E.164 com `+` (variantes, traversal rejeitado); `forChannel` recusa triplete inconsistente; envelope GCM (roundtrip, rotação por keyring, recusa de chave ausente); classificação durável/efêmero inalterada na fase 0.
- Integração: FKs compostas rejeitam canal estrangeiro; conversa por canal (mesma pessoa, duas linhas ⇒ duas conversas; resposta pela linha certa); dedup por canal (mesmo whatsapp_id em duas linhas ⇒ ambas persistem; retry na mesma linha ⇒ uma); staging (conflito re-arma job; kill entre commit e add ⇒ recovery sweep re-arma; handoff vs caminho vivo sem dupla entrega); pareamento; leak suite.
- E2E gateway: duas linhas → dois agentes; mesma pessoa nas duas linhas recebe cada resposta pela linha de origem.

## §6. Riscos e alternativas descartadas

- **Risco:** migração ampla de call sites (fase 0) — mecânica por preservar durabilidade; lint gate impede regressão.
- **Risco:** conversas legadas sem canal durante a transição — janela documentada; encerram naturalmente.
- **Descartados (mantidos):** rotear pelo remetente; agent-selector no inbound; upsert automático no pareamento; payload de staging no Redis.
- **Descartado (v4) — promover envio síncrono ao outbox na fase 0:** exigiria artefatos duráveis + ownership de cleanup + reconciliação de ledgers; violaria "comportamento idêntico". Fica como decisão futura explícita.
