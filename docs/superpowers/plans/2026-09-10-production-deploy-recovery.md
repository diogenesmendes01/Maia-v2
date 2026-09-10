# Task spec — recuperação do deploy de produção da Maia

## Objective

Restaurar o backend da Maia, impedir que o Coolify aceite um rollout sem processo vivo e tornar a imagem de produção do Admin UI novamente construível.

## Background

- O backend do commit `dfd59ab9` construiu, mas recusou o boot por configuração de produção incompleta.
- O healthcheck do recurso estava desativado, então o Coolify removeu o container anterior antes de detectar a queda.
- O Admin UI não tem um deploy bem-sucedido desde 2026-07-28. O erro atual é a ausência de declarações TypeScript de módulos compartilhados durante `next build`.
- Referências: `docs/runbooks/deploy-prod.md`, `docs/admin-ui-deploy.md`, `docs/architecture/modules/config.md`, `docs/architecture/modules/admin-ui.md`.

## Agent role

Implementer e operador.

## Expected scope

- `src/admin-ui/Dockerfile`
- `src/db/repositories/governance-repos.ts`
- `tests/unit/ci/admin-ui-e2e-gate.spec.ts`
- `tests/unit/db/workflow-open-statuses-sql.spec.ts`
- configuração dos recursos `app` e `admin-ui` no Coolify

Fora de escopo:

- alterar o contrato fail-closed;
- inventar ou reutilizar credenciais S3 de outro serviço;
- alterar migrations, dados de tenant ou regras de negócio.

## Maia invariants at risk

- [x] Fail-closed behavior
- [x] Runtime trace integrity
- [ ] Tenant/agent isolation
- [ ] Backend decides, LLM proposes
- [ ] Append-only migrations

## Implementation notes

- O estágio que alimenta `next build` precisa das devDependencies raiz porque o console importa e verifica fontes TypeScript compartilhadas.
- A imagem final continua sendo o standalone rastreado pelo Next e não recebe a árvore completa de dependências de build.
- Arrays usados com `ANY(...)` em SQL cru precisam ser um único `Param`; um array JS nu é expandido pelo Drizzle como uma row expression inválida no PostgreSQL.
- O probe do backend no Coolify deve ser `/livez`; `/health` é diagnóstico, não probe.
- Sem destino S3 aprovado, `MAIA_CONFIG_STRICT_BOOT=false` pode ser usado somente como rollback temporário, com remoção pendente e explícita.

## Validation commands

```bash
npm run typecheck
npm run lint
npm test -- --run tests/unit/ci/admin-ui-e2e-gate.spec.ts
docker build -f src/admin-ui/Dockerfile .
```

## Acceptance criteria

- [ ] O build Docker do Admin UI conclui no commit corrigido.
- [ ] Um teste impede `--omit=dev` de voltar ao estágio raiz usado pelo build.
- [ ] Os dispatchers de workflow renderizam `ANY($1)` com um parâmetro-array e não `ANY(($1, ...))`.
- [ ] Backend e Admin UI têm healthchecks habilitados com os endpoints corretos.
- [ ] O backend responde `/livez` e `/readyz` após a recuperação.
- [ ] O Admin UI responde com status abaixo de 500.
- [ ] O relatório final identifica o rollback temporário e o requisito restante de S3, se aplicável.
