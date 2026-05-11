# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Unreleased]

### Fixed
- **WhatsApp privacy IDs (`@lid`)**: mensagens chegando de contas com
  privacy enabled vinham como `XXXXXXXXXXXXXX@lid` em vez de
  `5511...@s.whatsapp.net`. O código tratava o LID como telefone, o que
  fazia (a) `pessoasRepo.findByPhone` falhar e cair em `unknown`, e (b) a
  resposta da Maia ser enviada para `LID@s.whatsapp.net` — JID inexistente,
  mensagem ia pro vácuo. Fix em três pontos (commit `e94bb46`):
  - `src/gateway/baileys.ts` — quando `remote_jid` termina em `@lid`,
    extrai o telefone real de `msg.key.senderPn` / `participantPn` antes
    de gravar `metadata.telefone`. Fallback para o JID raw mantido com
    log `baileys.lid_without_real_phone` caso o Baileys não exponha o
    campo.
  - `src/agent/output-dispatch.ts` — `sendOutbound` e `sendOutboundPoll`
    agora resolvem o JID de envio via novo `resolveOutboundJid()`, que
    lê `mensagens.metadata.remote_jid` do inbound. Replies sempre saem
    pelo mesmo JID que entraram (preserva thread `@lid`). Mantém o
    fallback antigo (`telefone + @s.whatsapp.net`) para mensagens
    proativas sem `in_reply_to`.
  - `src/agent/core.ts` — o `jid` usado para typing indicator e envio
    de PDF/voz passa pelo mesmo critério (lê do inbound).

### Próxima entrega
- Gateway Baileys funcional
- Loop do agente com tool use (ReAct)
- 5 ferramentas iniciais
- Memória episódica + semântica + procedural
- Smoke test ponta a ponta

## [0.1.0] - 2026-04-27

### Added
- Estrutura inicial do projeto (Node 20 + TypeScript)
- Documentação de arquitetura completa (`docs/arquitetura.md`)
- Schema do banco com 16 tabelas (PostgreSQL 16 + pgvector)
- System prompt da Maia v0 (`src/identity/maia-prompt.md`)
- Template de inventário para preencher (`docs/inventario.md`)
- Docker Compose com Postgres + pgvector + Redis
- Configuração TypeScript strict mode
- `.env.example` documentado
- Licença MIT
