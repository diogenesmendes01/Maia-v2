-- Down de 117 — volta o CHECK de `cognitive_module_log.status` à lista fechada
-- da 008, sem `cancelled`.
--
-- ATENÇÃO: este down FALHA se já existir row com `status = 'cancelled'` — e
-- falhar é o comportamento correto. Um down que apagasse ou reescrevesse essas
-- linhas destruiria a evidência de que uma tentativa foi CANCELADA (lease
-- perdida, shutdown) em vez de ter falhado — que é exatamente o fato que a 116
-- existe para registrar, e o único registro de que uma chamada paga ao provedor
-- foi interrompida. Quem precisar reverter em ambiente com dados decide
-- explicitamente o que fazer com elas antes.
--
-- POR QUE ESTE ARQUIVO É ATÔMICO (`BEGIN`/`COMMIT`), E O `_up` NÃO É
--   O rollback canônico (`docs/runbooks/migrations.md`) roda downs com
--   `psql -v ON_ERROR_STOP=1 -f`, statement a statement. Com `DROP` + `ADD`
--   soltos, o `DROP` commitaria e só então o `ADD` varreria a tabela e falharia
--   por causa das linhas `cancelled` — deixando `cognitive_module_log` SEM a
--   constraint de status. Falhar com a tabela desprotegida é pior que não
--   falhar. Com `BEGIN`/`COMMIT` a recusa é total.
--
--   O `_up` não pode fazer o mesmo: ele precisa de commits SEPARADOS para que a
--   varredura de `VALIDATE` não corra sob o ACCESS EXCLUSIVE do `DROP` (ver o
--   cabeçalho do `_up`). São exigências opostas porque os riscos são opostos:
--   o `_up` roda com tráfego, o `_down` roda em janela de manutenção e precisa
--   ser tudo-ou-nada.
--
--   Como este arquivo tem transação própria, NÃO o envolva em outra
--   (`psql -1`, `BEGIN` manual): `psql -f` já honra o `BEGIN`/`COMMIT` de dentro.
--
-- PREFLIGHT EXPLÍCITA
--   O `DO` abaixo recusa ANTES de qualquer DDL e diz o motivo em português, com
--   a contagem. Sem ele a recusa viria do `ADD CONSTRAINT` como um 23514 cru
--   ("violates check constraint"), que descreve o sintoma e não a decisão.
--
-- Ordem do rollback de código: derrube PRIMEIRO o código que escreve o status
-- (`src/cognition/runner.ts`, e os call sites que passam `signal` —
-- `src/agent/react-loop.ts` e `src/agent/pending-gate.ts`), depois rode este
-- down. Na ordem inversa, um turno em voo cujo cancelamento chegue durante a
-- janela tenta gravar um status que o CHECK já recusa; o INSERT falha dentro do
-- `try` do runner e vira `runner.audit_failed` — o módulo não quebra, mas a
-- auditoria daquela chamada se perde em silêncio.

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM cognitive_module_log WHERE status = 'cancelled';
  IF n > 0 THEN
    RAISE EXCEPTION
      'down de 117 recusado: % row(s) em cognitive_module_log com status = ''cancelled''', n
      USING HINT =
        'Essas linhas sao a evidencia de que uma tentativa foi cancelada (lease perdida, shutdown) '
        'em vez de ter falhado. Decida explicitamente o que fazer com elas (exportar, reclassificar) '
        'antes de reverter. Nada foi alterado: cognitive_module_log_status_check continua como estava.';
  END IF;
END
$$;

-- `_v117` só existe se o `_up` morreu entre os dois statements da fase 3. Cair
-- aqui também é rollback: o nome temporário não pode sobreviver ao down.
ALTER TABLE cognitive_module_log
  DROP CONSTRAINT IF EXISTS cognitive_module_log_status_check_v117;

ALTER TABLE cognitive_module_log
  DROP CONSTRAINT IF EXISTS cognitive_module_log_status_check;

ALTER TABLE cognitive_module_log
  ADD CONSTRAINT cognitive_module_log_status_check
  CHECK (status IN ('success', 'timeout', 'error', 'skipped'));

COMMIT;
