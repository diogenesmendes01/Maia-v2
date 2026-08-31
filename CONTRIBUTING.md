# Contribuindo para Maia

Projeto pessoal de Diógenes Mendes — uso interno por enquanto.

## Toolchain (Node + npm fixos)

O CI valida com `npm ci`, que falha se o `package-lock.json` não bater com o npm
que o gerou. Em #312 um lockfile gerado localmente com npm 11 quebrou o CI (que
rodava npm 10): a forma do bloco `esbuild` divergia. Para isso nunca mais
acontecer, **a versão do Node e do npm é fixada e tem uma única fonte da
verdade**:

- **Node:** `.nvmrc` (`22`) fixa o toolchain **local**. O CI **não** usa
  `node-version-file`: os jobs de `ci.yml` rodam uma matriz
  `node: ['22.18', 26]` e as lanes não-matriciais pinam `node-version: '22.18'`
  explicitamente. Ou seja, local e CI **podem** divergir dentro da linha 22 —
  `.nvmrc` dá o 22.x corrente, o CI dá 22.18 — e a perna 26 cobre de propósito
  o major da imagem de produção. O que impede a divergência de virar bug é o
  piso comum (`engines.node`), não um arquivo compartilhado.
  `tests/unit/scripts/check-node.spec.ts` percorre `.github/workflows/**` e
  reprova qualquer lane da linha 22 sem minor pinado.
- **npm:** `npm@11.5.2`, declarado em `package.json` (`packageManager` +
  `engines`: `node >=22.13.0`, `npm >=11.5.2 <12`). A versão ativa é fixada com
  `npm install -g npm@11.5.2` — **exatamente o que o CI faz**.

  > **Por que o piso do Node é 22.13.0, e não 22.0.0.** Duas restrições se
  > somam, e vale a maior:
  >
  > 1. O `engines` do próprio npm 11.5.2 é `^20.17.0 || >=22.9.0`. Rodando os
  >    binários reais, Node 22.0.0 e 22.8.0 fazem o npm pinado imprimir
  >    `npm warn cli npm v11.5.2 does not support Node.js v22.8.0`.
  > 2. Com `engine-strict=true`, o npm recusa qualquer pacote da árvore fora do
  >    `engines` dele — e o `eslint` deste lockfile pede
  >    `^20.19.0 || ^22.13.0 || >=24`. Medido com `npm ci --dry-run` real:
  >    Node 22.9.0 e 22.12.0 morrem em `EBADENGINE`; Node 22.13.0 instala
  >    (`added 810 packages`).
  >
  > Um piso em `22.0.0` aprovava toolchains em que o `npm ci` deste repo não
  > completa. O piso é derivado do `package-lock.json` por
  > `tests/unit/scripts/check-node.spec.ts`, então um bump de dependência que
  > suba a exigência reprova no teste em vez de no install de alguém.

### O que realmente barra um toolchain errado

Três mecanismos, em ordem de quando o npm os avalia — e vale saber a ordem,
porque ela já foi descrita errado aqui:

1. **`devEngines.runtime` (`package.json`, `onFail: "error"`)** — este é o
   **gate**. O npm o avalia **antes** de escrever `node_modules`; num Node fora
   da faixa o comando morre em `EBADDEVENGINES` e a árvore nem chega a existir
   (vale inclusive para `npm install --package-lock-only`).
2. **`engine-strict=true` (`.npmrc`) + `engines`** — recusa o install com
   `EBADENGINE`. Também roda **antes** dos lifecycle scripts.
3. **`node scripts/check-node.mjs`** — a **mensagem** legível, com instrução de
   conserto. O CI e os Dockerfiles a invocam como passo próprio **antes** do
   `npm ci`; é o que a torna garantida por construção.

> **O `preinstall` não é gate.** Ele encadeia o guard, mas num `npm ci` os
> lifecycle scripts rodam **depois** de a árvore já estar instalada, e com
> `engine-strict` um Node fora de `engines` nem chega a disparar `preinstall`.
> Medido com Node 20.19.5 e npm 11.5.2 reais contra este `package.json`: o
> primeiro (e único) erro é `npm error code EBADENGINE`, e a mensagem do guard
> nunca aparece. Por isso ele é invocado explicitamente, e por isso o gate é o
> `devEngines`.

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
npm run test:admin-ui:e2e           # Playwright, projeto `smoke` (exige console no ar)
npm run test:admin-ui:e2e:ci        # o que o CI roda: `admin:build` -> semeia as
                                    # fixtures -> sobe o console construído ->
                                    # smoke (boot + jornadas) -> derruba
npm run admin:acceptance            # 11 gates (skip-e2e por padrão)
```

O job `admin-ui` do CI é o gate: `next build` e o projeto `smoke` do Playwright
reprovam a PR. Desde a **#623** o `smoke` inclui as JORNADAS autenticadas do
operador (inbox, detalhe de proposta, aprovação simples e dupla, rejeição,
trava de arquitetura, trilha de auditoria, drift, traces e versões). Duas peças
sustentam isso, e nenhuma toca código de produção:

- **sessão** — `tests/admin-ui/e2e/_apoio/sessao.ts` MINTA o cookie de sessão
  com o `encode()` do próprio Auth.js e o `NEXTAUTH_SECRET` do processo. O
  middleware, o `auth()`, o `assertRole` e os gates de papel continuam
  valendo; o que o teste pula é o handshake com o IdP;
- **fixtures** — `scripts/seed-admin-ui-e2e-fixtures.ts` (o `admin-ui-e2e.sh`
  o chama sozinho) semeia usuários por papel, propostas com risco/trava
  DERIVADOS do spec, duas versões de perfil e um trace assinado pelo escritor
  de produção.

Desde a **#623 (segunda parte)** o `smoke` também inclui a jornada de LINHAS de
canal (`channel-lines.spec.ts`): a linha declarada permanece visível com o seu
estado, o papel `viewer` não enxerga a tela (com caso de controle para `owner`,
senão "viewer não vê" ficaria verde também com a rota quebrada) e, sem keyring,
o console declara o pareamento indisponível e DESABILITA o CTA. Esse último é a
premissa da quarentena virada asserção: no dia em que o runtime subir no job,
ele fica vermelho e obriga a revisitar o que continua marcado.

Fora do gate sobrou uma spec, `channel-lines-pairing.spec.ts`, marcada
`@pendente-runtime` — e apenas os **quatro casos que precisam de um segundo
processo**: o QR e o código de pareamento são produzidos pelo worker
`channel_pairing` do RUNTIME, e este job sobe só o console. Cada um traz o
motivo DELE no cabeçalho do arquivo, numa linha `FORA DO GATE: <título do
test>`; "o arquivo depende do runtime" não vale mais como motivo coletivo, e foi
esse denominador comum que manteve dois casos de listagem fora do gate. Três
travas em `tests/unit/ci/admin-ui-e2e-gate.spec.ts` seguram a contabilidade: a
lista de ARQUIVOS em quarentena, a contagem de CASOS dela e a conferência de que
cada título tem justificativa — entrar ou sair é sempre um diff que alguém lê.

```bash
npm run test:admin-ui:e2e:pendentes # roda a quarentena (vermelha sem um runtime no ar)
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

