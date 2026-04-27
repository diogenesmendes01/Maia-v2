# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Unreleased]

### Próxima entrega
- Gateway Baileys funcional
- Loop do agente com tool use (ReAct)
- 5 ferramentas iniciais
- Memória episódica + semântica + procedural
- Smoke test ponta a ponta

## [0.1.1] - 2026-04-27

### Changed
- Rename do projeto: `Lia` → `Maia` (todos os arquivos, env vars, container names, volumes Docker, package name)
- `src/identity/lia-prompt.md` → `src/identity/maia-prompt.md`
- Repo no GitHub: https://github.com/diogenesmendes01/Maia

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
