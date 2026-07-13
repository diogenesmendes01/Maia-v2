# Multi-Agent Channel Routing — Design Spec

**Date:** 2026-07-09
**Status:** Draft v1 — proposta para discussão; implementável de forma independente das fases 1–4 do relatório de complexidade (#491–#493, mescladas).
**Scope:** Substituir o catch-all `primary/primary` do resolver de canal (issue #411) por resolução exata pela **linha do bot**, permitindo que agentes não-primary criados pela UI recebam tráfego real de WhatsApp. Cobre gateway (`baileys.ts`, `channel-resolver.ts`), o contrato de `external_id`, migração do canal semeado e o plano de canary.

**Referências:**
- `src/gateway/channel-resolver.ts` — política de resolução atual (exact match → catch-all single-tenant → fail-loud) e os fixes #268 (fail-loud), #411 (catch-all) e #417 (discriminador global + TOCTOU).
- `src/db/repositories/channel-repos.ts` — `findByExternalCrossTenant` (único bypass sancionado do tenant guard) e `findPrimaryCatchAllChannel`.
- `migrations/031_p6_channels.sql` / `035_p6_seed_default_channel_role_policy.sql` — schema + seed (`external_id='default-channel'`).
- `docs/architecture/concerns/tenant-isolation.md` — invariante #1; `docs/architecture/concerns/channel-policy.md`.
- PR #491 — CRUD de canais/papéis na UI (pré-requisito de superfície já entregue).

**Architecture Locks tocados:** nenhum diretamente, mas o caminho é o **entry point de tenant-resolution** — toda mudança aqui exige `npm run test:leak` verde e revisão adversarial (histórico: um fix CRITICAL e um HIGH no PR #417).

**Depends on:** #491 (UI de canais — mesclado). **Blocks:** operação multi-agente e multi-tenant real por WhatsApp.

---

## §0. Purpose

O problema em uma frase: **um canal WhatsApp representa a LINHA DO BOT, mas o gateway passa o telefone do REMETENTE como `external_id`** — o exact match `(channel_type, external_id)` nunca casa, e todo inbound cai no catch-all `primary/primary` (issue #411). Consequência: um agente `vendedor` criado pela UI, com canal, papel e política configurados, **nunca recebe uma mensagem**.

O catch-all foi a correção certa para o bug que derrubava o bot (#411), mas é um beco para multi-agente: enquanto o lookup usa a identidade errada, registrar canais é configuração sem efeito de roteamento.

Este spec corrige a **identidade do lookup** — o `external_id` do canal passa a ser a linha do bot (o número em que a mensagem CHEGOU), que o Baileys conhece (`sock.user.id`) — e mantém o catch-all como fallback de compatibilidade atrás de flag, preservando os invariantes dos fixes #268/#417.

Não-objetivo: rotear MÚLTIPLOS agentes numa MESMA linha. Isso é seleção de papel/agente por contexto (camada `channel_policies`/`agent-selector`), não resolução de canal. Uma linha = um canal = um agente; multi-agente = múltiplas linhas (o schema já suporta: "um mesmo agent pode ter múltiplos canais", e o UNIQUE é por `(tenant, type, external_id)`).

## §1. Contrato novo do gateway

1. **`baileys.ts` / `agent/core.ts`** — o inbound passa a carregar DOIS identificadores distintos:
   - `bot_line_external_id`: número E.164 da linha conectada (derivado de `sock.user.id`, normalizado pelo mesmo caminho que já trata `@lid` — ver PR #489). É o argumento de `resolveChannel`.
   - `sender_external_id`: telefone do remetente — continua alimentando identidade/pessoa como hoje; **deixa de ser usado para resolução de canal**.
2. **`resolveChannel`** — a ordem de resolução vira:
   1. Exact match `(channel_type, bot_line_external_id)` ativo → triplete real (já implementado; passa a CASAR).
   2. Miss + flag `MAIA_STRICT_CHANNEL_ROUTING=false` (default durante canary) → catch-all atual (`findPrimaryCatchAllChannel`, com o discriminador GLOBAL do #417 intacto).
   3. Miss + flag ON → fail-loud `channel_resolution_failed` (mesma assinatura de auditoria do #268).
3. **Ambiguidade** (2+ ativos cross-tenant para a mesma linha) — continua `throw` propagado do repo, sem mudança.

## §2. Migração do canal semeado

O seed 035 criou `external_id='default-channel'` — um placeholder que nunca casa. Migração `NNN_channel_bot_line_backfill`:

- **No pareamento** (`src/setup/`, evento `connection.update` do Baileys): ao conectar, upsert do canal da linha: `external_id := <número da linha>`, `channel_type='whatsapp'`, apontando para `(primary, primary)` se não existir canal para essa linha. O pareamento é o único momento em que a linha é conhecida com certeza.
- O canal `default-channel` NÃO é apagado pela migração (é o catch-all do modo compat); a remoção acontece na fase 3 do rollout (§4).
- `_down`: reverte apenas a coluna de metadados adicionada (se houver); não apaga canais criados por pareamento.

## §3. Invariantes (stop conditions)

1. **Zero regressão do #268/#417**: o discriminador global multi-tenant e o fail-loud permanecem; `npm run test:leak` é gate obrigatório.
2. **Fail-closed**: linha desconhecida em deployment multi-tenant → throw + DLQ, nunca fallback.
3. **Auditoria**: toda resolução via catch-all durante o canary loga `channel_resolver.legacy_catch_all` com a linha real — é o sinal de shadow para medir prontidão.
4. **Uma linha, um agente**: rejeitar (CONFLICT) a criação via UI de um segundo canal ativo com a mesma `(type, external_id)` já é garantido pelo UNIQUE; a UI de #491 já mapeia 23505 → CONFLICT.

## §4. Rollout (3 fases)

1. **Shadow** (flag off): gateway passa a linha do bot em paralelo; resolver loga o que TERIA resolvido por exact match vs. o catch-all usado. Zero mudança de comportamento; coleta divergências por 1 semana.
2. **Exact-first** (flag off ainda): exact match ativado como caminho primário (passo 1 do §1); catch-all continua cobrindo misses. Comportamento único visível: linhas registradas roteiam para o agente certo.
3. **Strict** (flag `MAIA_STRICT_CHANNEL_ROUTING=true`): catch-all desligado; canal `default-channel` desativado. Pré-condição: 7 dias sem `legacy_catch_all` nos logs.

## §5. Testes

- Unit: resolver com linha registrada / linha desconhecida / flag on/off / ambiguidade.
- Integração: pareamento upserta canal da linha; dois tenants com linhas distintas roteiam isolados (leak suite).
- E2E (playground não cobre gateway): teste de integração do `baileys.ts` com evento sintético carregando `bot_line_external_id`.

## §6. Riscos e alternativas descartadas

- **Risco:** número da linha em formato `@lid`/JID não-E.164 — mitigado reusando a normalização do PR #489; divergências aparecem na fase shadow.
- **Descartado — rotear pelo remetente:** exigiria uma row de canal por interlocutor (explosão de cardinalidade) e quebraria a semântica documentada do schema.
- **Descartado — agent-selector no inbound:** seleção de agente por conteúdo é camada de decisão (custo LLM no hot path do gateway) e não resolve isolamento multi-tenant; papel disso é do `channel_policies`/role selector DEPOIS do triplete resolvido.
