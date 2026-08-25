-- Down de 119 — remove `signature_version` e o índice de agrupamento por turno
-- (issue #535).
--
-- POR QUE ESTE ARQUIVO É ATÔMICO (`BEGIN`/`COMMIT`)
--   O procedimento canônico de rollback (`docs/runbooks/migrations.md`) roda
--   downs com `psql -v ON_ERROR_STOP=1 -f`, ou seja, autocommit por statement.
--   Sem envelope, uma falha no meio deixaria a tabela num estado híbrido — por
--   exemplo, sem a CHECK e ainda com a coluna — que é pior que não reverter:
--   um escritor antigo voltaria a poder gravar qualquer inteiro na coluna de
--   versão de assinatura. Com `BEGIN`/`COMMIT` a reversão é tudo-ou-nada.
--
--   Como este arquivo tem transação própria, NÃO o envolva em outra
--   (`psql -1`, `BEGIN` manual): `psql -f` já honra o `BEGIN`/`COMMIT` daqui.
--
-- PREFLIGHT EXPLÍCITA
--   Reverter com envelopes v2 no banco NÃO os corrompe — a assinatura continua
--   íntegra, ela só deixa de ser interpretável: sem a coluna, o verifier do
--   código revertido recomputa a material v1 e devolve `invalid` para evidência
--   perfeitamente válida. Isso é exatamente o veredito errado que a #535
--   existe para evitar, e num incidente ele apareceria como "alguém adulterou
--   a trilha de auditoria".
--
--   Então a recusa é deliberada e diz a contagem. Quem precisar reverter mesmo
--   assim decide antes o que fazer com as linhas v2 (exportar a evidência,
--   ou aceitar conscientemente que elas ficarão ilegíveis) — a decisão é do
--   operador, não deste arquivo.
--
-- Ordem do rollback de código: derrube PRIMEIRO o código que escreve v2
-- (`src/control-plane/runtime-trace/envelope-writer.ts`), espere drenar os
-- turnos em voo, e só então rode este down. Na ordem inversa, um turno em voo
-- tenta gravar `signature_version` numa coluna que já não existe e o envelope
-- obrigatório falha fechado — abortando turnos com side effect.

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n
    FROM runtime_trace_envelopes
   WHERE signature_version >= 2;
  IF n > 0 THEN
    RAISE EXCEPTION
      'down de 119 recusado: % envelope(s) em runtime_trace_envelopes com signature_version >= 2', n
      USING HINT =
        'Sem a coluna, o verifier revertido recomputa a material v1 sobre uma assinatura v2 '
        'e reporta evidencia integra como adulterada. Decida explicitamente o que fazer com '
        'essas linhas antes de reverter. Nada foi alterado.';
  END IF;
END
$$;

DROP INDEX IF EXISTS runtime_trace_env_attempt_turn_idx;

ALTER TABLE runtime_trace_envelopes
  DROP CONSTRAINT IF EXISTS runtime_trace_env_signature_version_chk;

ALTER TABLE runtime_trace_envelopes
  DROP COLUMN IF EXISTS signature_version;

COMMIT;
