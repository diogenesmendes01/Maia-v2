# Maia — Playground de Conversa (Testar Agente no Console) — Design Spec

**Date:** 2026-06-10
**Status:** v1 implementada (2026-06-10) — escopo conservador: tools NÃO são vinculadas à chamada LLM (deny-all estrito; o agente descreve a ação que tomaria). O contrato `sandbox_behavior: 'mock'|'deny'` por tool (§2) é a v1.1 planejada. Implementação: migração 087, `src/db/repositories/playground-repos.ts` (Postgres-as-queue, SKIP LOCKED), `src/agent/playground-turn.ts` (executor + audit `playground_turn`), `src/workers/playground-turn-worker.ts` (drain ~50s/tick), router `playground` no admin-ui e aba "Testar" em `/agents/[agentId]`. Decisão de transporte: Postgres-as-queue em vez de BullMQ — o admin-ui não tem cliente Redis; o padrão espelha `message-recovery`/`outbox_drain`.
**Master refs:** visão em `2026-06-10-learnable-workforce-vision.md` § 2.4; `ARCHITECTURE.md` invariantes 1–5; `docs/architecture/concerns/action-layer.md`
**Architecture Locks:** tenant isolation, fail-closed, LLM-propõe/backend-decide, audit total — inalterados.

---

## 0. Purpose

Hoje a única forma de testar um agente é mensagem real no WhatsApp. O playground permite, no console (`/agents/[agentId]`, aba "Testar"), conversar com o agente — inclusive com uma **versão proposta** do perfil — antes de aprovar. Transforma o ciclo "aprova e reza" em "testa → ajusta → aprova".

## 1. Restrição estrutural

O admin-ui fala só com o Postgres (Drizzle direto); o runtime do agente vive no processo Fastify. O playground exige uma ponte. **Decisão: fila BullMQ dedicada** (`playground_turns`), não HTTP direto — reusa a infraestrutura existente, herda retry/backoff, e evita expor o runtime na rede do admin-ui.

```
Console (aba Testar)
  └─ tRPC playground.sendTurn  → INSERT playground_sessions/turns + enqueue
        └─ worker playgroundTurnWorker (processo runtime)
              └─ pipeline de turno em MODO SANDBOX
        └─ tRPC playground.getTurn (poll) ← resultado persistido
```

## 2. Modo sandbox — contrato

| Dimensão | Produção | Sandbox |
|---|---|---|
| Tools de leitura | executam | executam |
| Tools de efeito colateral | executam | **bloqueadas** — retornam mock declarado no contrato da tool (`sandbox_behavior: 'mock' \| 'deny'`); default fail-closed `deny` |
| Memória working/episódica | grava | **não grava** (namespace `playground:` em Redis, TTL 1h; Postgres não é tocado) |
| Reflexão/aprendizado pós-turno | roda | **não roda** (cognitive graph pós-turno desabilitado) |
| Self-model / drift | alimenta | **não alimenta** |
| Audit | `audit_logs` | `audit_logs` com `action='playground_turn'` (auditado, mas marcado) |
| Outbox/WhatsApp | envia | **nunca enfileira** |

Invariantes: contexto `tenant_id + agent_id` obrigatório em toda a cadeia (fail-closed); `profile_version_id` opcional — quando informado e `status='proposed'`, o prompt-builder usa o body proposto **sem ativá-lo**.

## 3. Schema (migração nova, `_up`/`_down`)

```sql
playground_sessions (
  id uuid PK, tenant_id text NOT NULL, agent_id text NOT NULL,
  profile_version_id uuid NULL,     -- NULL = perfil ativo
  created_by text NOT NULL,         -- app_user
  created_at timestamptz, expires_at timestamptz  -- TTL 24h
)
playground_turns (
  id uuid PK, session_id uuid FK, role text CHECK (user|agent),
  content text, decision_meta jsonb,  -- intents, tools propostas/bloqueadas, confiança
  status text CHECK (queued|running|done|error), created_at timestamptz
)
```

Índices por `(tenant_id, agent_id)`. Limpeza por worker cron (TTL).

## 4. Superfície tRPC (admin-ui)

- `playground.createSession({ tenantId, agentId, profileVersionId? })` — owner/founder; valida agente do tenant; valida versão pertence ao agente.
- `playground.sendTurn({ sessionId, message })` — insere turno `queued` + enfileira.
- `playground.listTurns({ sessionId })` — poll (2s) até `done|error`.

## 5. UI (aba "Testar" em `/agents/[agentId]`)

- Seletor "Conversar com": **Perfil ativo (vN)** | **Proposta vM** (lista de `getProfileVersions().proposed`).
- Chat com bolhas; cada resposta do agente expande "ver decisão" (intents, tools que TENTOU usar e foram bloqueadas pelo sandbox — isso é ouro para o owner entender o comportamento).
- Banner permanente: "Ambiente de teste — nada aqui afeta clientes, memória ou aprendizado."
- Atalho na aba Versões: "Testar esta proposta" abre o playground já apontando para a versão.

## 6. Métricas de aceite

- Turno sandbox nunca gera linha em outbox, memória episódica ou learned_*.
- Tool de efeito colateral bloqueada aparece em `decision_meta` com motivo.
- Testar proposta não muda `status` da versão.
- `test:leak` estendido: sessão de playground do tenant A invisível ao tenant B.

## 7. Fora de escopo (v1)

Replay de conversas reais no playground; comparação lado a lado ativa×proposta na mesma tela (vem com o modo shadow); playground multi-turno persistido além do TTL; anexos de mídia.

## 8. Estimativa

Backend (migração + workers + sandbox gates no decision engine/tool runner): ~1 semana. tRPC + UI: ~2-3 dias. Total: ~2 semanas com testes.
