# P0 — Fail-closed no hot path do agente

## Objective

Fechar quatro caminhos críticos antes de qualquer LLM, ferramenta ou resposta: audiência ausente/inválida, política ou role de canal indisponível, erro inesperado do Decision Engine e carregamento de conversa/pessoa fora do escopo `tenant_id + agent_id`.

## Background

Uma análise do produto encontrou caminhos em `src/agent/core.ts` que transformam falhas de governança em execução permissiva. No mesmo hot path, a conversa e a pessoa são carregadas por IDs simples, embora as FKs atuais permitam referências cruzadas entre tenants/agentes.

- Issue: auditoria local solicitada pelo proprietário em 2026-09-08; sem issue externa.
- Related PRs: nenhuma.
- Relevant docs:
  - `ARCHITECTURE.md`
  - `docs/architecture/concerns/tenant-isolation.md`
  - `docs/architecture/concerns/action-layer.md`
  - `docs/architecture/concerns/channel-policy.md`
  - `docs/architecture/concerns/governance-observability.md`
  - `docs/architecture/modules/agent.md`
  - `docs/architecture/modules/db.md`

## Agent Role

- Implementer

## Expected Scope

Likely files or modules:

- `src/agent/core.ts`
- `src/db/repositories/conversation-repos.ts`
- `src/observability/instrumentation.ts`
- testes unitários do core e testes reais de isolamento dos repositórios
- documentação de arquitetura afetada

Out of scope:

- RLS ou alteração ampla do schema/FKs nesta entrega
- atomicidade geral de auditoria e side effects
- recuperação geral do outbound além dos ramos tocados
- implementação de objetivos, novos procedimentos ou integrações externas
- refatoração ampla do orquestrador do agente

## Maia Invariants at Risk

- [x] Tenant/agent isolation
- [x] Fail-closed behavior
- [x] Backend decides, LLM proposes
- [x] Audit every side effect or policy decision
- [ ] Deterministic confidence
- [ ] Governed operational identity
- [ ] Append-only migrations
- [x] Idempotency for side effects
- [x] Runtime trace integrity
- [x] Policy-controlled channel/role/agent routing

## Required Reading

- [x] `AGENTS.md`
- [x] `ARCHITECTURE.md`
- [x] `docs/ai/agent-operating-model.md`
- [x] Relevant concern docs: tenant isolation, action layer, channel policy, governance/observability
- [x] Relevant module docs: agent, identity, db, runtime
- [x] Existing tests: core fail-closed, tenant leak suites, repository isolation suites

## Implementation Notes

- Falha transitória de store antes de side effect deve deixar o inbound não processado, marcar o turno como retryable e propagar para retry/DLQ.
- Ausência ou inatividade determinística de audiência deve encerrar o turno sem LLM/tool e produzir auditoria de governança.
- Política/role de canal ausente, inconsistente ou indisponível não pode desabilitar silenciosamente o role-selector.
- O catch do Decision Engine deve envolver somente a fronteira que ainda não produziu side effects; erro inesperado nunca pode cair no ReAct.
- O carregamento conversa→pessoa deve restringir os dois lados do join pelo contexto ALS atual.
- Não editar migrations já mergeadas. Uma defesa sistêmica com FKs compostas fica como follow-up explícito.

## Validation Commands

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:leak
```

Se Postgres/Redis ou Docker não estiverem disponíveis, registrar exatamente os checks de integração não executados e o motivo.

## Acceptance Criteria

- [x] Audiência ausente/inativa encerra o turno sem LLM, tool ou outbound do agente e com auditoria.
- [x] Falha ao consultar audiência marca o turno retryable, propaga e mantém o inbound recuperável.
- [x] Política/default role/roles ativos ausentes ou falha na consulta bloqueiam o pipeline antes do grafo/LLM.
- [x] Erro inesperado do Decision Engine marca retryable, propaga e nunca cai no ReAct.
- [x] Recusa/escalada do Decision Engine não pode executar ReAct depois de tentativa de outbound.
- [x] Conversa e pessoa de outro tenant/agente não são retornadas, mesmo com IDs conhecidos ou vínculo cruzado.
- [x] Testes direcionados, typecheck, lint e suites de isolamento passam, ou impedimentos ambientais são documentados.
- [x] Entrega relata validação, impacto nos invariantes e risco residual.

## Validation Results

- Node.js 22.23.0: `tsc --noEmit` e o build (`tsc` + `tsc-alias`) passaram.
- ESLint completo (`src`, `tests`, `scripts`): 0 erros; 481 warnings preexistentes.
- Testes direcionados: 93 passaram em 8 arquivos.
- Suite de isolamento (`test:leak`): 92 passaram; 103 foram ignorados por dependerem de banco real; 0 falhas.
- Suite unitária completa: 9.038 passaram, 45 falharam e 4 foram ignorados. As 45 falhas são o mesmo conjunto ambiental/preexistente observado antes da última correção: permissões e caminhos POSIX no Windows, leitura de artefatos/workflows com separador Windows e subprocessos `npm` indisponíveis no sandbox. Nenhuma falha ocorreu nos arquivos alterados por esta entrega.
- `docs:ai:check` e `config:check:drift` passaram.
- A integração nova de escopo em banco real foi coletada, mas seus 3 casos ficaram ignorados porque `TEST_DB_URL` não está definido e Docker não está instalado nesta máquina.

## Residual Risk and Follow-ups

- O recovery do outbox ainda não terminaliza o `agent_turn` que permanece em `outbound_pending`; isso pode segurar o FIFO após uma falha pós-commit.
- O ramo de rate limit ainda pode engolir uma falha pós-commit e tentar uma transição terminal incompatível.
- O caminho `execute-skill` ainda precisa de uma barreira explícita para não chegar ao ReAct depois de um commit de outbound.
- Conversas legadas com `channel_id=NULL` recebem o canal governado em memória neste turno, mas ainda precisam de um bind persistente com CAS para os turnos futuros.
- FKs compostas de conversa/pessoa continuam recomendadas como segunda linha de defesa; esta entrega fecha o acesso no repositório sem alterar migrations.

## Expected Output

- resumo dos arquivos alterados;
- resultados de validação;
- impacto nos invariantes;
- riscos residuais;
- recomendações de follow-up.
