# Contribuindo para Maia

Projeto pessoal de Diógenes Mendes — uso interno por enquanto.

## Toolchain (Node + npm fixos)

O CI valida com `npm ci`, que falha se o `package-lock.json` não bater com o npm
que o gerou. Em #312 um lockfile gerado localmente com npm 11 quebrou o CI (que
rodava npm 10): a forma do bloco `esbuild` divergia. Para isso nunca mais
acontecer, **a versão do Node e do npm é fixada e tem uma única fonte da
verdade**:

- **Node:** `.nvmrc` (`22`). O CI usa `node-version-file: '.nvmrc'`, então
  local e CI nunca divergem.
- **npm:** `npm@11.5.2`, declarado em `package.json` (`packageManager` +
  `engines`: `node >=22.0.0`, `npm >=11.5.2 <12`). A versão ativa é fixada com
  `npm install -g npm@11.5.2` — **exatamente o que o CI faz**. O `.npmrc`
  (`engine-strict=true`) e o script `preinstall` recusam o install se o npm
  ativo estiver fora dessa faixa, então o pin é obrigatório, não só sugestão.

### Setup (uma vez)

```bash
nvm install            # lê .nvmrc → Node 22
nvm use                # ativa Node 22
npm install -g npm@11.5.2
npm --version          # deve imprimir 11.5.2
```

> **Por que não `corepack enable`?** Tentamos, e o histórico de CI deste pin
> (#314) provou que `corepack enable` **não** trocou o npm ativo no runner — ele
> continuou usando o npm 10.x que vem com o Node. Por isso tanto o CI quanto este
> guia usam `npm install -g npm@11.5.2`, que coloca a versão certa no PATH de
> forma confiável.

### Regra do lockfile

> **Toda mudança em `package-lock.json` DEVE ser feita com o toolchain fixado
> (Node 22 + npm 11.5.2).** Não regenere o lockfile com outra versão de npm — a
> forma dos blocos de dependência muda entre majors de npm e o `npm ci` do CI
> vai rejeitar. Confirme com `node --version` (v22.x) e `npm --version`
> (11.5.2) antes de rodar `npm install` (o `preinstall` + `engine-strict` já
> barram o npm errado, mas confira mesmo assim). Antes de commitar, valide do
> zero:

```bash
rm -rf node_modules && npm ci   # tem de passar — é exatamente o que o CI roda
```

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

## Admin UI (P8.5)

O admin-ui é uma aplicação Next.js 14 colocada em `src/admin-ui/`. Convive com
o backend Fastify (em `src/`) no mesmo repositório, mas usa seu próprio
`package.json` e `tsconfig.json` para isolar dependências React/Next/tRPC.

### Setup inicial

```bash
# Instalar deps do admin-ui (separadas do root para isolamento)
npm run admin:install

# Aplicar migrations P8.5 (038-041)
npm run db:migrate

# (Opcional) seed fixtures de teste
npx tsx scripts/seed-proposals-fixtures.ts
```

### Desenvolvimento

```bash
# Sobe Fastify (:3000) + Next.js (:4000) em paralelo
npm run admin:dev

# Abrir http://localhost:4000/inbox
```

### Testes

```bash
npm run test:admin-ui:unit          # Vitest (58+ testes)
npm run test:admin-ui:e2e           # Playwright (requer dev server up)
npm run admin:acceptance            # 11 gates (skip-e2e por padrão)
```

### Feature flags

Configure em `src/admin-ui/.env.local` (copie de `.env.example`):

```bash
FEATURE_ADMIN_UI_V1=true             # libera o app
FEATURE_ADMIN_UI_DEBUG_SNAPSHOTS=false  # libera /traces/[id] full-snapshot grants
FEATURE_ADMIN_UI_BULK_REJECT=true    # libera bulk-reject (risk=low only)
FEATURE_ADMIN_UI_REDECIDE=false      # libera re-decide (v1.1)
```

### Arquitetura

- **5 telas:** Proposal Inbox → Diff & Approval → Version History →
  Drift & Incidents → Audit & Trace Explorer
- **14 classes de aprovação:** dual approval para hard_limit, soul_core,
  dangerous_tool, identity_drift_correction (ver `lib/approval-matrix.ts`)
- **Architecture Lock:** banner + role=founder gate em proposals locked
- **Audit append-only:** `admin_audit_log` (migration 047); repo expõe
  apenas `append` + `list`
- **Migrations P8.5:** 045 (app_users/sessions), 046 (proposal_approvals),
  047 (admin_audit_log), 048 (debug_snapshot_grants), 049 (proposal_approvals user UQ)
- **Dependências futuras:** P8a-e (policy_rules, soul_biases, skills,
  knowledge_pending_review) — repo `proposalsUnified` faz lookup em
  `information_schema` e degrada graciosamente se tabelas ainda não existem

