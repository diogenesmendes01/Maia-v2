# P1 — Convergência entre outbox e turno

## Objective

Fechar três janelas pós-commit do hot path: a entrega/reconciliação do outbox deve
terminalizar o `agent_turn` quando toda a resposta estiver concluída; o aviso de
rate limit não pode encerrar um turno já comprometido; e `execute_skill` não pode
cair no ReAct depois que um outbound durável foi criado.

## Background

- Continuação da auditoria e do P0 em
  `docs/superpowers/plans/2026-09-08-p0-fail-closed-hot-path.md`.
- O estado `outbound_pending` é a barreira FIFO: só o ciclo do outbox pode
  removê-la depois do commit.
- Relevant docs: `ARCHITECTURE.md`, `docs/architecture/modules/runtime.md`,
  `docs/runbooks/outbound-recovery.md`,
  `docs/architecture/concerns/action-layer.md`,
  `docs/architecture/concerns/tenant-isolation.md` e
  `docs/architecture/concerns/governance-observability.md`.

## Agent Role

- Implementer, com investigação e revisão separadas em paralelo.

## Expected Scope

Likely files or modules:

- `src/agent/core.ts`
- `src/db/repositories/turn-repos.ts`
- `src/db/repositories/outbound-delivery-repo.ts`
- `src/db/repositories/outbound-recovery-repo.ts`
- `src/runtime/outbound/` e `src/workers/outbound-recovery.ts`
- testes unitários e de integração diretamente ligados a esses caminhos
- documentação de runtime/outbox afetada pelo contrato

Out of scope:

- alterar a política de retry ou a capacidade idempotente dos provedores;
- criar migração ou mudar schema;
- ampliar os modos de skill executáveis;
- corrigir falhas preexistentes fora destes três caminhos.

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
- [ ] Policy-controlled channel/role/agent routing

## Required Reading

- [x] `AGENTS.md`
- [x] `ARCHITECTURE.md`
- [x] `docs/ai/agent-operating-model.md`
- [x] Relevant concern docs: action layer, tenant isolation, governance/observability
- [x] Relevant module doc: runtime
- [x] Existing delivery, recovery, state-machine and agent-core tests

## Implementation Notes

- A conclusão do artefato e a conclusão do turno são fases e transações
  separadas. Depois que os artefatos convergem, o recovery exige lease expirada,
  bloqueia primeiro o turno e depois todas as partes, e revalida o conjunto. Um
  crash entre os commits é reencontrado no próximo tick elegível, depois de a
  lease expirar.
- Na transação de finalização, o CAS do turno, a projeção dos inputs, a eleição
  do sucessor FIFO e a auditoria são atômicos. O sinal BullMQ só ocorre depois
  do commit.
- Multipart só conclui o turno quando não restar artefato não concluído.
- A transição do turno permanece CAS, escopada por `tenant_id + agent_id`, marca
  os inputs como processados e preserva a promoção FIFO existente.
- Depois do commit, o estado mutável do `TurnHandle` prevalece sobre a
  classificação da exceção: `outbound_pending` nunca autoriza ReAct ou um
  desfecho incompatível.

## Validation Commands

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run test:leak
npm run build
```

Os testes com Postgres real serão executados apenas se `TEST_DB_URL` estiver
disponível; quando não estiver, a entrega deve registrar explicitamente o skip e
apresentar a melhor evidência local substituta.

## Acceptance Criteria

- [x] Com recovery e turn claims habilitados, depois do último artefato
      convergir e da lease expirar, o recovery
      terminaliza o turno como `completed`, processa seus inputs e elege o
      sucessor FIFO; crash entre as duas fases converge no próximo tick elegível.
- [x] Artefato multipart ainda pendente impede conclusão antecipada do turno.
- [x] `delivered` ainda bloqueia a conclusão do turno; todos os artefatos devem
      estar em `completed | failed_terminal | cancelled | dead_letter`.
- [x] Lease viva impede fechamento antecipado; claim ou lease ausente falha
      fechado porque não prova quiescência multipart.
- [x] Pelo menos um artefato `completed` é obrigatório para terminalizar. Um
      conjunto final sem sucesso fica fora do `LIMIT` da finalização, é contado
      por diagnóstico agregado, devolve `no_success` em chamada direta e mantém
      o pai fail-closed sem inventar outcome de entrega.
- [x] Backlog zero-sucesso não causa starvation: a eleição limitada contém
      somente turnos com entrega comprovada, e o estado bloqueado aparece no
      gauge `maia_outbound_turn_no_success_pending` sem counter por tick.
- [x] Se todos os sucessos forem `status_fallback`, o outcome é
      `fallback_delivered`; qualquer outro sucesso produz `reply_delivered`.
- [x] Reconciliação da janela `delivered -> completed` converge o turno também.
- [x] Rate-limit `warn`: sucesso conclui `fallback_delivered`; falha pós-commit
      preserva `outbound_pending`; silêncio e falhas sem commit usam outcomes
      compatíveis sem duplicar envio.
- [x] `execute_skill` nunca entra no ReAct quando o turno já está
      `outbound_pending`, mesmo que o dispatcher reporte `not_sent`.
- [x] Rearme manual usa CAS exato do estado observado e não reabre artefato de
      turno já terminal; finalização concorrente e rearme têm um único vencedor.
- [x] Testes focados, typecheck, lint e build passam; skips/risco residual são
      reportados.

## Declared Residual Risks

- Turnos cujas partes terminem todas sem nenhum `completed` continuam em
  `outbound_pending`; falta uma política própria para decidir falha/DLQ do
  turno sem declarar entrega inexistente. Eles permanecem visíveis em
  `maia_outbound_pending_age_seconds` e no gauge atual
  `maia_outbound_turn_no_success_pending`, que dispara alerta depois de cinco
  minutos sem multiplicar o mesmo incidente por tick.
- Com `FEATURE_TURN_CLAIM=false`, uma falha pós-commit não deixa claim/lease que
  sirva de selo de quiescência. O recovery recusa a finalização automática em
  vez de assumir que o produtor morreu.
- `finalizableTurnsStatement` ainda precisa de uma prova de plano com PostgreSQL
  real (`EXPLAIN`) no ambiente de integração; esta fatia não cria índice nem
  migration.

## Validation Results — 2026-09-08

- Node.js 22: `typecheck`, `lint` e `build` passaram. O lint terminou sem erros
  e preservou 481 warnings preexistentes.
- Suíte focada nos caminhos alterados: 176 testes passaram e 44 foram pulados
  por indisponibilidade do banco de integração; nenhuma falha ocorreu.
- `test:leak`: 92 testes passaram e 103 foram pulados por indisponibilidade do
  banco de integração.
- Testes de integração P1: 44 foram coletados e pulados porque `TEST_DB_URL` não
  está disponível; Redis também não está ativo neste ambiente. A tentativa de
  subir a infraestrutura falhou com `spawn docker ENOENT`.
- `docs:ai:check`, `config:check:drift` e `git diff --check` passaram.
- A suíte completa não ficou verde neste Windows sem a infraestrutura do
  projeto: 10.080 testes executaram, 56 falharam e 1.026 foram pulados; o Vitest
  registrou 10.024 passes. As falhas observadas envolvem Redis/PostgreSQL
  ausentes, caminhos/comandos específicos de Unix, arquivos operacionais
  externos e permissões de symlink; nenhuma ocorreu nas suítes focadas
  alteradas.
- `audit:exceptions:check` executou com acesso ao registry e falhou por
  advisories sem exceção já presentes nos lockfiles, incluindo dois advisories
  críticos de Next.js. Esta mudança não altera dependências nem registra uma
  exceção sem decisão do owner.

## Expected Output

- resumo de arquivos e comportamento alterados;
- validações executadas e não executadas;
- impacto nos invariantes;
- riscos residuais e próximos passos.
