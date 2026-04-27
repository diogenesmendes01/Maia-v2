# Contribuindo para Lia

Projeto pessoal de Diógenes Mendes — uso interno por enquanto.

## Convenções

### Commits
Seguimos [Conventional Commits](https://www.conventionalcommits.org/pt-br/v1.0.0/):

- `feat:` — nova funcionalidade
- `fix:` — correção de bug
- `docs:` — apenas documentação
- `refactor:` — refatoração sem mudança de comportamento
- `test:` — adiciona/ajusta testes
- `chore:` — tarefas de manutenção
- `db:` — migrations e mudanças de schema

Exemplos:
```
feat(agent): add tool register-transaction
fix(gateway): handle disconnect retry
db(migration): add learned_rules table
```

### Branches
- `main` — produção/estável
- `develop` — integração
- `feat/*`, `fix/*`, `chore/*` — trabalho em progresso

### Code style
- TypeScript strict mode (sem `any` solto)
- ESLint + Prettier
- Schemas Zod para qualquer entrada externa
- Toda query no banco passa por `entidade_id` (separação rígida)
