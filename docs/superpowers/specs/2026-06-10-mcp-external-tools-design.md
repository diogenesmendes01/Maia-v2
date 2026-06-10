# Maia — Tools Externas via MCP (ERP First-Party) — Design Spec

**Date:** 2026-06-10
**Status:** v1 implementada (2026-06-10) — migração 089 (`mcp_servers` + `mcp_server_tools`), `src/lib/mcp-client.ts` (SDK, conexões efêmeras, timeout 15s, secret via env ref), `src/tools/mcp-bridge.ts` (visibilidade + execução com todas as guardas, cap 32KB, audit `mcp_tool_call`), costuras no hot path (append em `core.ts`, branch pré-REGISTRY no dispatcher) atrás da flag `FEATURE_MCP_TOOLS` (default OFF), worker `mcp_sync` (test/sync por flags), router `mcp` e tela `/setup/mcp` (conectar/ver/decidir/regular por agente). Validação de input v1 é estrutural (required top-level) — ajv completo, writes (`confirm_before_write_policy`) e integração com o Inbox unificado são v2.
**Master refs:** visão `2026-06-10-learnable-workforce-vision.md` §2.3 (Braços); `docs/architecture/concerns/capability-taxonomy.md`; `docs/architecture/concerns/action-layer.md`; sistema de grants/packs (#408/#474)
**Architecture Locks:** todos os 6 invariantes. **MCP é um TRANSPORTE novo de tools — nunca um atalho em volta da governança.** Nenhuma tool MCP executa fora do dispatcher.

---

## 0. Purpose

O bloco "Braços" do blueprint listava conectores a construir um a um. MCP inverte: o owner constrói **um servidor MCP first-party na frente do seu ERP**, e os agentes ganham acesso governado às operações do negócio (pedidos, faturas, clientes, estoque). Cada profissão fica viável de uma vez; o "pedido de ferramenta" (#471) passa a ter resposta barata ("expor mais uma tool no MCP do ERP").

## 1. Modelo de confiança

- **v1 assume server first-party** (construído pelo próprio tenant). Ainda assim: defesa em profundidade — descrições e resultados de tools MCP são **conteúdo não-confiável** no prompt (injeção via dados do ERP é possível mesmo em server próprio: um nome de cliente pode conter texto adversarial).
- Credenciais NUNCA em plaintext no banco: referência a secret (env var no runtime; `MCP_SERVER_<NAME>_TOKEN`).
- Rede: somente o processo runtime fala com o server MCP; o admin-ui continua Postgres-only.

## 2. Lado Maia (cliente) — pipeline de governança

```
Registrar server (owner/founder, auditado)
  └─ Descobrir tools (listTools) → cada tool vira CAPABILITY PROPOSAL
       └─ Owner aprova tool a tool (classe de risco default: critical)
            └─ Tool aprovada entra no registry como `mcp:<server>:<tool>`
                 dentro do pack `mcp.<server>` (grant por agente — #474)
                      └─ Execução SEMPRE via dispatcher: grant check, deny
                         hard, policies, timeout, cap de resultado, audit
```

1. **Migração**: tabela `mcp_servers` (`tenant_id`, `name` slug, `url`, `transport` (`streamable_http`), `auth_secret_ref`, `status` (`active|disabled`), `created_by`, timestamps; unique `(tenant_id, name)`).
2. **Cliente**: `@modelcontextprotocol/sdk` (dependência nova) embrulhado em `src/lib/mcp-client.ts` — connect/listTools/callTool com timeout (15s) e retry limitado; nunca no hot path sem grant.
3. **Descoberta → proposta**: worker/ação de console "sincronizar tools" cria `capability_proposals` (tipo novo `mcp_tool`) para tools ainda não aprovadas; mudança de schema em tool já aprovada gera NOVA proposta (re-aprovação) e suspende a tool até decisão — fail-closed.
4. **Bridge no registry**: tool aprovada vira entrada dinâmica `mcp:<server>:<tool>`; input validado contra o JSON Schema do server (ajv ou conversão p/ Zod); writes exigem `idempotency_key` (ver §3). `sandbox_behavior: 'deny'` sempre (playground nunca executa MCP).
5. **Execução**: branch MCP no `dispatchTool` — mesmas guardas de `tool_not_granted`, policies e audit (`action='mcp_tool_call'` com server, tool, duração, bytes); resultado truncado a um cap (32KB) e marcado como conteúdo externo no prompt.
6. **Estado por tool** (tabela `mcp_server_tools`): `tenant_id`, `server_id`, `tool_name`, `schema` jsonb + `schema_hash`, `status` (`discovered → proposed → approved | suspended | rejected`), `risk_class`, `proposal_id`. É a fonte do console ("ver") e do fail-closed: sync que detecta hash diferente em tool aprovada ⇒ `suspended` + nova proposta.
7. **Ponte admin-ui→runtime**: o admin-ui é Postgres-only (mesma restrição do playground) — "testar conexão" e "sincronizar tools" são operações ENFILEIRADAS (Postgres-as-queue) que o runtime executa e grava o resultado; o console faz poll.
8. **Console (3 superfícies)**:
   - **Conectar** — `/setup/mcp` "Conexões MCP" (Plataforma): lista de servers (status, última sync, contagem de tools por estado), registrar (nome, URL, secret REF), testar conexão, sincronizar.
   - **Ver** — detalhe do server: tabela de tools (nome, risco, status, schema resumido, link à proposta), ação "enviar para aprovação" → aprovação no Inbox existente (proposta `mcp_tool` com diff de schema).
   - **Regular por agente** — card "Capacidades da função" (#474) lista packs `mcp.<server>` com conceder/revogar. DECISÃO: esta é a primeira superfície de EDIÇÃO de grant (hoje grants só nascem na criação); owner/founder, audit direto (padrão channel policies), v1 sem dual-approval — revisitar quando writes chegarem (v2).
   - **Observar** — chamadas em `/audit` (`mcp_tool_call`) e na aba Atividade do agente.
9. **Seam no grant-math**: packs hoje são estáticos em código (`TOOL_PACKS`); o pack `mcp.<server>` é DINÂMICO (resolvido das rows `approved` de `mcp_server_tools`). O resolver de visibilidade/dispatcher ganha um provider de packs dinâmicos — mantendo fail-closed (server `disabled` ⇒ pack resolve vazio).

## 3. Lado ERP (servidor) — contrato que o owner constrói

Guia para o server MCP do ERP encaixar limpo na governança:

| Regra | Por quê |
|---|---|
| **Nomes verbo_objeto**: `erp_listar_pedidos`, `erp_consultar_fatura`, `erp_criar_pedido` | viram nomes de tool no registry; previsibilidade = policy fácil |
| **Reads e writes separados** — nunca uma tool que "consulta ou cria" | classe de risco por tool; reads aprovam rápido, writes exigem mais |
| **Writes aceitam `idempotency_key` (string) e são idempotentes nela** | o dispatcher da Maia já trabalha com contratos idempotentes; retry seguro |
| **JSON Schema completo e descritivo** em inputs/outputs (required, enums, formatos) | validação fail-closed no bridge; descrição vira documentação no console |
| **Paginação obrigatória em listas** (`limit` máx. 50 + cursor) | cap de resultado; o prompt não engole o ERP inteiro |
| **Sem efeitos colaterais em reads** (nem "marcar como visto") | read = risco baixo de verdade |
| **Auth por bearer token dedicado à Maia, rotacionável** | revogação independente; secret ref no runtime |
| **Erros estruturados** (`code`, `message` curto) — nunca stack traces | mensagens de erro entram no prompt; vazamento mínimo |
| **Versionamento**: mudou schema de tool → mude o nome (`_v2`) | mudança silenciosa de contrato suspende a tool na Maia (§2.3) |

**Primeiras tools recomendadas (v1, read-only):** `erp_listar_pedidos`, `erp_consultar_pedido`, `erp_consultar_cliente`, `erp_listar_faturas_abertas`, `erp_consultar_estoque`.
**Depois (v2, write com confirmação):** `erp_criar_pedido`, `erp_atualizar_status_pedido` — sob `confirm_before_write_policy` (precedente da migração 078).

## 4. Entrega faseada

- **v1**: migração + cliente + descoberta→proposta + bridge **somente para tools read-only aprovadas** + tela Conexões MCP + audit. Writes recusados no bridge mesmo se aprovados (flag de fase).
- **v2**: writes com `idempotency_key` + `confirm_before_write_policy`; métricas de uso por tool; multi-server.
- **v3**: servers de terceiros (catálogo público) — exige revisão de threat model própria.

## 5. Invariantes e anti-escopo

1. Tool MCP sem aprovação + grant não existe para o agente (nem visível no prompt).
2. O agente NUNCA registra servers ou aprova tools — só owner/founder (pode *pedir* via #471).
3. Playground: deny sempre. Decision engine e policies aplicam-se inalterados.
4. Anti-escopo v1: OAuth flows por usuário final; streaming de resultados; servers stdio locais; tools MCP chamando outras tools.

## 6. Métricas de aceite (v1)

- Tool não aprovada: invisível ao LLM e recusada no dispatcher (`tool_not_granted`).
- Mudança de schema no server suspende a tool e gera nova proposta.
- Toda chamada audita server/tool/latência/tamanho; `test:leak` cobre `mcp_servers` entre tenants.
- Agente sem o pack `mcp.<server>` não vê as tools mesmo aprovadas no tenant.

## 7. Estimativa

v1: ~2 semanas (cliente+bridge+pack dinâmico 5d, governança/propostas/sync 3d, console 3 telas 3d, testes 3d). Server do ERP: do lado do owner, com o contrato §3 como guia.
