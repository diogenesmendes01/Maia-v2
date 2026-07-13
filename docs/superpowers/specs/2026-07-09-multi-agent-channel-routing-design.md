# Multi-Agent Channel Routing — Design Spec

**Date:** 2026-07-09 (revisado 2026-07-13)
**Status:** Draft v2 — incorpora o review de design de 2026-07-13 (2 bloqueantes + 2 altos). Mudanças vs. v1: §1.5 gerenciador multi-sessão + outbound por linha (bloqueante 1), §2 ownership verificado no pareamento + unicidade global parcial (bloqueante 2), modo tri-state `shadow | exact_first | strict` (alto 1), staging durável de inbound como pré-condição do strict (alto 2).
**Scope:** Substituir o catch-all `primary/primary` do resolver de canal (issue #411) por resolução exata pela **linha do bot**, E habilitar operação real com múltiplas linhas (gerenciador multi-sessão + outbound pela linha correta), permitindo que agentes não-primary criados pela UI recebam e respondam tráfego real de WhatsApp.

**Referências:**
- `src/gateway/channel-resolver.ts` — política de resolução atual (exact match → catch-all single-tenant → fail-loud) e os fixes #268 (fail-loud), #411 (catch-all) e #417 (discriminador global + TOCTOU).
- `src/gateway/baileys.ts` — socket ÚNICO global, `BAILEYS_AUTH_DIR` único, outbound via socket global, e o catch da falha de resolução que audita e DESCARTA o inbound (review v2: linhas ~33/~208/~494/~849).
- `src/db/repositories/channel-repos.ts` — `findByExternalCrossTenant` (retorna ambiguidade cross-tenant como erro em runtime) e `findPrimaryCatchAllChannel`.
- `migrations/031_p6_channels.sql` — UNIQUE atual é `(tenant_id, channel_type, external_id)` — **por tenant**, não global.
- `docs/architecture/concerns/tenant-isolation.md`; PR #491 (CRUD de canais na UI).

**Architecture Locks tocados:** nenhum diretamente, mas o caminho é o **entry point de tenant-resolution** — toda mudança exige `npm run test:leak` verde e revisão adversarial (histórico: um fix CRITICAL e um HIGH no PR #417).

**Depends on:** #491 (UI de canais — mesclado). **Blocks:** operação multi-agente e multi-tenant real por WhatsApp.

---

## §0. Purpose

O problema em uma frase: **um canal WhatsApp representa a LINHA DO BOT, mas o gateway passa o telefone do REMETENTE como `external_id`** — o exact match nunca casa e todo inbound cai no catch-all `primary/primary` (#411). E, como o review v1→v2 apontou, corrigir só o lookup não basta: **o runtime é mono-linha por construção** (um socket, um auth dir, outbound global), então "multi-agente = múltiplas linhas" exige também o plano de operação multi-sessão.

Este spec entrega as duas metades:

1. **Resolução** — o `external_id` do lookup passa a ser a linha em que a mensagem chegou (§1.1–1.4).
2. **Operação** — um gerenciador de sessões torna possível manter N linhas conectadas e responder cada conversa pela linha correta (§1.5).

Não-objetivo (mantido da v1): rotear múltiplos agentes numa MESMA linha — isso é seleção de papel (`channel_policies`/role selector) DEPOIS do triplete resolvido.

## §1. Design

### §1.1 Contrato do inbound

`baileys.ts` / `agent/core.ts` — o inbound passa a carregar dois identificadores distintos:
- `bot_line_external_id`: número E.164 da linha conectada (derivado de `sock.user.id` DA SESSÃO que recebeu o evento, normalizado pelo caminho do PR #489). Argumento de `resolveChannel`.
- `sender_external_id`: telefone do remetente — continua alimentando identidade/pessoa; deixa de ser usado para resolução de canal.

### §1.2 Modos de resolução (tri-state — review v2, alto 1)

`MAIA_CHANNEL_ROUTING_MODE = 'shadow' | 'exact_first' | 'strict'` (default `shadow`). Um único enum — a v1 usava uma flag booleana que não distinguia shadow de exact-first (as fases 1 e 2 tinham a MESMA configuração, logo shadow não garantia "zero mudança de comportamento").

- **`shadow`**: a resolução EFETIVA é o caminho legado atual (exact match que nunca casa → catch-all). Em paralelo, o resolver COMPUTA o exact match pela linha e loga `channel_resolver.shadow_divergence` quando o resultado difere do efetivo. Zero mudança de comportamento, por construção.
- **`exact_first`**: exact match pela linha é o caminho primário; miss cai no catch-all legado (com o discriminador global do #417 intacto). Linhas registradas roteiam certo; o resto se comporta como hoje.
- **`strict`**: miss ⇒ inbound vai para o staging durável (§1.4) e a resolução falha tipada. Catch-all desligado.

### §1.3 Ambiguidade

2+ canais ativos cross-tenant para a mesma linha continuam `throw` — mas com a unicidade global do §2 isso se torna estado impossível de CRIAR, restando apenas como defesa contra dados legados.

### §1.4 Destino do miss em strict (review v2, alto 2)

Estado atual documentado: a resolução acontece ANTES de qualquer persistência; `baileys.ts` captura a falha, audita `channel_resolution_failed` e **descarta o inbound** — não há DLQ nesse ponto (o retry/DLQ do BullMQ só existe depois que a mensagem entra na fila, o que requer o triplete). Um strict mal configurado perderia mensagens de forma irrecuperável.

Decisão: **strict só liga depois do staging durável de inbound**. Novo passo no `baileys.ts`: o envelope bruto (linha, remetente, payload, timestamps) é gravado numa fila BullMQ `inbound:unrouted` ANTES do throw quando a resolução falha em strict. Worker `unrouted-inbound-drain` re-tenta a resolução (ex.: o operador acabou de registrar/parear a linha) com backoff; esgotado ⇒ DLQ padrão com alerta. Trade-off aceito: o staging guarda payload de mensagem fora do escopo de um tenant resolvido — o registro é cifrado em repouso pelo mesmo mecanismo do Redis atual e tem TTL curto (72h), documentado em `governance-observability`.

Nos modos `shadow`/`exact_first` nada muda: o catch-all absorve o miss como hoje.

### §1.5 Gerenciador multi-sessão e outbound por linha (review v2, bloqueante 1)

O runtime hoje: UM socket Baileys global, UM `BAILEYS_AUTH_DIR`, outbound global. Para operar N linhas:

- **`LineSessionManager`** (`src/gateway/line-session-manager.ts`): mapa `line_external_id → BaileysSession`, onde cada sessão encapsula socket + auth state + reconexão/recovery (o `recovery.ts` atual vira per-sessão). Auth state por linha em `BAILEYS_AUTH_DIR/<line_external_id>/` (a migração move o diretório atual para o subdiretório da linha primária no primeiro boot — reversível).
- **Origem das sessões**: o manager sobe uma sessão para cada canal `whatsapp` ATIVO e VERIFICADO (§2). Pareamento de linha nova acontece pela superfície `/setup` atual, parametrizada por linha (a tela lista linhas registradas e o estado de cada sessão: unpaired/pairing/connected/recovering).
- **Inbound**: cada sessão injeta `bot_line_external_id` próprio (§1.1) — nenhuma afinidade extra é necessária na entrada.
- **Outbound pela linha correta**: o outbox já é a fronteira transacional de saída; a linha é derivável do canal da conversa (triplete resolvido na entrada carrega `channel_id`). Mudança: o registro de outbox passa a carregar `channel_id` (migração append-only; backfill = canal primário), e o drain worker resolve `channel_id → line → sessão` no manager. Sessão da linha indisponível ⇒ o job espera/retry (semântica atual de outbox), NUNCA sai por outra linha (fail-closed: responder pela linha errada vaza contexto entre linhas).
- **Isolamento de falha**: queda de uma sessão não derruba as outras; métricas e alertas por linha (`gateway.line.<line>.state`).
- **Topologia**: v1 do manager é in-process (single node, N sockets). Processo-por-linha fica explicitamente como evolução se o número de linhas ou o isolamento operacional exigirem — a interface do manager (resolver sessão por linha) é o ponto de corte para essa mudança não vazar para o resto do código.

## §2. Ownership da linha: declarado vs. verificado (review v2, bloqueante 2)

Dois buracos na v1: (a) o UNIQUE de canais é POR TENANT — dois tenants podiam manter a mesma linha ativa, e a ambiguidade só aparecia em runtime derrubando tráfego; (b) a UI do #491 permite declarar qualquer número sem prova de controle.

Modelo novo — **canal declarado ≠ canal verificado**:

1. **Criar canal pela UI** (`createChannel`) registra a linha como **declarada**: `active=false`, `metadata.verification='declared'`. Canal declarado não roteia nem sobe sessão.
2. **Pareamento verifica ownership**: ao conectar a sessão da linha (QR/código na superfície `/setup` da linha), o gateway compara o número REAL do `sock.user.id` com o `external_id` declarado; casou ⇒ `active=true`, `metadata.verification='paired'` (+ timestamp e auditoria). É a prova de posse: só quem controla o aparelho/linha completa o pareamento.
3. **Unicidade GLOBAL de linha ativa** — migração append-only:
   `CREATE UNIQUE INDEX channels_active_line_uq ON channels(channel_type, external_id) WHERE active;`
   Dois tenants não conseguem mais ATIVAR a mesma linha — o conflito vira 23505 no momento da verificação (mapeado para erro de pareamento "linha já pertence a outro workspace"), não um drop de tráfego em runtime. Pré-migração: query de auditoria detecta duplicatas ativas existentes; runbook decide qual desativar ANTES de aplicar o índice (a migração falha se houver duplicata — fail-closed, não escolhe sozinha).
4. `findByExternalCrossTenant` mantém a defesa de ambiguidade como invariante de runtime (dados legados/anômalos), mas com o índice ela se torna inatingível por escrita nova.

Impacto no #491 (já mesclado): `createChannel` passa a criar `active=false` para `channel_type='whatsapp'`; o badge da tela de canais ganha o estado "aguardando pareamento". Tipos não-WhatsApp (sem sessão) mantêm o comportamento atual até terem verificação própria.

## §3. Invariantes (stop conditions)

1. **Zero regressão do #268/#417**: discriminador global multi-tenant e fail-loud permanecem; `npm run test:leak` é gate obrigatório em todo PR da série.
2. **Fail-closed**: linha desconhecida em `strict` ⇒ staging + falha tipada, nunca fallback; outbound NUNCA sai por linha diferente da do canal da conversa.
3. **Ownership verificado**: nenhum canal WhatsApp roteia sem pareamento confirmado; unicidade global de linha ativa garantida no DB, não em runtime.
4. **Auditoria**: `shadow_divergence`, `legacy_catch_all` (em exact_first), verificação de pareamento e cada transição de estado de sessão são logados/auditados.

## §4. Rollout

0. **Multi-sessão atrás de flag** (`MAIA_MULTI_LINE=false` default): manager entra no código com a linha primária como única sessão — paridade comportamental total; migrações de outbox (`channel_id`) e do índice global aplicadas (com runbook de duplicatas antes).
1. **`shadow`** (default): coleta `shadow_divergence` por ≥1 semana; zero mudança de comportamento por construção (§1.2).
2. **`exact_first`**: linhas verificadas roteiam exato; catch-all cobre o resto. `MAIA_MULTI_LINE=true` habilita parear linhas adicionais.
3. **`strict`**: pré-condições: staging `inbound:unrouted` operante + 7 dias sem `legacy_catch_all`. Catch-all e canal `default-channel` desativados.

## §5. Testes

- Unit: resolver nos 3 modos; divergência de shadow; ambiguidade; normalização da linha (`@lid`).
- Integração: pareamento verifica ownership (número real ≠ declarado ⇒ recusa); índice global rejeita segunda ativação cross-tenant (23505 → erro tipado); outbox drena pela sessão da linha do canal; leak suite.
- Integração (staging): miss em strict grava `inbound:unrouted`; drain re-resolve após registro da linha.
- E2E gateway: dois eventos sintéticos em linhas distintas → agentes distintos, respostas pelas linhas de origem.

## §6. Riscos e alternativas descartadas

- **Risco:** N sockets num processo (memória/CPU por sessão Baileys) — mitigado pelo corte limpo do manager (§1.5 topologia) que permite migrar para processo-por-linha sem tocar resolução/outbox.
- **Risco:** staging de inbound não-resolvido guarda payload fora de tenant — TTL 72h + cifragem + acesso restrito ao worker; documentado como exceção consciente em `governance-observability`.
- **Descartado — rotear pelo remetente** e **agent-selector no inbound** (v1, mantidos): cardinalidade explosiva / custo LLM no hot path e não resolvem isolamento.
- **Descartado — upsert de canal automático no pareamento sem declaração prévia**: manteria a UI fora do loop e criaria canais "fantasma" sem intenção do operador; o modelo declarado→verificado mantém a intenção (UI) e a prova (pareamento) separadas e auditáveis.
